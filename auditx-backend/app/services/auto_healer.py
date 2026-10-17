"""AI Auto-Healer (Feature 1).

Evaluates every open discrepancy for a tenant against a deterministic forensic rule-book, enriched
with (simulated) raw gateway API log metadata, settlement-batch context (bank leg) and courier parcel
records (COD leg). High-confidence, low-risk patterns are resolved
autonomously (`auto_resolved = TRUE`); everything else receives a ranked root-cause hypothesis and a
machine-readable fix proposal (`ai_suggested_fix` JSONB) for a human reviewer.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

import pandas as pd
from psycopg2.extras import execute_values
from sqlalchemy import text

from app.database import engine

logger = logging.getLogger("auditx.auto_healer")

MICRO_VARIANCE_CENTS = 50
PROMO_VARIANCE_CENTS = 500
FRAUD_RATIO_THRESHOLD = 0.20

OPEN_LOGS_SQL = text(
    """
    SELECT log_id::text AS log_id,
           source_order_number,
           issue_type,
           channel,
           ROUND(order_amount * 100)::bigint    AS order_cents,
           ROUND(gateway_amount * 100)::bigint  AS gateway_cents,
           ROUND(variance_amount * 100)::bigint AS variance_cents
      FROM discrepancy_logs
     WHERE org_id = :org_id
       AND status = 'UNRESOLVED'
    """
)

GATEWAY_DETAIL_SQL = text(
    """
    SELECT source_order_number,
           source_transaction_id,
           ROUND(gross_amount * 100)::bigint AS gross_cents,
           ROUND(fee_amount * 100)::bigint   AS fee_cents,
           processed_at
      FROM gateway_transactions
     WHERE org_id = :org_id
       AND source_order_number = ANY(:order_numbers)
    """
)

ORG_SQL = text("SELECT brand_currency FROM organizations WHERE org_id = :org_id")

SETTLEMENT_CTX_SQL = text(
    """
    SELECT payout_reference AS reference, 'GATEWAY_PAYOUT' AS source, NULL::text AS counterparty,
           COUNT(*)::int AS items, MAX(processed_at) AS closed_at
      FROM gateway_transactions
     WHERE org_id = :org_id AND payout_reference = ANY(:refs)
     GROUP BY payout_reference
    UNION ALL
    SELECT remittance_reference, 'COURIER_REMITTANCE', MIN(courier_name),
           COUNT(*)::int, MAX(COALESCE(remitted_at, delivered_at))
      FROM courier_remittances
     WHERE org_id = :org_id AND remittance_reference = ANY(:refs)
     GROUP BY remittance_reference
    """
)

CREDIT_CTX_SQL = text(
    """
    SELECT bank_reference, description, transaction_date, bank_account
      FROM bank_transactions
     WHERE org_id = :org_id AND bank_reference = ANY(:refs)
    """
)

PARCEL_CTX_SQL = text(
    """
    SELECT DISTINCT ON (source_order_number)
           source_order_number, tracking_number, courier_name, parcel_status,
           ROUND(cod_amount * 100)::bigint       AS cod_cents,
           ROUND(delivery_charges * 100)::bigint AS charge_cents,
           ROUND(net_remitted * 100)::bigint     AS net_cents,
           remittance_reference, booked_at, delivered_at
      FROM courier_remittances
     WHERE org_id = :org_id AND source_order_number = ANY(:refs)
     ORDER BY source_order_number,
              CASE parcel_status WHEN 'DELIVERED' THEN 0 WHEN 'RETURNED' THEN 1 WHEN 'LOST' THEN 2 ELSE 3 END
    """
)

COURIER_MEDIAN_SQL = text(
    """
    SELECT courier_name,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY delivery_charges) * 100)::bigint AS median_cents
      FROM courier_remittances
     WHERE org_id = :org_id AND parcel_status = 'DELIVERED'
     GROUP BY courier_name
    """
)

AS_OF_SQL = text(
    """
    SELECT GREATEST(
             (SELECT MAX(GREATEST(booked_at, delivered_at, remitted_at)) FROM courier_remittances WHERE org_id = :org_id),
             (SELECT MAX(transaction_date) FROM bank_transactions WHERE org_id = :org_id))
    """
)

BANK_CHARGE_MAX_RATIO = 0.005
BANK_CHARGE_MAX_CENTS = 2_500
OVERDUE_ESCALATION_DAYS = 30


@dataclass
class Verdict:
    category: str
    confidence: float
    auto_resolve: bool
    fix: Dict[str, Any]


def _money(cents: Optional[int]) -> Optional[float]:
    return None if cents is None else round(cents / 100, 2)


def _normalise_order_ref(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]", "", value).upper()
    match = re.match(r"^([A-Z]*)(\d+)$", cleaned)
    if match:
        return f"{match.group(1)}{int(match.group(2))}"
    return cleaned


def _provider_from_txn(txn_id: str) -> str:
    prefixes = {"ch_": "stripe", "pi_": "stripe", "pay_": "razorpay", "PAYID-": "paypal", "adyen_": "adyen"}
    for prefix, provider in prefixes.items():
        if txn_id.startswith(prefix):
            return provider
    return "generic_gateway"


def simulate_gateway_api_logs(order_number: str, txns: List[Dict[str, Any]], brand_currency: str) -> Dict[str, Any]:
    """Reconstruct the raw webhook / API log trail a gateway would return for this order.

    Deterministic per order number so repeated healing runs produce identical evidence.
    """
    digest = hashlib.sha256(order_number.encode()).digest()
    presentment = ["EUR", "GBP", "CAD", "AED", "INR"][digest[0] % 5]
    fx_rate = round(0.7 + (digest[1] / 255) * 0.6, 6)
    events = []
    for txn in txns:
        captured_at = txn.get("processed_at")
        if isinstance(captured_at, pd.Timestamp):
            captured_at = captured_at.to_pydatetime()
        captured_at = captured_at or datetime.now(timezone.utc)
        events.append(
            {
                "id": f"evt_{hashlib.md5((txn['source_transaction_id'] + 'cap').encode()).hexdigest()[:16]}",
                "type": "charge.captured",
                "transaction_id": txn["source_transaction_id"],
                "provider": _provider_from_txn(txn["source_transaction_id"]),
                "amount": _money(txn["gross_cents"]),
                "fee": _money(txn["fee_cents"]),
                "settlement_currency": brand_currency,
                "presentment_currency": presentment,
                "fx_rate": fx_rate,
                "created": captured_at.isoformat(),
                "settled": (captured_at + timedelta(days=2)).isoformat(),
            }
        )
    return {
        "source": "gateway_api_log_replay",
        "order_reference": order_number,
        "event_count": len(events),
        "events": events,
        "discount_codes_seen": [f"SAVE5-{digest[2]:03d}"] if digest[3] % 2 == 0 else ["WELCOME5"],
    }


def _journal(debit_account: str, credit_account: str, amount_cents: int, memo: str) -> List[Dict[str, Any]]:
    amount = _money(abs(amount_cents))
    return [
        {"account": debit_account, "debit": amount, "credit": 0.0, "memo": memo},
        {"account": credit_account, "debit": 0.0, "credit": amount, "memo": memo},
    ]


def evaluate(row: Dict[str, Any], txns: List[Dict[str, Any]], brand_currency: str,
             drift_partner: Optional[Dict[str, Any]]) -> Verdict:
    """Apply the forensic rule-book to a single discrepancy."""
    issue = row["issue_type"]
    order_no = row["source_order_number"]
    variance = int(row["variance_cents"])
    order_cents = row["order_cents"]
    gateway_cents = row["gateway_cents"]
    evidence = simulate_gateway_api_logs(order_no, txns, brand_currency) if txns else None
    fee_cents = sum(int(t["fee_cents"]) for t in txns)

    if issue == "AMOUNT_MISMATCH":
        abs_var = abs(variance)
        if 0 < abs_var < MICRO_VARIANCE_CENTS:
            confidence = round(0.99 - (abs_var / MICRO_VARIANCE_CENTS) * 0.08, 4)
            return Verdict("FX_ROUNDING_ERROR", confidence, True, {
                "action": "POST_ADJUSTING_JOURNAL_ENTRY",
                "reason": "Sub-$0.50 delta consistent with presentment-to-settlement FX rounding.",
                "target_table": "general_ledger",
                "journal": _journal(
                    "7920-FX Rounding Differences" if variance > 0 else "1210-Gateway Clearing",
                    "1210-Gateway Clearing" if variance > 0 else "7920-FX Rounding Differences",
                    variance, f"FX rounding on order {order_no}"),
                "evidence": evidence,
            })
        if abs_var == PROMO_VARIANCE_CENTS and variance > 0:
            return Verdict("PROMO_CODE_UNSYNCED", 0.93, True, {
                "action": "PATCH_ORDER_TOTAL",
                "reason": "Exact $5.00 shortfall matches a checkout discount code that never synced to the ERP.",
                "target_table": "ecom_orders",
                "match": {"source_order_number": order_no},
                "transform": {"field": "total_amount", "from": _money(order_cents), "to": _money(gateway_cents)},
                "journal": _journal("4910-Sales Discounts", "1100-Accounts Receivable", variance,
                                    f"Unsynced promo on order {order_no}"),
                "evidence": evidence,
            })
        if abs_var == PROMO_VARIANCE_CENTS and variance < 0:
            return Verdict("SURCHARGE_UNBOOKED", 0.85, True, {
                "action": "PATCH_ORDER_TOTAL",
                "reason": "Exact $5.00 over-capture matches a flat shipping / handling surcharge missing in the ERP.",
                "target_table": "ecom_orders",
                "match": {"source_order_number": order_no},
                "transform": {"field": "total_amount", "from": _money(order_cents), "to": _money(gateway_cents)},
                "journal": _journal("1100-Accounts Receivable", "4300-Shipping Revenue", variance,
                                    f"Unbooked surcharge on order {order_no}"),
                "evidence": evidence,
            })
        if fee_cents and variance == -fee_cents:
            return Verdict("GATEWAY_FEE_NETTING", 0.9, True, {
                "action": "RECLASSIFY_NET_TO_GROSS",
                "reason": "ERP booked the net settlement instead of gross revenue; the delta equals the gateway fee.",
                "target_table": "ecom_orders",
                "match": {"source_order_number": order_no},
                "transform": {"field": "total_amount", "from": _money(order_cents), "to": _money(gateway_cents)},
                "journal": _journal("6150-Payment Processing Fees", "4000-Revenue", fee_cents,
                                    f"Gross-up gateway fee on order {order_no}"),
                "evidence": evidence,
            })
        if len(txns) > 1 and order_cents and gateway_cents == 2 * order_cents:
            return Verdict("DUPLICATE_CAPTURE", 0.88, False, {
                "action": "ISSUE_REFUND",
                "reason": "Customer charged twice for the same order; refund the duplicate capture.",
                "refund_transaction_id": txns[-1]["source_transaction_id"],
                "refund_amount": _money(order_cents),
                "evidence": evidence,
            })
        ratio = abs_var / order_cents if order_cents else 1.0
        if ratio >= FRAUD_RATIO_THRESHOLD:
            return Verdict("POTENTIAL_FRAUD_OR_MANIPULATION", 0.55, False, {
                "action": "ESCALATE_FORENSIC_REVIEW",
                "reason": f"Variance is {ratio:.0%} of the order value; exceeds the {FRAUD_RATIO_THRESHOLD:.0%} fraud threshold.",
                "priority": "HIGH",
                "evidence": evidence,
            })
        return Verdict("UNEXPLAINED_VARIANCE", 0.4, False, {
            "action": "MANUAL_FORENSIC_REVIEW",
            "reason": "Variance does not match any known healing pattern.",
            "priority": "MEDIUM",
            "evidence": evidence,
        })

    if drift_partner is not None:
        erp_ref = order_no if issue == "MISSING_PAYMENT" else drift_partner["source_order_number"]
        gw_ref = drift_partner["source_order_number"] if issue == "MISSING_PAYMENT" else order_no
        return Verdict("ORDER_ID_FORMAT_DRIFT", 0.95, True, {
            "action": "REMAP_ORDER_REFERENCE",
            "reason": "Gateway reference differs only in formatting (prefix / padding / case) from an ERP order with an identical amount.",
            "target_table": "gateway_transactions",
            "match": {"source_order_number": gw_ref},
            "transform": {"field": "source_order_number", "from": gw_ref, "to": erp_ref},
            "evidence": evidence,
        })

    if issue == "MISSING_PAYMENT":
        return Verdict("PAYMENT_NOT_CAPTURED", 0.6, False, {
            "action": "ESCALATE_TO_COLLECTIONS",
            "reason": "Order fulfilled in the ERP but no gateway capture exists for its reference.",
            "priority": "HIGH" if (order_cents or 0) >= 50_000 else "MEDIUM",
            "receivable_amount": _money(order_cents),
            "next_steps": [
                "Confirm fulfilment / shipment status",
                "Check gateway for failed or pending authorisations",
                "Raise invoice or void the order",
            ],
        })

    return Verdict("ORPHAN_GATEWAY_PAYMENT", 0.6, False, {
        "action": "CREATE_SHADOW_ORDER_FOR_REVIEW",
        "reason": "Cash captured by the gateway with no corresponding ERP order (unbooked revenue or diversion risk).",
        "priority": "HIGH",
        "unbooked_amount": _money(gateway_cents),
        "evidence": evidence,
    })


def _plain(record: Dict[str, Any]) -> Dict[str, Any]:
    """JSON-safe copy of a pandas record (NaN / NaT -> None, numpy scalars -> Python, timestamps -> ISO)."""
    out: Dict[str, Any] = {}
    for key, value in record.items():
        if value is None or (not isinstance(value, str) and pd.isna(value)):
            out[key] = None
        elif isinstance(value, (datetime, pd.Timestamp)):
            out[key] = value.isoformat()
        elif hasattr(value, "item"):
            out[key] = value.item()
        else:
            out[key] = value
    return out


def _days_since(moment: Any, as_of: Optional[datetime]) -> Optional[int]:
    if moment is None or as_of is None or pd.isna(moment):
        return None
    return max(0, (pd.Timestamp(as_of) - pd.Timestamp(moment)).days)


def evaluate_bank(row: Dict[str, Any], ctx: Dict[str, Any]) -> Verdict:
    """Bank leg: settlement batches vs statement credits."""
    issue = row["issue_type"]
    ref = row["source_order_number"]
    variance = int(row["variance_cents"])
    expected = row["order_cents"] or 0
    batch = ctx["settlements"].get(ref, {})
    source = batch.get("source", "SETTLEMENT")
    evidence = _plain(batch)

    if issue == "DEPOSIT_MISMATCH":
        if 0 < variance < MICRO_VARIANCE_CENTS:
            return Verdict("FX_ROUNDING_ERROR", 0.95, True, {
                "action": "POST_ADJUSTING_JOURNAL_ENTRY",
                "reason": "Sub-$0.50 gap between the settlement batch and the bank credit: conversion rounding.",
                "target_table": "general_ledger",
                "journal": _journal("7920-FX Rounding Differences", "1210-Settlement Clearing", variance,
                                    f"Rounding on settlement {ref}"),
                "evidence": evidence,
            })
        if variance > 0 and variance <= max(BANK_CHARGE_MAX_RATIO * expected, MICRO_VARIANCE_CENTS) \
                and variance <= BANK_CHARGE_MAX_CENTS:
            return Verdict("BANK_CHARGES_DEDUCTED", 0.88, True, {
                "action": "POST_ADJUSTING_JOURNAL_ENTRY",
                "reason": f"The bank credited {_money(variance)} less than the batch, within the "
                          f"{BANK_CHARGE_MAX_RATIO:.1%} band typical of inward-remittance charges.",
                "target_table": "general_ledger",
                "journal": _journal("6200-Bank Charges", "1210-Settlement Clearing", variance,
                                    f"Bank charges on settlement {ref}"),
                "evidence": evidence,
            })
        if variance < 0:
            return Verdict("SETTLEMENT_OVER_DEPOSIT", 0.6, False, {
                "action": "INVESTIGATE_OVER_DEPOSIT",
                "reason": "The bank received more than the batch: likely two batches paid together or a reversed refund.",
                "priority": "MEDIUM",
                "evidence": evidence,
            })
        return Verdict("UNEXPLAINED_SETTLEMENT_SHORTFALL", 0.5, False, {
            "action": "REQUEST_SETTLEMENT_STATEMENT",
            "reason": f"The bank credited {_money(variance)} less than the {source.lower().replace('_', ' ')} "
                      "and the gap is too large to be bank charges.",
            "priority": "HIGH",
            "evidence": evidence,
        })

    if issue == "SETTLEMENT_NOT_DEPOSITED":
        days = _days_since(batch.get("closed_at"), ctx["as_of"])
        if source == "COURIER_REMITTANCE":
            category, party = "COURIER_REMITTANCE_NOT_RECEIVED", batch.get("counterparty") or "the courier"
        else:
            category, party = "GATEWAY_PAYOUT_NOT_RECEIVED", "the payment gateway"
        return Verdict(category, 0.8, False, {
            "action": "REQUEST_PAYMENT_TRACE",
            "reason": f"{_money(expected)} reported as paid out by {party} never reached the bank statement.",
            "priority": "HIGH" if (days or 0) > OVERDUE_ESCALATION_DAYS else "MEDIUM",
            "days_outstanding": days,
            "batch_items": batch.get("items"),
            "next_steps": [
                f"Ask {party} for the payment trace / UTR of batch {ref}",
                "Check whether the payout went to a different bank account",
                "Book a receivable until the funds arrive",
            ],
            "evidence": evidence,
        })

    credit = ctx["credits"].get(ref, {})
    received = row["gateway_cents"] or 0
    return Verdict("UNIDENTIFIED_SETTLEMENT_CREDIT", 0.6, False, {
        "action": "ALLOCATE_OR_SUSPENSE",
        "reason": "A gateway / courier credit hit the bank but matches no reported payout or remittance.",
        "priority": "MEDIUM",
        "narration": credit.get("description"),
        "journal": _journal("1000-Bank", "2900-Suspense (Unidentified Receipts)", received,
                            f"Unidentified settlement credit {ref}"),
    })


def evaluate_cod(row: Dict[str, Any], ctx: Dict[str, Any]) -> Verdict:
    """COD leg: orders vs courier parcel records."""
    issue = row["issue_type"]
    order_no = row["source_order_number"]
    variance = int(row["variance_cents"])
    parcel = ctx["parcels"].get(order_no, {})
    courier = parcel.get("courier_name") or "the courier"
    evidence = _plain(parcel)

    if issue == "COD_PARCEL_UNTRACKED":
        return Verdict("COD_ORDER_NOT_DISPATCHED", 0.65, False, {
            "action": "VERIFY_DISPATCH",
            "reason": "COD order is past the dispatch window and no courier has a parcel for it.",
            "priority": "MEDIUM",
            "next_steps": ["Check the warehouse dispatch log", "Cancel the order if it was never shipped",
                           "If shipped, get the tracking number from the courier"],
        })
    if issue == "COD_ORDER_NOT_BOOKED":
        collected = row["gateway_cents"] or 0
        return Verdict("UNBOOKED_COD_SALE", 0.75, False, {
            "action": "CREATE_ORDER_IN_ERP",
            "reason": f"{courier} delivered and collected cash for an order the ERP does not have.",
            "priority": "HIGH",
            "journal": _journal("1150-Courier Receivable", "4000-Revenue", collected, f"Unbooked COD sale {order_no}"),
            "evidence": evidence,
        })
    if issue == "COD_NOT_REMITTED":
        days = _days_since(parcel.get("delivered_at"), ctx["as_of"])
        return Verdict("COURIER_REMITTANCE_OVERDUE", 0.85, False, {
            "action": "RAISE_COURIER_CLAIM",
            "reason": f"{courier} delivered the parcel {days} days ago and has not remitted the cash.",
            "priority": "HIGH" if (days or 0) > OVERDUE_ESCALATION_DAYS else "MEDIUM",
            "days_since_delivery": days,
            "claim_amount": _money(variance),
            "evidence": evidence,
        })
    if issue == "COD_REMITTANCE_SHORTFALL":
        order_total = (row["order_cents"] or 0) + int(parcel.get("charge_cents") or 0)
        cod = int(parcel.get("cod_cents") or 0)
        if cod < order_total:
            return Verdict("RIDER_SHORT_COLLECTION", 0.8, False, {
                "action": "RECOVER_FROM_COURIER",
                "reason": f"The rider collected {_money(cod)} against an order of {_money(order_total)}.",
                "priority": "HIGH",
                "recoverable_amount": _money(variance),
                "evidence": evidence,
            })
        return Verdict("COURIER_UNEXPLAINED_DEDUCTION", 0.75, False, {
            "action": "DISPUTE_REMITTANCE",
            "reason": f"{courier} remitted {_money(variance)} less than cash collected minus its own charges.",
            "priority": "HIGH",
            "evidence": evidence,
        })
    if issue == "COURIER_OVERCHARGE":
        median = ctx["medians"].get(parcel.get("courier_name"))
        return Verdict("EXCESS_COURIER_CHARGES", 0.82, False, {
            "action": "DISPUTE_COURIER_INVOICE",
            "reason": f"{courier} charged {_money(parcel.get('charge_cents'))} where its usual charge is "
                      f"{_money(median)}.",
            "priority": "MEDIUM",
            "excess_amount": _money(variance),
            "evidence": evidence,
        })
    if issue == "RETURNED_ORDER_BOOKED":
        return Verdict("REVENUE_NOT_REVERSED_ON_RETURN", 0.9, False, {
            "action": "POST_SALES_RETURN",
            "reason": "The parcel came back to the warehouse but the ERP still carries the sale.",
            "priority": "MEDIUM",
            "target_table": "ecom_orders",
            "journal": _journal("4100-Sales Returns", "1100-Accounts Receivable", variance,
                                f"Return of COD order {order_no}"),
            "next_steps": ["Confirm the goods were received back into stock", "Reverse the sale in the ERP"],
            "evidence": evidence,
        })
    days = _days_since(parcel.get("booked_at"), ctx["as_of"])
    if parcel.get("parcel_status") == "LOST":
        return Verdict("PARCEL_LOST_IN_TRANSIT", 0.85, False, {
            "action": "FILE_LOSS_CLAIM",
            "reason": f"{courier} reports the parcel as lost.",
            "priority": "HIGH",
            "claim_amount": _money(variance),
            "evidence": evidence,
        })
    return Verdict("PARCEL_STUCK_IN_TRANSIT", 0.7, False, {
        "action": "ESCALATE_TO_COURIER",
        "reason": f"The parcel has been in transit for {days} days.",
        "priority": "MEDIUM",
        "evidence": evidence,
    })


def _records_by(frame: pd.DataFrame, key: str) -> Dict[str, Dict[str, Any]]:
    return {rec[key]: rec for rec in frame.to_dict("records")}


def _pair_format_drift(logs: pd.DataFrame) -> Dict[str, Dict[str, Any]]:
    """Pair MISSING_PAYMENT and UNTRACKED_REVENUE logs whose order refs normalise identically and amounts agree."""
    missing = logs[logs["issue_type"] == "MISSING_PAYMENT"]
    untracked = logs[logs["issue_type"] == "UNTRACKED_REVENUE"]
    if missing.empty or untracked.empty:
        return {}
    left = missing.assign(_norm=missing["source_order_number"].map(_normalise_order_ref))
    right = untracked.assign(_norm=untracked["source_order_number"].map(_normalise_order_ref))
    pairs = left.merge(right, on="_norm", suffixes=("_m", "_u"))
    pairs = pairs[pairs["order_cents_m"] == pairs["gateway_cents_u"]]
    pairs = pairs.drop_duplicates("log_id_m").drop_duplicates("log_id_u")
    partners: Dict[str, Dict[str, Any]] = {}
    for rec in pairs.to_dict("records"):
        partners[rec["log_id_m"]] = {"log_id": rec["log_id_u"], "source_order_number": rec["source_order_number_u"]}
        partners[rec["log_id_u"]] = {"log_id": rec["log_id_m"], "source_order_number": rec["source_order_number_m"]}
    return partners


def _nullable_int(value: Any) -> Optional[int]:
    return None if value is None or pd.isna(value) else int(value)


def heal_org(org_id: UUID) -> Dict[str, Any]:
    params = {"org_id": str(org_id)}
    with engine.connect() as conn:
        brand_currency = conn.execute(ORG_SQL, params).scalar_one()
        logs = pd.read_sql(OPEN_LOGS_SQL, conn, params=params)
        if logs.empty:
            return {"evaluated": 0, "auto_resolved": 0, "auto_resolved_value": 0.0, "by_category": {}}
        gateway_refs = logs.loc[logs["channel"] == "GATEWAY", "source_order_number"].unique().tolist()
        bank_refs = logs.loc[logs["channel"] == "BANK", "source_order_number"].unique().tolist()
        cod_refs = logs.loc[logs["channel"] == "COD", "source_order_number"].unique().tolist()
        details = pd.read_sql(GATEWAY_DETAIL_SQL, conn, params={**params, "order_numbers": gateway_refs})
        ctx: Dict[str, Any] = {"settlements": {}, "credits": {}, "parcels": {}, "medians": {}, "as_of": None}
        if bank_refs or cod_refs:
            ctx["as_of"] = conn.execute(AS_OF_SQL, params).scalar()
        if bank_refs:
            ctx["settlements"] = _records_by(
                pd.read_sql(SETTLEMENT_CTX_SQL, conn, params={**params, "refs": bank_refs}), "reference")
            ctx["credits"] = _records_by(
                pd.read_sql(CREDIT_CTX_SQL, conn, params={**params, "refs": bank_refs}), "bank_reference")
        if cod_refs:
            ctx["parcels"] = _records_by(
                pd.read_sql(PARCEL_CTX_SQL, conn, params={**params, "refs": cod_refs}), "source_order_number")
            medians = pd.read_sql(COURIER_MEDIAN_SQL, conn, params=params)
            ctx["medians"] = dict(zip(medians["courier_name"], medians["median_cents"].astype(int)))

    txns_by_order: Dict[str, List[Dict[str, Any]]] = {}
    for rec in details.to_dict("records"):
        txns_by_order.setdefault(rec["source_order_number"], []).append(rec)
    partners = _pair_format_drift(logs)

    now = datetime.now(timezone.utc)
    updates = []
    by_category: Dict[str, int] = {}
    auto_count = 0
    auto_value_cents = 0
    for rec in logs.to_dict("records"):
        rec["order_cents"] = _nullable_int(rec["order_cents"])
        rec["gateway_cents"] = _nullable_int(rec["gateway_cents"])
        if rec["channel"] == "BANK":
            verdict = evaluate_bank(rec, ctx)
        elif rec["channel"] == "COD":
            verdict = evaluate_cod(rec, ctx)
        else:
            verdict = evaluate(rec, txns_by_order.get(rec["source_order_number"], []), brand_currency,
                               partners.get(rec["log_id"]))
        by_category[verdict.category] = by_category.get(verdict.category, 0) + 1
        if verdict.auto_resolve:
            auto_count += 1
            auto_value_cents += abs(int(rec["variance_cents"]))
        updates.append((
            rec["log_id"],
            verdict.category,
            verdict.confidence,
            json.dumps(verdict.fix, default=str),
            verdict.auto_resolve,
            "RESOLVED" if verdict.auto_resolve else "UNRESOLVED",
            now if verdict.auto_resolve else None,
        ))

    raw = engine.raw_connection()
    try:
        with raw.cursor() as cur:
            # execute_values accepts a single VALUES placeholder, so the tenant id is inlined after UUID validation.
            sql = """
                UPDATE discrepancy_logs AS d
                   SET ai_root_cause_category = v.category,
                       ai_confidence_score    = v.confidence,
                       ai_suggested_fix       = v.fix::jsonb,
                       auto_resolved          = v.auto_resolved,
                       status                 = v.status,
                       resolved_at            = v.resolved_at
                  FROM (VALUES %s) AS v(log_id, category, confidence, fix, auto_resolved, status, resolved_at)
                 WHERE d.log_id = v.log_id::uuid
                   AND d.org_id = '{org}'::uuid
            """.replace("{org}", str(UUID(str(org_id))))
            execute_values(
                cur,
                sql,
                updates,
                template="(%s, %s, %s::numeric, %s, %s::boolean, %s, %s::timestamptz)",
                page_size=2000,
            )
        raw.commit()
    except Exception:
        raw.rollback()
        raise
    finally:
        raw.close()

    result = {
        "evaluated": len(updates),
        "auto_resolved": auto_count,
        "auto_resolved_value": round(auto_value_cents / 100, 2),
        "by_category": by_category,
    }
    logger.info("Auto-healer org=%s %s", org_id, result)
    return result
