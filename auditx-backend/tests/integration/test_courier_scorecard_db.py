"""Integration: the courier scorecard against PostgreSQL with a fast, clean courier and a slow, costly one."""
from decimal import Decimal

import pytest

from app.services import courier_scorecard, recovery
from app.services.reconciliation import reconcile_org
from tests.helpers import add_orders, add_parcels, days_ago, make_org, make_user

pytestmark = pytest.mark.integration


@pytest.fixture
def fleet(db):
    """LEOPARDS: 4 parcels delivered and remitted 2 days later at 2.00.
    TCS: 2 remitted 15 days after delivery (one charged 9.00), 1 never remitted, 1 returned, 1 lost."""
    with db.begin() as conn:
        org = make_org(conn, "Fleet Co")
        user = make_user(conn, org, "ops@fleet.test", "ANALYST")
        orders = [(f"L{i}", 100.0) for i in range(1, 5)] + [("T1", 80.0), ("T2", 80.0), ("T3", 80.0), ("T4", 50.0), ("T5", 60.0)]
        add_orders(conn, org, [{"n": n, "amount": a, "method": "COD", "at": days_ago(45)} for n, a in orders])
        add_parcels(conn, org, [
            {"n": f"L{i}", "courier": "LEOPARDS", "cod": 100, "charge": 2.0, "net": 98.0, "ref": "LCS-1",
             "booked": days_ago(6), "delivered": days_ago(3), "remitted": days_ago(1)} for i in range(1, 5)
        ] + [
            {"n": "T1", "courier": "TCS", "cod": 80, "charge": 2.5, "net": 77.5, "ref": "CPR-9",
             "booked": days_ago(40), "delivered": days_ago(30), "remitted": days_ago(15)},
            {"n": "T2", "courier": "TCS", "cod": 80, "charge": 9.0, "net": 71.0, "ref": "CPR-9",
             "booked": days_ago(40), "delivered": days_ago(30), "remitted": days_ago(15)},
            {"n": "T3", "courier": "TCS", "cod": 80, "charge": 2.5, "net": 0, "booked": days_ago(40), "delivered": days_ago(25)},
            {"n": "T4", "courier": "TCS", "status": "RETURNED", "charge": 2.5, "booked": days_ago(40), "delivered": days_ago(30)},
            {"n": "T5", "courier": "TCS", "status": "LOST", "booked": days_ago(40)},
        ])
    reconcile_org(org)
    return org, user


def card(db, org, days=90):
    with db.connect() as conn:
        return courier_scorecard.build(conn, org, days)


def test_parcel_outcomes_cash_and_speed(db, fleet):
    org, _ = fleet
    c = {x["courier_name"]: x for x in card(db, org)["couriers"]}
    tcs, lcs = c["TCS"], c["LEOPARDS"]
    assert (tcs["booked"], tcs["delivered"], tcs["returned"], tcs["lost_or_stuck"]) == (5, 3, 1, 1)
    assert (tcs["delivery_rate_pct"], tcs["return_rate_pct"]) == (60.0, 20.0)
    assert (tcs["cod_collected"], tcs["remitted"], tcs["with_courier"]) == (Decimal("240.00"), Decimal("148.50"), Decimal("77.50"))
    assert (tcs["avg_remit_days"], tcs["on_time_pct"], tcs["overdue_unremitted"]) == (15.0, 0.0, 1)   # 0 of 3 within 10 days
    assert tcs["avg_charge"] == Decimal("4.67")
    assert (lcs["avg_remit_days"], lcs["on_time_pct"], lcs["delivery_rate_pct"]) == (2.0, 100.0, 100.0)
    assert lcs["with_courier"] == 0 and lcs["avg_charge"] == Decimal("2.00")


def test_findings_feed_charges_and_money_owed(db, fleet):
    org, _ = fleet
    c = {x["courier_name"]: x for x in card(db, org)["couriers"]}
    tcs = c["TCS"]
    assert (tcs["overcharged"], tcs["overcharge_value"]) == (1, Decimal("6.50"))              # 9.00 vs 2.50 median
    assert tcs["owed_now"] >= Decimal("77.50") + Decimal("6.50")                            # unremitted + overcharge (+ lost)
    assert tcs["components"]["charges"] == 0.0 and tcs["components"]["issues"] < 100
    assert c["LEOPARDS"]["owed_now"] == 0 and c["LEOPARDS"]["components"]["issues"] == 100.0


def test_scores_grades_and_leaders(db, fleet):
    org, _ = fleet
    result = card(db, org)
    names = [x["courier_name"] for x in result["couriers"]]
    assert names == ["LEOPARDS", "TCS"]                                                    # best first
    lcs, tcs = result["couriers"]
    assert (lcs["score"], lcs["grade"]) == (100.0, "A") and tcs["grade"] == "F" and tcs["score"] < 40
    assert lcs["low_volume"] and tcs["low_volume"]                                          # fewer than 20 parcels
    assert result["best"] == {"overall": "LEOPARDS", "fastest_remittance": "LEOPARDS",
                              "best_delivery": "LEOPARDS", "cheapest": "LEOPARDS"}
    assert result["as_of"] is not None and result["currency"] == "USD"


def test_window_ends_at_the_latest_report_date(db, fleet):
    org, _ = fleet
    week = card(db, org, days=7)["couriers"]
    assert [x["courier_name"] for x in week] == ["LEOPARDS"]                                 # TCS parcels booked 39+ days earlier


def test_claims_show_on_the_courier(db, fleet):
    org, user = fleet
    with db.connect() as conn:
        tcs_ids = [f["log_id"] for f in recovery.claimable_findings(conn, org) if f["counterparty_name"] == "TCS"]
    with db.begin() as conn:
        claim = recovery.create_claim(conn, org, user, "ops@fleet.test", tcs_ids)
        recovery.submit_claim(conn, org, claim["claim_id"], "ops@fleet.test")
        recovery.record_payment(conn, org, claim["claim_id"], user, "ops@fleet.test", Decimal("20.00"), "UTR-1")
    tcs = next(x for x in card(db, org)["couriers"] if x["courier_name"] == "TCS")
    assert tcs["claimed"] == claim["claimed_amount"] and tcs["recovered"] == Decimal("20.00")


def test_empty_and_isolated(db, fleet):
    with db.begin() as conn:
        other = make_org(conn, "No Couriers Co")
    empty = card(db, other)
    assert empty["couriers"] == [] and empty["as_of"] is None
    csv_text = courier_scorecard.to_csv(card(db, fleet[0]))
    assert csv_text.count("\n") == 3 and "LEOPARDS,A,100.0" in csv_text
