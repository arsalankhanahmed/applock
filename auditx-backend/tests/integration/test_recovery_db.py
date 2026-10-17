"""Integration: recovery claims against PostgreSQL — claimable findings, the claim lifecycle, payments,
recovery detected in fresh data, and maker-checker on closing."""
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.services import recovery
from app.services.recovery import RecoveryError
from app.services.reconciliation import reconcile_org
from tests.helpers import add_bank, days_ago, findings, make_org, make_user, now
from tests.integration.test_reconciliation_db import build_company

pytestmark = pytest.mark.integration


@pytest.fixture
def company(db):
    with db.begin() as conn:
        org = build_company(conn)
        maker = make_user(conn, org, "maker@co.test", "ANALYST")
        checker = make_user(conn, org, "checker@co.test", "AUDITOR")
    reconcile_org(org)
    return org, maker, checker


def claimable(db, org):
    with db.connect() as conn:
        return {(f["issue_type"], f["source_order_number"]): f for f in recovery.claimable_findings(conn, org)}


def log_ids(db, org, *keys):
    found = claimable(db, org)
    return [found[k]["log_id"] for k in keys]


def new_claim(db, org, maker, *keys, **kw):
    with db.begin() as conn:
        return recovery.create_claim(conn, org, maker, "maker@co.test", log_ids(db, org, *keys), **kw)


def submit(db, org, claim):
    with db.begin() as conn:
        return recovery.submit_claim(conn, org, claim["claim_id"], "maker@co.test")[0]


def pay(db, org, maker, claim, amount, ref="UTR-1"):
    with db.begin() as conn:
        return recovery.record_payment(conn, org, claim["claim_id"], maker, "maker@co.test", Decimal(amount), ref)


def test_only_money_owed_by_a_counterparty_is_claimable(db, company):
    org, *_ = company
    found = claimable(db, org)
    assert set(found) == {("COD_NOT_REMITTED", "C2"), ("PARCEL_LOST_OR_STUCK", "C4"), ("COD_REMITTANCE_SHORTFALL", "C7"),
                          ("COURIER_OVERCHARGE", "C8"), ("SETTLEMENT_NOT_DEPOSITED", "po_two"),
                          ("DEPOSIT_MISMATCH", "CPR-ONE")}
    assert found[("COD_NOT_REMITTED", "C2")]["counterparty_name"] == "TCS"
    assert found[("COD_NOT_REMITTED", "C2")]["evidence"]["tracking_number"].startswith("TRK-C2")
    assert found[("DEPOSIT_MISMATCH", "CPR-ONE")]["counterparty_name"] == "TCS"          # a courier remittance
    assert (found[("SETTLEMENT_NOT_DEPOSITED", "po_two")]["counterparty_type"],
            found[("SETTLEMENT_NOT_DEPOSITED", "po_two")]["counterparty_name"]) == ("GATEWAY", "PAYMENT GATEWAY")
    groups = recovery.group_by_counterparty(found.values())
    assert [(g["counterparty_name"], g["count"], g["total"]) for g in groups] == [
        ("TCS", 5, Decimal("122.40")), ("PAYMENT GATEWAY", 1, Decimal("72.52"))]


def test_create_claim_numbers_snapshots_and_locks_findings(db, company):
    org, maker, _ = company
    claim = new_claim(db, org, maker, ("COD_NOT_REMITTED", "C2"), ("PARCEL_LOST_OR_STUCK", "C4"), notes="Weekly claim")
    assert claim["claim_number"] == "CLM-0001" and claim["status"] == "DRAFT"
    assert claim["claimed_amount"] == Decimal("112.50") and claim["counterparty_name"] == "TCS"
    assert [e["kind"] for e in claim["events"]] == ["CREATED"]
    assert "CLM-0001" in claim["letter_subject"] and "USD 112.50" in claim["letter_text"]
    assert ("COD_NOT_REMITTED", "C2") not in claimable(db, org)                         # now under claim
    second = new_claim(db, org, maker, ("COURIER_OVERCHARGE", "C8"))
    assert second["claim_number"] == "CLM-0002"


def test_a_finding_cannot_be_claimed_twice_or_mixed_across_counterparties(db, company):
    org, maker, _ = company
    ids = log_ids(db, org, ("COD_NOT_REMITTED", "C2"))
    with db.begin() as conn:
        recovery.create_claim(conn, org, maker, "maker@co.test", ids)
    with db.begin() as conn, pytest.raises(RecoveryError) as twice:
        recovery.create_claim(conn, org, maker, "maker@co.test", ids)
    assert twice.value.status_code == 409
    mixed = log_ids(db, org, ("PARCEL_LOST_OR_STUCK", "C4"), ("SETTLEMENT_NOT_DEPOSITED", "po_two"))
    with db.begin() as conn, pytest.raises(RecoveryError, match="one counterparty") as err:
        recovery.create_claim(conn, org, maker, "maker@co.test", mixed)
    assert err.value.status_code == 422


def test_non_claimable_findings_are_refused(db, company):
    org, maker, _ = company
    with db.connect() as conn:
        missing_payment = findings(conn, org)[("MISSING_PAYMENT", "O2")]["log_id"]       # the customer owes this
    with db.begin() as conn, pytest.raises(RecoveryError) as err:
        recovery.create_claim(conn, org, maker, "maker@co.test", [missing_payment])
    assert err.value.status_code == 409


def test_payments_are_capped_and_full_recovery_goes_through_maker_checker(db, company):
    org, maker, checker = company
    claim = submit(db, org, new_claim(db, org, maker, ("COD_NOT_REMITTED", "C2"), ("PARCEL_LOST_OR_STUCK", "C4")))
    with db.begin() as conn, pytest.raises(RecoveryError, match="Cannot record"):
        recovery.record_payment(conn, org, new_claim(db, org, maker, ("COURIER_OVERCHARGE", "C8"))["claim_id"],
                                maker, "maker@co.test", Decimal("1"))                  # still a draft
    partial = pay(db, org, maker, claim, "50.00")
    assert partial["status"] == "PARTIALLY_RECOVERED" and partial["outstanding_amount"] == Decimal("62.50")
    with db.begin() as conn, pytest.raises(RecoveryError, match="more than"):
        recovery.record_payment(conn, org, claim["claim_id"], maker, "maker@co.test", Decimal("62.51"))
    done = pay(db, org, maker, claim, "62.50", ref="UTR-2")
    assert done["status"] == "RECOVERED" and done["outstanding_amount"] == 0 and done["closed_at"] is not None
    assert {r["source_order_number"]: r["status"] for r in done["resolutions"]} == {
        "C2": "PENDING_APPROVAL", "C4": "PENDING_APPROVAL"}                              # default policy: checker needed
    with db.connect() as conn:
        reasons = conn.execute(text("SELECT root_cause_category, maker_note FROM resolution_requests "
                                    "WHERE org_id = :o AND proposed_by_type = 'USER'"), {"o": str(org)}).all()
    assert {r.root_cause_category for r in reasons} == {"RECOVERED_FROM_COUNTERPARTY"}
    assert all("CLM-0001" in r.maker_note and "UTR-2" in r.maker_note for r in reasons)


def test_write_off_needs_a_reason_and_routes_findings_to_a_checker(db, company):
    org, maker, _ = company
    claim = submit(db, org, new_claim(db, org, maker, ("COURIER_OVERCHARGE", "C8")))
    pay(db, org, maker, claim, "2.00")
    with db.begin() as conn, pytest.raises(RecoveryError, match="reason"):
        recovery.write_off(conn, org, claim["claim_id"], maker, "maker@co.test", "  ")
    with db.begin() as conn:
        result = recovery.write_off(conn, org, claim["claim_id"], maker, "maker@co.test", "Courier contract allows it")
    assert result["status"] == "WRITTEN_OFF" and result["written_off_amount"] == Decimal("4.50")
    assert result["recovered_amount"] == Decimal("2.00") and result["outstanding_amount"] == 0
    with db.connect() as conn:
        assert findings(conn, org)[("COURIER_OVERCHARGE", "C8")]["status"] == "PENDING_APPROVAL"


def test_rejection_releases_findings_for_a_new_claim(db, company):
    org, maker, _ = company
    claim = submit(db, org, new_claim(db, org, maker, ("PARCEL_LOST_OR_STUCK", "C4")))
    with db.begin() as conn:
        rejected = recovery.reject_claim(conn, org, claim["claim_id"], "maker@co.test", "TCS says parcel was delivered")
    assert rejected["status"] == "REJECTED" and not any(i["active"] for i in rejected["items"])
    assert ("PARCEL_LOST_OR_STUCK", "C4") in claimable(db, org)
    with db.connect() as conn:
        assert findings(conn, org)[("PARCEL_LOST_OR_STUCK", "C4")]["status"] == "UNRESOLVED"
    assert new_claim(db, org, maker, ("PARCEL_LOST_OR_STUCK", "C4"))["claim_number"] == "CLM-0002"


def test_only_drafts_can_be_cancelled(db, company):
    org, maker, _ = company
    draft = new_claim(db, org, maker, ("COD_NOT_REMITTED", "C2"))
    with db.begin() as conn:
        assert recovery.cancel_claim(conn, org, draft["claim_id"], "maker@co.test")["status"] == "CANCELLED"
    sent = submit(db, org, new_claim(db, org, maker, ("COD_NOT_REMITTED", "C2")))
    with db.begin() as conn, pytest.raises(RecoveryError) as err:
        recovery.cancel_claim(conn, org, sent["claim_id"], "maker@co.test")
    assert err.value.status_code == 409


def remit_c2(db, org, net):
    """The courier finally pays C2 (partly or fully) and the money reaches the bank."""
    with db.begin() as conn:
        conn.execute(text("UPDATE courier_remittances SET net_remitted = :n, remittance_reference = 'CPR-LATE', "
                          "remitted_at = :t WHERE org_id = :o AND source_order_number = 'C2'"),
                     {"n": net, "t": days_ago(1), "o": str(org)})
        add_bank(conn, org, [{"at": now(), "desc": "TCS CPR-LATE", "amount": net, "ref": "B-LATE"}])
    return reconcile_org(org)


def test_recovery_is_detected_in_fresh_courier_data(db, company):
    org, maker, _ = company
    claim = submit(db, org, new_claim(db, org, maker, ("COD_NOT_REMITTED", "C2")))
    report = remit_c2(db, org, 67.50)
    assert report.recovery == {"claims_checked": 1, "claims_updated": 1, "recovered_via_data": 67.5, "claims_closed": 1}
    with db.connect() as conn:
        after = recovery.get_claim(conn, org, claim["claim_id"])
    assert after["status"] == "RECOVERED" and after["recovered_amount"] == Decimal("67.50")
    assert [e["kind"] for e in after["events"]][-1] == "DATA_MATCH"
    assert reconcile_org(org).recovery["claims_checked"] == 0                         # closed claims are left alone


def test_partial_payment_in_the_data_is_not_mistaken_for_full_recovery(db, company):
    """C2 turns from COD_NOT_REMITTED into a 7.50 COD_REMITTANCE_SHORTFALL: only 60.00 came back."""
    org, maker, _ = company
    claim = submit(db, org, new_claim(db, org, maker, ("COD_NOT_REMITTED", "C2")))
    remit_c2(db, org, 60.00)
    with db.connect() as conn:
        after = recovery.get_claim(conn, org, claim["claim_id"])
        assert findings(conn, org)[("COD_REMITTANCE_SHORTFALL", "C2")]["variance_amount"] == Decimal("7.50")
    assert after["status"] == "PARTIALLY_RECOVERED" and after["outstanding_amount"] == Decimal("7.50")
    assert ("COD_REMITTANCE_SHORTFALL", "C2") not in claimable(db, org)                 # still covered by CLM-0001
    assert reconcile_org(org).recovery["claims_updated"] == 0                          # no double counting on re-run


def test_data_match_never_double_counts_a_recorded_payment(db, company):
    org, maker, _ = company
    claim = submit(db, org, new_claim(db, org, maker, ("COD_NOT_REMITTED", "C2"), ("PARCEL_LOST_OR_STUCK", "C4")))
    pay(db, org, maker, claim, "100.00")                                               # 12.50 still outstanding
    remit_c2(db, org, 67.50)                                                           # data shows C2's 67.50 paid
    with db.connect() as conn:
        after = recovery.get_claim(conn, org, claim["claim_id"])
    assert after["recovered_amount"] == Decimal("112.50") and after["status"] == "RECOVERED"
    assert sum(e["amount"] for e in after["events"] if e["kind"] in ("PAYMENT", "DATA_MATCH")) == Decimal("112.50")


def test_summary_shows_recovery(db, company):
    org, maker, _ = company
    claim = submit(db, org, new_claim(db, org, maker, ("COD_NOT_REMITTED", "C2"), ("PARCEL_LOST_OR_STUCK", "C4")))
    pay(db, org, maker, claim, "45.00")
    new_claim(db, org, maker, ("SETTLEMENT_NOT_DEPOSITED", "po_two"))                   # draft: not yet "claimed"
    with db.connect() as conn:
        s = recovery.summary(conn, org)
    assert (s["open_claims"], s["open_value"]) == (2, Decimal("140.02"))
    assert (s["recovered_total"], s["recovered_this_month"]) == (Decimal("45.00"), Decimal("45.00"))
    assert s["recovery_rate_pct"] == Decimal("40.00")                                  # 45 of 112.50 sent
    assert s["claimable_count"] == 3 and s["claimable_value"] == Decimal("9.90")       # C7, C8, CPR-ONE
    parties = {p["counterparty_name"]: (p["open_claims"], p["recovered"], p["outstanding"]) for p in s["by_counterparty"]}
    assert parties == {"PAYMENT GATEWAY": (1, Decimal("0.00"), Decimal("72.52")),            # largest outstanding first
                       "TCS": (1, Decimal("45.00"), Decimal("67.50"))}
    assert s["by_counterparty"][0]["counterparty_name"] == "PAYMENT GATEWAY"


def test_claims_are_tenant_scoped(db, company):
    org, maker, _ = company
    claim = new_claim(db, org, maker, ("COD_NOT_REMITTED", "C2"))
    with db.begin() as conn:
        other = make_org(conn, "Other Co")
    with db.connect() as conn, pytest.raises(RecoveryError) as err:
        recovery.get_claim(conn, other, claim["claim_id"])
    assert err.value.status_code == 404
    with db.connect() as conn:
        assert recovery.list_claims(conn, other)["total"] == 0
        assert recovery.claimable_findings(conn, other) == []


def test_a_failing_recovery_check_does_not_fail_reconciliation(db, company, monkeypatch):
    org, *_ = company

    def broken(_org):
        raise RuntimeError("boom")

    monkeypatch.setattr(recovery, "sync_with_data", broken)
    report = reconcile_org(org)
    assert report.recovery == {"error": "RuntimeError: boom"} and report.discrepancies_logged == 13
