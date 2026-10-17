"""Black-box API tests: optional WhatsApp / email alerts (HTTP only)."""
import pytest

from app.config import settings
from tests.api.test_ingest_recon_api import full_dataset
from tests.helpers import add_member, auth, register

pytestmark = pytest.mark.api

SETTINGS = {"enabled": True, "frequency": "DAILY", "send_hour": 8, "timezone": "Asia/Karachi", "min_amount": "0",
            "cod_overdue_days": 7, "include_cod": True, "include_settlements": True, "include_approvals": True,
            "include_recovery": True, "send_when_clear": False}


@pytest.fixture
def company(client):
    owner = register(client)["access_token"]
    analyst = add_member(client, owner, "analyst@acme.test", "ANALYST")
    full_dataset(client, owner)
    client.post("/api/v1/reconciliation/run", headers=auth(owner))
    return {"owner": owner, "analyst": analyst}


def test_alerts_are_off_by_default_and_report_what_the_server_can_send(client, company):
    res = client.get("/api/v1/alerts/settings", headers=auth(company["owner"])).json()
    assert res["enabled"] is False and res["send_hour"] == 9 and res["timezone"] == "Asia/Karachi"
    assert res["channels"]["whatsapp_ready"] is False and "not configured" in res["channels"]["whatsapp_problem"]
    assert res["channels"]["email_ready"] is False


def test_switching_on_and_validation(client, company):
    owner = auth(company["owner"])
    saved = client.put("/api/v1/alerts/settings", headers=owner, json=SETTINGS).json()
    assert saved["enabled"] is True and saved["send_hour"] == 8 and saved["updated_by_email"] == "owner@acme.test"
    for bad in [{"timezone": "Nowhere/City"}, {"send_hour": 24}, {"frequency": "HOURLY"}, {"min_amount": "-1"},
                {"cod_overdue_days": 0}]:
        assert client.put("/api/v1/alerts/settings", headers=owner, json={**SETTINGS, **bad}).status_code == 422, bad


@pytest.mark.parametrize("path, method, body", [
    ("/api/v1/alerts/settings", "get", None), ("/api/v1/alerts/settings", "put", SETTINGS),
    ("/api/v1/alerts/recipients", "get", None),
    ("/api/v1/alerts/recipients", "post", {"name": "X Y", "channel": "WHATSAPP", "address": "+923001234567", "consent": True}),
    ("/api/v1/alerts/test", "post", {}), ("/api/v1/alerts/deliveries", "get", None),
])
def test_only_owners_and_admins_manage_alerts(client, company, path, method, body):
    res = getattr(client, method)(path, headers=auth(company["analyst"]), **({"json": body} if body is not None else {}))
    assert res.status_code == 403


def test_everyone_can_preview_the_digest(client, company):
    res = client.get("/api/v1/alerts/preview", headers=auth(company["analyst"])).json()
    assert res["has_content"] is True
    assert res["lines"][0].startswith("TCS holds USD 67.50 COD for 1 order")
    assert "\n" not in res["whatsapp_summary"] and res["text"].startswith("AuditX alert · Acme Retail")


def test_recipients_lifecycle(client, company):
    owner = auth(company["owner"])
    body = {"name": "Ayesha Finance", "channel": "WHATSAPP", "address": "+92 300 1234567", "consent": False}
    assert client.post("/api/v1/alerts/recipients", headers=owner, json=body).status_code == 422       # no consent
    assert client.post("/api/v1/alerts/recipients", headers=owner, json={**body, "consent": True, "address": "0300"}).status_code == 422
    created = client.post("/api/v1/alerts/recipients", headers=owner, json={**body, "consent": True}).json()
    assert created["address"] == "+923001234567" and created["active"] is True
    assert client.post("/api/v1/alerts/recipients", headers=owner, json={**body, "consent": True}).status_code == 409
    rid = created["recipient_id"]
    assert client.patch(f"/api/v1/alerts/recipients/{rid}", headers=owner, json={"active": False}).json()["active"] is False
    assert client.delete(f"/api/v1/alerts/recipients/{rid}", headers=owner).status_code == 204
    assert client.get("/api/v1/alerts/recipients", headers=owner).json() == []


def test_test_send_and_delivery_log(client, company, monkeypatch):
    owner = auth(company["owner"])
    assert client.post("/api/v1/alerts/test", headers=owner, json={}).status_code == 409                # no recipients
    client.post("/api/v1/alerts/recipients", headers=owner,
                json={"name": "Ayesha", "channel": "WHATSAPP", "address": "+923001234567", "consent": True})
    not_ready = client.post("/api/v1/alerts/test", headers=owner, json={}).json()[0]
    assert not_ready["sent"] is False and "not configured" in not_ready["error"]
    monkeypatch.setattr(settings, "WHATSAPP_PROVIDER", "log")
    ok = client.post("/api/v1/alerts/test", headers=owner, json={}).json()[0]
    assert ok["sent"] is True and ok["provider"] == "log" and ok["address_masked"] == "+923******567"
    log = client.get("/api/v1/alerts/deliveries", headers=owner).json()
    assert [(d["kind"], d["status"]) for d in log] == [("TEST", "SENT"), ("TEST", "FAILED")]
    assert "TCS holds" in log[0]["summary"] and log[0]["recipient_name"] == "Ayesha"
    assert "+923001234567" not in str(log)                                    # the log never stores the full number


def test_cron_endpoint_needs_its_token(client, company, monkeypatch):
    url = "/api/v1/internal/alerts/run-due"
    assert client.post(url).status_code == 404                                # disabled without a token
    monkeypatch.setattr(settings, "ALERTS_CRON_TOKEN", "s3cret-cron-token")
    assert client.post(url, headers={"X-Cron-Token": "wrong"}).status_code == 403
    monkeypatch.setattr(settings, "WHATSAPP_PROVIDER", "log")
    owner = auth(company["owner"])
    client.put("/api/v1/alerts/settings", headers=owner, json={**SETTINGS, "send_hour": 0})
    client.post("/api/v1/alerts/recipients", headers=owner,
                json={"name": "Ayesha", "channel": "WHATSAPP", "address": "+923001234567", "consent": True})
    first = client.post(url, headers={"X-Cron-Token": "s3cret-cron-token"}).json()
    again = client.post(url, headers={"X-Cron-Token": "s3cret-cron-token"}).json()
    assert (first["sent"], again["sent"]) == (1, 0)                           # once per period


def test_alert_settings_are_tenant_scoped(client, company):
    owner = auth(company["owner"])
    rid = client.post("/api/v1/alerts/recipients", headers=owner, json={
        "name": "Ayesha", "channel": "WHATSAPP", "address": "+923001234567", "consent": True}).json()["recipient_id"]
    intruder = auth(register(client, "Intruder Co", "x@intruder.test")["access_token"])
    assert client.get("/api/v1/alerts/recipients", headers=intruder).json() == []
    assert client.patch(f"/api/v1/alerts/recipients/{rid}", headers=intruder, json={"active": False}).status_code == 404
    assert client.delete(f"/api/v1/alerts/recipients/{rid}", headers=intruder).status_code == 404
    assert client.post("/api/v1/alerts/test", headers=intruder, json={"recipient_id": rid}).status_code == 404
    assert client.get("/api/v1/alerts/deliveries", headers=intruder).json() == []


def test_agent_cannot_read_alert_recipients(client, company):
    from app.services.ai_agent import UnsafeQueryError, guard_sql

    with pytest.raises(UnsafeQueryError):
        guard_sql("SELECT address FROM alert_recipients WHERE org_id = :org_id")
