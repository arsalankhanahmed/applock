"""Black-box API tests: maker-checker approvals, approval policy, invitations and passwords."""
import re

import pytest

from app.config import settings
from tests.api.test_ingest_recon_api import full_dataset
from tests.helpers import PASSWORD, add_member, auth, login, register

pytestmark = pytest.mark.api


@pytest.fixture
def company(client):
    owner = register(client)["access_token"]
    analyst = add_member(client, owner, "analyst@acme.test", "ANALYST")
    auditor = add_member(client, owner, "auditor@acme.test", "AUDITOR")
    full_dataset(client, owner)
    client.post("/api/v1/reconciliation/run", headers=auth(owner))
    return {"owner": owner, "analyst": analyst, "auditor": auditor}


def open_finding(client, token, issue):
    return client.get(f"/api/v1/discrepancies?issue_type={issue}&status=UNRESOLVED", headers=auth(token)).json()["items"][0]


# ----------------------------------------------------------------------------- maker-checker
def test_maker_checker_happy_path(client, company):
    log = open_finding(client, company["analyst"], "MISSING_PAYMENT")
    res = client.post(f"/api/v1/discrepancies/{log['log_id']}/resolve", headers=auth(company["analyst"]),
                      json={"resolution_note": "Paid by bank transfer"})
    assert res.status_code == 200 and res.json()["status"] == "PENDING_APPROVAL"
    queue = client.get("/api/v1/approvals?proposed_by_type=USER", headers=auth(company["auditor"])).json()
    request = queue["items"][0]
    assert queue["total"] == 1 and request["is_mine"] is False and request["maker_note"] == "Paid by bank transfer"
    own = client.post(f"/api/v1/approvals/{request['request_id']}/approve", headers=auth(company["analyst"]))
    assert own.status_code == 403
    ok = client.post(f"/api/v1/approvals/{request['request_id']}/approve", headers=auth(company["auditor"]), json={"note": "Seen"})
    assert ok.status_code == 200 and ok.json()["status"] == "APPROVED"
    resolved = client.get(f"/api/v1/discrepancies?search={log['source_order_number']}", headers=auth(company["owner"])).json()["items"][0]
    assert resolved["status"] == "RESOLVED"


def test_resolving_twice_is_refused(client, company):
    log = open_finding(client, company["analyst"], "MISSING_PAYMENT")
    url = f"/api/v1/discrepancies/{log['log_id']}/resolve"
    assert client.post(url, headers=auth(company["analyst"]), json={"resolution_note": "first"}).status_code == 200
    assert client.post(url, headers=auth(company["analyst"]), json={"resolution_note": "again"}).status_code == 404


def test_reject_needs_reason_and_bulk_approve_reports_failures(client, company):
    ai = client.get("/api/v1/approvals?proposed_by_type=AI", headers=auth(company["auditor"])).json()["items"]
    assert len(ai) == 1
    rid = ai[0]["request_id"]
    assert client.post(f"/api/v1/approvals/{rid}/reject", headers=auth(company["auditor"]), json={}).status_code == 422
    bulk = client.post("/api/v1/approvals/bulk-approve", headers=auth(company["auditor"]),
                       json={"request_ids": [rid, "00000000-0000-0000-0000-000000000000"]}).json()
    assert bulk["approved"] == [rid] and list(bulk["failed"].values()) == ["Approval request not found"]


def test_policy_is_admin_only_and_validated(client, company):
    body = {"auto_heal_mode": "AUTO", "auto_heal_max_amount": "5", "manual_requires_approval": False, "manual_auto_approve_max": "0"}
    assert client.put("/api/v1/approval-policy", headers=auth(company["auditor"]), json=body).status_code == 403
    assert client.put("/api/v1/approval-policy", headers=auth(company["owner"]), json={**body, "auto_heal_mode": "YOLO"}).status_code == 422
    assert client.put("/api/v1/approval-policy", headers=auth(company["owner"]), json={**body, "auto_heal_max_amount": "-1"}).status_code == 422
    saved = client.put("/api/v1/approval-policy", headers=auth(company["owner"]), json=body).json()
    assert saved["auto_heal_mode"] == "AUTO" and saved["updated_by_email"] == "owner@acme.test"
    log = open_finding(client, company["analyst"], "MISSING_PAYMENT")
    res = client.post(f"/api/v1/discrepancies/{log['log_id']}/resolve", headers=auth(company["analyst"]), json={"resolution_note": "ok now"})
    assert res.json()["status"] == "RESOLVED"                         # manual approval switched off


def test_approvals_are_tenant_scoped(client, company):
    rid = client.get("/api/v1/approvals", headers=auth(company["owner"])).json()["items"][0]["request_id"]
    intruder = register(client, "Intruder Co", "x@intruder.test")["access_token"]
    assert client.get("/api/v1/approvals", headers=auth(intruder)).json()["total"] == 0
    assert client.post(f"/api/v1/approvals/{rid}/approve", headers=auth(intruder)).status_code == 404


def test_metrics_reflect_the_queue(client, company):
    metrics = client.get("/api/v1/dashboard/metrics", headers=auth(company["owner"])).json()
    assert metrics["pending_approval_count"] == 1 and float(metrics["pending_approval_value"]) == 5.0
    assert metrics["open_discrepancies"] == 4                         # pending still counts as open
    assert {c["channel"] for c in metrics["by_channel"]} == {"GATEWAY", "BANK", "COD"}
    assert metrics["courier_summary"][0]["courier_name"] == "TCS"


# ----------------------------------------------------------------------------- invitations
def invite(client, token, email, role="AUDITOR"):
    return client.post("/api/v1/invites", headers=auth(token), json={"email": email, "role": role, "full_name": "New Person"})


def token_of(url):
    return re.search(r"token=([\w-]+)", url).group(1)


def test_invite_lifecycle(client):
    owner = register(client)["access_token"]
    res = invite(client, owner, "New@Acme.test")
    assert res.status_code == 201
    sent = res.json()
    assert sent["email_sent"] is False and "not configured" in sent["email_error"]   # SMTP off in tests
    assert sent["invite_url"].startswith("http://app.test/invite?token=")
    t = token_of(sent["invite_url"])
    public = client.get(f"/api/v1/invites/token/{t}").json()
    assert public["email"] == "new@acme.test" and public["company_name"] == "Acme Retail" and public["role"] == "AUDITOR"
    assert client.post(f"/api/v1/invites/token/{t}/accept", json={"full_name": "New Person", "password": "short"}).status_code == 422
    joined = client.post(f"/api/v1/invites/token/{t}/accept", json={"full_name": "New Person", "password": PASSWORD})
    assert joined.status_code == 201 and joined.json()["role"] == "AUDITOR"
    assert client.get("/api/v1/me", headers=auth(joined.json()["access_token"])).status_code == 200
    assert client.post(f"/api/v1/invites/token/{t}/accept", json={"full_name": "X Y", "password": PASSWORD}).status_code == 409
    assert client.get("/api/v1/invites", headers=auth(owner)).json() == []          # no longer pending


def test_resend_rotates_and_revoke_kills_the_link(client):
    owner = register(client)["access_token"]
    first = invite(client, owner, "n@acme.test").json()
    resent = client.post(f"/api/v1/invites/{first['invite_id']}/resend", headers=auth(owner)).json()
    assert client.get(f"/api/v1/invites/token/{token_of(first['invite_url'])}").status_code == 404
    assert client.get(f"/api/v1/invites/token/{token_of(resent['invite_url'])}").status_code == 200
    assert client.delete(f"/api/v1/invites/{first['invite_id']}", headers=auth(owner)).status_code == 204
    assert client.get(f"/api/v1/invites/token/{token_of(resent['invite_url'])}").status_code == 404
    assert client.post(f"/api/v1/invites/{first['invite_id']}/resend", headers=auth(owner)).status_code == 409


def test_expired_invites(client, monkeypatch):
    owner = register(client)["access_token"]
    monkeypatch.setattr(settings, "INVITE_EXPIRY_DAYS", -1)
    sent = invite(client, owner, "late@acme.test").json()
    assert client.get(f"/api/v1/invites/token/{token_of(sent['invite_url'])}").status_code == 410
    assert client.get("/api/v1/invites", headers=auth(owner)).json()[0]["status"] == "EXPIRED"


def test_invite_rules(client):
    owner = register(client)["access_token"]
    admin = add_member(client, owner, "admin@acme.test", "ADMIN")
    analyst = add_member(client, owner, "an@acme.test", "ANALYST")
    assert invite(client, admin, "boss@acme.test", "OWNER").status_code == 403
    assert invite(client, analyst, "x@acme.test").status_code == 403
    assert invite(client, owner, "an@acme.test").status_code == 409             # already has an account
    assert client.get("/api/v1/invites/token/forged-token-value").status_code == 404
    first = invite(client, owner, "dup@acme.test").json()
    invite(client, owner, "dup@acme.test")                                      # replaces the first
    assert client.get(f"/api/v1/invites/token/{token_of(first['invite_url'])}").status_code == 404


# ----------------------------------------------------------------------------- passwords
def test_temporary_password_must_be_changed(client):
    owner = register(client)["access_token"]
    client.post("/api/v1/users", headers=auth(owner), json={"full_name": "Temp User", "email": "t@acme.test",
                                                              "password": "Temporary#123", "role": "ANALYST"})
    session = login(client, "t@acme.test", "Temporary#123").json()
    assert session["must_change_password"] is True
    token = session["access_token"]
    assert client.get("/api/v1/dashboard/metrics", headers=auth(token)).status_code == 403
    assert client.get("/api/v1/me", headers=auth(token)).status_code == 200
    wrong = client.post("/api/v1/me/password", headers=auth(token), json={"current_password": "nope", "new_password": PASSWORD})
    same = client.post("/api/v1/me/password", headers=auth(token), json={"current_password": "Temporary#123", "new_password": "Temporary#123"})
    assert (wrong.status_code, same.status_code) == (400, 422)


def test_password_change_signs_out_other_sessions(client):
    register(client)
    import time

    old = login(client, "owner@acme.test").json()["access_token"]
    time.sleep(1.1)                                                     # tokens carry whole-second timestamps
    new = client.post("/api/v1/me/password", headers=auth(old),
                      json={"current_password": PASSWORD, "new_password": "Brand#New#Pass1"}).json()["access_token"]
    assert client.get("/api/v1/me", headers=auth(old)).status_code == 401
    assert client.get("/api/v1/me", headers=auth(new)).status_code == 200
    assert login(client, "owner@acme.test", PASSWORD).status_code == 401
    assert login(client, "owner@acme.test", "Brand#New#Pass1").status_code == 200


# ----------------------------------------------------------------------------- agent & dashboard
@pytest.mark.parametrize("question", ["What is our total leakage?", "Which courier owes us the most COD?",
                                      "Which payouts never reached the bank?", "What is waiting for approval?"])
def test_agent_answers_with_tenant_scoped_sql(client, company, question):
    res = client.post("/api/v1/agent/query", headers=auth(company["owner"]), json={"question": question})
    assert res.status_code == 200
    body = res.json()
    assert ":org_id" in body["sql"] and body["engine"] == "heuristic-router" and body["narrative"]


def test_agent_validates_question_length(client, company):
    assert client.post("/api/v1/agent/query", headers=auth(company["owner"]), json={"question": "x"}).status_code == 422
