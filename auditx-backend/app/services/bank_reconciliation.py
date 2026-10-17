"""Bank leg: settlement batches (gateway payouts + courier COD remittances) <-> bank statement credits.

Every settlement batch is expected to land in the bank as one credit. Matching runs in two passes:
  1. reference match: the payout / remittance id appears in the credit's narration or bank reference;
  2. amount + date match: same amount, credited within BANK_MATCH_WINDOW_DAYS of the batch closing.
Unmatched batches older than SETTLEMENT_LAG_DAYS (measured against the last statement date) become
SETTLEMENT_NOT_DEPOSITED; credits that look like settlements but match nothing become UNMATCHED_DEPOSIT.
Other credits (loans, interest, capital) are ignored. All amounts are integer cents.
"""
from __future__ import annotations

import re
from datetime import timedelta
from typing import Any, Dict, Tuple
from uuid import UUID

import pandas as pd
from sqlalchemy import text

from app.config import settings
from app.database import engine

FINDING_COLUMNS = ["source_order_number", "issue_type", "channel", "order_cents", "gateway_cents", "variance_cents"]

SETTLEMENTS_SQL = text(
    """
    SELECT payout_reference                      AS reference,
           'GATEWAY_PAYOUT'                      AS source,
           ROUND(SUM(net_amount) * 100)::bigint  AS expected_cents,
           MAX(processed_at)                     AS closed_at
      FROM gateway_transactions
     WHERE org_id = :org_id AND payout_reference IS NOT NULL
     GROUP BY payout_reference
    UNION ALL
    SELECT remittance_reference,
           'COURIER_REMITTANCE',
           ROUND(SUM(net_remitted) * 100)::bigint,
           MAX(COALESCE(remitted_at, delivered_at))
      FROM courier_remittances
     WHERE org_id = :org_id AND remittance_reference IS NOT NULL
     GROUP BY remittance_reference
    """
)

CREDITS_SQL = text(
    """
    SELECT bank_reference,
           transaction_date,
           description,
           ROUND(amount * 100)::bigint AS amount_cents
      FROM bank_transactions
     WHERE org_id = :org_id AND amount > 0
    """
)

# Narration keywords of payment gateways and couriers. Unmatched credits without one are not settlements.
SETTLEMENT_KEYWORDS = re.compile(
    r"(?i)\b(?:stripe|paypal|razorpay|adyen|checkout\.com|payfast|jazzcash|easypaisa|safepay|hbl\s?pay|"
    r"shopify|payout|settlement|remittance|cpr|cod|tcs|leopards|postex|trax|m&p|callcourier|daraz|blueex|rider)\b"
)
_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-]{2,}")


def _empty() -> pd.DataFrame:
    return pd.DataFrame(columns=FINDING_COLUMNS)


def _finding(frame: pd.DataFrame, ref_col: str, issue: str, expected: pd.Series, received: pd.Series) -> pd.DataFrame:
    expected = expected.astype("Int64")
    received = received.astype("Int64")
    return pd.DataFrame({
        "source_order_number": frame[ref_col].to_numpy(),
        "issue_type": issue,
        "channel": "BANK",
        "order_cents": expected.to_numpy(),
        "gateway_cents": received.to_numpy(),
        "variance_cents": (expected.fillna(0) - received.fillna(0)).astype("int64").to_numpy(),
    })


def _reference_matches(settlements: pd.DataFrame, credits: pd.DataFrame) -> pd.DataFrame:
    """Pair batches with credits whose narration or bank reference carries the batch id.

    Fast path: exact token join (narrations split on spaces, slashes and other separators). Fallback for the
    few batches left: the id appears inside a longer token (e.g. "CPR-TCS-77-WK41"), not glued to letters or
    digits on either side."""
    text_by_credit = (credits["description"].fillna("") + " " + credits["bank_reference"]).str.upper()
    tokens = pd.DataFrame({"bank_reference": credits["bank_reference"],
                           "token": text_by_credit.map(lambda s: list(set(_TOKEN.findall(s))))})
    tokens = tokens.explode("token").dropna(subset=["token"])
    keyed = settlements.assign(token=settlements["reference"].str.upper())
    pairs = keyed.merge(tokens[["bank_reference", "token"]], on="token")
    pairs = pairs.drop_duplicates("reference").drop_duplicates("bank_reference")[["reference", "bank_reference"]]

    left = settlements[~settlements["reference"].isin(pairs["reference"])]
    free = dict(zip(credits["bank_reference"], text_by_credit))
    for ref in pairs["bank_reference"]:
        free.pop(ref, None)
    extra = []
    for reference in left["reference"]:
        pattern = re.compile(r"(?<![A-Z0-9])" + re.escape(reference.upper()) + r"(?![A-Z0-9])")
        hit = next((b for b, t in free.items() if reference.upper() in t and pattern.search(t)), None)
        if hit is not None:
            extra.append({"reference": reference, "bank_reference": hit})
            free.pop(hit)
    if extra:
        pairs = pd.concat([pairs, pd.DataFrame(extra)], ignore_index=True)
    return pairs


def _amount_matches(settlements: pd.DataFrame, credits: pd.DataFrame) -> pd.DataFrame:
    if settlements.empty or credits.empty:
        return pd.DataFrame(columns=["reference", "bank_reference"])
    pairs = settlements.merge(credits, left_on="expected_cents", right_on="amount_cents")
    gap = pairs["transaction_date"] - pairs["closed_at"]
    window = (gap >= -pd.Timedelta(days=1)) & (gap <= pd.Timedelta(days=settings.BANK_MATCH_WINDOW_DAYS))
    pairs = pairs.loc[window].assign(_gap=gap[window].abs()).sort_values("_gap")
    pairs = pairs.drop_duplicates("reference").drop_duplicates("bank_reference")
    return pairs[["reference", "bank_reference"]]


def reconcile_bank(org_id: UUID) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    params = {"org_id": str(org_id)}
    with engine.connect() as conn:
        settlements = pd.read_sql(SETTLEMENTS_SQL, conn, params=params)
        credits = pd.read_sql(CREDITS_SQL, conn, params=params)

    summary: Dict[str, Any] = {
        "settlements_expected": int(len(settlements)),
        "bank_credits": int(len(credits)),
        "matched_by_reference": 0,
        "matched_by_amount": 0,
        "pending_within_lag": 0,
        "outside_statement_period": 0,
        "ignored_non_settlement_credits": 0,
    }
    if credits.empty or settlements.empty:
        summary["skipped"] = "no bank statement uploaded" if credits.empty else "no settlement batches found"
        return _empty(), summary

    settlements["closed_at"] = pd.to_datetime(settlements["closed_at"], utc=True)
    credits["transaction_date"] = pd.to_datetime(credits["transaction_date"], utc=True)
    settlements["expected_cents"] = settlements["expected_cents"].astype("int64")
    credits["amount_cents"] = credits["amount_cents"].astype("int64")

    by_ref = _reference_matches(settlements, credits)
    rest_s = settlements[~settlements["reference"].isin(by_ref["reference"])]
    rest_c = credits[~credits["bank_reference"].isin(by_ref["bank_reference"])]
    by_amount = _amount_matches(rest_s, rest_c)
    summary["matched_by_reference"] = int(len(by_ref))
    summary["matched_by_amount"] = int(len(by_amount))

    findings = []
    matched = by_ref.merge(settlements, on="reference").merge(credits, on="bank_reference")
    mismatched = matched[matched["expected_cents"] != matched["amount_cents"]]
    if not mismatched.empty:
        findings.append(_finding(mismatched, "reference", "DEPOSIT_MISMATCH",
                                 mismatched["expected_cents"], mismatched["amount_cents"]))

    open_s = rest_s[~rest_s["reference"].isin(by_amount["reference"])]
    statement_end = credits["transaction_date"].max()
    statement_start = credits["transaction_date"].min()
    lag = timedelta(days=settings.SETTLEMENT_LAG_DAYS)
    due = open_s["closed_at"] + lag <= statement_end
    in_period = open_s["closed_at"] >= statement_start - lag
    summary["pending_within_lag"] = int((~due & in_period).sum())
    summary["outside_statement_period"] = int((~in_period).sum())
    missing = open_s[due & in_period]
    if not missing.empty:
        findings.append(_finding(missing, "reference", "SETTLEMENT_NOT_DEPOSITED",
                                 missing["expected_cents"], pd.Series(0, index=missing.index)))

    open_c = rest_c[~rest_c["bank_reference"].isin(by_amount["bank_reference"])]
    looks_like_settlement = open_c["description"].fillna("").str.contains(SETTLEMENT_KEYWORDS)
    summary["ignored_non_settlement_credits"] = int((~looks_like_settlement).sum())
    orphan = open_c[looks_like_settlement]
    if not orphan.empty:
        findings.append(_finding(orphan, "bank_reference", "UNMATCHED_DEPOSIT",
                                 pd.Series(0, index=orphan.index), orphan["amount_cents"]))

    result = pd.concat(findings, ignore_index=True) if findings else _empty()
    return result, summary
