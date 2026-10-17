"""Regression suite: every defect found so far is pinned here so it can never silently return.

Each test names the defect it guards. DEF-xx ids are listed in docs/testing/TEST_REPORT.md.
"""
import contextlib
import io

import pandas as pd
import pytest
from sqlalchemy import text

from app.services import approvals
from app.services.ai_agent import UnsafeQueryError, execute_readonly, guard_sql
from app.services.auto_healer import heal_org
from app.services.bank_reconciliation import _reference_matches
from app.services.parser import clean_currency_series
from app.services.reconciliation import reconcile_org
from tests.helpers import auth, findings, make_org, make_user, register
from tests.integration.test_reconciliation_db import build_company

pytestmark = pytest.mark.regression


# ----------------------------------------------------------------------------- defects found in this test cycle
@pytest.mark.parametrize("raw, expected", [("0.005", 0.01), ("$2.675", 2.68), ("-1.005", -1.01), ("(0.125)", -0.13)])
def test_def01_half_cents_round_away_from_zero(raw, expected):
    """DEF-01: Python's banker's rounding + binary floats turned 0.005 into 0.00 and 2.675 into 2.67."""
    assert clean_currency_series(pd.Series([raw])).iloc[0] == pytest.approx(expected)


def test_def02_references_inside_slash_joined_narrations():
    """DEF-02: 'NEFT/po_ABC123/STRIPE' was one token, so payout po_ABC123 was matched by amount or not at all."""
    from tests.unit.test_reconciliation_unit import T0, credits, settlements

    s = settlements(("po_ABC123", "GATEWAY_PAYOUT", 1000, T0), ("CPR-77", "COURIER_REMITTANCE", 500, T0))
    c = credits(("b1", T0, "NEFT/po_ABC123/STRIPE PAYMENTS", 1000), ("b2", T0, "IMPS CPR-77/TCS REMIT", 500))
    matched = _reference_matches(s, c)
    assert dict(zip(matched["reference"], matched["bank_reference"])) == {"po_ABC123": "b1", "CPR-77": "b2"}


def test_def03_invitations_cannot_leak_across_tenants(db):
    """DEF-03 (security): the agent sandbox did not shadow `invitations`, so `OR 1=1` read other tenants' invites."""
    with db.begin() as conn:
        a, b = make_org(conn, "A"), make_org(conn, "B")
        conn.execute(text("INSERT INTO invitations (org_id, email, role, token_hash, expires_at) "
                          "VALUES (:o, 'victim@b.test', 'ADMIN', repeat('f', 64), now())"), {"o": str(b)})
    with pytest.raises(UnsafeQueryError):
        guard_sql("SELECT email, token_hash FROM invitations WHERE org_id = :org_id OR 1=1")
    frame, _ = execute_readonly("SELECT * FROM invitations WHERE org_id = :org_id OR 1 = 1", a)
    assert frame.empty


# ----------------------------------------------------------------------------- found in the ad-hoc session
@pytest.mark.parametrize("request_args", [
    ("get", "/api/v1/discrepancies?search=%00", None),
    ("post", "/api/v1/agent/query", {"question": "total\u0000leakage"}),
    ("patch", "/api/v1/users/00000000-0000-0000-0000-000000000000", {"full_name": "Nul\u0000Name"}),
])
def test_def04_nul_characters_are_refused_not_a_500(client, request_args):
    """DEF-04: PostgreSQL cannot store NUL, so `search=%00` or a NUL in JSON crashed with HTTP 500."""
    method, url, body = request_args
    token = register(client)["access_token"]
    res = getattr(client, method)(url, headers=auth(token), **({"json": body} if body else {}))
    assert res.status_code == 422 and "NUL" in res.json()["detail"]
    assert client.post("/api/v1/auth/register", json={"company_name": "Nul\u0000Co", "full_name": "N N",
                                                       "email": "n@nul.test", "password": "Str0ng#Passw0rd"}).status_code == 422


@pytest.mark.parametrize("raw, expected", [("1e30", None), ("1.25E+05", 125000.0), ("-3.5e2", -350.0),
                                           ("999999999999999.99", None), ("9999999999999.99", 9999999999999.99)])
def test_def05_scientific_notation_and_absurd_amounts(raw, expected):
    """DEF-05: '1e30' had its letters stripped and was stored as 130.00; huge values lost their cents."""
    value = clean_currency_series(pd.Series([raw])).iloc[0]
    assert (pd.isna(value) if expected is None else value == pytest.approx(expected))


def test_def06_tokens_without_expiry_are_rejected(client):
    """DEF-06: a validly signed JWT with no `exp` claim was accepted forever."""
    import jwt as pyjwt

    from app.config import settings

    claims = pyjwt.decode(register(client)["access_token"], options={"verify_signature": False})
    claims.pop("exp")
    forever = pyjwt.encode(claims, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    assert client.get("/api/v1/me", headers=auth(forever)).status_code == 401


def test_def07_overlong_identifier_rejects_the_row_not_the_file(client):
    """DEF-07: one 5,000-character order number aborted the COPY and failed the whole upload."""
    from tests.helpers import csv_file

    token = register(client)["access_token"]
    files = csv_file("o.csv", "source_order_number,total_amount", ["Z" * 5000 + ",1", "OK1,2"])
    job = client.post("/api/v1/ingest/ecom_orders", headers=auth(token), files=files).json()
    result = client.get(f"/api/v1/jobs/{job['job_id']}", headers=auth(token)).json()
    assert result["status"] == "SUCCEEDED"
    assert (result["result"]["rows_inserted"], result["result"]["rows_rejected"]) == (1, 1)


def test_def08_utf16_excel_exports_are_readable(client):
    """DEF-08: Excel 'Unicode Text' (UTF-16 + BOM) failed with a misleading 'missing columns' error."""
    token = register(client)["access_token"]
    content = "source_order_number\ttotal_amount\nU1\t10.50\nU2\t3\n".encode("utf-16")
    job = client.post("/api/v1/ingest/ecom_orders", headers=auth(token),
                      files={"file": ("export.txt", io.BytesIO(content), "text/plain")}).json()
    result = client.get(f"/api/v1/jobs/{job['job_id']}", headers=auth(token)).json()
    assert result["status"] == "SUCCEEDED" and result["result"]["rows_inserted"] == 2


# ----------------------------------------------------------------------------- defects fixed during development
def test_delete_routes_return_empty_204_and_openapi_builds(client):
    """FastAPI refused to start when a 204 route declared a JSON response class."""
    schema = client.app.openapi()
    assert "/api/v1/users/{user_id}" in schema["paths"] and "/api/v1/invites/{invite_id}" in schema["paths"]
    owner = register(client)["access_token"]
    invite_id = client.post("/api/v1/invites", headers=auth(owner),
                            json={"email": "z@acme.test", "role": "VIEWER"}).json()["invite_id"]
    res = client.delete(f"/api/v1/invites/{invite_id}", headers=auth(owner))
    assert res.status_code == 204 and res.content == b""


def test_rejected_ai_fix_is_not_proposed_again(db):
    """A checker's rejection must stick: the next Auto-Healer run may not re-queue the same fix."""
    with db.begin() as conn:
        org = build_company(conn)
        checker = make_user(conn, org, "checker@co.test", "AUDITOR")
    reconcile_org(org)
    heal_org(org)
    with db.connect() as conn:
        rid = conn.execute(text("SELECT request_id FROM resolution_requests WHERE org_id = :o AND status = 'PENDING'"),
                           {"o": str(org)}).scalar()
    with db.begin() as conn:
        approvals.decide(conn, org, rid, checker, "checker@co.test", "AUDITOR", False, "Promo was not valid")
    reconcile_org(org)
    second = heal_org(org)
    with db.connect() as conn:
        pending = conn.execute(text("SELECT COUNT(*) FROM resolution_requests WHERE org_id = :o AND status = 'PENDING'"),
                               {"o": str(org)}).scalar()
        o4 = findings(conn, org)[("AMOUNT_MISMATCH", "O4")]
    assert pending == 0 and second["queued_for_approval"] == 0 and o4["status"] == "UNRESOLVED"


def test_rerun_keeps_pending_findings_without_duplicates(db):
    """Re-running reconciliation used to re-open PENDING_APPROVAL rows and create a second copy."""
    with db.begin() as conn:
        org = build_company(conn)
    reconcile_org(org)
    heal_org(org)
    reconcile_org(org)
    heal_org(org)
    with db.connect() as conn:
        rows = conn.execute(text("SELECT issue_type, status, COUNT(*) AS n FROM discrepancy_logs WHERE org_id = :o "
                                 "GROUP BY 1, 2"), {"o": str(org)}).all()
        requests = conn.execute(text("SELECT COUNT(*) FROM resolution_requests WHERE org_id = :o"), {"o": str(org)}).scalar()
    assert sum(r.n for r in rows) == 13
    assert ("AMOUNT_MISMATCH", "PENDING_APPROVAL", 1) in [tuple(r) for r in rows]
    assert requests == 2                                         # one auto-approved, one pending, nothing re-queued


def test_cod_orders_are_never_missing_gateway_payments(db):
    """Before the COD leg existed every cash-on-delivery order was reported as MISSING_PAYMENT."""
    with db.begin() as conn:
        org = build_company(conn)
    reconcile_org(org)
    with db.connect() as conn:
        missing = [ref for (issue, ref) in findings(conn, org) if issue == "MISSING_PAYMENT"]
    assert missing == ["O2"]


def test_removed_member_token_stops_working(client):
    """Role and membership are read from the database on every request, not trusted from the JWT."""
    from tests.helpers import add_member

    owner = register(client)["access_token"]
    member = add_member(client, owner, "gone@acme.test", "ADMIN")
    member_id = next(u["user_id"] for u in client.get("/api/v1/users", headers=auth(owner)).json()
                     if u["email"] == "gone@acme.test")
    client.delete(f"/api/v1/users/{member_id}", headers=auth(owner))
    assert client.get("/api/v1/users", headers=auth(member)).status_code == 401


def test_pending_status_is_allowed_by_the_check_constraint(db):
    """The original CHECK constraint rejected PENDING_APPROVAL; init_db must upgrade it in place."""
    with db.connect() as conn:
        definition = conn.execute(text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_discrepancy_status'")).scalar()
    assert "PENDING_APPROVAL" in definition


# ----------------------------------------------------------------------------- planted-vs-found (whole system)
PLANTED_TO_CATEGORY = {
    "missing_payment": ["PAYMENT_NOT_CAPTURED"],
    "orphan_gateway_payment": ["ORPHAN_GATEWAY_PAYMENT"],
    "promo_mismatch_5usd": ["PROMO_CODE_UNSYNCED"],
    "fx_micro_variance": ["FX_ROUNDING_ERROR"],
    "cod_not_remitted": ["COURIER_REMITTANCE_OVERDUE"],
    "courier_short_remittance": ["COURIER_UNEXPLAINED_DEDUCTION"],
    "rider_short_collection": ["RIDER_SHORT_COLLECTION"],
    "courier_overcharge": ["EXCESS_COURIER_CHARGES"],
    "returned_but_booked": ["REVENUE_NOT_REVERSED_ON_RETURN"],
    "parcel_lost_or_stuck": ["PARCEL_LOST_IN_TRANSIT", "PARCEL_STUCK_IN_TRANSIT"],
    "cod_never_dispatched": ["COD_ORDER_NOT_DISPATCHED"],
    "parcel_without_erp_order": ["UNBOOKED_COD_SALE"],
    "settlement_not_deposited": ["GATEWAY_PAYOUT_NOT_RECEIVED", "COURIER_REMITTANCE_NOT_RECEIVED"],
    "bank_charges_deducted": ["BANK_CHARGES_DEDUCTED"],
    "short_deposit": ["UNEXPLAINED_SETTLEMENT_SHORTFALL"],
    "unidentified_credit": ["UNIDENTIFIED_SETTLEMENT_CREDIT"],
}


@pytest.mark.slow
@pytest.mark.parametrize("seed, fx_noise", [(7, "0"), (42, "0.02"), (2026, "0")])
def test_every_planted_anomaly_is_found_exactly_once(db, seed, fx_noise):
    """Seed a dirty dataset, run reconciliation + Auto-Healer, and compare planted vs found per root cause."""
    from app.utils import seeder

    args = seeder.build_parser().parse_args([
        "--orders", "3000", "--batch-size", "1000", "--seed", str(seed), "--fx-noise-rate", fx_noise,
        "--email", f"seed{seed}@example.com", "--company-name", f"Seed {seed}", "--reconcile"])
    with contextlib.redirect_stdout(io.StringIO()):
        stats = seeder.run(args)
    planted = {**stats.anomalies, **stats.cod_anomalies, **stats.bank_anomalies}
    with db.connect() as conn:
        org = conn.execute(text("SELECT org_id FROM users WHERE email = :e"), {"e": f"seed{seed}@example.com"}).scalar()
        found = dict(conn.execute(text(
            "SELECT ai_root_cause_category, COUNT(*) FROM discrepancy_logs WHERE org_id = :o GROUP BY 1"),
            {"o": str(org)}).all())
    expected = {name: planted[name] for name in PLANTED_TO_CATEGORY}
    actual = {name: sum(found.pop(cat, 0) for cat in cats) for name, cats in PLANTED_TO_CATEGORY.items()}
    assert actual == expected
    assert found == {}                                          # no false positives in any other category
    assert sum(planted.values()) > 100                          # the seed really did plant a dirty dataset


# ----------------------------------------------------------------------------- recovery & claims
def test_def10_claim_timeline_keeps_the_order_of_same_transaction_events(client, monkeypatch):
    """DEF-10: SUBMITTED and EMAILED were written in one transaction with now(), so the timeline order was random."""
    from app.services import mailer
    from tests.api.test_ingest_recon_api import full_dataset

    monkeypatch.setattr(mailer, "send_claim", lambda *a, **k: (True, None))
    token = register(client)["access_token"]
    full_dataset(client, token)
    client.post("/api/v1/reconciliation/run", headers=auth(token))
    ids = [i["log_id"] for i in client.get("/api/v1/recovery/claimable", headers=auth(token)).json()[0]["items"]]
    cid = client.post("/api/v1/claims", headers=auth(token), json={"log_ids": ids}).json()["claim_id"]
    for _ in range(5):                                   # random UUID tie-breaks would fail within a few tries
        client.post(f"/api/v1/claims/{cid}/cancel", headers=auth(token))
        cid = client.post("/api/v1/claims", headers=auth(token), json={"log_ids": ids}).json()["claim_id"]
        events = client.post(f"/api/v1/claims/{cid}/submit", headers=auth(token),
                             json={"send_email": True, "counterparty_contact": "c@tcs.example.com"}).json()["events"]
        assert [e["kind"] for e in events] == ["CREATED", "SUBMITTED", "EMAILED"]
        client.post(f"/api/v1/claims/{cid}/reject", headers=auth(token), json={"note": "reset for next round"})
