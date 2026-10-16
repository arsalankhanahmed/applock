"""Programmatic reconciliation mock generator.

Seeds a tenant with realistic order + gateway data in iterative batches and injects a controlled anomaly
distribution (default 5%, split evenly between missing payments, orphan gateway payments and exact
$5.00 promo mismatches) to benchmark the parser, reconciliation and auto-healer layers.

Examples:
    python -m app.utils.seeder --orders 20000 --reconcile
    python -m app.utils.seeder --orders 50000 --anomaly-rate 0.05 --fx-noise-rate 0.01 --reconcile
    python -m app.utils.seeder --orders 5000 --export-csv ./samples --export-only --email parser@auditx.io
"""
from __future__ import annotations

import argparse
import io
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple
from uuid import UUID

import numpy as np
import pandas as pd
from sqlalchemy import text

from app.database import engine, init_db

NORMAL, MISSING_PAYMENT, ORPHAN_PAYMENT, PROMO_MISMATCH, FX_NOISE = range(5)

DEMO_EMAIL = "demo@auditx.io"
DEMO_PASSWORD = "AuditX#Demo2026"

SAP_ORDER_MAPPING = {
    "source_order_number": ("Sales Document", None),
    "total_amount": ("Net Value", None),
    "currency": ("Doc. Currency", None),
    "ordered_at": ("Created On", "date_format:%d.%m.%Y %H:%M:%S"),
}
GATEWAY_MAPPING = {
    "source_order_number": ("Merchant Reference", "trim"),
    "source_transaction_id": ("Charge ID", None),
    "gross_amount": ("Gross Amount", None),
    "net_amount": ("Net Payout", None),
    "fee_amount": ("Processing Fee", "abs"),
    "processed_at": ("Captured At", None),
}
CURRENCY_SYMBOLS = {"USD": "$", "INR": "Rs. ", "PKR": "Rs. ", "EUR": "€", "GBP": "£", "AED": "AED "}


@dataclass
class SeedStats:
    orders: int = 0
    gateway_transactions: int = 0
    anomalies: Dict[str, int] = field(default_factory=lambda: {
        "missing_payment": 0, "orphan_gateway_payment": 0, "promo_mismatch_5usd": 0, "fx_micro_variance": 0,
    })
    expected_leakage: float = 0.0


def ensure_tenant(company_name: str, currency: str, org_id: Optional[str], email: str, password: str) -> Tuple[UUID, bool]:
    from app.main import hash_password

    with engine.begin() as conn:
        if org_id:
            found = conn.execute(text("SELECT org_id FROM organizations WHERE org_id = :o"), {"o": org_id}).scalar()
            if not found:
                raise SystemExit(f"Organization {org_id} not found")
            org = UUID(str(found))
        else:
            org = conn.execute(
                text("INSERT INTO organizations (company_name, brand_currency) VALUES (:n, :c) RETURNING org_id"),
                {"n": company_name, "c": currency},
            ).scalar_one()
        created_user = False
        exists = conn.execute(text("SELECT 1 FROM users WHERE email = lower(:e)"), {"e": email}).scalar()
        if not exists:
            conn.execute(
                text("INSERT INTO users (org_id, full_name, email, password_hash, role) "
                     "VALUES (:o, 'Demo Controller', lower(:e), :p, 'OWNER')"),
                {"o": str(org), "e": email, "p": hash_password(password)},
            )
            created_user = True
        fields = conn.execute(
            text("SELECT standard_field_id, core_table_name, standard_field_name FROM data_dictionary_master")
        ).mappings().all()
        for f in fields:
            mapping = SAP_ORDER_MAPPING if f["core_table_name"] == "ecom_orders" else GATEWAY_MAPPING
            column, rule = mapping[f["standard_field_name"]]
            conn.execute(
                text(
                    """
                    INSERT INTO client_field_mappings (org_id, standard_field_id, client_erp_column_name, transformation_rule)
                    VALUES (:o, :f, :c, :r)
                    ON CONFLICT (org_id, standard_field_id) DO UPDATE
                       SET client_erp_column_name = EXCLUDED.client_erp_column_name,
                           transformation_rule = EXCLUDED.transformation_rule
                    """
                ),
                {"o": str(org), "f": f["standard_field_id"], "c": column, "r": rule},
            )
    return UUID(str(org)), created_user


def generate_batch(
    rng: np.random.Generator,
    start_index: int,
    size: int,
    run_token: str,
    currency: str,
    anomaly_rate: float,
    fx_noise_rate: float,
) -> Tuple[pd.DataFrame, pd.DataFrame, np.ndarray]:
    """Build one iteration of orders + gateway captures with weighted anomaly injection."""
    split = anomaly_rate / 3
    weights = [1 - anomaly_rate - fx_noise_rate, split, split, split, fx_noise_rate]
    labels = rng.choice(5, size=size, p=weights)

    numbers = np.array([f"SO-{run_token}-{start_index + i:08d}" for i in range(size)])
    amount_cents = np.clip(np.round(rng.lognormal(mean=4.4, sigma=0.75, size=size) * 100), 1200, 2_500_000).astype(np.int64)

    now = datetime.now(timezone.utc).replace(microsecond=0)
    ordered_at = pd.to_datetime(now) - pd.to_timedelta(rng.integers(0, 90 * 24 * 3600, size=size), unit="s")
    processed_at = ordered_at + pd.to_timedelta(rng.integers(5, 1800, size=size), unit="s")

    gross_cents = amount_cents.copy()
    gross_cents[labels == PROMO_MISMATCH] -= 500
    fx_mask = labels == FX_NOISE
    fx_delta = rng.integers(1, 50, size=size) * rng.choice([-1, 1], size=size)
    gross_cents[fx_mask] += fx_delta[fx_mask]
    fee_cents = np.round(gross_cents * 0.029 + 30).astype(np.int64)
    net_cents = gross_cents - fee_cents

    providers = rng.choice(np.array(["ch_", "pay_", "pi_"]), size=size)
    entropy = rng.bytes(12 * size).hex()
    txn_ids = np.array([f"{p}{entropy[i * 24:(i + 1) * 24]}" for i, p in enumerate(providers)])

    has_order = labels != ORPHAN_PAYMENT
    has_payment = labels != MISSING_PAYMENT

    orders = pd.DataFrame({
        "source_order_number": numbers[has_order],
        "total_cents": amount_cents[has_order],
        "currency": currency,
        "ordered_at": ordered_at[has_order],
    })
    gateway = pd.DataFrame({
        "source_order_number": numbers[has_payment],
        "source_transaction_id": txn_ids[has_payment],
        "gross_cents": gross_cents[has_payment],
        "net_cents": net_cents[has_payment],
        "fee_cents": fee_cents[has_payment],
        "processed_at": processed_at[has_payment],
    })
    return orders, gateway, labels


def _cents(series: pd.Series) -> pd.Series:
    return series.map(lambda c: f"{'-' if c < 0 else ''}{abs(int(c)) // 100}.{abs(int(c)) % 100:02d}")


def copy_batch(org_id: UUID, orders: pd.DataFrame, gateway: pd.DataFrame) -> None:
    order_buf = io.StringIO()
    pd.DataFrame({
        "org_id": str(org_id),
        "source_order_number": orders["source_order_number"],
        "total_amount": _cents(orders["total_cents"]),
        "currency": orders["currency"],
        "ordered_at": orders["ordered_at"].dt.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }).to_csv(order_buf, index=False, header=False)
    order_buf.seek(0)

    gateway_buf = io.StringIO()
    pd.DataFrame({
        "org_id": str(org_id),
        "source_order_number": gateway["source_order_number"],
        "source_transaction_id": gateway["source_transaction_id"],
        "gross_amount": _cents(gateway["gross_cents"]),
        "net_amount": _cents(gateway["net_cents"]),
        "fee_amount": _cents(gateway["fee_cents"]),
        "processed_at": gateway["processed_at"].dt.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }).to_csv(gateway_buf, index=False, header=False)
    gateway_buf.seek(0)

    raw = engine.raw_connection()
    try:
        with raw.cursor() as cur:
            cur.copy_expert(
                "COPY ecom_orders (org_id, source_order_number, total_amount, currency, ordered_at) "
                "FROM STDIN WITH (FORMAT csv)", order_buf)
            cur.copy_expert(
                "COPY gateway_transactions (org_id, source_order_number, source_transaction_id, gross_amount, "
                "net_amount, fee_amount, processed_at) FROM STDIN WITH (FORMAT csv)", gateway_buf)
        raw.commit()
    except Exception:
        raw.rollback()
        raise
    finally:
        raw.close()


def export_dirty_csv(directory: str, orders: pd.DataFrame, gateway: pd.DataFrame, currency: str, first: bool) -> None:
    """Write SAP / gateway style exports with dirty currency formatting to exercise the parser."""
    os.makedirs(directory, exist_ok=True)
    symbol = CURRENCY_SYMBOLS.get(currency, f"{currency} ")
    sap = pd.DataFrame({
        "Sales Document": orders["source_order_number"],
        "Net Value": orders["total_cents"].map(lambda c: f"{symbol}{c / 100:,.2f}"),
        "Doc. Currency": orders["currency"],
        "Created On": orders["ordered_at"].dt.strftime("%d.%m.%Y %H:%M:%S"),
    })
    gw = pd.DataFrame({
        "Merchant Reference": gateway["source_order_number"].map(lambda s: f" {s} "),
        "Charge ID": gateway["source_transaction_id"],
        "Gross Amount": gateway["gross_cents"].map(lambda c: f"{c / 100:,.2f}"),
        "Net Payout": gateway["net_cents"].map(lambda c: f"{symbol}{c / 100:,.2f}"),
        "Processing Fee": gateway["fee_cents"].map(lambda c: f"({c / 100:.2f})"),
        "Captured At": gateway["processed_at"].dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    mode = "w" if first else "a"
    sap.to_csv(os.path.join(directory, "sap_sales_orders.csv"), index=False, header=first, mode=mode)
    gw.to_csv(os.path.join(directory, "gateway_settlements.csv"), index=False, header=first, mode=mode)


def run(args: argparse.Namespace) -> SeedStats:
    init_db()
    if args.anomaly_rate + args.fx_noise_rate >= 1:
        raise SystemExit("anomaly-rate + fx-noise-rate must be < 1")
    rng = np.random.default_rng(args.seed)
    run_token = datetime.now(timezone.utc).strftime("%y%m%d%H%M%S")
    org_id, created_user = ensure_tenant(args.company_name, args.currency.upper(), args.org_id, args.email, args.password)
    stats = SeedStats()
    started = time.perf_counter()

    iterations = (args.orders + args.batch_size - 1) // args.batch_size
    for iteration in range(iterations):
        size = min(args.batch_size, args.orders - iteration * args.batch_size)
        orders, gateway, labels = generate_batch(
            rng, iteration * args.batch_size, size, run_token, args.currency.upper(), args.anomaly_rate,
            args.fx_noise_rate,
        )
        if not args.export_only:
            copy_batch(org_id, orders, gateway)
        if args.export_csv:
            export_dirty_csv(args.export_csv, orders, gateway, args.currency.upper(), first=iteration == 0)

        stats.orders += len(orders)
        stats.gateway_transactions += len(gateway)
        stats.anomalies["missing_payment"] += int((labels == MISSING_PAYMENT).sum())
        stats.anomalies["orphan_gateway_payment"] += int((labels == ORPHAN_PAYMENT).sum())
        stats.anomalies["promo_mismatch_5usd"] += int((labels == PROMO_MISMATCH).sum())
        stats.anomalies["fx_micro_variance"] += int((labels == FX_NOISE).sum())
        print(f"  iteration {iteration + 1}/{iterations}: {len(orders)} orders, {len(gateway)} captures")

    elapsed = time.perf_counter() - started
    total_anomalies = sum(stats.anomalies.values())
    print("\nAuditX seed complete")
    print(f"  org_id               : {org_id}")
    print(f"  orders / captures    : {stats.orders:,} / {stats.gateway_transactions:,}")
    print(f"  injected anomalies   : {total_anomalies:,} ({total_anomalies / max(args.orders, 1):.2%}) {stats.anomalies}")
    print(f"  elapsed              : {elapsed:.2f}s")
    if created_user:
        print(f"  login                : {args.email} / {args.password}")
    else:
        print(f"  login                : {args.email} already exists (belongs to its original org; pass --email)")
    if args.export_csv:
        print(f"  dirty CSV exports    : {os.path.abspath(args.export_csv)}")

    if args.reconcile and not args.export_only:
        from app.services.auto_healer import heal_org
        from app.services.reconciliation import reconcile_org

        report = reconcile_org(org_id)
        healed = heal_org(org_id)
        print(f"  reconciliation       : {report.as_dict()}")
        print(f"  auto-healer          : {healed}")
    return stats


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Seed AuditX with reconciliation test data")
    parser.add_argument("--orders", type=int, default=10_000, help="Total orders to generate")
    parser.add_argument("--batch-size", type=int, default=2_000, help="Orders generated per iteration")
    parser.add_argument("--anomaly-rate", type=float, default=0.05, help="Share of orders with an injected break")
    parser.add_argument("--fx-noise-rate", type=float, default=0.0, help="Extra share with sub-$0.50 FX variance")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed for reproducible datasets")
    parser.add_argument("--company-name", default="Northwind Commerce Ltd")
    parser.add_argument("--currency", default="USD")
    parser.add_argument("--email", default=DEMO_EMAIL, help="Owner login created for the seeded org")
    parser.add_argument("--password", default=DEMO_PASSWORD, help="Password for --email")
    parser.add_argument("--org-id", default=None, help="Seed into an existing organization instead of creating one")
    parser.add_argument("--export-csv", default=None, help="Directory to also write dirty SAP/gateway CSV exports")
    parser.add_argument("--export-only", action="store_true", help="Only write CSVs; skip direct DB inserts")
    parser.add_argument("--reconcile", action="store_true", help="Run reconciliation + auto-healer after seeding")
    return parser


if __name__ == "__main__":
    run(build_parser().parse_args())
