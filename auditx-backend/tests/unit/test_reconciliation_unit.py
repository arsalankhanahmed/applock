"""White-box unit tests for the matching logic of the three reconciliation legs (pure pandas, no database)."""
from datetime import datetime, timedelta, timezone

import pandas as pd
import pytest

from app.services import bank_reconciliation as bank
from app.services.cod_reconciliation import aggregate_parcels
from app.services.reconciliation import _cents_to_text, _exclude_resolved, classify

pytestmark = pytest.mark.unit
T0 = datetime(2026, 10, 1, tzinfo=timezone.utc)


# ----------------------------------------------------------------------------- gateway leg
def frames(orders, captures):
    o = pd.DataFrame(orders, columns=["source_order_number", "order_cents", "order_rows"])
    g = pd.DataFrame(captures, columns=["source_order_number", "gateway_cents", "fee_cents", "gateway_rows"])
    return o, g


def test_classify_isolates_the_three_variance_groups():
    o, g = frames(
        [("A", 1000, 1), ("B", 2000, 1), ("D", 3000, 1)],
        [("A", 1000, 59, 1), ("C", 500, 45, 1), ("D", 2500, 100, 1)],
    )
    result = classify(o, g, tolerance_cents=0).set_index("source_order_number")
    assert result.loc["A", "issue_type"] == "MATCHED"
    assert result.loc["B", "issue_type"] == "MISSING_PAYMENT"
    assert result.loc["C", "issue_type"] == "UNTRACKED_REVENUE"
    assert result.loc["D", "issue_type"] == "AMOUNT_MISMATCH"
    assert result.loc["B", "variance_cents"] == 2000      # expected - received
    assert result.loc["C", "variance_cents"] == -500
    assert result.loc["D", "variance_cents"] == 500
    assert set(result["channel"]) == {"GATEWAY"}


@pytest.mark.parametrize("tolerance, issue", [(0, "AMOUNT_MISMATCH"), (1, "MATCHED"), (2, "MATCHED")])
def test_classify_respects_the_match_tolerance(tolerance, issue):
    o, g = frames([("A", 1000, 1)], [("A", 999, 0, 1)])
    assert classify(o, g, tolerance)["issue_type"].iloc[0] == issue


def test_classify_handles_empty_inputs():
    o, g = frames([], [])
    assert classify(o, g, 0).empty


def test_cents_to_text_formats_signs_and_missing_values():
    out = _cents_to_text(pd.Series([12345, -5, 0, None], dtype="Int64")).tolist()
    assert out == ["123.45", "-0.05", "0.00", ""]


def test_exclude_resolved_skips_only_identical_findings():
    found = pd.DataFrame({"source_order_number": ["A", "B"], "issue_type": ["AMOUNT_MISMATCH"] * 2,
                          "variance_cents": [500, 700]})
    resolved = pd.DataFrame({"source_order_number": ["A", "B"], "issue_type": ["AMOUNT_MISMATCH"] * 2,
                             "variance_cents": [500, 300]})          # B changed amount -> raise it again
    remaining, skipped = _exclude_resolved(found, resolved)
    assert skipped == 1
    assert remaining["source_order_number"].tolist() == ["B"]


# ----------------------------------------------------------------------------- bank leg
def settlements(*rows):
    return pd.DataFrame(rows, columns=["reference", "source", "expected_cents", "closed_at"])


def credits(*rows):
    return pd.DataFrame(rows, columns=["bank_reference", "transaction_date", "description", "amount_cents"])


def test_reference_match_finds_payout_ids_inside_narrations_case_insensitively():
    s = settlements(("po_ABC123", "GATEWAY_PAYOUT", 1000, T0), ("CPR-TCS-77", "COURIER_REMITTANCE", 500, T0))
    c = credits(("B1", T0, "stripe payout PO_abc123 ref", 1000), ("B2", T0, "IBFT CPR-TCS-77/WK41", 480))
    pairs = bank._reference_matches(s, c).set_index("reference")["bank_reference"].to_dict()
    assert pairs == {"po_ABC123": "B1", "CPR-TCS-77": "B2"}


def test_reference_match_is_one_to_one():
    s = settlements(("po_1", "GATEWAY_PAYOUT", 1000, T0))
    c = credits(("B1", T0, "PAYOUT po_1", 1000), ("B2", T0, "PAYOUT po_1 duplicate", 1000))
    assert len(bank._reference_matches(s, c)) == 1


def test_amount_match_requires_the_date_window():
    s = settlements(("po_1", "GATEWAY_PAYOUT", 1000, T0), ("po_2", "GATEWAY_PAYOUT", 2000, T0))
    c = credits(
        ("B1", T0 + timedelta(days=2), "STRIPE TRANSFER", 1000),          # inside window
        ("B2", T0 + timedelta(days=45), "STRIPE TRANSFER", 2000),         # far too late
    )
    pairs = bank._amount_matches(s, c)
    assert pairs["reference"].tolist() == ["po_1"]


def test_amount_match_prefers_the_closest_date():
    s = settlements(("po_1", "GATEWAY_PAYOUT", 1000, T0))
    c = credits(("FAR", T0 + timedelta(days=8), "STRIPE", 1000), ("NEAR", T0 + timedelta(days=1), "STRIPE", 1000))
    assert bank._amount_matches(s, c)["bank_reference"].tolist() == ["NEAR"]


@pytest.mark.parametrize("narration, is_settlement", [
    ("STRIPE PAYOUT", True), ("IBFT TCS EXPRESS", True), ("Leopards COD", True), ("JazzCash settlement", True),
    ("LOAN DISBURSEMENT", False), ("PROFIT ON DEPOSIT", False), ("OWNER CAPITAL INJECTION", False),
])
def test_settlement_keyword_filter(narration, is_settlement):
    assert bool(bank.SETTLEMENT_KEYWORDS.search(narration)) is is_settlement


# ----------------------------------------------------------------------------- COD leg
def parcels(*rows):
    cols = ["source_order_number", "courier_name", "parcel_status", "cod_cents", "charge_cents", "net_cents",
            "remittance_reference", "booked_at", "delivered_at"]
    return pd.DataFrame(rows, columns=cols)


def test_parcel_aggregation_takes_the_most_advanced_status_and_delivered_cash_only():
    p = parcels(
        ("A", "TCS", "RETURNED", 0, 200, 0, None, T0, T0),
        ("A", "TCS", "DELIVERED", 5000, 250, 4750, "CPR-1", T0, T0 + timedelta(days=3)),
        ("B", "TRAX", "IN_TRANSIT", 0, 0, 0, None, T0, None),
    )
    agg = aggregate_parcels(p).set_index("source_order_number")
    assert agg.loc["A", "parcel_status"] == "DELIVERED"
    assert agg.loc["A", "cod_cents"] == 5000
    assert agg.loc["A", "charge_cents"] == 250          # the return's charge is not a delivered charge
    assert not agg.loc["A", "unremitted"]
    assert agg.loc["B", "parcel_status"] == "IN_TRANSIT"


def test_parcel_aggregation_flags_any_unremitted_delivery():
    p = parcels(
        ("A", "TCS", "DELIVERED", 3000, 250, 2750, "CPR-1", T0, T0),
        ("A", "TCS", "DELIVERED", 2000, 250, 0, None, T0, T0),
    )
    assert bool(aggregate_parcels(p)["unremitted"].iloc[0]) is True


@pytest.mark.regression
@pytest.mark.parametrize("narration", [
    "IBFT CPR-TCS-77/WK41",            # slash-joined (DEF-02)
    "REMIT:CPR-TCS-77;BATCH",          # other separators
    "TRF CPR-TCS-77-WK41",             # glued with a hyphen: fallback search
])
def test_reference_found_inside_noisy_narrations(narration):
    s = settlements(("CPR-TCS-77", "COURIER_REMITTANCE", 500, T0))
    c = credits(("B1", T0, narration, 500))
    assert bank._reference_matches(s, c)["bank_reference"].tolist() == ["B1"]


@pytest.mark.regression
def test_reference_is_not_matched_inside_a_longer_id():
    s = settlements(("po_7", "GATEWAY_PAYOUT", 500, T0))
    c = credits(("B1", T0, "STRIPE PAYOUT po_77", 500))
    assert bank._reference_matches(s, c).empty
