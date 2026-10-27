import time
from datetime import timedelta

from app.database import Alert, Device, Notification, session_scope, utcnow
from app.services import alerts as engine


def post(client, device, readings, **extra):
    return client.post("/api/device/ingest", headers=device["headers"], json={"readings": readings, **extra})


def sensor_id(client, device, key="temp"):
    dev = client.get(f"/api/devices/{device['id']}").json()
    return next(s["id"] for s in dev["sensors"] if s["key"] == key)


def test_login_rejects_wrong_password(client):
    r = client.post("/api/auth/login", json={"email": "admin@test.local", "password": "nope"})
    assert r.status_code == 401


def test_dashboard_requires_login(client):
    assert client.get("/api/overview", headers={"Authorization": ""}).status_code == 401


def test_device_needs_valid_key(client, device):
    r = client.post("/api/device/ingest", headers={"X-Device-Serial": device["serial"], "X-Device-Key": "x"},
                    json={"readings": []})
    assert r.status_code == 401


def test_ingest_creates_sensors_and_returns_config(client, device):
    now = int(time.time())
    r = post(client, device, [{"ts": now, "values": {"temp": 4.5, "hum": 52.0, "broken": None}}],
             firmware="0.1.0", mains_power=True)
    assert r.status_code == 200
    body = r.json()
    assert body["stored"] == 2 and body["interval_seconds"] == 60
    dev = client.get(f"/api/devices/{device['id']}").json()
    kinds = {s["key"]: (s["kind"], s["unit"]) for s in dev["sensors"]}
    assert kinds == {"temp": ("temperature", "°C"), "hum": ("humidity", "%")}
    assert dev["online"] and dev["firmware"] == "0.1.0"


def test_duplicate_and_bad_clock_readings(client, device):
    now = int(time.time())
    post(client, device, [{"ts": now - 60, "values": {"temp": 4.0}}])
    r = post(client, device, [{"ts": now - 60, "values": {"temp": 4.0}}, {"ts": 1000, "values": {"temp": 4.1}}])
    assert r.json()["stored"] == 1                     # duplicate skipped; unsynced clock -> server time


def test_high_temperature_alert_respects_delay_then_resolves(client, device):
    post(client, device, [{"ts": int(time.time()) - 600, "values": {"temp": 5.0}}])
    sid = sensor_id(client, device)
    assert client.patch(f"/api/sensors/{sid}", json={"min_value": 2, "max_value": 8, "delay_minutes": 5}
                        ).status_code == 200
    client.post("/api/contacts", json={"name": "Shift lead", "email": "lead@test.local", "phone": "03001234567",
                                       "channels": ["email", "whatsapp", "sms"], "level": 1})
    base = int(time.time()) - 540
    # 3 minutes above max: still within the delay, no alert.
    post(client, device, [{"ts": base + i * 60, "values": {"temp": 9.0 + i * 0.1}} for i in range(4)])
    assert client.get("/api/alerts?status=active").json() == []
    # Past 5 minutes: alert opens, peak tracked.
    post(client, device, [{"ts": base + i * 60, "values": {"temp": 9.0 + i * 0.1}} for i in range(4, 7)])
    active = client.get("/api/alerts?status=active").json()
    assert len(active) == 1 and active[0]["kind"] == "HIGH" and active[0]["peak_value"] == 9.6
    detail = client.get(f"/api/alerts/{active[0]['id']}").json()
    assert {n["channel"] for n in detail["notifications"]} == {"email", "whatsapp", "sms"}
    assert all(n["ok"] for n in detail["notifications"])
    # Back in range: resolved.
    post(client, device, [{"ts": base + 420, "values": {"temp": 6.0}}])
    assert client.get("/api/alerts?status=active").json() == []
    detail = client.get(f"/api/alerts/{active[0]['id']}").json()
    assert detail["status"] == "RESOLVED"
    assert any(n["event"] == "resolved" for n in detail["notifications"])


def test_buffered_excursion_is_reported_once(client, device):
    post(client, device, [{"ts": int(time.time()) - 3600, "values": {"temp": 5.0}}])
    sid = sensor_id(client, device)
    client.patch(f"/api/sensors/{sid}", json={"max_value": 8, "delay_minutes": 0})
    client.post("/api/contacts", json={"name": "QA", "email": "qa@test.local", "channels": ["email"]})
    base = int(time.time()) - 1800
    post(client, device, [{"ts": base, "values": {"temp": 10}}, {"ts": base + 60, "values": {"temp": 5}}])
    alerts = client.get("/api/alerts").json()
    assert len(alerts) == 1 and alerts[0]["status"] == "RESOLVED"
    events = [n["event"] for n in client.get(f"/api/alerts/{alerts[0]['id']}").json()["notifications"]]
    assert events == ["excursion"]


def test_power_failure_alert(client, device):
    post(client, device, [], mains_power=False)
    active = client.get("/api/alerts?status=active").json()
    assert [a["kind"] for a in active] == ["POWER"]
    post(client, device, [], mains_power=True)
    assert client.get("/api/alerts?status=active").json() == []


def test_offline_alert_escalation_ack_and_recovery(client, device):
    client.post("/api/contacts", json={"name": "Operator", "email": "op@test.local", "level": 1})
    client.post("/api/contacts", json={"name": "Manager", "email": "mgr@test.local", "level": 2})
    post(client, device, [])
    with session_scope() as db:
        db.get(Device, device["id"]).last_seen_at = utcnow() - timedelta(minutes=10)
    now = utcnow()
    with session_scope() as db:
        events = engine.tick(db, now)
        engine.deliver(db, events)
    active = client.get("/api/alerts?status=active").json()
    assert [a["kind"] for a in active] == ["OFFLINE"] and active[0]["level"] == 1

    with session_scope() as db:                       # nobody acknowledged for 15 minutes -> level 2
        events = engine.tick(db, now + timedelta(minutes=16))
        engine.deliver(db, events)
        assert [e.name for e in events] == ["escalated"]
        sent = db.query(Notification).filter_by(alert_id=active[0]["id"], event="escalated").all()
        assert [n.recipient for n in sent] == ["mg***@test.local"]

    with session_scope() as db:                       # top level reached: reminders after 30 minutes
        db.get(Alert, active[0]["id"]).last_notified_at = now
        assert [e.name for e in engine.tick(db, now + timedelta(minutes=31))] == ["reminder"]

    r = client.post(f"/api/alerts/{active[0]['id']}/ack", json={"note": "Router rebooting"})
    assert r.status_code == 200 and r.json()["status"] == "ACKED"
    with session_scope() as db:                       # acknowledged: no more escalation or reminders
        assert engine.tick(db, now + timedelta(hours=2)) == []

    post(client, device, [])                          # device back: resolves
    assert client.get("/api/alerts?status=active").json() == []


def test_report_and_csv(client, device):
    base = int(time.time()) - 3600
    post(client, device, [{"ts": base + i * 60, "values": {"temp": v}} for i, v in enumerate([4, 5, 6, 9, 5])])
    sid = sensor_id(client, device)
    client.patch(f"/api/sensors/{sid}", json={"min_value": 2, "max_value": 8, "delay_minutes": 30})
    summary = client.get(f"/api/sensors/{sid}/report").json()["summary"]
    assert summary["count"] == 5 and summary["max"] == 9 and summary["minutes_out_of_range"] == 1.0
    assert 5.0 < summary["mkt"] < 6.5
    csv_text = client.get(f"/api/sensors/{sid}/export.csv").text
    assert csv_text.count("\n") == 6 and ",HIGH" in csv_text
    points = client.get(f"/api/sensors/{sid}/readings").json()["points"]
    assert len(points) == 5


def test_threshold_validation_and_audit(client, device):
    post(client, device, [{"values": {"temp": 4}}])
    sid = sensor_id(client, device)
    assert client.patch(f"/api/sensors/{sid}", json={"min_value": 9, "max_value": 8}).status_code == 422
    client.patch(f"/api/sensors/{sid}", json={"max_value": 8})
    actions = [a["action"] for a in client.get("/api/audit").json()]
    assert "sensor.update" in actions and "device.create" in actions


def test_operator_cannot_change_thresholds(client, device):
    client.post("/api/users", json={"email": "op@example.com", "password": "operator-1", "role": "OPERATOR"})
    token = client.post("/api/auth/login", json={"email": "op@example.com", "password": "operator-1"}).json()["token"]
    post(client, device, [{"values": {"temp": 4}}])
    sid = sensor_id(client, device)
    r = client.patch(f"/api/sensors/{sid}", json={"max_value": 8}, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_contact_phone_normalised_and_validated(client):
    r = client.post("/api/contacts", json={"name": "A", "phone": "0300-1234567", "channels": ["sms"]})
    assert r.status_code == 200 and r.json()["phone"] == "+923001234567"
    assert client.post("/api/contacts", json={"name": "B", "channels": ["sms"]}).status_code == 422


def test_tick_endpoint_needs_token(client):
    assert client.post("/api/internal/tick").status_code == 403
    assert client.post("/api/internal/tick", headers={"X-Tick-Token": "tick-secret"}).status_code == 200


def test_unsynced_clock_uses_uptime_from_same_boot(client, device):
    r = post(client, device, [{"up": 100_000, "boot": 7, "values": {"temp": 4.0}},
                              {"up": 50_000, "boot": 6, "values": {"temp": 4.1}}], uptime_ms=700_000, boot=7)
    assert r.json()["stored"] == 2
    sid = sensor_id(client, device)
    points = client.get(f"/api/sensors/{sid}/readings").json()["points"]
    from datetime import datetime
    stamps = sorted(datetime.fromisoformat(t[:-1]) for t, _ in points)
    assert 595 <= (stamps[1] - stamps[0]).total_seconds() <= 605      # 600 s before upload vs. "now"


# --- Stock-aware cooling control & ERP integration -----------------------------------------------------------

def erp_key(client):
    return client.post("/api/api-keys", json={"name": "SAP B1"}).json()["key"]


def test_erp_requires_valid_key(client, device):
    assert client.post("/api/erp/stock", json={"device": device["serial"], "state": "empty"}).status_code == 401
    key = erp_key(client)
    kid = client.get("/api/api-keys").json()[0]["id"]
    client.delete(f"/api/api-keys/{kid}")
    r = client.post("/api/erp/stock", json={"device": device["serial"], "state": "empty"}, headers={"X-API-Key": key})
    assert r.status_code == 401


def test_stock_empty_pauses_alerts_and_switches_cooling_off_after_delay(client, device):
    post(client, device, [{"ts": int(time.time()) - 600, "values": {"temp": 5.0}}], cooling="on")
    sid = sensor_id(client, device)
    client.patch(f"/api/sensors/{sid}", json={"min_value": 2, "max_value": 8, "delay_minutes": 0})
    client.post("/api/contacts", json={"name": "Store", "email": "store@test.local", "level": 1})
    client.patch(f"/api/devices/{device['id']}", json={"erp_code": "WH1-FRIDGE-03", "auto_cooling_off": True})
    post(client, device, [{"ts": int(time.time()) - 540, "values": {"temp": 9.5}}])
    assert len(client.get("/api/alerts?status=active").json()) == 1

    key = erp_key(client)
    r = client.post("/api/erp/stock", headers={"X-API-Key": key},
                    json={"device": "WH1-FRIDGE-03", "quantity": 0, "reference": "GIN-1"})
    res = r.json()["results"][0]
    assert r.status_code == 200 and res["state"] == "empty" and res["changed"]
    assert res["cooling"] == "on" and res["cooling_off_at"]          # grace period before switching off
    assert client.get("/api/alerts?status=active").json() == []       # open HIGH alert closed

    # Warming up while empty raises no alert; device still gets "on" during the grace period.
    body = post(client, device, [{"ts": int(time.time()) - 480, "values": {"temp": 14.0}}]).json()
    assert body["cooling"] == "on" and body["sensors"] == {}
    assert client.get("/api/alerts?status=active").json() == []

    with session_scope() as db:                                      # grace period over
        db.get(Device, device["id"]).stock_updated_at = utcnow() - timedelta(minutes=31)
    body = post(client, device, [{"ts": int(time.time()) - 420, "values": {"temp": 15.0}}], cooling="off").json()
    assert body["cooling"] == "off"

    with session_scope() as db:
        info = [n.event for n in db.query(Notification).filter_by(device_id=device["id"], event="info")]
    assert len(info) == 2                                            # "stock empty" and "cooling switched off"

    events = client.get(f"/api/devices/{device['id']}/stock-events").json()
    assert events[0]["state"] == "EMPTY" and events[0]["reference"] == "GIN-1"


def test_restock_turns_cooling_on_and_waits_for_pulldown(client, device):
    post(client, device, [{"ts": int(time.time()) - 900, "values": {"temp": 5.0}}])
    sid = sensor_id(client, device)
    client.patch(f"/api/sensors/{sid}", json={"min_value": 2, "max_value": 8, "delay_minutes": 0})
    client.patch(f"/api/devices/{device['id']}", json={"auto_cooling_off": True})
    key = erp_key(client)
    client.post("/api/erp/stock", headers={"X-API-Key": key}, json={"device": device["serial"], "state": "empty"})
    with session_scope() as db:
        db.get(Device, device["id"]).stock_updated_at = utcnow() - timedelta(hours=2)
    assert post(client, device, [{"ts": int(time.time()) - 800, "values": {"temp": 18}}]).json()["cooling"] == "off"

    r = client.post("/api/erp/stock", headers={"X-API-Key": key},
                    json={"updates": [{"device": device["serial"], "state": "stocked"}, {"device": "nope", "state": "empty"}]})
    ok, bad = r.json()["results"]
    assert ok["cooling"] == "on" and bad["error"]
    # Still warm after restocking: no HIGH alert during pull-down.
    body = post(client, device, [{"ts": int(time.time()) - 700, "values": {"temp": 12}}]).json()
    assert body["cooling"] == "on" and body["sensors"]["temp"]["max"] == 8
    assert client.get("/api/alerts?status=active").json() == []
    # Back in range ends pull-down; the next excursion alerts normally.
    post(client, device, [{"ts": int(time.time()) - 600, "values": {"temp": 6}}])
    post(client, device, [{"ts": int(time.time()) - 500, "values": {"temp": 10}}])
    assert [a["kind"] for a in client.get("/api/alerts?status=active").json()] == ["HIGH"]


def test_cooling_stays_on_without_opt_in_and_override_wins(client, device):
    post(client, device, [{"values": {"temp": 5.0}}])
    key = erp_key(client)
    client.post("/api/erp/stock", headers={"X-API-Key": key}, json={"device": device["serial"], "state": "empty"})
    with session_scope() as db:
        db.get(Device, device["id"]).stock_updated_at = utcnow() - timedelta(hours=5)
    assert post(client, device, []).json()["cooling"] == "on"          # auto_cooling_off not enabled
    client.patch(f"/api/devices/{device['id']}", json={"cooling_mode": "off"})
    assert post(client, device, []).json()["cooling"] == "off"
    client.patch(f"/api/devices/{device['id']}", json={"cooling_mode": "auto"})
    assert post(client, device, []).json()["cooling"] == "on"


def test_empty_without_data_sharing_sends_heartbeat_only(client, device):
    post(client, device, [{"values": {"temp": 5.0}}])
    client.patch(f"/api/devices/{device['id']}", json={"share_data_when_empty": False})
    client.post(f"/api/devices/{device['id']}/stock", json={"state": "empty", "note": "audit test"})
    body = post(client, device, [{"values": {"temp": 20.0}}]).json()
    assert body["record"] is False and body["stored"] == 0 and body["interval_seconds"] == 900
    dev = client.get(f"/api/devices/{device['id']}").json()
    assert dev["online"] and dev["stock_state"] == "EMPTY" and not dev["recording"]
    with session_scope() as db:                                       # heartbeat interval governs OFFLINE
        db.get(Device, device["id"]).last_seen_at = utcnow() - timedelta(minutes=20)
        assert engine.tick(db) == []


def test_power_alert_suppressed_while_empty(client, device):
    client.post(f"/api/devices/{device['id']}/stock", json={"state": "empty"})
    post(client, device, [], mains_power=False)
    assert client.get("/api/alerts?status=active").json() == []


def test_erp_code_must_be_unique(client, device):
    site = device["site"]["id"]
    other = client.post("/api/devices", json={"site_id": site, "name": "Freezer"}).json()
    client.patch(f"/api/devices/{device['id']}", json={"erp_code": "BIN-1"})
    assert client.patch(f"/api/devices/{other['id']}", json={"erp_code": "BIN-1"}).status_code == 409


# --- Firmware updates ----------------------------------------------------------------------------------------

def test_firmware_upload_rollout_and_download(client, device):
    image = bytes([0xE9]) + b"\x00" * 4095
    assert client.post("/api/firmware?version=0.2.0", content=b"not firmware" * 200).status_code == 422
    fw = client.post("/api/firmware?version=0.2.0", content=image,
                     headers={"Content-Type": "application/octet-stream"}).json()
    assert fw["size"] == 4096 and len(fw["md5"]) == 32
    # Not assigned yet: no offer, and the device may not download it.
    assert "ota" not in post(client, device, [], firmware="0.1.0").json()
    assert client.get(f"/api/device/firmware/{fw['id']}.bin", headers=device["headers"]).status_code == 403
    client.post(f"/api/firmware/{fw['id']}/rollout", json={"device_ids": [device["id"]]})
    ota = post(client, device, [], firmware="0.1.0").json()["ota"]
    assert ota["version"] == "0.2.0" and ota["md5"] == fw["md5"]
    blob = client.get(ota["url"], headers=device["headers"])
    assert blob.status_code == 200 and blob.content == image
    post(client, device, [], firmware="0.2.0")
    dev = client.get(f"/api/devices/{device['id']}").json()
    assert dev["ota_status"] == "updated to 0.2.0"
    assert "ota" not in post(client, device, [], firmware="0.2.0").json()
