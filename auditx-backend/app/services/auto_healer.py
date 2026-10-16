"""AI Auto-Healer (Feature 1).

Evaluates every open discrepancy for a tenant against a deterministic forensic rule-book, enriched
with (simulated) raw gateway API log metadata. High-confidence, low-risk patterns are resolved
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
        order_numbers = logs["source_order_number"].unique().tolist()
        details = pd.read_sql(GATEWAY_DETAIL_SQL, conn, params={**params, "order_numbers": order_numbers})

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
