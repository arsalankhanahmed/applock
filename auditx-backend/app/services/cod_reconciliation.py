"""COD leg: cash-on-delivery orders <-> courier parcel reports (TCS, Leopards, PostEx, Trax, ...).

Per order the courier report tells us whether the parcel was delivered, returned, lost or is still moving,
how much cash the rider collected, what the courier charged and what was remitted. Breaks:

  COD_PARCEL_UNTRACKED      COD order never handed to a courier (older than COD_DISPATCH_SLA_DAYS)
  COD_ORDER_NOT_BOOKED      courier delivered and collected cash for an order the ERP doesn't have
  COD_NOT_REMITTED          delivered, cash collected, no remittance after COD_REMITTANCE_SLA_DAYS
  COD_REMITTANCE_SHORTFALL  remitted less than order total minus charges (short collection or deduction)
  COURIER_OVERCHARGE        charge above COURIER_OVERCHARGE_RATIO x that courier's median charge
  RETURNED_ORDER_BOOKED     parcel returned but the ERP still carries the sale
  PARCEL_LOST_OR_STUCK      parcel lost, or in transit longer than PARCEL_STUCK_DAYS

"Now" is the latest date in the tenant's own data, so results don't drift with the wall clock.
variance = expected - received, in integer cents; positive means money the brand is owed.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict, Tuple
from uuid import UUID

import numpy as np
import pandas as pd
from sqlalchemy import text

from app.config import settings
from app.database import engine

FINDING_COLUMNS = ["source_order_number", "issue_type", "channel", "order_cents", "gateway_cents", "variance_cents"]
STATUS_PRIORITY = {"DELIVERED": 0, "RETURNED": 1, "LOST": 2, "IN_TRANSIT": 3}

ORDERS_SQL = text(
    """
    SELECT source_order_number,
           ROUND(SUM(total_amount) * 100)::bigint AS order_cents,
           MAX(ordered_at)                        AS ordered_at,
           bool_or(payment_method = 'COD')        AS is_cod
      FROM ecom_orders
     WHERE org_id = :org_id
     GROUP BY source_order_number
    """
)

PARCELS_SQL = text(
    """
    SELECT source_order_number,
           courier_name,
           parcel_status,
           ROUND(cod_amount * 100)::bigint       AS cod_cents,
           ROUND(delivery_charges * 100)::bigint AS charge_cents,
           ROUND(net_remitted * 100)::bigint     AS net_cents,
           remittance_reference,
           booked_at,
           delivered_at,
           remitted_at
      FROM courier_remittances
     WHERE org_id = :org_id
    """
)


def _empty() -> pd.DataFrame:
    return pd.DataFrame(columns=FINDING_COLUMNS)


def _finding(frame: pd.DataFrame, issue: str, expected: pd.Series, received: pd.Series) -> pd.DataFrame:
    expected = pd.Series(expected, index=frame.index).astype("Int64")
    received = pd.Series(received, index=frame.index).astype("Int64")
    return pd.DataFrame({
        "source_order_number": frame["source_order_number"].to_numpy(),
        "issue_type": issue,
        "channel": "COD",
        "order_cents": expected.to_numpy(),
        "gateway_cents": received.to_numpy(),
        "variance_cents": (expected.fillna(0) - received.fillna(0)).astype("int64").to_numpy(),
    })


def aggregate_parcels(parcels: pd.DataFrame) -> pd.DataFrame:
    """One row per order: the most advanced status wins (delivered > returned > lost > in transit)."""
    parcels = parcels.copy()
    parcels["_rank"] = parcels["parcel_status"].map(STATUS_PRIORITY).fillna(3)
    delivered = parcels["parcel_status"] == "DELIVERED"
    parcels["delivered_cod"] = parcels["cod_cents"].where(delivered, 0)
    parcels["delivered_charge"] = parcels["charge_cents"].where(delivered, 0)
    parcels["unremitted"] = delivered & parcels["remittance_reference"].isna()
    parcels = parcels.sort_values("_rank")
    return parcels.groupby("source_order_number", sort=False).agg(
        courier_name=("courier_name", "first"),
        parcel_status=("parcel_status", "first"),
        cod_cents=("delivered_cod", "sum"),
        charge_cents=("delivered_charge", "sum"),
        net_cents=("net_cents", "sum"),
        unremitted=("unremitted", "any"),
        booked_at=("booked_at", "min"),
        delivered_at=("delivered_at", "max"),
    ).reset_index()


def reconcile_cod(org_id: UUID) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    params = {"org_id": str(org_id)}
    with engine.connect() as conn:
        orders = pd.read_sql(ORDERS_SQL, conn, params=params)
        parcels = pd.read_sql(PARCELS_SQL, conn, params=params)

    cod_orders = int(orders["is_cod"].sum()) if not orders.empty else 0
    summary: Dict[str, Any] = {"cod_orders": cod_orders, "parcels": int(len(parcels))}
    if parcels.empty:
        summary["skipped"] = "no courier report uploaded"
        return _empty(), summary

    for col in ("booked_at", "delivered_at", "remitted_at"):
        parcels[col] = pd.to_datetime(parcels[col], utc=True)
    orders["ordered_at"] = pd.to_datetime(orders["ordered_at"], utc=True)
    as_of = pd.concat([parcels["booked_at"], parcels["delivered_at"], parcels["remitted_at"]]).max()
    summary["as_of"] = as_of.isoformat() if pd.notna(as_of) else None

    per_order = aggregate_parcels(parcels)
    merged = per_order.merge(orders, on="source_order_number", how="left")
    merged["in_erp"] = merged["order_cents"].notna()
    merged["is_cod"] = merged["is_cod"].astype("boolean").fillna(False).astype(bool)
    status = merged["parcel_status"]
    findings = []

    # COD orders the courier has never seen.
    untracked = orders[orders["is_cod"] & ~orders["source_order_number"].isin(per_order["source_order_number"])]
    untracked = untracked[untracked["ordered_at"] <= as_of - timedelta(days=settings.COD_DISPATCH_SLA_DAYS)]
    if not untracked.empty:
        findings.append(_finding(untracked, "COD_PARCEL_UNTRACKED", untracked["order_cents"], 0))

    not_booked = merged[(status == "DELIVERED") & ~merged["in_erp"] & (merged["cod_cents"] > 0)]
    if not not_booked.empty:
        findings.append(_finding(not_booked, "COD_ORDER_NOT_BOOKED", 0, not_booked["cod_cents"]))

    cod = merged[merged["in_erp"] & merged["is_cod"]]
    cod_status = cod["parcel_status"]

    returned = cod[cod_status == "RETURNED"]
    if not returned.empty:
        findings.append(_finding(returned, "RETURNED_ORDER_BOOKED", returned["order_cents"], 0))

    stuck_cutoff = as_of - timedelta(days=settings.PARCEL_STUCK_DAYS)
    lost = cod[(cod_status == "LOST") | ((cod_status == "IN_TRANSIT") & (cod["booked_at"] <= stuck_cutoff))]
    if not lost.empty:
        findings.append(_finding(lost, "PARCEL_LOST_OR_STUCK", lost["order_cents"], 0))

    delivered = cod[cod_status == "DELIVERED"]
    overdue_cutoff = as_of - timedelta(days=settings.COD_REMITTANCE_SLA_DAYS)
    overdue = delivered[delivered["unremitted"] & (delivered["delivered_at"] <= overdue_cutoff)]
    if not overdue.empty:
        findings.append(_finding(overdue, "COD_NOT_REMITTED",
                                 overdue["cod_cents"] - overdue["charge_cents"], 0))

    remitted = delivered[~delivered["unremitted"]]
    expected_net = remitted["order_cents"] - remitted["charge_cents"]
    short = remitted[expected_net - remitted["net_cents"] > settings.RECON_MATCH_TOLERANCE_CENTS]
    if not short.empty:
        findings.append(_finding(short, "COD_REMITTANCE_SHORTFALL",
                                 short["order_cents"] - short["charge_cents"], short["net_cents"]))

    # Overcharges are judged against each courier's own median charge across delivered parcels.
    medians = delivered.groupby("courier_name")["charge_cents"].transform("median")
    ratio = settings.COURIER_OVERCHARGE_RATIO
    over = delivered[(delivered["charge_cents"] > medians * ratio) & (delivered["charge_cents"] - medians >= 100)]
    if not over.empty:
        fair = np.round(medians[over.index]).astype("int64")
        findings.append(_finding(over, "COURIER_OVERCHARGE",
                                 over["cod_cents"] - fair, over["cod_cents"] - over["charge_cents"]))

    summary.update({
        "delivered": int((status == "DELIVERED").sum()),
        "returned": int((status == "RETURNED").sum()),
        "remittance_pending_within_sla": int(
            (delivered["unremitted"] & (delivered["delivered_at"] > overdue_cutoff)).sum()
        ),
    })
    result = pd.concat(findings, ignore_index=True) if findings else _empty()
    return result, summary
