"""Multi-channel reconciliation engine (orders <-> payment gateway).

All arithmetic is done in integer cents to avoid floating point drift. Each tenant is reconciled in
isolation: every query is filtered by `org_id` and results are written back to `discrepancy_logs`
in a single transaction (open findings are rebuilt, resolved findings are preserved).

Sign convention: variance_amount = order_amount - gateway_amount
    > 0  -> money expected but not collected (leakage)
    < 0  -> money collected that the books do not explain (untracked revenue / over-capture)
"""
from __future__ import annotations

import io
import logging
import time
from dataclasses import dataclass
from typing import Dict
from uuid import UUID

import numpy as np
import pandas as pd
from sqlalchemy import text

from app.config import settings
from app.database import engine

logger = logging.getLogger("auditx.reconciliation")

ORDERS_SQL = text(
    """
    SELECT source_order_number,
           ROUND(SUM(total_amount) * 100)::bigint AS order_cents,
           COUNT(*)::int                          AS order_rows
      FROM ecom_orders
     WHERE org_id = :org_id
     GROUP BY source_order_number
    """
)

GATEWAY_SQL = text(
    """
    SELECT source_order_number,
           ROUND(SUM(gross_amount) * 100)::bigint AS gateway_cents,
           ROUND(SUM(fee_amount) * 100)::bigint   AS fee_cents,
           COUNT(*)::int                          AS gateway_rows
      FROM gateway_transactions
     WHERE org_id = :org_id
     GROUP BY source_order_number
    """
)

RESOLVED_SQL = text(
    """
    SELECT source_order_number,
           issue_type,
           ROUND(variance_amount * 100)::bigint AS variance_cents
      FROM discrepancy_logs
     WHERE org_id = :org_id
       AND status = 'RESOLVED'
    """
)

LOG_COLUMNS = [
    "org_id",
    "source_order_number",
    "issue_type",
    "order_amount",
    "gateway_amount",
    "variance_amount",
    "status",
]


@dataclass
class ReconciliationReport:
    org_id: str
    orders_compared: int
    gateway_orders_compared: int
    matched: int
    missing_payments: int
    untracked_revenue: int
    amount_mismatches: int
    already_resolved_skipped: int
    leakage_exposure: float
    untracked_exposure: float
    elapsed_ms: int

    @property
    def discrepancies_logged(self) -> int:
        return self.missing_payments + self.untracked_revenue + self.amount_mismatches

    def as_dict(self) -> Dict[str, object]:
        data = dict(self.__dict__)
        data["discrepancies_logged"] = self.discrepancies_logged
        return data


def _load_frames(org_id: UUID) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    params = {"org_id": str(org_id)}
    with engine.connect() as conn:
        orders = pd.read_sql(ORDERS_SQL, conn, params=params)
        gateway = pd.read_sql(GATEWAY_SQL, conn, params=params)
        resolved = pd.read_sql(RESOLVED_SQL, conn, params=params)
    orders = orders.astype({"order_cents": "int64", "order_rows": "int32"})
    gateway = gateway.astype({"gateway_cents": "int64", "fee_cents": "int64", "gateway_rows": "int32"})
    return orders, gateway, resolved


def classify(orders: pd.DataFrame, gateway: pd.DataFrame, tolerance_cents: int) -> pd.DataFrame:
    """Full outer join on source_order_number and isolate the three variance groups."""
    merged = orders.merge(gateway, on="source_order_number", how="outer", indicator=True, copy=False)
    order_cents = merged["order_cents"].astype("Int64")
    gateway_cents = merged["gateway_cents"].astype("Int64")
    merged["variance_cents"] = (order_cents.fillna(0) - gateway_cents.fillna(0)).astype("int64")

    is_left = (merged["_merge"] == "left_only").to_numpy()
    is_right = (merged["_merge"] == "right_only").to_numpy()
    is_both = (merged["_merge"] == "both").to_numpy()
    is_mismatch = is_both & (np.abs(merged["variance_cents"].to_numpy()) > tolerance_cents)

    merged["issue_type"] = np.select(
        [is_left, is_right, is_mismatch],
        ["MISSING_PAYMENT", "UNTRACKED_REVENUE", "AMOUNT_MISMATCH"],
        default="MATCHED",
    )
    return merged


def _exclude_resolved(findings: pd.DataFrame, resolved: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    if resolved.empty or findings.empty:
        return findings, 0
    resolved = resolved.astype({"variance_cents": "int64"}).drop_duplicates()
    keyed = findings.merge(
        resolved.assign(_resolved=True),
        on=["source_order_number", "issue_type", "variance_cents"],
        how="left",
    )
    mask = keyed["_resolved"].isna().to_numpy()
    return findings.loc[mask], int((~mask).sum())


def _cents_to_text(series: pd.Series) -> pd.Series:
    def fmt(value: object) -> str:
        if value is pd.NA or value is None or (isinstance(value, float) and np.isnan(value)):
            return ""
        cents = int(value)
        sign = "-" if cents < 0 else ""
        cents = abs(cents)
        return f"{sign}{cents // 100}.{cents % 100:02d}"

    return series.astype("object").map(fmt)


def _write_logs(org_id: UUID, findings: pd.DataFrame) -> None:
    payload = pd.DataFrame(
        {
            "org_id": str(org_id),
            "source_order_number": findings["source_order_number"].to_numpy(),
            "issue_type": findings["issue_type"].to_numpy(),
            "order_amount": _cents_to_text(findings["order_cents"].astype("Int64")).to_numpy(),
            "gateway_amount": _cents_to_text(findings["gateway_cents"].astype("Int64")).to_numpy(),
            "variance_amount": _cents_to_text(findings["variance_cents"]).to_numpy(),
            "status": "UNRESOLVED",
        },
        columns=LOG_COLUMNS,
    )
    buffer = io.StringIO()
    payload.to_csv(buffer, index=False, header=False)
    buffer.seek(0)

    raw = engine.raw_connection()
    try:
        with raw.cursor() as cur:
            # Serialise concurrent reconciliations for the same tenant.
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"recon:{org_id}",))
            cur.execute(
                "DELETE FROM discrepancy_logs WHERE org_id = %s AND status = 'UNRESOLVED'", (str(org_id),)
            )
            if not payload.empty:
                cur.copy_expert(
                    f"COPY discrepancy_logs ({', '.join(LOG_COLUMNS)}) FROM STDIN WITH (FORMAT csv, NULL '')",
                    buffer,
                )
        raw.commit()
    except Exception:
        raw.rollback()
        raise
    finally:
        raw.close()


def reconcile_org(org_id: UUID, tolerance_cents: int | None = None) -> ReconciliationReport:
    started = time.perf_counter()
    tolerance = settings.RECON_MATCH_TOLERANCE_CENTS if tolerance_cents is None else tolerance_cents

    orders, gateway, resolved = _load_frames(org_id)
    classified = classify(orders, gateway, tolerance)
    findings = classified.loc[classified["issue_type"] != "MATCHED"]
    findings, skipped = _exclude_resolved(findings, resolved)
    _write_logs(org_id, findings)

    counts = findings["issue_type"].value_counts()
    variance = findings["variance_cents"]
    report = ReconciliationReport(
        org_id=str(org_id),
        orders_compared=int(len(orders)),
        gateway_orders_compared=int(len(gateway)),
        matched=int((classified["issue_type"] == "MATCHED").sum()),
        missing_payments=int(counts.get("MISSING_PAYMENT", 0)),
        untracked_revenue=int(counts.get("UNTRACKED_REVENUE", 0)),
        amount_mismatches=int(counts.get("AMOUNT_MISMATCH", 0)),
        already_resolved_skipped=skipped,
        leakage_exposure=round(float(variance[variance > 0].sum()) / 100, 2),
        untracked_exposure=round(float(-variance[variance < 0].sum()) / 100, 2),
        elapsed_ms=int((time.perf_counter() - started) * 1000),
    )
    logger.info("Reconciliation complete: %s", report.as_dict())
    return report
