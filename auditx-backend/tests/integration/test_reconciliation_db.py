"""Integration: one hand-built company exercising every finding type on all three legs, with exact expectations."""
from datetime import timedelta

import pytest
from sqlalchemy import text

from app.services.reconciliation import reconcile_org
from tests.helpers import add_bank, add_captures, add_orders, add_parcels, days_ago, findings, make_org, now

pytestmark = pytest.mark.integration


def build_company(conn):
    """A small company whose data contains exactly one example of each break (see EXPECTED)."""
    org = make_org(conn, "Scenario Co")
    # --- gateway leg: prepaid orders vs captures
    add_orders(conn, org, [
        {"n": "O1", "amount": 100.00}, {"n": "O2", "amount": 55.00}, {"n": "O4", "amount": 80.00},
    ])
    add_captures(conn, org, [
        {"n": "O1", "gross": 100.00, "fee": 3.20, "payout": "po_one", "at": days_ago(30)},
        {"n": "O3", "gross": 42.00, "fee": 1.52},                                # no order: untracked
        {"n": "O4", "gross": 75.00, "fee": 2.48, "payout": "po_two", "at": days_ago(20)},   # $5 short
    ])
    # --- COD leg
    cod = [("C1", 60.0), ("C2", 70.0), ("C3", 30.0), ("C4", 45.0), ("C5", 25.0), ("C7", 90.0), ("C8", 50.0),
           ("N1", 40.0), ("N2", 41.0), ("N3", 42.0), ("N4", 43.0)]
    add_orders(conn, org, [{"n": n, "amount": a, "method": "COD", "at": days_ago(12 if n == "C5" else 30)} for n, a in cod])
    remitted_1, remitted_2 = days_ago(15), days_ago(1)
    parcels = [
        {"n": "C1", "cod": 60, "charge": 2.5, "net": 57.5, "ref": "CPR-ONE", "delivered": days_ago(20), "remitted": remitted_1},
        {"n": "C2", "cod": 70, "charge": 2.5, "net": 0, "delivered": days_ago(25)},                       # never paid
        {"n": "C3", "status": "RETURNED", "charge": 2.5, "delivered": days_ago(26)},
        {"n": "C4", "status": "LOST"},
        {"n": "P6", "cod": 30, "charge": 2.5, "net": 27.5, "ref": "CPR-TWO", "delivered": days_ago(5), "remitted": remitted_2},
        {"n": "C7", "cod": 90, "charge": 2.5, "net": 84.5, "ref": "CPR-ONE", "delivered": days_ago(19), "remitted": remitted_1},
        {"n": "C8", "cod": 50, "charge": 9.0, "net": 41.0, "ref": "CPR-TWO", "delivered": days_ago(4), "remitted": remitted_2},
    ] + [
        {"n": n, "cod": a, "charge": 2.5, "net": a - 2.5, "ref": "CPR-TWO", "delivered": days_ago(4), "remitted": remitted_2}
        for n, a in cod if n.startswith("N")
    ]
    add_parcels(conn, org, parcels)
    # --- bank leg
    cpr_one = 57.5 + 84.5
    cpr_two = 27.5 + 41.0 + sum(a - 2.5 for n, a in cod if n.startswith("N"))
    add_bank(conn, org, [
        {"at": days_ago(28), "desc": "STRIPE PAYOUT po_one", "amount": 96.80, "ref": "B-PO1"},
        {"at": days_ago(14), "desc": "IBFT TCS COD REMITTANCE CPR-ONE", "amount": round(cpr_one - 0.40, 2), "ref": "B-CPR1"},
        {"at": now() - timedelta(hours=1), "desc": "TCS CPR-TWO", "amount": cpr_two, "ref": "B-CPR2"},
        {"at": days_ago(5), "desc": "STRIPE SETTLEMENT ADJ 991", "amount": 123.45, "ref": "B-ADJ"},
        {"at": days_ago(6), "desc": "LOAN DISBURSEMENT", "amount": 50_000, "ref": "B-LOAN"},
        {"at": days_ago(2), "desc": "OFFICE RENT", "amount": -900, "ref": "B-RENT"},
    ])
    return org


EXPECTED = {
    ("MISSING_PAYMENT", "O2"): ("GATEWAY", 55.00, None, 55.00),
    ("UNTRACKED_REVENUE", "O3"): ("GATEWAY", None, 42.00, -42.00),
    ("AMOUNT_MISMATCH", "O4"): ("GATEWAY", 80.00, 75.00, 5.00),
    ("SETTLEMENT_NOT_DEPOSITED", "po_two"): ("BANK", 72.52, 0, 72.52),
    ("DEPOSIT_MISMATCH", "CPR-ONE"): ("BANK", 142.00, 141.60, 0.40),
    ("UNMATCHED_DEPOSIT", "B-ADJ"): ("BANK", 0, 123.45, -123.45),
    ("COD_NOT_REMITTED", "C2"): ("COD", 67.50, 0, 67.50),
    ("RETURNED_ORDER_BOOKED", "C3"): ("COD", 30.00, 0, 30.00),
    ("PARCEL_LOST_OR_STUCK", "C4"): ("COD", 45.00, 0, 45.00),
    ("COD_PARCEL_UNTRACKED", "C5"): ("COD", 25.00, 0, 25.00),
    ("COD_ORDER_NOT_BOOKED", "P6"): ("COD", 0, 30.00, -30.00),
    ("COD_REMITTANCE_SHORTFALL", "C7"): ("COD", 87.50, 84.50, 3.00),
    ("COURIER_OVERCHARGE", "C8"): ("COD", 47.50, 41.00, 6.50),
}


def test_every_break_is_found_once_and_nothing_else(db):
    with db.begin() as conn:
        org = build_company(conn)
    report = reconcile_org(org)
    with db.connect() as conn:
        found = findings(conn, org)
    assert set(found) == set(EXPECTED), f"unexpected: {set(found) ^ set(EXPECTED)}"
    for key, (channel, expected, received, variance) in EXPECTED.items():
        f = found[key]
        assert f["channel"] == channel, key
        as_float = lambda v: None if v is None else float(v)  # noqa: E731
        assert as_float(f["order_amount"]) == (None if expected is None else pytest.approx(expected)), key
        assert as_float(f["gateway_amount"]) == (None if received is None else pytest.approx(received)), key
        assert float(f["variance_amount"]) == pytest.approx(variance), key
        assert f["status"] == "UNRESOLVED"
    assert report.discrepancies_logged == 13
    assert report.bank["matched_by_reference"] == 3 and report.bank["ignored_non_settlement_credits"] == 1
    assert report.cod["delivered"] >= 8


def test_cod_orders_are_not_reported_as_missing_gateway_payments(db):
    with db.begin() as conn:
        org = build_company(conn)
    reconcile_org(org)
    with db.connect() as conn:
        missing = [k for k in findings(conn, org) if k[0] == "MISSING_PAYMENT"]
    assert missing == [("MISSING_PAYMENT", "O2")]


def test_legs_without_data_are_skipped_with_a_reason(db):
    with db.begin() as conn:
        org = make_org(conn)
        add_orders(conn, org, [{"n": "A", "amount": 10}, {"n": "B", "amount": 20, "method": "COD"}])
    report = reconcile_org(org)
    assert report.bank["skipped"] == "no bank statement uploaded"
    assert report.cod["skipped"] == "no courier report uploaded"
    assert report.discrepancies_logged == 1                  # only A (no capture); B is COD and not judged yet


def test_rerun_rebuilds_open_findings_without_duplicates(db):
    with db.begin() as conn:
        org = build_company(conn)
    reconcile_org(org)
    reconcile_org(org)
    with db.connect() as conn:
        total = conn.execute(text("SELECT COUNT(*) FROM discrepancy_logs WHERE org_id = :o"), {"o": str(org)}).scalar()
    assert total == len(EXPECTED)


def test_fixing_the_data_closes_the_finding_on_next_run(db):
    with db.begin() as conn:
        org = build_company(conn)
    reconcile_org(org)
    with db.begin() as conn:
        add_captures(conn, org, [{"n": "O2", "gross": 55.00, "txn": "late_capture"}])
    reconcile_org(org)
    with db.connect() as conn:
        assert ("MISSING_PAYMENT", "O2") not in findings(conn, org)


def test_reconciliation_is_tenant_isolated(db):
    with db.begin() as conn:
        org = build_company(conn)
        other = make_org(conn, "Other")
        add_orders(conn, other, [{"n": "O2", "amount": 55.00}])                # same order number elsewhere
        add_captures(conn, other, [{"n": "O2", "gross": 55.00}])
    reconcile_org(org)
    reconcile_org(other)
    with db.connect() as conn:
        assert findings(conn, other) == {}
        assert ("MISSING_PAYMENT", "O2") in findings(conn, org)
