"""Unit (white box): counterparty rules, grouping and the claim letter."""
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest

from app.services import recovery

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("finding, parcel, settlement, expected", [
    ({"channel": "COD"}, {"courier_name": "leopards"}, None, ("COURIER", "LEOPARDS")),
    ({"channel": "COD"}, None, None, ("COURIER", "UNKNOWN COURIER")),
    ({"channel": "BANK"}, None, {"kind": "COURIER", "courier": "tcs"}, ("COURIER", "TCS")),
    ({"channel": "BANK"}, None, {"kind": "GATEWAY", "courier": None}, ("GATEWAY", "PAYMENT GATEWAY")),
    ({"channel": "BANK"}, None, None, ("GATEWAY", "PAYMENT GATEWAY")),
    ({"channel": "BANK", "ai_root_cause_category": "BANK_CHARGES_DEDUCTED"}, None, {"kind": "GATEWAY"}, ("BANK", "BANK")),
])
def test_counterparty_rules(finding, parcel, settlement, expected):
    assert recovery.counterparty_for(finding, parcel, settlement) == expected


def test_grouping_totals_and_order():
    items = [
        {"counterparty_type": "COURIER", "counterparty_name": "TCS", "amount": Decimal("10.00")},
        {"counterparty_type": "GATEWAY", "counterparty_name": "PAYMENT GATEWAY", "amount": Decimal("50.00")},
        {"counterparty_type": "COURIER", "counterparty_name": "TCS", "amount": Decimal("45.50")},
    ]
    groups = recovery.group_by_counterparty(items)
    assert [(g["counterparty_name"], g["count"], g["total"]) for g in groups] == [
        ("TCS", 2, Decimal("55.50")), ("PAYMENT GATEWAY", 1, Decimal("50.00"))]


def test_claimable_types_never_include_customer_or_internal_issues():
    claimable = {t for types in recovery.CLAIMABLE.values() for t in types}
    assert not claimable & {"MISSING_PAYMENT", "UNTRACKED_REVENUE", "AMOUNT_MISMATCH", "UNMATCHED_DEPOSIT",
                            "RETURNED_ORDER_BOOKED", "COD_PARCEL_UNTRACKED", "COD_ORDER_NOT_BOOKED"}
    assert "d.issue_type IN ('COD_NOT_REMITTED'" in recovery.SAME_FAMILY


def claim(**extra):
    return {"claim_number": "CLM-0007", "counterparty_name": "TCS", "currency": "PKR",
            "claimed_amount": Decimal("1234.50"), "due_date": date(2026, 11, 1),
            "submitted_at": datetime(2026, 10, 17, tzinfo=timezone.utc), "notes": None, **extra}


ITEMS = [
    {"channel": "COD", "source_order_number": "SO-1", "issue_type": "COD_NOT_REMITTED", "amount": Decimal("1200.00"),
     "evidence": {"tracking_number": "TCS123", "delivered_at": "2026-09-03T10:00:00+00:00"}},
    {"channel": "COD", "source_order_number": "SO-2", "issue_type": "COURIER_OVERCHARGE", "amount": Decimal("34.50"),
     "evidence": '{"tracking_number": "TCS456"}'},                     # evidence may arrive as a JSON string
]


def test_letter_lists_every_item_with_total_due_date_and_reference():
    subject, body, page = recovery.render_letter(claim(), ITEMS, "Karachi Traders")
    assert subject == "Karachi Traders - claim CLM-0007 for PKR 1,234.50"
    assert "1. Order SO-1 / CN TCS123 - Cash collected on delivery but not remitted (dated 2026-09-03): PKR 1,200.00" in body
    assert "2. Order SO-2 / CN TCS456 - Delivery charges above the agreed rate: PKR 34.50" in body
    assert "Total claimed: PKR 1,234.50" in body and "by 01 Nov 2026" in body
    assert "quoting claim number CLM-0007" in body
    assert page.count("<tr><td") == 3 and "PKR 1,234.50" in page             # two items + the total row


def test_letter_escapes_user_text_in_html():
    _, body, page = recovery.render_letter(
        claim(counterparty_name="<b>TCS</b>", notes="<script>alert(1)</script>"), ITEMS, "Acme & Sons <Ltd>")
    assert "<script>" not in page and "&lt;script&gt;" in page
    assert "Acme &amp; Sons &lt;Ltd&gt;" in page and "&lt;b&gt;TCS&lt;/b&gt;" in page
    assert "Notes: <script>alert(1)</script>" in body                 # plain text stays verbatim


def test_bank_items_use_the_settlement_reference():
    items = [{"channel": "BANK", "source_order_number": "po_two", "issue_type": "SETTLEMENT_NOT_DEPOSITED",
              "amount": Decimal("72.52"), "evidence": {"settlement_closed_at": "2026-09-27T00:00:00"}}]
    _, body, _ = recovery.render_letter(claim(due_date=None, counterparty_name="PAYMENT GATEWAY"), items, "Acme")
    assert "Reference po_two - Settlement never deposited to our bank account (dated 2026-09-27)" in body
    assert "within 14 days" in body
