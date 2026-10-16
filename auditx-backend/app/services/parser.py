"""Universal Data Dictionary file parser.

Streams arbitrarily large ERP / gateway CSV exports (SAP, Dynamics 365, Shopify, Stripe, custom ERPs)
chunk-by-chunk, maps tenant-specific headers onto the AuditX canonical schema using
`client_field_mappings`, sanitises currency / date fields and bulk loads the result through
PostgreSQL COPY into a staging table followed by an idempotent INSERT ... ON CONFLICT DO NOTHING.
Memory usage is bounded by PARSER_CHUNK_ROWS regardless of file size.
"""
from __future__ import annotations

import csv
import io
import logging
import re
from dataclasses import dataclass, field
from typing import BinaryIO, Callable, Dict, List, Optional
from uuid import UUID

import pandas as pd
from sqlalchemy import text

from app.config import settings
from app.database import engine

logger = logging.getLogger("auditx.parser")

SUPPORTED_TARGETS = ("ecom_orders", "gateway_transactions")

# Ordered column layout written to COPY for each canonical table (org_id is prepended).
TARGET_COLUMNS: Dict[str, List[str]] = {
    "ecom_orders": ["source_order_number", "total_amount", "currency", "ordered_at"],
    "gateway_transactions": [
        "source_order_number",
        "source_transaction_id",
        "gross_amount",
        "net_amount",
        "fee_amount",
        "processed_at",
    ],
}

CONFLICT_KEYS: Dict[str, str] = {
    "ecom_orders": "(org_id, source_order_number)",
    "gateway_transactions": "(org_id, source_transaction_id)",
}

STAGING_DDL: Dict[str, str] = {
    "ecom_orders": """
        CREATE TEMP TABLE stg_ecom_orders (
            org_id UUID, source_order_number VARCHAR(128), total_amount NUMERIC(18,2),
            currency VARCHAR(3), ordered_at TIMESTAMPTZ
        ) ON COMMIT DROP
    """,
    "gateway_transactions": """
        CREATE TEMP TABLE stg_gateway_transactions (
            org_id UUID, source_order_number VARCHAR(128), source_transaction_id VARCHAR(128),
            gross_amount NUMERIC(18,2), net_amount NUMERIC(18,2), fee_amount NUMERIC(18,2),
            processed_at TIMESTAMPTZ
        ) ON COMMIT DROP
    """,
}

# --------------------------------------------------------------------------- regex sanitisers
_CURRENCY_TOKENS = re.compile(
    r"(?i)(rs\.?|inr|pkr|usd|us\$|eur|gbp|aed|sar|cad|aud|sgd|chf|jpy|cny|zar)"
)
_CURRENCY_SYMBOLS = re.compile(r"[$€£₹¥₨﷼]")
_WHITESPACE = re.compile(r"[\s  ']")
_EUROPEAN_FORMAT = re.compile(r"^-?[\d.]*\d,\d{1,2}-?$")
_NON_NUMERIC = re.compile(r"[^0-9.\-]")
_ISO_CURRENCY = re.compile(r"([A-Za-z]{3})")
_HEADER_NORMALISER = re.compile(r"[^a-z0-9]")


def normalise_header(name: str) -> str:
    return _HEADER_NORMALISER.sub("", str(name).strip().lower())


def clean_currency_series(raw: pd.Series) -> pd.Series:
    """Convert dirty monetary strings ('$1,299.00', 'Rs. 4,500', '(12.50)', '1.234,56-', 'USD 99') to floats."""
    s = raw.astype("string").str.strip()
    negative_parentheses = s.str.match(r"^\(.*\)$").fillna(False)
    trailing_minus = s.str.endswith("-").fillna(False)

    s = s.str.replace(_CURRENCY_TOKENS, "", regex=True)
    s = s.str.replace(_CURRENCY_SYMBOLS, "", regex=True)
    s = s.str.replace(_WHITESPACE, "", regex=True)
    s = s.str.replace(r"[()]", "", regex=True)

    european = s.str.match(_EUROPEAN_FORMAT).fillna(False)
    s = s.where(~european, s.str.replace(".", "", regex=False).str.replace(",", ".", regex=False))
    s = s.str.replace(",", "", regex=False)
    s = s.str.replace(_NON_NUMERIC, "", regex=True)
    s = s.str.rstrip("-")

    values = pd.to_numeric(s, errors="coerce")
    values = values.where(~(negative_parentheses | trailing_minus), -values.abs())
    return values.round(2)


def clean_string_series(raw: pd.Series) -> pd.Series:
    s = raw.astype("string").str.strip()
    s = s.str.replace(r"[\x00-\x1f\x7f]", "", regex=True)
    return s.mask(s == "", pd.NA)


def clean_currency_code_series(raw: pd.Series, default_code: str) -> pd.Series:
    extracted = raw.astype("string").str.extract(_ISO_CURRENCY, expand=False).str.upper()
    return extracted.fillna(default_code)


def parse_timestamp_series(raw: pd.Series, fmt: Optional[str], dayfirst: bool) -> pd.Series:
    s = raw.astype("string").str.strip()
    if fmt:
        return pd.to_datetime(s, format=fmt, errors="coerce", utc=True)
    return pd.to_datetime(s, errors="coerce", utc=True, dayfirst=dayfirst, format="mixed")


# --------------------------------------------------------------------------- transformation rules
@dataclass
class FieldRule:
    standard_field_name: str
    client_column: str
    expected_data_type: str
    is_required: bool
    transformation_rule: Optional[str] = None
    ops: List[tuple] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.ops = parse_transformation_rule(self.transformation_rule)

    @property
    def date_format(self) -> Optional[str]:
        for op, arg in self.ops:
            if op == "date_format":
                return arg
        return None

    @property
    def dayfirst(self) -> bool:
        return any(op == "dayfirst" for op, _ in self.ops)

    @property
    def default(self) -> Optional[str]:
        for op, arg in self.ops:
            if op == "default":
                return arg
        return None


_ALLOWED_OPS = {
    "trim", "upper", "lower", "strip_prefix", "strip_suffix", "multiply", "divide",
    "negate", "abs", "date_format", "dayfirst", "default",
}


def parse_transformation_rule(rule: Optional[str]) -> List[tuple]:
    """Parse 'strip_prefix:#|upper|multiply:0.01' into [('strip_prefix', '#'), ('upper', None), ...]."""
    if not rule:
        return []
    ops: List[tuple] = []
    for part in rule.split("|"):
        part = part.strip()
        if not part:
            continue
        op, _, arg = part.partition(":")
        op = op.strip().lower()
        if op not in _ALLOWED_OPS:
            raise ValueError(f"Unsupported transformation op '{op}' in rule '{rule}'")
        ops.append((op, arg if arg != "" else None))
    return ops


def apply_string_ops(series: pd.Series, ops: List[tuple]) -> pd.Series:
    for op, arg in ops:
        if op == "trim":
            series = series.str.strip()
        elif op == "upper":
            series = series.str.upper()
        elif op == "lower":
            series = series.str.lower()
        elif op == "strip_prefix" and arg:
            series = series.str.removeprefix(arg)
        elif op == "strip_suffix" and arg:
            series = series.str.removesuffix(arg)
    return series


def apply_numeric_ops(series: pd.Series, ops: List[tuple]) -> pd.Series:
    for op, arg in ops:
        if op == "multiply" and arg:
            series = series * float(arg)
        elif op == "divide" and arg:
            series = series / float(arg)
        elif op == "negate":
            series = -series
        elif op == "abs":
            series = series.abs()
    return series.round(2)


# --------------------------------------------------------------------------- mapping resolution
def load_field_rules(org_id: UUID, target_table: str) -> Dict[str, FieldRule]:
    """Join the tenant's mappings against the master dictionary. Unmapped fields fall back to their
    canonical name so files already exported in AuditX standard format load without configuration."""
    if target_table not in SUPPORTED_TARGETS:
        raise ValueError(f"Unsupported target table '{target_table}'")
    query = text(
        """
        SELECT d.standard_field_name,
               d.expected_data_type,
               d.is_required,
               m.client_erp_column_name,
               m.transformation_rule
          FROM data_dictionary_master AS d
          LEFT JOIN client_field_mappings AS m
            ON m.standard_field_id = d.standard_field_id
           AND m.org_id = :org_id
         WHERE d.core_table_name = :target_table
         ORDER BY d.standard_field_name
        """
    )
    with engine.connect() as conn:
        rows = conn.execute(query, {"org_id": str(org_id), "target_table": target_table}).mappings().all()
    if not rows:
        raise RuntimeError("Data dictionary is empty. Run `python -m app.database` first.")
    return {
        row["standard_field_name"]: FieldRule(
            standard_field_name=row["standard_field_name"],
            client_column=row["client_erp_column_name"] or row["standard_field_name"],
            expected_data_type=row["expected_data_type"],
            is_required=row["is_required"],
            transformation_rule=row["transformation_rule"],
        )
        for row in rows
    }


def _org_currency(org_id: UUID) -> str:
    with engine.connect() as conn:
        value = conn.execute(
            text("SELECT brand_currency FROM organizations WHERE org_id = :org_id"), {"org_id": str(org_id)}
        ).scalar_one_or_none()
    if value is None:
        raise LookupError(f"Organization {org_id} does not exist")
    return value


def _sniff_dialect(stream: BinaryIO) -> str:
    sample = stream.read(64 * 1024).decode("utf-8-sig", errors="replace")
    stream.seek(0)
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        return ","


def _resolve_columns(header: List[str], rules: Dict[str, FieldRule]) -> Dict[str, str]:
    """Return {raw_file_header: standard_field_name}; raise if a required field is absent."""
    by_normalised = {normalise_header(col): col for col in header}
    resolved: Dict[str, str] = {}
    missing: List[str] = []
    for standard_name, rule in rules.items():
        raw = by_normalised.get(normalise_header(rule.client_column))
        if raw is None:
            raw = by_normalised.get(normalise_header(standard_name))
        if raw is not None:
            resolved[raw] = standard_name
        elif rule.is_required:
            missing.append(f"{standard_name} (expected column '{rule.client_column}')")
    if missing:
        raise ValueError("Uploaded file is missing required mapped columns: " + ", ".join(missing))
    return resolved


# --------------------------------------------------------------------------- chunk transformation
def transform_chunk(
    chunk: pd.DataFrame,
    target_table: str,
    rules: Dict[str, FieldRule],
    default_currency: str,
) -> tuple[pd.DataFrame, int]:
    """Clean a renamed chunk into the canonical layout. Returns (clean_frame, rejected_row_count)."""
    out = pd.DataFrame(index=chunk.index)
    for standard_name, rule in rules.items():
        raw = chunk[standard_name] if standard_name in chunk.columns else pd.Series(pd.NA, index=chunk.index, dtype="string")
        if rule.default is not None:
            raw = raw.astype("string").fillna(rule.default)
        dtype = rule.expected_data_type
        if dtype == "DECIMAL":
            out[standard_name] = apply_numeric_ops(clean_currency_series(raw), rule.ops)
        elif dtype == "TIMESTAMP":
            out[standard_name] = parse_timestamp_series(raw, rule.date_format, rule.dayfirst)
        elif dtype == "CURRENCY_CODE":
            out[standard_name] = clean_currency_code_series(raw, default_currency)
        else:
            out[standard_name] = apply_string_ops(clean_string_series(raw), rule.ops)

    if target_table == "gateway_transactions":
        gross, net, fee = out["gross_amount"], out["net_amount"], out["fee_amount"]
        out["fee_amount"] = fee.fillna((gross - net).round(2)).fillna(0.0)
        out["net_amount"] = net.fillna((gross - out["fee_amount"]).round(2))

    required = [name for name, rule in rules.items() if rule.is_required]
    valid_mask = out[required].notna().all(axis=1)
    rejected = int((~valid_mask).sum())
    clean = out.loc[valid_mask, TARGET_COLUMNS[target_table]]
    return clean, rejected


def _frame_to_copy_buffer(frame: pd.DataFrame, org_id: UUID, target_table: str) -> io.StringIO:
    payload = frame.copy()
    for column in payload.columns:
        if pd.api.types.is_datetime64_any_dtype(payload[column]):
            payload[column] = payload[column].dt.strftime("%Y-%m-%dT%H:%M:%S%z")
        elif pd.api.types.is_float_dtype(payload[column]):
            payload[column] = payload[column].map(lambda v: "" if pd.isna(v) else f"{v:.2f}")
    payload.insert(0, "org_id", str(org_id))
    buffer = io.StringIO()
    payload.to_csv(buffer, index=False, header=False, na_rep="")
    buffer.seek(0)
    return buffer


def bulk_load_chunk(frame: pd.DataFrame, org_id: UUID, target_table: str) -> int:
    """COPY a cleaned chunk into a session-local staging table and merge idempotently. Returns rows inserted."""
    if frame.empty:
        return 0
    columns = ["org_id"] + TARGET_COLUMNS[target_table]
    column_sql = ", ".join(columns)
    staging = f"stg_{target_table}"
    buffer = _frame_to_copy_buffer(frame, org_id, target_table)

    raw = engine.raw_connection()
    try:
        with raw.cursor() as cur:
            cur.execute(STAGING_DDL[target_table])
            cur.copy_expert(f"COPY {staging} ({column_sql}) FROM STDIN WITH (FORMAT csv, NULL '')", buffer)
            cur.execute(
                f"INSERT INTO {target_table} ({column_sql}) "
                f"SELECT {column_sql} FROM {staging} "
                f"ON CONFLICT {CONFLICT_KEYS[target_table]} DO NOTHING"
            )
            inserted = cur.rowcount
        raw.commit()
        return inserted
    except Exception:
        raw.rollback()
        raise
    finally:
        raw.close()


# --------------------------------------------------------------------------- public entrypoints
@dataclass
class ParseReport:
    target_table: str
    chunks_processed: int = 0
    rows_read: int = 0
    rows_rejected: int = 0
    rows_inserted: int = 0
    rows_duplicate: int = 0
    column_map: Dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, object]:
        return {
            "target_table": self.target_table,
            "chunks_processed": self.chunks_processed,
            "rows_read": self.rows_read,
            "rows_rejected": self.rows_rejected,
            "rows_inserted": self.rows_inserted,
            "rows_duplicate": self.rows_duplicate,
            "column_map": self.column_map,
        }


def parse_stream(
    stream: BinaryIO,
    org_id: UUID,
    target_table: str,
    chunk_rows: Optional[int] = None,
    progress: Optional[Callable[[ParseReport], None]] = None,
) -> ParseReport:
    """Parse a binary CSV stream chunk-by-chunk into the tenant's canonical table."""
    rules = load_field_rules(org_id, target_table)
    default_currency = _org_currency(org_id)
    delimiter = _sniff_dialect(stream)

    header = pd.read_csv(stream, nrows=0, sep=delimiter, encoding="utf-8-sig", encoding_errors="replace").columns.tolist()
    stream.seek(0)
    column_map = _resolve_columns(header, rules)
    report = ParseReport(target_table=target_table, column_map=column_map)

    reader = pd.read_csv(
        stream,
        sep=delimiter,
        dtype=str,
        usecols=list(column_map.keys()),
        chunksize=chunk_rows or settings.PARSER_CHUNK_ROWS,
        encoding="utf-8-sig",
        encoding_errors="replace",
        on_bad_lines="skip",
        skip_blank_lines=True,
        keep_default_na=False,
        na_values=["", "NULL", "null", "N/A", "n/a", "#N/A", "NaN", "-"],
    )
    for chunk in reader:
        chunk = chunk.rename(columns=column_map)
        clean, rejected = transform_chunk(chunk, target_table, rules, default_currency)
        inserted = bulk_load_chunk(clean, org_id, target_table)

        report.chunks_processed += 1
        report.rows_read += len(chunk)
        report.rows_rejected += rejected
        report.rows_inserted += inserted
        report.rows_duplicate += len(clean) - inserted
        logger.info(
            "org=%s table=%s chunk=%d read=%d inserted=%d rejected=%d",
            org_id, target_table, report.chunks_processed, len(chunk), inserted, rejected,
        )
        if progress:
            progress(report)
    return report


def parse_file(path: str, org_id: UUID, target_table: str, chunk_rows: Optional[int] = None,
               progress: Optional[Callable[[ParseReport], None]] = None) -> ParseReport:
    with open(path, "rb") as stream:
        return parse_stream(stream, org_id, target_table, chunk_rows=chunk_rows, progress=progress)


__all__ = [
    "ParseReport",
    "clean_currency_series",
    "load_field_rules",
    "parse_file",
    "parse_stream",
    "parse_transformation_rule",
    "transform_chunk",
]
