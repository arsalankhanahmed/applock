"""Integration: Auto-Healer + maker-checker policy + approval decisions against PostgreSQL."""
import json

import pytest
from sqlalchemy import text

from app.services import approvals
from app.services.approvals import ApprovalError
from app.services.auto_healer import heal_org
from app.services.reconciliation import reconcile_org
from tests.helpers import findings, make_user
from tests.integration.test_reconciliation_db import build_company

pytestmark = pytest.mark.integration


def setup(db, mode=None, limit=None):
    with db.begin() as conn:
        org = build_company(conn)
        maker = make_user(conn, org, "maker@co.test", "ANALYST")
        checker = make_user(conn, org, "checker@co.test", "AUDITOR")
        if mode:
            approvals.save_policy(conn, org, {"auto_heal_mode": mode, "auto_heal_max_amount": limit or 1,
                                              "manual_requires_approval": True, "manual_auto_approve_max": 0}, "o@co.test")
    reconcile_org(org)
    return org, maker, checker


def requests(conn, org):
    return conn.execute(text("SELECT * FROM resolution_requests WHERE org_id = :o ORDER BY created_at"),
                        {"o": str(org)}).mappings().all()


def test_default_policy_posts_only_sub_dollar_fixes(db):
    org, *_ = setup(db)
    result = heal_org(org)
    with db.connect() as conn:
        f = findings(conn, org)
        reqs = requests(conn, org)
    assert f[("DEPOSIT_MISMATCH", "CPR-ONE")]["status"] == "RESOLVED"          # 0.40 rounding: under 1.00
    assert f[("DEPOSIT_MISMATCH", "CPR-ONE")]["auto_resolved"] is True
    assert f[("AMOUNT_MISMATCH", "O4")]["status"] == "PENDING_APPROVAL"        # $5 promo patch waits
    assert result["auto_resolved"] == 1 and result["queued_for_approval"] == 1
    assert {(r["status"], r["decided_by_email"]) for r in reqs} == {("APPROVED", "policy:auto"), ("PENDING", None)}
    assert all(f[k]["status"] == "UNRESOLVED" for k in f if f[k]["channel"] == "COD" or k[0] == "MISSING_PAYMENT")


@pytest.mark.parametrize("mode, resolved, pending", [("AUTO", 2, 0), ("ALWAYS_APPROVE", 0, 2), ("THRESHOLD", 1, 1)])
def test_policy_modes(db, mode, resolved, pending):
    org, *_ = setup(db, mode, 1)
    result = heal_org(org)
    assert (result["auto_resolved"], result["queued_for_approval"]) == (resolved, pending)


def test_fix_proposals_are_valid_json_with_evidence(db):
    org, *_ = setup(db)
    heal_org(org)
    with db.connect() as conn:
        fixes = conn.execute(text("SELECT issue_type, ai_suggested_fix FROM discrepancy_logs WHERE org_id = :o"),
                             {"o": str(org)}).all()
    assert len(fixes) == 13 and all(fix and fix.get("action") for _, fix in fixes)
    json.dumps([fix for _, fix in fixes])                                     # no NaN / non-JSON values


def pending_ai_request(db, org):
    with db.connect() as conn:
        return next(r for r in requests(conn, org) if r["status"] == "PENDING")


def test_checker_approves_ai_fix(db):
    org, maker, checker = setup(db)
    heal_org(org)
    req = pending_ai_request(db, org)
    with db.begin() as conn:
        approvals.decide(conn, org, req["request_id"], checker, "checker@co.test", "AUDITOR", True, "ok")
    with db.connect() as conn:
        log = findings(conn, org)[("AMOUNT_MISMATCH", "O4")]
    assert log["status"] == "RESOLVED" and log["auto_resolved"] is True
    assert log["ai_suggested_fix"]["approval"]["approved_by"] == "checker@co.test"


@pytest.mark.parametrize("role", ["ANALYST", "VIEWER"])
def test_only_checker_roles_decide(db, role):
    org, maker, _ = setup(db)
    heal_org(org)
    req = pending_ai_request(db, org)
    with db.begin() as conn, pytest.raises(ApprovalError) as err:
        approvals.decide(conn, org, req["request_id"], maker, "maker@co.test", role, True, None)
    assert err.value.status_code == 403


def test_manual_flow_maker_cannot_approve_own_request(db):
    org, maker, checker = setup(db)
    with db.connect() as conn:
        log_id = findings(conn, org)[("MISSING_PAYMENT", "O2")]["log_id"]
    with db.begin() as conn:
        row = approvals.submit_manual_resolution(conn, org, log_id, maker, "maker@co.test", "Paid by cheque", None)
    assert row["status"] == "PENDING_APPROVAL"
    with db.connect() as conn:
        req = next(r for r in requests(conn, org) if r["proposed_by"] is not None)
    with db.begin() as conn, pytest.raises(ApprovalError, match="Segregation of duties"):
        approvals.decide(conn, org, req["request_id"], maker, "maker@co.test", "OWNER", True, None)   # even as OWNER
    with db.begin() as conn:
        approvals.decide(conn, org, req["request_id"], checker, "checker@co.test", "AUDITOR", True, None)
    with db.begin() as conn, pytest.raises(ApprovalError) as again:
        approvals.decide(conn, org, req["request_id"], checker, "checker@co.test", "AUDITOR", True, None)
    assert again.value.status_code == 409


def test_rejection_needs_a_reason_and_reopens_the_finding(db):
    org, maker, checker = setup(db)
    heal_org(org)
    req = pending_ai_request(db, org)
    with db.begin() as conn, pytest.raises(ApprovalError) as err:
        approvals.decide(conn, org, req["request_id"], checker, "checker@co.test", "AUDITOR", False, "  ")
    assert err.value.status_code == 422
    with db.begin() as conn:
        approvals.decide(conn, org, req["request_id"], checker, "checker@co.test", "AUDITOR", False, "Promo not valid")
    with db.connect() as conn:
        log = findings(conn, org)[("AMOUNT_MISMATCH", "O4")]
    assert log["status"] == "UNRESOLVED" and log["ai_suggested_fix"]["approval"]["rejected_by"] == "checker@co.test"


def test_withdraw_is_only_for_the_maker(db):
    org, maker, checker = setup(db)
    with db.connect() as conn:
        log_id = findings(conn, org)[("MISSING_PAYMENT", "O2")]["log_id"]
    with db.begin() as conn:
        approvals.submit_manual_resolution(conn, org, log_id, maker, "maker@co.test", "note", None)
    with db.connect() as conn:
        req = next(r for r in requests(conn, org) if r["proposed_by"] is not None)
    with db.begin() as conn, pytest.raises(ApprovalError) as err:
        approvals.withdraw(conn, org, req["request_id"], checker)
    assert err.value.status_code == 403
    with db.begin() as conn:
        approvals.withdraw(conn, org, req["request_id"], maker)
    with db.connect() as conn:
        assert findings(conn, org)[("MISSING_PAYMENT", "O2")]["status"] == "UNRESOLVED"


def test_manual_auto_approve_limit(db):
    org, maker, _ = setup(db)
    with db.begin() as conn:
        approvals.save_policy(conn, org, {"auto_heal_mode": "THRESHOLD", "auto_heal_max_amount": 1,
                                          "manual_requires_approval": True, "manual_auto_approve_max": 100}, "o@co.test")
        log_id = findings(conn, org)[("MISSING_PAYMENT", "O2")]["log_id"]                           # 55.00 <= 100
        row = approvals.submit_manual_resolution(conn, org, log_id, maker, "maker@co.test", "small", "WRITE_OFF")
    assert row["status"] == "RESOLVED" and row["ai_root_cause_category"] == "WRITE_OFF"


def test_cross_tenant_requests_are_invisible(db):
    org, maker, checker = setup(db)
    heal_org(org)
    req = pending_ai_request(db, org)
    with db.begin() as conn:
        from tests.helpers import make_org
        intruder_org = make_org(conn, "Intruder")
        intruder = make_user(conn, intruder_org, "x@intruder.test", "OWNER")
    with db.begin() as conn, pytest.raises(ApprovalError) as err:
        approvals.decide(conn, intruder_org, req["request_id"], intruder, "x@intruder.test", "OWNER", True, None)
    assert err.value.status_code == 404
