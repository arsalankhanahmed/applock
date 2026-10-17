"""Programmatic reconciliation mock generator.

Seeds a tenant with realistic data for all three reconciliation legs, in iterative batches:

  GATEWAY  prepaid orders + gateway captures; anomalies (default 5% of prepaid orders, split evenly):
           missing payments, orphan gateway payments, exact $5.00 promo mismatches (+ optional FX noise)
  COD      cash-on-delivery orders + courier parcel reports (TCS, Leopards, PostEx, Trax) with weekly
           remittance batches; anomalies (default 5% of COD orders, split evenly): not remitted, short
           remittance, rider short collection, courier overcharge, returned-but-booked, lost / stuck,
           never dispatched, parcel without an ERP order
  BANK     a bank statement holding every gateway payout and courier remittance that has landed, plus
           rent / salary / loan noise; anomalies (default 5% of settlement batches, split evenly):
           missing deposit, bank charges deducted, unexplained short deposit, unidentified credit

Anomalies are only planted where they are detectable on the run date (e.g. a remittance is only "late"
once it is past the SLA), so the reconciliation report can be checked against the injected counts.

Examples:
    python -m app.utils.seeder --orders 20000 --reconcile
    python -m app.utils.seeder --orders 50000 --cod-share 0.5 --fx-noise-rate 0.01 --reconcile
    python -m app.utils.seeder --orders 5000 --export-csv ./samples --export-only --email parser@auditx.io
"""
from __future__ import annotations

import argparse
import io
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

import numpy as np
import pandas as pd
from sqlalchemy import text

from app.config import settings
from app.database import engine, init_db

NORMAL, MISSING_PAYMENT, ORPHAN_PAYMENT, PROMO_MISMATCH, FX_NOISE = range(5)
(C_NORMAL, C_NOT_REMITTED, C_SHORT_REMIT, C_RIDER_SHORT, C_OVERCHARGE,
 C_RETURN_BOOKED, C_LOST, C_UNTRACKED, C_ORPHAN_PARCEL) = range(9)
COD_ANOMALY_NAMES = {
    C_NOT_REMITTED: "cod_not_remitted",
    C_SHORT_REMIT: "courier_short_remittance",
    C_RIDER_SHORT: "rider_short_collection",
    C_OVERCHARGE: "courier_overcharge",
    C_RETURN_BOOKED: "returned_but_booked",
    C_LOST: "parcel_lost_or_stuck",
    C_UNTRACKED: "cod_never_dispatched",
    C_ORPHAN_PARCEL: "parcel_without_erp_order",
}
B_NORMAL, B_MISSING, B_BANK_CHARGE, B_SHORT, B_UNMATCHED = range(5)
BANK_ANOMALY_NAMES = {
    B_MISSING: "settlement_not_deposited",
    B_BANK_CHARGE: "bank_charges_deducted",
    B_SHORT: "short_deposit",
    B_UNMATCHED: "unidentified_credit",
}

COURIERS = np.array(["TCS", "LEOPARDS", "POSTEX", "TRAX"])
COURIER_WEIGHTS = [0.35, 0.30, 0.20, 0.15]
COURIER_BASE_CHARGE_CENTS = {"TCS": 250, "LEOPARDS": 220, "POSTEX": 200, "TRAX": 190}
STATUS_WORDING = {"DELIVERED": "Delivered", "RETURNED": "Returned to Shipper", "IN_TRANSIT": "In Transit",
                  "LOST": "Lost"}

DEMO_EMAIL = "demo@auditx.io"
DEMO_PASSWORD = "AuditX#Demo2026"

# Header mappings matching the dirty exports below (column name, transformation rule).
MAPPINGS: Dict[str, Dict[str, Tuple[str, Optional[str]]]] = {
    "ecom_orders": {
        "source_order_number": ("Sales Document", None),
        "total_amount": ("Net Value", None),
        "currency": ("Doc. Currency", None),
        "ordered_at": ("Created On", "date_format:%d.%m.%Y %H:%M:%S"),
        "payment_method": ("Payment Method", None),
    },
    "gateway_transactions": {
        "source_order_number": ("Merchant Reference", "trim"),
        "source_transaction_id": ("Charge ID", None),
        "gross_amount": ("Gross Amount", None),
        "net_amount": ("Net Payout", None),
        "fee_amount": ("Processing Fee", "abs"),
        "processed_at": ("Captured At", None),
        "payout_reference": ("Payout ID", None),
    },
    "bank_transactions": {
        "transaction_date": ("Value Date", "date_format:%d/%m/%Y"),
        "description": ("Narration", None),
        "credit_amount": ("Credit", None),
        "debit_amount": ("Debit", None),
        "bank_reference": ("Ref No", None),
        "bank_account": ("Account", None),
        "amount": ("Amount", None),
    },
    "courier_remittances": {
        "tracking_number": ("Tracking #", None),
        "source_order_number": ("Order Ref", "trim"),
        "courier_name": ("Courier", None),
        "parcel_status": ("Status", None),
        "cod_amount": ("COD Amount", None),
        "delivery_charges": ("Delivery Charges", None),
        "net_remitted": ("Net Payable", None),
        "remittance_reference": ("CPR No", None),
        "booked_at": ("Booking Date", "date_format:%d-%m-%Y %H:%M"),
        "delivered_at": ("Delivery Date", "date_format:%d-%m-%Y %H:%M"),
        "remitted_at": ("Payment Date", "date_format:%d-%m-%Y %H:%M"),
    },
}
CURRENCY_SYMBOLS = {"USD": "$", "INR": "Rs. ", "PKR": "Rs. ", "EUR": "€", "GBP": "£", "AED": "AED "}


@dataclass
class SeedStats:
    orders: int = 0
    cod_orders: int = 0
    gateway_transactions: int = 0
    parcels: int = 0
    bank_lines: int = 0
    anomalies: Dict[str, int] = field(default_factory=lambda: {
        "missing_payment": 0, "orphan_gateway_payment": 0, "promo_mismatch_5usd": 0, "fx_micro_variance": 0,
    })
    cod_anomalies: Dict[str, int] = field(default_factory=lambda: {name: 0 for name in COD_ANOMALY_NAMES.values()})
    bank_anomalies: Dict[str, int] = field(default_factory=lambda: {name: 0 for name in BANK_ANOMALY_NAMES.values()})


@dataclass
class Settlement:
    """A payout / remittance batch accumulated across seeding iterations."""
    kind: str
    party: str
    cents: int = 0
    closed_at: Optional[pd.Timestamp] = None

    def add(self, cents: int, moment: pd.Timestamp) -> None:
        self.cents += int(cents)
        if self.closed_at is None or moment > self.closed_at:
            self.closed_at = moment


def checker_email(email: str) -> str:
    """The AUDITOR login seeded next to the owner, so maker-checker can be exercised: demo@x -> demo+checker@x."""
    local, _, domain = email.partition("@")
    return f"{local}+checker@{domain}"


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
            conn.execute(
                text("INSERT INTO users (org_id, full_name, email, password_hash, role) "
                     "VALUES (:o, 'Demo Auditor', lower(:e), :p, 'AUDITOR') ON CONFLICT (email) DO NOTHING"),
                {"o": str(org), "e": checker_email(email), "p": hash_password(password)},
            )
            created_user = True
        fields = conn.execute(
            text("SELECT standard_field_id, core_table_name, standard_field_name FROM data_dictionary_master")
        ).mappings().all()
        for f in fields:
            mapped = MAPPINGS.get(f["core_table_name"], {}).get(f["standard_field_name"])
            if mapped is None:
                continue
            column, rule = mapped
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


def _seconds(values: np.ndarray) -> pd.TimedeltaIndex:
    return pd.to_timedelta(values, unit="s")


def generate_parcels(
    rng: np.random.Generator,
    cod_numbers: np.ndarray,
    order_cents: np.ndarray,
    ordered_at: pd.DatetimeIndex,
    tracking_offset: int,
    run_token: str,
    now: pd.Timestamp,
    cod_anomaly_rate: float,
    return_rate: float,
) -> Tuple[pd.DataFrame, np.ndarray, np.ndarray]:
    """Courier parcels for one batch of COD orders.

    Returns (parcels, cod_labels, order_in_erp) where order_in_erp is False for parcels whose order the
    ERP does not carry (normal returns are cancelled in the ERP; orphan parcels were never booked)."""
    n = len(cod_numbers)
    labels = rng.choice(9, size=n, p=[1 - cod_anomaly_rate] + [cod_anomaly_rate / 8] * 8)
    courier = rng.choice(COURIERS, size=n, p=COURIER_WEIGHTS)
    base = np.array([COURIER_BASE_CHARGE_CENTS[c] for c in courier], dtype=np.int64)
    charge = np.round(base * rng.uniform(0.9, 1.2, size=n)).astype(np.int64)

    booked = ordered_at + _seconds(rng.integers(2 * 3600, 20 * 3600, size=n))
    booked = booked.where(booked <= now, now)
    delivered = booked + _seconds(rng.integers(86_400, 4 * 86_400, size=n))
    week_start = delivered.normalize() - pd.to_timedelta(delivered.weekday, unit="D")
    remitted = week_start + pd.Timedelta(days=9, hours=10)  # Wednesday of the following week

    # Plant an anomaly only where the reconciliation can see it on the run date (1-day safety margin).
    margin = pd.Timedelta(days=1)
    is_delivered = delivered <= now
    is_remitted = remitted <= now
    eligible = {
        C_NOT_REMITTED: is_delivered & (delivered <= now - pd.Timedelta(days=settings.COD_REMITTANCE_SLA_DAYS) - margin),
        C_SHORT_REMIT: is_remitted,
        C_RIDER_SHORT: is_remitted & (order_cents > 2_000),
        C_OVERCHARGE: is_delivered,
        C_RETURN_BOOKED: is_delivered,
        C_LOST: np.ones(n, dtype=bool),
        C_UNTRACKED: ordered_at <= now - pd.Timedelta(days=settings.COD_DISPATCH_SLA_DAYS) - margin,
        C_ORPHAN_PARCEL: is_delivered,
    }
    for label, ok in eligible.items():
        labels[(labels == label) & ~np.asarray(ok)] = C_NORMAL

    normal_return = (labels == C_NORMAL) & (rng.random(n) < return_rate)
    status = np.where(is_delivered, "DELIVERED", "IN_TRANSIT").astype(object)
    status[normal_return | (labels == C_RETURN_BOOKED)] = np.where(
        is_delivered[normal_return | (labels == C_RETURN_BOOKED)], "RETURNED", "IN_TRANSIT")
    lost = labels == C_LOST
    stuck = lost & (rng.random(n) < 0.5) & (booked <= now - pd.Timedelta(days=settings.PARCEL_STUCK_DAYS) - margin)
    status[lost] = "LOST"
    status[stuck] = "IN_TRANSIT"

    charge[labels == C_OVERCHARGE] = base[labels == C_OVERCHARGE] * 3
    cod = order_cents.copy()
    rider_short = labels == C_RIDER_SHORT
    shortfall = np.minimum(rng.integers(300, 2_000, size=n), order_cents // 2)
    cod[rider_short] -= shortfall[rider_short]

    delivered_mask = status == "DELIVERED"
    finished = delivered_mask | (status == "RETURNED")
    cod = np.where(delivered_mask, cod, 0)
    charge = np.where(finished, charge, 0)
    net = cod - charge
    deduction = np.minimum(rng.integers(200, 1_500, size=n), np.maximum(net, 0))
    net[labels == C_SHORT_REMIT] -= deduction[labels == C_SHORT_REMIT]

    remit_ok = delivered_mask & np.asarray(is_remitted) & (labels != C_NOT_REMITTED)
    iso = delivered.isocalendar()
    refs = np.array([f"CPR-{c}-{run_token}-{y}{w:02d}" for c, y, w in zip(courier, iso.year, iso.week)], dtype=object)

    parcels = pd.DataFrame({
        "tracking_number": [f"{c[:3]}{run_token}{tracking_offset + i:08d}" for i, c in enumerate(courier)],
        "source_order_number": cod_numbers,
        "courier_name": courier,
        "parcel_status": status,
        "cod_cents": cod,
        "charge_cents": charge,
        "net_cents": np.where(remit_ok, net, 0),
        "remittance_reference": np.where(remit_ok, refs, None),
        "booked_at": pd.Series(booked),
        "delivered_at": pd.Series(delivered).where(finished),
        "remitted_at": pd.Series(remitted).where(remit_ok),
    })
    parcels = parcels[labels != C_UNTRACKED].reset_index(drop=True)
    order_in_erp = ~(normal_return | (labels == C_ORPHAN_PARCEL))
    return parcels, labels, order_in_erp


def generate_batch(
    rng: np.random.Generator,
    start_index: int,
    size: int,
    run_token: str,
    currency: str,
    now: pd.Timestamp,
    args: argparse.Namespace,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, np.ndarray, np.ndarray]:
    """Build one iteration of orders, gateway captures and courier parcels with weighted anomalies."""
    split = args.anomaly_rate / 3
    weights = [1 - args.anomaly_rate - args.fx_noise_rate, split, split, split, args.fx_noise_rate]
    labels = rng.choice(5, size=size, p=weights)
    is_cod = rng.random(size) < args.cod_share
    labels[is_cod] = NORMAL  # gateway anomalies only apply to prepaid orders

    numbers = np.array([f"SO-{run_token}-{start_index + i:08d}" for i in range(size)])
    amount_cents = np.clip(np.round(rng.lognormal(mean=4.4, sigma=0.75, size=size) * 100), 1200, 2_500_000).astype(np.int64)
    ordered_at = now - _seconds(rng.integers(0, 90 * 24 * 3600, size=size))
    processed_at = ordered_at + _seconds(rng.integers(5, 1800, size=size))

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
    payout_refs = np.array([f"po_{run_token}_{d}" for d in processed_at.strftime("%Y%m%d")])

    cod_idx = np.flatnonzero(is_cod)
    parcels, cod_labels, cod_in_erp = generate_parcels(
        rng, numbers[cod_idx], amount_cents[cod_idx], ordered_at[cod_idx], start_index, run_token, now,
        args.cod_anomaly_rate, args.return_rate,
    )

    has_order = labels != ORPHAN_PAYMENT
    has_order[cod_idx] = cod_in_erp
    has_payment = (labels != MISSING_PAYMENT) & ~is_cod

    orders = pd.DataFrame({
        "source_order_number": numbers[has_order],
        "total_cents": amount_cents[has_order],
        "currency": currency,
        "ordered_at": ordered_at[has_order],
        "payment_method": np.where(is_cod, "COD", "PREPAID")[has_order],
    })
    gateway = pd.DataFrame({
        "source_order_number": numbers[has_payment],
        "source_transaction_id": txn_ids[has_payment],
        "gross_cents": gross_cents[has_payment],
        "net_cents": net_cents[has_payment],
        "fee_cents": fee_cents[has_payment],
        "processed_at": processed_at[has_payment],
        "payout_reference": payout_refs[has_payment],
    })
    return orders, gateway, parcels, labels, cod_labels


def accumulate_settlements(book: Dict[str, Settlement], gateway: pd.DataFrame, parcels: pd.DataFrame) -> None:
    for ref, grp in gateway.groupby("payout_reference"):
        book.setdefault(ref, Settlement("GATEWAY_PAYOUT", "STRIPE")).add(grp["net_cents"].sum(), grp["processed_at"].max())
    remitted = parcels[parcels["remittance_reference"].notna()]
    for ref, grp in remitted.groupby("remittance_reference"):
        book.setdefault(ref, Settlement("COURIER_REMITTANCE", grp["courier_name"].iloc[0])).add(
            grp["net_cents"].sum(), pd.Timestamp(grp["remitted_at"].max()))


def build_bank_statement(
    rng: np.random.Generator, book: Dict[str, Settlement], run_token: str, now: pd.Timestamp,
    start: pd.Timestamp, anomaly_rate: float, stats: SeedStats,
) -> pd.DataFrame:
    """One credit per landed settlement batch (with planted anomalies) plus ordinary operating noise."""
    lines: List[Dict[str, Any]] = []
    lag = pd.Timedelta(days=settings.SETTLEMENT_LAG_DAYS + 1)
    for ref, batch in sorted(book.items(), key=lambda kv: kv[1].closed_at):
        hop = pd.Timedelta(days=2) if batch.kind == "GATEWAY_PAYOUT" else pd.Timedelta(days=1)
        landed_at = batch.closed_at.normalize() + hop + pd.Timedelta(hours=9)
        if landed_at > now:
            continue
        label = B_NORMAL
        if batch.closed_at + lag <= now and rng.random() < anomaly_rate:
            label = int(rng.integers(1, 5))
        if label == B_MISSING:
            stats.bank_anomalies[BANK_ANOMALY_NAMES[label]] += 1
            continue
        amount = batch.cents
        if label == B_BANK_CHARGE:
            amount -= int(min(max(round(batch.cents * 0.003), 60), 2_500))
        elif label == B_SHORT:
            amount -= int(round(batch.cents * rng.uniform(0.05, 0.15)))
        if label != B_NORMAL:
            stats.bank_anomalies[BANK_ANOMALY_NAMES[label]] += 1
        party = batch.party
        if batch.kind == "GATEWAY_PAYOUT":
            narration = f"{party} PAYOUT {ref}"
        else:
            narration = f"IBFT {party} COD REMITTANCE {ref}"
        if label == B_NORMAL and rng.random() < 0.15:
            narration = f"{party} PAYOUT TRANSFER" if batch.kind == "GATEWAY_PAYOUT" else f"IBFT {party} EXPRESS"
        lines.append({"transaction_date": landed_at, "description": narration, "amount_cents": amount})
        if label == B_UNMATCHED:
            lines.append({
                "transaction_date": landed_at + pd.Timedelta(hours=2),
                "description": f"{party} SETTLEMENT ADJ {rng.integers(10**6, 10**7)}",
                "amount_cents": int(rng.integers(5_000, 200_000)),
            })

    day = start.normalize()
    while day <= now:
        if day.day == 1:
            lines.append({"transaction_date": day + pd.Timedelta(hours=11), "description": "OFFICE RENT DHA PHASE 6",
                          "amount_cents": -int(rng.integers(150_000, 250_000))})
            lines.append({"transaction_date": day + pd.Timedelta(hours=12), "description": "SALARY TRANSFER BATCH",
                          "amount_cents": -int(rng.integers(800_000, 1_200_000))})
            lines.append({"transaction_date": day + pd.Timedelta(hours=16), "description": "PROFIT ON DEPOSIT",
                          "amount_cents": int(rng.integers(1_000, 5_000))})
        if day.weekday() == 4:
            lines.append({"transaction_date": day + pd.Timedelta(hours=15), "description": "1LINK FUNDS TRANSFER SUPPLIER",
                          "amount_cents": -int(rng.integers(50_000, 400_000))})
        day += pd.Timedelta(days=1)
    lines.append({"transaction_date": now - pd.Timedelta(hours=1), "description": "ATM CASH WITHDRAWAL",
                  "amount_cents": -20_000})

    statement = pd.DataFrame(lines).sort_values("transaction_date").reset_index(drop=True)
    statement["bank_reference"] = [f"BNK{run_token}{i:07d}" for i in range(len(statement))]
    statement["bank_account"] = "HBL-0042-COLLECTIONS"
    return statement


def _cents(series: pd.Series) -> pd.Series:
    return series.map(lambda c: f"{'-' if c < 0 else ''}{abs(int(c)) // 100}.{abs(int(c)) % 100:02d}")


def _iso(series: pd.Series) -> pd.Series:
    return pd.Series(pd.to_datetime(series, utc=True)).dt.strftime("%Y-%m-%dT%H:%M:%S%z").fillna("")


def _copy(cur: Any, table: str, frame: pd.DataFrame) -> None:
    if frame.empty:
        return
    buffer = io.StringIO()
    frame.to_csv(buffer, index=False, header=False)
    buffer.seek(0)
    cur.copy_expert(f"COPY {table} ({', '.join(frame.columns)}) FROM STDIN WITH (FORMAT csv, NULL '')", buffer)


def copy_batch(org_id: UUID, orders: pd.DataFrame, gateway: pd.DataFrame, parcels: pd.DataFrame) -> None:
    org = str(org_id)
    raw = engine.raw_connection()
    try:
        with raw.cursor() as cur:
            _copy(cur, "ecom_orders", pd.DataFrame({
                "org_id": org,
                "source_order_number": orders["source_order_number"],
                "total_amount": _cents(orders["total_cents"]),
                "currency": orders["currency"],
                "ordered_at": _iso(orders["ordered_at"]),
                "payment_method": orders["payment_method"],
            }))
            _copy(cur, "gateway_transactions", pd.DataFrame({
                "org_id": org,
                "source_order_number": gateway["source_order_number"],
                "source_transaction_id": gateway["source_transaction_id"],
                "gross_amount": _cents(gateway["gross_cents"]),
                "net_amount": _cents(gateway["net_cents"]),
                "fee_amount": _cents(gateway["fee_cents"]),
                "processed_at": _iso(gateway["processed_at"]),
                "payout_reference": gateway["payout_reference"],
            }))
            _copy(cur, "courier_remittances", pd.DataFrame({
                "org_id": org,
                "tracking_number": parcels["tracking_number"],
                "source_order_number": parcels["source_order_number"],
                "courier_name": parcels["courier_name"],
                "parcel_status": parcels["parcel_status"],
                "cod_amount": _cents(parcels["cod_cents"]),
                "delivery_charges": _cents(parcels["charge_cents"]),
                "net_remitted": _cents(parcels["net_cents"]),
                "remittance_reference": parcels["remittance_reference"],
                "booked_at": _iso(parcels["booked_at"]),
                "delivered_at": _iso(parcels["delivered_at"]),
                "remitted_at": _iso(parcels["remitted_at"]),
            }))
        raw.commit()
    except Exception:
        raw.rollback()
        raise
    finally:
        raw.close()


def copy_bank(org_id: UUID, statement: pd.DataFrame) -> None:
    raw = engine.raw_connection()
    try:
        with raw.cursor() as cur:
            _copy(cur, "bank_transactions", pd.DataFrame({
                "org_id": str(org_id),
                "bank_account": statement["bank_account"],
                "transaction_date": _iso(statement["transaction_date"]),
                "description": statement["description"],
                "amount": _cents(statement["amount_cents"]),
                "bank_reference": statement["bank_reference"],
            }))
        raw.commit()
    except Exception:
        raw.rollback()
        raise
    finally:
        raw.close()


def _local_date(series: pd.Series, fmt: str) -> pd.Series:
    return pd.Series(pd.to_datetime(series, utc=True)).dt.strftime(fmt).fillna("")


def export_dirty_csv(directory: str, orders: pd.DataFrame, gateway: pd.DataFrame, parcels: pd.DataFrame,
                     currency: str, first: bool) -> None:
    """Write SAP / gateway / courier style exports with dirty formatting to exercise the parser."""
    os.makedirs(directory, exist_ok=True)
    symbol = CURRENCY_SYMBOLS.get(currency, f"{currency} ")
    sap = pd.DataFrame({
        "Sales Document": orders["source_order_number"],
        "Net Value": orders["total_cents"].map(lambda c: f"{symbol}{c / 100:,.2f}"),
        "Doc. Currency": orders["currency"],
        "Created On": orders["ordered_at"].dt.strftime("%d.%m.%Y %H:%M:%S"),
        "Payment Method": orders["payment_method"].map({"COD": "Cash on Delivery", "PREPAID": "Card"}),
    })
    gw = pd.DataFrame({
        "Merchant Reference": gateway["source_order_number"].map(lambda s: f" {s} "),
        "Charge ID": gateway["source_transaction_id"],
        "Gross Amount": gateway["gross_cents"].map(lambda c: f"{c / 100:,.2f}"),
        "Net Payout": gateway["net_cents"].map(lambda c: f"{symbol}{c / 100:,.2f}"),
        "Processing Fee": gateway["fee_cents"].map(lambda c: f"({c / 100:.2f})"),
        "Captured At": gateway["processed_at"].dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "Payout ID": gateway["payout_reference"],
    })
    courier = pd.DataFrame({
        "Tracking #": parcels["tracking_number"],
        "Order Ref": parcels["source_order_number"],
        "Courier": parcels["courier_name"].str.title(),
        "Status": parcels["parcel_status"].map(STATUS_WORDING),
        "COD Amount": parcels["cod_cents"].map(lambda c: f"{symbol}{c / 100:,.2f}"),
        "Delivery Charges": parcels["charge_cents"].map(lambda c: f"{c / 100:,.2f}"),
        "Net Payable": parcels["net_cents"].map(lambda c: f"{c / 100:,.2f}"),
        "CPR No": parcels["remittance_reference"].fillna(""),
        "Booking Date": _local_date(parcels["booked_at"], "%d-%m-%Y %H:%M"),
        "Delivery Date": _local_date(parcels["delivered_at"], "%d-%m-%Y %H:%M"),
        "Payment Date": _local_date(parcels["remitted_at"], "%d-%m-%Y %H:%M"),
    })
    mode = "w" if first else "a"
    sap.to_csv(os.path.join(directory, "sap_sales_orders.csv"), index=False, header=first, mode=mode)
    gw.to_csv(os.path.join(directory, "gateway_settlements.csv"), index=False, header=first, mode=mode)
    courier.to_csv(os.path.join(directory, "courier_cod_report.csv"), index=False, header=first, mode=mode)


def export_bank_csv(directory: str, statement: pd.DataFrame) -> None:
    amounts = statement["amount_cents"]
    pd.DataFrame({
        "Value Date": statement["transaction_date"].dt.strftime("%d/%m/%Y"),
        "Narration": statement["description"],
        "Debit": amounts.map(lambda c: f"{-c / 100:,.2f}" if c < 0 else ""),
        "Credit": amounts.map(lambda c: f"{c / 100:,.2f}" if c > 0 else ""),
        "Ref No": statement["bank_reference"],
        "Account": statement["bank_account"],
    }).to_csv(os.path.join(directory, "bank_statement.csv"), index=False)


def run(args: argparse.Namespace) -> SeedStats:
    init_db()
    if args.anomaly_rate + args.fx_noise_rate >= 1:
        raise SystemExit("anomaly-rate + fx-noise-rate must be < 1")
    rng = np.random.default_rng(args.seed)
    now = pd.Timestamp(datetime.now(timezone.utc).replace(microsecond=0))
    run_token = now.strftime("%y%m%d%H%M%S")
    org_id, created_user = ensure_tenant(args.company_name, args.currency.upper(), args.org_id, args.email, args.password)
    stats = SeedStats()
    settlements: Dict[str, Settlement] = {}
    started = time.perf_counter()

    iterations = (args.orders + args.batch_size - 1) // args.batch_size
    for iteration in range(iterations):
        size = min(args.batch_size, args.orders - iteration * args.batch_size)
        orders, gateway, parcels, labels, cod_labels = generate_batch(
            rng, iteration * args.batch_size, size, run_token, args.currency.upper(), now, args,
        )
        accumulate_settlements(settlements, gateway, parcels)
        if not args.export_only:
            copy_batch(org_id, orders, gateway, parcels)
        if args.export_csv:
            export_dirty_csv(args.export_csv, orders, gateway, parcels, args.currency.upper(), first=iteration == 0)

        stats.orders += len(orders)
        stats.cod_orders += int((orders["payment_method"] == "COD").sum())
        stats.gateway_transactions += len(gateway)
        stats.parcels += len(parcels)
        stats.anomalies["missing_payment"] += int((labels == MISSING_PAYMENT).sum())
        stats.anomalies["orphan_gateway_payment"] += int((labels == ORPHAN_PAYMENT).sum())
        stats.anomalies["promo_mismatch_5usd"] += int((labels == PROMO_MISMATCH).sum())
        stats.anomalies["fx_micro_variance"] += int((labels == FX_NOISE).sum())
        for label, name in COD_ANOMALY_NAMES.items():
            stats.cod_anomalies[name] += int((cod_labels == label).sum())
        print(f"  iteration {iteration + 1}/{iterations}: {len(orders)} orders, {len(gateway)} captures, "
              f"{len(parcels)} parcels")

    statement = build_bank_statement(rng, settlements, run_token, now, now - pd.Timedelta(days=90),
                                     args.bank_anomaly_rate, stats)
    stats.bank_lines = len(statement)
    if not args.export_only:
        copy_bank(org_id, statement)
    if args.export_csv:
        export_bank_csv(args.export_csv, statement)

    elapsed = time.perf_counter() - started
    total_anomalies = sum(stats.anomalies.values())
    prepaid = max(args.orders - stats.cod_orders, 1)
    print("\nAuditX seed complete")
    print(f"  org_id               : {org_id}")
    print(f"  orders (COD)         : {stats.orders:,} ({stats.cod_orders:,} COD)")
    print(f"  captures / parcels   : {stats.gateway_transactions:,} / {stats.parcels:,}")
    print(f"  bank statement lines : {stats.bank_lines:,} ({len(settlements):,} settlement batches)")
    print(f"  gateway anomalies    : {total_anomalies:,} (~{total_anomalies / prepaid:.2%} of prepaid) {stats.anomalies}")
    print(f"  COD anomalies        : {sum(stats.cod_anomalies.values()):,} {stats.cod_anomalies}")
    print(f"  bank anomalies       : {sum(stats.bank_anomalies.values()):,} {stats.bank_anomalies}")
    print(f"  elapsed              : {elapsed:.2f}s")
    if created_user:
        print(f"  login (maker/owner)  : {args.email} / {args.password}")
        print(f"  login (checker)      : {checker_email(args.email)} / {args.password}  (AUDITOR)")
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
    parser.add_argument("--anomaly-rate", type=float, default=0.05, help="Share of prepaid orders with a gateway break")
    parser.add_argument("--fx-noise-rate", type=float, default=0.0, help="Extra share with sub-$0.50 FX variance")
    parser.add_argument("--cod-share", type=float, default=0.35, help="Share of orders paid cash on delivery")
    parser.add_argument("--cod-anomaly-rate", type=float, default=0.05, help="Share of COD orders with a courier break")
    parser.add_argument("--return-rate", type=float, default=0.06, help="Share of COD parcels returned (and cancelled)")
    parser.add_argument("--bank-anomaly-rate", type=float, default=0.05, help="Share of settlement batches with a bank break")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed for reproducible datasets")
    parser.add_argument("--company-name", default="Northwind Commerce Ltd")
    parser.add_argument("--currency", default="USD")
    parser.add_argument("--email", default=DEMO_EMAIL, help="Owner login created for the seeded org")
    parser.add_argument("--password", default=DEMO_PASSWORD, help="Password for --email")
    parser.add_argument("--org-id", default=None, help="Seed into an existing organization instead of creating one")
    parser.add_argument("--export-csv", default=None, help="Directory to also write dirty SAP/gateway/courier/bank CSVs")
    parser.add_argument("--export-only", action="store_true", help="Only write CSVs; skip direct DB inserts")
    parser.add_argument("--reconcile", action="store_true", help="Run reconciliation + auto-healer after seeding")
    return parser


if __name__ == "__main__":
    run(build_parser().parse_args())
