"""White-box unit tests for the Auto-Healer rule-book: one test per branch of every evaluator."""
from datetime import datetime, timedelta, timezone

import pandas as pd
import pytest

from app.services import auto_healer as h

pytestmark = pytest.mark.unit
NOW = datetime(2026, 10, 15, tzinfo=timezone.utc)


def row(issue, variance, order=None, gateway=None, ref="SO-1", channel="GATEWAY"):
    return {"log_id": "L1", "source_order_number": ref, "issue_type": issue, "channel": channel,
            "variance_cents": variance, "order_cents": order, "gateway_cents": gateway}


def txn(gross, fee=0, tid="ch_1"):
    return {"source_transaction_id": tid, "gross_cents": gross, "fee_cents": fee, "processed_at": NOW}


# ----------------------------------------------------------------------------- gateway rules
@pytest.mark.parametrize("variance, category, auto", [
    (1, "FX_ROUNDING_ERROR", True),
    (49, "FX_ROUNDING_ERROR", True),
    (500, "PROMO_CODE_UNSYNCED", True),
    (-500, "SURCHARGE_UNBOOKED", True),
])
def test_amount_mismatch_patterns(variance, category, auto):
    v = h.evaluate(row("AMOUNT_MISMATCH", variance, 10_000, 10_000 - variance), [txn(10_000 - variance)], "USD", None)
    assert (v.category, v.auto_resolve) == (category, auto)
    assert v.fix["evidence"]["events"][0]["transaction_id"] == "ch_1"


def test_fx_confidence_falls_as_the_variance_grows():
    small = h.evaluate(row("AMOUNT_MISMATCH", 1, 1000, 999), [txn(999)], "USD", None).confidence
    large = h.evaluate(row("AMOUNT_MISMATCH", 49, 1000, 951), [txn(951)], "USD", None).confidence
    assert 0.91 <= large < small <= 0.99


def test_fee_netting_when_variance_equals_the_fee():
    v = h.evaluate(row("AMOUNT_MISMATCH", -290, 9710, 10_000), [txn(10_000, fee=290)], "USD", None)
    assert v.category == "GATEWAY_FEE_NETTING" and v.auto_resolve
    journal = v.fix["journal"]
    assert sum(l["debit"] for l in journal) == sum(l["credit"] for l in journal) == 2.9   # balanced entry


def test_duplicate_capture_is_never_auto_resolved():
    v = h.evaluate(row("AMOUNT_MISMATCH", -5000, 5000, 10_000), [txn(5000, tid="a"), txn(5000, tid="b")], "USD", None)
    assert v.category == "DUPLICATE_CAPTURE" and not v.auto_resolve
    assert v.fix["refund_transaction_id"] == "b"


def test_large_variance_escalates_as_potential_fraud():
    v = h.evaluate(row("AMOUNT_MISMATCH", 6000, 10_000, 4000), [txn(4000)], "USD", None)
    assert v.category == "POTENTIAL_FRAUD_OR_MANIPULATION" and v.fix["priority"] == "HIGH"


def test_small_unexplained_variance_goes_to_manual_review():
    v = h.evaluate(row("AMOUNT_MISMATCH", 700, 10_000, 9300), [txn(9300)], "USD", None)
    assert v.category == "UNEXPLAINED_VARIANCE" and not v.auto_resolve


def test_missing_and_untracked_defaults():
    assert h.evaluate(row("MISSING_PAYMENT", 5000, 5000), [], "USD", None).category == "PAYMENT_NOT_CAPTURED"
    assert h.evaluate(row("UNTRACKED_REVENUE", -5000, None, 5000), [txn(5000)], "USD", None).category == "ORPHAN_GATEWAY_PAYMENT"


def test_high_value_missing_payment_is_high_priority():
    assert h.evaluate(row("MISSING_PAYMENT", 60_000, 60_000), [], "USD", None).fix["priority"] == "HIGH"
    assert h.evaluate(row("MISSING_PAYMENT", 6_000, 6_000), [], "USD", None).fix["priority"] == "MEDIUM"


@pytest.mark.parametrize("raw, norm", [("#0001003", "1003"), ("1003", "1003"), ("so-00042", "SO42"), (" SO 42 ", "SO42")])
def test_order_reference_normalisation(raw, norm):
    assert h._normalise_order_ref(raw) == norm


def test_format_drift_pairs_missing_and_untracked_with_equal_amounts():
    logs = pd.DataFrame([
        {"log_id": "m1", "source_order_number": "#0001003", "issue_type": "MISSING_PAYMENT", "order_cents": 8000, "gateway_cents": None},
        {"log_id": "u1", "source_order_number": "1003", "issue_type": "UNTRACKED_REVENUE", "order_cents": None, "gateway_cents": 8000},
        {"log_id": "u2", "source_order_number": "1004", "issue_type": "UNTRACKED_REVENUE", "order_cents": None, "gateway_cents": 8000},
    ])
    partners = h._pair_format_drift(logs)
    assert partners["m1"]["log_id"] == "u1" and partners["u1"]["log_id"] == "m1"
    assert "u2" not in partners
    verdict = h.evaluate(row("MISSING_PAYMENT", 8000, 8000, ref="#0001003"), [], "USD", partners["m1"])
    assert verdict.category == "ORDER_ID_FORMAT_DRIFT" and verdict.fix["transform"]["to"] == "#0001003"


def test_simulated_gateway_logs_are_deterministic():
    a = h.simulate_gateway_api_logs("SO-9", [txn(100)], "USD")
    b = h.simulate_gateway_api_logs("SO-9", [txn(100)], "USD")
    assert a == b and a["event_count"] == 1


# ----------------------------------------------------------------------------- bank rules
def bank_ctx(**settlement):
    return {"settlements": {"po_1": {"source": "GATEWAY_PAYOUT", "closed_at": NOW - timedelta(days=40), **settlement}},
            "credits": {"BNK-9": {"description": "STRIPE ADJ"}}, "as_of": NOW}


@pytest.mark.parametrize("variance, category, auto", [
    (30, "FX_ROUNDING_ERROR", True),
    (300, "BANK_CHARGES_DEDUCTED", True),            # 0.3% of 1000.00
    (2_000, "UNEXPLAINED_SETTLEMENT_SHORTFALL", False),
    (-1_000, "SETTLEMENT_OVER_DEPOSIT", False),
])
def test_deposit_mismatch_rules(variance, category, auto):
    v = h.evaluate_bank(row("DEPOSIT_MISMATCH", variance, 100_000, 100_000 - variance, ref="po_1", channel="BANK"), bank_ctx())
    assert (v.category, v.auto_resolve) == (category, auto)


def test_bank_charges_are_capped_at_25_dollars():
    v = h.evaluate_bank(row("DEPOSIT_MISMATCH", 2_600, 10_000_000, 9_997_400, ref="po_1", channel="BANK"), bank_ctx())
    assert v.category == "UNEXPLAINED_SETTLEMENT_SHORTFALL"


def test_missing_settlement_names_the_party_and_escalates_when_old():
    gw = h.evaluate_bank(row("SETTLEMENT_NOT_DEPOSITED", 5000, 5000, 0, ref="po_1", channel="BANK"), bank_ctx())
    assert gw.category == "GATEWAY_PAYOUT_NOT_RECEIVED" and gw.fix["priority"] == "HIGH" and gw.fix["days_outstanding"] == 40
    ctx = bank_ctx(source="COURIER_REMITTANCE", counterparty="LEOPARDS", closed_at=NOW - timedelta(days=9))
    cr = h.evaluate_bank(row("SETTLEMENT_NOT_DEPOSITED", 5000, 5000, 0, ref="po_1", channel="BANK"), ctx)
    assert cr.category == "COURIER_REMITTANCE_NOT_RECEIVED" and "LEOPARDS" in cr.fix["reason"] and cr.fix["priority"] == "MEDIUM"


def test_unmatched_deposit_goes_to_suspense():
    v = h.evaluate_bank(row("UNMATCHED_DEPOSIT", -12_345, 0, 12_345, ref="BNK-9", channel="BANK"), bank_ctx())
    assert v.category == "UNIDENTIFIED_SETTLEMENT_CREDIT" and v.fix["narration"] == "STRIPE ADJ"
    assert v.fix["journal"][1]["account"].startswith("2900")


# ----------------------------------------------------------------------------- COD rules
def cod_ctx(**parcel):
    base = {"courier_name": "TCS", "parcel_status": "DELIVERED", "cod_cents": 10_000, "charge_cents": 250,
            "delivered_at": NOW - timedelta(days=35), "booked_at": NOW - timedelta(days=40)}
    return {"parcels": {"SO-1": {**base, **parcel}}, "medians": {"TCS": 250}, "as_of": NOW}


def cod_row(issue, variance, order=None, gateway=0):
    return row(issue, variance, order, gateway, channel="COD")


@pytest.mark.parametrize("issue, ctx, category", [
    ("COD_PARCEL_UNTRACKED", {}, "COD_ORDER_NOT_DISPATCHED"),
    ("COD_ORDER_NOT_BOOKED", {}, "UNBOOKED_COD_SALE"),
    ("COD_NOT_REMITTED", {}, "COURIER_REMITTANCE_OVERDUE"),
    ("COURIER_OVERCHARGE", {"charge_cents": 900}, "EXCESS_COURIER_CHARGES"),
    ("RETURNED_ORDER_BOOKED", {"parcel_status": "RETURNED"}, "REVENUE_NOT_REVERSED_ON_RETURN"),
    ("PARCEL_LOST_OR_STUCK", {"parcel_status": "LOST"}, "PARCEL_LOST_IN_TRANSIT"),
    ("PARCEL_LOST_OR_STUCK", {"parcel_status": "IN_TRANSIT"}, "PARCEL_STUCK_IN_TRANSIT"),
])
def test_cod_categories(issue, ctx, category):
    v = h.evaluate_cod(cod_row(issue, 9_750, 9_750), cod_ctx(**ctx))
    assert v.category == category
    assert v.auto_resolve is False                      # COD findings always go to a person


def test_cod_overdue_escalates_after_30_days():
    assert h.evaluate_cod(cod_row("COD_NOT_REMITTED", 9750), cod_ctx()).fix["priority"] == "HIGH"
    recent = cod_ctx(delivered_at=NOW - timedelta(days=12))
    assert h.evaluate_cod(cod_row("COD_NOT_REMITTED", 9750), recent).fix["priority"] == "MEDIUM"


def test_shortfall_splits_rider_short_collection_from_courier_deduction():
    # expected = order - charge = 9750; rider only collected 8000 of a 10000 order
    rider = h.evaluate_cod(cod_row("COD_REMITTANCE_SHORTFALL", 2000, 9750, 7750), cod_ctx(cod_cents=8000))
    assert rider.category == "RIDER_SHORT_COLLECTION"
    courier = h.evaluate_cod(cod_row("COD_REMITTANCE_SHORTFALL", 500, 9750, 9250), cod_ctx(cod_cents=10_000))
    assert courier.category == "COURIER_UNEXPLAINED_DEDUCTION"


def test_plain_converts_pandas_values_to_json_safe_python():
    out = h._plain({"a": pd.NaT, "b": float("nan"), "c": pd.Timestamp("2026-10-01", tz="UTC"), "d": pd.Series([5]).iloc[0], "e": "x"})
    assert out == {"a": None, "b": None, "c": "2026-10-01T00:00:00+00:00", "d": 5, "e": "x"}
