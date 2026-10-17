"""Black-box API tests: recovery & claims (HTTP only)."""
import pytest

from app.services import mailer
from tests.api.test_ingest_recon_api import full_dataset
from tests.helpers import add_member, auth, register

pytestmark = pytest.mark.api


@pytest.fixture
def company(client):
    owner = register(client)["access_token"]
    analyst = add_member(client, owner, "analyst@acme.test", "ANALYST")
    auditor = add_member(client, owner, "auditor@acme.test", "AUDITOR")
    viewer = add_member(client, owner, "viewer@acme.test", "VIEWER")
    full_dataset(client, owner)
    client.post("/api/v1/reconciliation/run", headers=auth(owner))
    return {"owner": owner, "analyst": analyst, "auditor": auditor, "viewer": viewer}


def claimable(client, token):
    return client.get("/api/v1/recovery/claimable", headers=auth(token)).json()


def draft(client, token, **body):
    group = claimable(client, token)[0]
    ids = [i["log_id"] for i in group["items"]]
    return client.post("/api/v1/claims", headers=auth(token), json={"log_ids": ids, **body})


def test_claimable_groups_by_counterparty(client, company):
    groups = claimable(client, company["viewer"])                       # reading is open to every role
    assert [(g["counterparty_name"], g["count"], float(g["total"])) for g in groups] == [("TCS", 1, 67.5)]                 # 70.00 COD less 2.50 delivery charges
    item = groups[0]["items"][0]
    assert item["source_order_number"] == "C2" and item["issue_type"] == "COD_NOT_REMITTED"
    assert item["evidence"]["tracking_number"] == "T2"


def test_full_claim_journey(client, company):
    res = draft(client, company["analyst"], notes="September COD")
    assert res.status_code == 201
    claim = res.json()
    assert claim["claim_number"] == "CLM-0001" and claim["status"] == "DRAFT" and float(claim["claimed_amount"]) == 67.5
    cid = claim["claim_id"]
    matrix = client.get("/api/v1/discrepancies?search=C2", headers=auth(company["owner"])).json()["items"][0]
    assert matrix["claim_number"] == "CLM-0001"
    assert claimable(client, company["analyst"]) == []

    sent = client.post(f"/api/v1/claims/{cid}/submit", headers=auth(company["analyst"]), json={}).json()
    assert sent["status"] == "SUBMITTED" and sent["email_sent"] is None
    over = client.post(f"/api/v1/claims/{cid}/payments", headers=auth(company["analyst"]), json={"amount": "67.51"})
    assert over.status_code == 422
    paid = client.post(f"/api/v1/claims/{cid}/payments", headers=auth(company["analyst"]),
                       json={"amount": "67.50", "reference": "IBFT-889", "received_on": "2026-10-15"}).json()
    assert paid["status"] == "RECOVERED" and paid["resolutions"] == [{"source_order_number": "C2", "status": "PENDING_APPROVAL"}]
    assert [e["kind"] for e in paid["events"]] == ["CREATED", "SUBMITTED", "PAYMENT"]
    assert paid["events"][-1]["occurred_on"] == "2026-10-15"

    approval = client.get("/api/v1/approvals?proposed_by_type=USER", headers=auth(company["auditor"])).json()["items"][0]
    assert approval["root_cause_category"] == "RECOVERED_FROM_COUNTERPARTY" and "IBFT-889" in approval["maker_note"]
    assert client.post(f"/api/v1/approvals/{approval['request_id']}/approve", headers=auth(company["auditor"])).status_code == 200

    summary = client.get("/api/v1/recovery/summary", headers=auth(company["owner"])).json()
    assert float(summary["recovered_total"]) == 67.5 and float(summary["recovery_rate_pct"]) == 100.0
    assert summary["open_claims"] == 0 and summary["claimable_count"] == 0


def test_email_letter_to_the_courier(client, company, monkeypatch):
    sent = []
    monkeypatch.setattr(mailer, "send_claim", lambda *a, **k: (sent.append((a, k)), (True, None))[1])
    cid = draft(client, company["analyst"]).json()["claim_id"]
    res = client.post(f"/api/v1/claims/{cid}/submit", headers=auth(company["analyst"]),
                      json={"send_email": True, "counterparty_contact": "claims@tcs.example.com"}).json()
    assert res["email_sent"] is True and res["counterparty_contact"] == "claims@tcs.example.com"
    (to, subject, body, html_body), kwargs = sent[0]
    assert to == "claims@tcs.example.com" and "CLM-0001" in subject and "C2" in body and "<table" in html_body
    assert kwargs["reply_to"] == "analyst@acme.test"
    assert [e["kind"] for e in res["events"]][-1] == "EMAILED"


def test_without_smtp_the_letter_is_still_available(client, company):
    cid = draft(client, company["analyst"], counterparty_contact="claims@tcs.example.com").json()["claim_id"]
    res = client.post(f"/api/v1/claims/{cid}/submit", headers=auth(company["analyst"]), json={"send_email": True}).json()
    assert res["status"] == "SUBMITTED" and res["email_sent"] is False and "copy or print" in res["email_error"]
    letter = client.get(f"/api/v1/claims/{cid}/letter", headers=auth(company["viewer"])).json()
    assert "CLM-0001" in letter["subject"] and "<table" in letter["html"] and "TCS" in letter["text"]


@pytest.mark.parametrize("role", ["auditor", "viewer"])
def test_checkers_and_viewers_cannot_run_claims(client, company, role):
    assert draft(client, company[role]).status_code == 403
    cid = draft(client, company["analyst"]).json()["claim_id"]
    for path, body in [("submit", {}), ("payments", {"amount": "1"}), ("reject", {"note": "no way"}),
                       ("write-off", {"note": "give up"}), ("cancel", None)]:
        assert client.post(f"/api/v1/claims/{cid}/{path}", headers=auth(company[role]), json=body).status_code == 403


def test_validation_and_state_rules(client, company):
    analyst = auth(company["analyst"])
    assert client.post("/api/v1/claims", headers=analyst, json={"log_ids": []}).status_code == 422
    assert client.post("/api/v1/claims", headers=analyst,
                       json={"log_ids": ["00000000-0000-0000-0000-000000000000"]}).status_code == 409
    cid = draft(client, company["analyst"]).json()["claim_id"]
    assert client.post(f"/api/v1/claims/{cid}/payments", headers=analyst, json={"amount": "5"}).status_code == 409
    assert client.post(f"/api/v1/claims/{cid}/payments", headers=analyst, json={"amount": "-5"}).status_code == 422
    assert client.post(f"/api/v1/claims/{cid}/reject", headers=analyst, json={"note": "x"}).status_code == 422
    assert client.get("/api/v1/claims?status=NONSENSE", headers=analyst).status_code == 422
    assert client.post(f"/api/v1/claims/{cid}/cancel", headers=analyst).json()["status"] == "CANCELLED"
    assert client.get("/api/v1/claims?status=OPEN", headers=analyst).json()["total"] == 0
    assert claimable(client, company["analyst"])[0]["count"] == 1                 # released again


def test_reject_then_write_off_a_new_claim(client, company):
    analyst = auth(company["analyst"])
    first = draft(client, company["analyst"]).json()["claim_id"]
    client.post(f"/api/v1/claims/{first}/submit", headers=analyst, json={})
    assert client.post(f"/api/v1/claims/{first}/reject", headers=analyst,
                       json={"note": "TCS disputes delivery"}).json()["status"] == "REJECTED"
    second = draft(client, company["analyst"]).json()
    assert second["claim_number"] == "CLM-0002"
    client.post(f"/api/v1/claims/{second['claim_id']}/submit", headers=analyst, json={})
    off = client.post(f"/api/v1/claims/{second['claim_id']}/write-off", headers=analyst,
                      json={"note": "Below cost of pursuing"}).json()
    assert off["status"] == "WRITTEN_OFF" and float(off["written_off_amount"]) == 67.5
    assert off["resolutions"] == [{"source_order_number": "C2", "status": "PENDING_APPROVAL"}]


def test_claims_are_tenant_scoped(client, company):
    cid = draft(client, company["analyst"]).json()["claim_id"]
    intruder = register(client, "Intruder Co", "x@intruder.test")["access_token"]
    assert client.get(f"/api/v1/claims/{cid}", headers=auth(intruder)).status_code == 404
    assert client.get(f"/api/v1/claims/{cid}/letter", headers=auth(intruder)).status_code == 404
    assert client.post(f"/api/v1/claims/{cid}/submit", headers=auth(intruder), json={}).status_code == 404
    assert client.get("/api/v1/claims", headers=auth(intruder)).json()["total"] == 0
    assert claimable(client, intruder) == []


def test_agent_answers_recovery_questions(client, company):
    cid = draft(client, company["analyst"]).json()["claim_id"]
    client.post(f"/api/v1/claims/{cid}/submit", headers=auth(company["analyst"]), json={})
    res = client.post("/api/v1/agent/query", headers=auth(company["owner"]),
                      json={"question": "How much have we recovered from couriers?"}).json()
    assert "recovery_claims" in res["sql"] and res["rows"][0]["counterparty_name"] == "TCS"
