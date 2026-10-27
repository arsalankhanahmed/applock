"""HTTP API for devices and the dashboard, plus the background alert loop."""
from __future__ import annotations

import asyncio
import csv
import io
import logging
import math
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import (Alert, AuditLog, Contact, Device, Notification, Reading, Sensor, Site, User, audit,
                          get_db, init_db, session_scope, utcnow)
from app.schemas import (ContactIn, DeviceIn, DevicePatch, IngestIn, LoginIn, NoteIn, SensorPatch, SiteIn,
                         UserIn)
from app.security import (admin_user, create_token, current_device, current_user, hash_password, hash_secret,
                          new_device_credentials, verify_password)
from app.services import alerts as engine
from app.services import notify

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("coldchain")

STATIC_DIR = Path(__file__).parent / "static"
# Readings before this are from a device whose clock has not synced yet.
MIN_PLAUSIBLE_TS = int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp())
MAX_CHART_POINTS = 1500
# Mean kinetic temperature: activation energy / gas constant (83.144 kJ/mol / 8.3144 J/mol·K), per USP <1160>.
MKT_DELTA_H_OVER_R = 10_000.0


def run_tick() -> None:
    with session_scope() as db:
        events = engine.tick(db)
        engine.deliver(db, events)


async def _loop() -> None:
    while True:
        await asyncio.sleep(settings.TICK_SECONDS)
        try:
            await asyncio.to_thread(run_tick)
        except Exception:
            logger.exception("Alert tick failed")


def bootstrap_admin() -> None:
    with session_scope() as db:
        if db.scalar(select(func.count(User.id))) == 0:
            db.add(User(email=settings.ADMIN_EMAIL.lower(), full_name="Administrator", role="ADMIN",
                        password_hash=hash_password(settings.ADMIN_PASSWORD)))
            audit(db, "system", "user.bootstrap", settings.ADMIN_EMAIL)
            logger.warning("Created first admin %s - change its password", settings.ADMIN_EMAIL)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    bootstrap_admin()
    task = asyncio.create_task(_loop()) if settings.RUN_BACKGROUND_LOOP else None
    yield
    if task:
        task.cancel()


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)
if settings.cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"],
                       allow_headers=["*"])


# --- Serialisers --------------------------------------------------------------------------------------------

def iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat(timespec="seconds") + "Z" if dt else None


def parse_time(value: Optional[str], default: datetime) -> datetime:
    if not value:
        return default
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(422, f"Bad time: {value}")
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def device_online(device: Device, now: datetime) -> bool:
    if device.last_seen_at is None:
        return False
    limit = max(settings.OFFLINE_AFTER_MINUTES * 60, 3 * device.interval_seconds)
    return (now - device.last_seen_at).total_seconds() <= limit


def sensor_state(sensor: Sensor) -> str:
    if not sensor.enabled:
        return "disabled"
    if sensor.last_value is None:
        return "waiting"
    if sensor.breach_kind:
        return "breach"
    if sensor.min_value is None and sensor.max_value is None:
        return "unconfigured"
    return "ok"


def sensor_out(s: Sensor) -> dict:
    return {"id": s.id, "device_id": s.device_id, "key": s.key, "kind": s.kind, "label": s.label or s.key,
            "unit": s.unit, "min_value": s.min_value, "max_value": s.max_value, "delay_minutes": s.delay_minutes,
            "enabled": s.enabled, "last_value": s.last_value, "last_at": iso(s.last_at),
            "breach_since": iso(s.breach_since), "breach_kind": s.breach_kind, "state": sensor_state(s)}


def device_out(d: Device, now: datetime) -> dict:
    return {"id": d.id, "site_id": d.site_id, "site_name": d.site.name, "serial": d.serial, "name": d.name,
            "interval_seconds": d.interval_seconds, "last_seen_at": iso(d.last_seen_at),
            "online": device_online(d, now), "firmware": d.firmware, "rssi": d.rssi, "battery_pct": d.battery_pct,
            "mains_power": d.mains_power, "network": d.network,
            "sensors": [sensor_out(s) for s in sorted(d.sensors, key=lambda s: s.id)]}


def alert_out(a: Alert) -> dict:
    s = a.sensor
    return {"id": a.id, "kind": a.kind, "status": a.status, "level": a.level,
            "device_id": a.device_id, "device_name": a.device.name, "serial": a.device.serial,
            "site_name": a.device.site.name, "sensor_id": a.sensor_id,
            "sensor_label": (s.label or s.key) if s else None, "unit": s.unit if s else "",
            "threshold": a.threshold, "peak_value": a.peak_value, "started_at": iso(a.started_at),
            "opened_at": iso(a.opened_at), "acked_by": a.acked_by, "acked_at": iso(a.acked_at),
            "ack_note": a.ack_note, "resolved_at": iso(a.resolved_at),
            "summary": engine.build_message(a, "opened").summary}


def contact_out(c: Contact) -> dict:
    return {"id": c.id, "name": c.name, "email": c.email, "phone": c.phone, "channels": c.channel_list,
            "level": c.level, "site_id": c.site_id, "active": c.active}


def user_out(u: User) -> dict:
    return {"id": u.id, "email": u.email, "full_name": u.full_name, "role": u.role}


def _get(db: Session, model, obj_id: int):
    obj = db.get(model, obj_id)
    if obj is None:
        raise HTTPException(404, f"{model.__name__} not found")
    return obj


# --- Health & device ingestion ------------------------------------------------------------------------------

@app.get("/health")
def health() -> dict:
    return {"ok": True}


def _guess_sensor(key: str) -> tuple[str, str]:
    return ("humidity", "%") if key.lower().startswith(("hum", "rh")) else ("temperature", "°C")


@app.post("/api/device/ingest")
def ingest(body: IngestIn, background: BackgroundTasks, device: Device = Depends(current_device),
           db: Session = Depends(get_db)) -> dict:
    """Devices POST a batch of readings (live, or buffered while the network was down) and get their config back.

    Headers: X-Device-Serial, X-Device-Key.
    Body:    {"readings": [{"ts": 1730000000, "values": {"temp": 4.2, "hum": 51.0}}], "mains_power": true, ...}
    """
    now = utcnow()
    now_ts = int(now.replace(tzinfo=timezone.utc).timestamp())
    sensors = {s.key: s for s in device.sensors}
    events: list[engine.Event] = []
    stored = 0

    rows = []
    for r in body.readings:
        if r.ts and MIN_PLAUSIBLE_TS <= r.ts <= now_ts + settings.MAX_CLOCK_SKEW_SECONDS:
            ts = r.ts
        elif (r.up is not None and body.uptime_ms is not None and r.boot == body.boot
              and 0 <= r.up <= body.uptime_ms):
            ts = now_ts - (body.uptime_ms - r.up) // 1000
        else:
            ts = now_ts
        rows.append((min(ts, now_ts), r.values))
    rows.sort(key=lambda row: row[0])

    seen: set[tuple[int, datetime]] = set()
    for ts_int, values in rows:
        ts = datetime.fromtimestamp(ts_int, timezone.utc).replace(tzinfo=None)
        for key, value in values.items():
            if value is None or not math.isfinite(value) or not key or len(key) > 40:
                continue                                  # sensor read failure on the device
            sensor = sensors.get(key)
            if sensor is None:
                kind, unit = _guess_sensor(key)
                sensor = Sensor(device_id=device.id, key=key, kind=kind, unit=unit, label=key)
                sensor.device = device
                db.add(sensor)
                db.flush()
                sensors[key] = sensor
            if (sensor.id, ts) in seen:
                continue
            seen.add((sensor.id, ts))
            if sensor.last_at is not None and ts <= sensor.last_at and db.scalar(
                    select(Reading.id).where(Reading.sensor_id == sensor.id, Reading.ts == ts)):
                continue                                  # re-sent after a lost response
            db.add(Reading(sensor_id=sensor.id, ts=ts, value=float(value)))
            stored += 1
            events += engine.process_reading(db, sensor, ts, float(value), now)

    device.last_seen_at = now
    for field in ("firmware", "rssi", "battery_pct", "mains_power", "network"):
        value = getattr(body, field)
        if value is not None:
            setattr(device, field, value)
    events += engine.process_device_status(db, device, body.mains_power, now)
    db.commit()
    background.add_task(engine.dispatch, engine.collapse(events))

    return {"stored": stored, "server_time": now_ts, "interval_seconds": device.interval_seconds,
            "sensors": {s.key: {"min": s.min_value, "max": s.max_value} for s in sensors.values() if s.enabled}}


@app.post("/api/internal/tick")
def internal_tick(x_tick_token: str = Header(default="")) -> dict:
    if not settings.TICK_TOKEN or x_tick_token != settings.TICK_TOKEN:
        raise HTTPException(403, "Forbidden")
    run_tick()
    return {"ok": True}


# --- Auth & users -------------------------------------------------------------------------------------------

@app.post("/api/auth/login")
def login(body: LoginIn, db: Session = Depends(get_db)) -> dict:
    user = db.scalars(select(User).where(User.email == body.email.strip().lower())).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Wrong email or password")
    audit(db, user.email, "user.login")
    db.commit()
    return {"token": create_token(user), "user": user_out(user)}


@app.get("/api/me")
def me(user: User = Depends(current_user)) -> dict:
    return user_out(user)


@app.get("/api/users")
def list_users(_: User = Depends(admin_user), db: Session = Depends(get_db)) -> list[dict]:
    return [user_out(u) for u in db.scalars(select(User).order_by(User.id))]


@app.post("/api/users")
def create_user(body: UserIn, admin: User = Depends(admin_user), db: Session = Depends(get_db)) -> dict:
    email = body.email.lower()
    if db.scalars(select(User).where(User.email == email)).first():
        raise HTTPException(409, "A user with this email exists")
    user = User(email=email, full_name=body.full_name, role=body.role, password_hash=hash_password(body.password))
    db.add(user)
    audit(db, admin.email, "user.create", f"{email} as {body.role}")
    db.commit()
    return user_out(user)


@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, admin: User = Depends(admin_user), db: Session = Depends(get_db)) -> dict:
    user = _get(db, User, user_id)
    if user.id == admin.id:
        raise HTTPException(400, "You cannot delete yourself")
    db.delete(user)
    audit(db, admin.email, "user.delete", user.email)
    db.commit()
    return {"ok": True}


# --- Overview, sites, devices, sensors ----------------------------------------------------------------------

@app.get("/api/overview")
def overview(_: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    now = utcnow()
    sites = db.scalars(select(Site).order_by(Site.name)).all()
    active = db.scalars(select(Alert).where(Alert.status.in_(engine.ACTIVE)).order_by(Alert.opened_at.desc())).all()
    devices = [d for s in sites for d in s.devices]
    return {
        "server_time": iso(now),
        "counts": {"sites": len(sites), "devices": len(devices),
                   "online": sum(device_online(d, now) for d in devices),
                   "open_alerts": sum(a.status == "OPEN" for a in active), "acked_alerts": sum(
                       a.status == "ACKED" for a in active)},
        "sites": [{"id": s.id, "name": s.name, "address": s.address,
                   "devices": [device_out(d, now) for d in sorted(s.devices, key=lambda d: d.name)]} for s in sites],
        "alerts": [alert_out(a) for a in active],
    }


@app.get("/api/sites")
def list_sites(_: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    return [{"id": s.id, "name": s.name, "address": s.address, "device_count": len(s.devices)}
            for s in db.scalars(select(Site).order_by(Site.name))]


@app.post("/api/sites")
def create_site(body: SiteIn, admin: User = Depends(admin_user), db: Session = Depends(get_db)) -> dict:
    site = Site(name=body.name.strip(), address=body.address)
    db.add(site)
    db.flush()
    audit(db, admin.email, "site.create", f"#{site.id} {site.name}")
    db.commit()
    return {"id": site.id, "name": site.name, "address": site.address}


@app.patch("/api/sites/{site_id}")
def update_site(site_id: int, body: SiteIn, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    site = _get(db, Site, site_id)
    audit(db, admin.email, "site.update", f"#{site.id} {site.name!r} -> {body.name!r}")
    site.name, site.address = body.name.strip(), body.address
    db.commit()
    return {"id": site.id, "name": site.name, "address": site.address}


@app.delete("/api/sites/{site_id}")
def delete_site(site_id: int, admin: User = Depends(admin_user), db: Session = Depends(get_db)) -> dict:
    site = _get(db, Site, site_id)
    if site.devices:
        raise HTTPException(400, "Move or delete this site's devices first")
    db.delete(site)
    audit(db, admin.email, "site.delete", f"#{site_id} {site.name}")
    db.commit()
    return {"ok": True}


@app.post("/api/devices")
def create_device(body: DeviceIn, admin: User = Depends(admin_user), db: Session = Depends(get_db)) -> dict:
    _get(db, Site, body.site_id)
    serial, secret = new_device_credentials()
    while db.scalars(select(Device).where(Device.serial == serial)).first():
        serial, secret = new_device_credentials()
    device = Device(site_id=body.site_id, serial=serial, secret_hash=hash_secret(secret), name=body.name.strip(),
                    interval_seconds=body.interval_seconds)
    db.add(device)
    db.flush()
    audit(db, admin.email, "device.create", f"{serial} {device.name} at site #{body.site_id}")
    db.commit()
    db.refresh(device)
    # The secret is only ever returned here; it is stored hashed.
    return {**device_out(device, utcnow()), "secret": secret}


@app.get("/api/devices/{device_id}")
def get_device(device_id: int, _: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    return device_out(_get(db, Device, device_id), utcnow())


@app.patch("/api/devices/{device_id}")
def update_device(device_id: int, body: DevicePatch, admin: User = Depends(admin_user),
                  db: Session = Depends(get_db)) -> dict:
    device = _get(db, Device, device_id)
    changes = body.model_dump(exclude_none=True)
    if "site_id" in changes:
        _get(db, Site, changes["site_id"])
    for field, value in changes.items():
        audit(db, admin.email, "device.update", f"{device.serial} {field}: {getattr(device, field)!r} -> {value!r}")
        setattr(device, field, value)
    db.commit()
    db.refresh(device)
    return device_out(device, utcnow())


@app.post("/api/devices/{device_id}/rotate-key")
def rotate_key(device_id: int, admin: User = Depends(admin_user), db: Session = Depends(get_db)) -> dict:
    device = _get(db, Device, device_id)
    _, secret = new_device_credentials()
    device.secret_hash = hash_secret(secret)
    audit(db, admin.email, "device.rotate_key", device.serial)
    db.commit()
    return {"serial": device.serial, "secret": secret}


@app.delete("/api/devices/{device_id}")
def delete_device(device_id: int, admin: User = Depends(admin_user), db: Session = Depends(get_db)) -> dict:
    device = _get(db, Device, device_id)
    audit(db, admin.email, "device.delete", f"{device.serial} {device.name}")
    db.delete(device)
    db.commit()
    return {"ok": True}


@app.patch("/api/sensors/{sensor_id}")
def update_sensor(sensor_id: int, body: SensorPatch, admin: User = Depends(admin_user),
                  db: Session = Depends(get_db)) -> dict:
    sensor = _get(db, Sensor, sensor_id)
    changes = body.model_dump(exclude_none=True, exclude={"clear_min", "clear_max"})
    if body.clear_min:
        changes["min_value"] = None
    if body.clear_max:
        changes["max_value"] = None
    lo = changes.get("min_value", sensor.min_value)
    hi = changes.get("max_value", sensor.max_value)
    if lo is not None and hi is not None and lo >= hi:
        raise HTTPException(422, "Minimum must be below maximum")
    for field, value in changes.items():
        if getattr(sensor, field) != value:
            audit(db, admin.email, "sensor.update",
                  f"{sensor.device.serial}/{sensor.key} {field}: {getattr(sensor, field)!r} -> {value!r}")
            setattr(sensor, field, value)
    # New limits apply from the next reading; restart any pending breach timer.
    sensor.breach_since = sensor.breach_kind = None
    db.commit()
    return sensor_out(sensor)


def _readings(db: Session, sensor_id: int, start: datetime, end: datetime) -> list[Reading]:
    return list(db.scalars(select(Reading).where(Reading.sensor_id == sensor_id, Reading.ts >= start,
                                                 Reading.ts <= end).order_by(Reading.ts)))


@app.get("/api/sensors/{sensor_id}/readings")
def sensor_readings(sensor_id: int, start: Optional[str] = None, end: Optional[str] = None,
                    _: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    sensor = _get(db, Sensor, sensor_id)
    end_dt = parse_time(end, utcnow())
    start_dt = parse_time(start, end_dt - timedelta(hours=24))
    rows = _readings(db, sensor_id, start_dt, end_dt)
    points = [[iso(r.ts), r.value] for r in rows]
    if len(rows) > MAX_CHART_POINTS:                       # bucket into min/avg/max so spikes stay visible
        size = math.ceil(len(rows) / MAX_CHART_POINTS)
        points = []
        for i in range(0, len(rows), size):
            chunk = rows[i:i + size]
            values = [r.value for r in chunk]
            peak = max(values, key=lambda v: abs(v - sum(values) / len(values)))
            points.append([iso(chunk[len(chunk) // 2].ts), round(peak, 3)])
    return {"sensor": sensor_out(sensor), "start": iso(start_dt), "end": iso(end_dt), "points": points}


def summarise(sensor: Sensor, rows: list[Reading], interval_seconds: int) -> dict:
    if not rows:
        return {"count": 0}
    values = [r.value for r in rows]
    gap_cap = 3 * interval_seconds                         # a gap longer than this is downtime, not time in range
    in_range = out_range = 0.0
    for a, b in zip(rows, rows[1:]):
        span = min((b.ts - a.ts).total_seconds(), gap_cap)
        if engine._breach(sensor, a.value):
            out_range += span
        else:
            in_range += span
    result = {"count": len(rows), "min": min(values), "max": max(values),
              "avg": round(sum(values) / len(values), 3), "first": iso(rows[0].ts), "last": iso(rows[-1].ts),
              "minutes_out_of_range": round(out_range / 60, 1),
              "pct_in_range": round(100 * in_range / (in_range + out_range), 2) if in_range + out_range else None}
    if sensor.kind == "temperature":
        total = sum(math.exp(-MKT_DELTA_H_OVER_R / (v + 273.15)) for v in values)
        result["mkt"] = round(MKT_DELTA_H_OVER_R / -math.log(total / len(values)) - 273.15, 2)
    return result


@app.get("/api/sensors/{sensor_id}/report")
def sensor_report(sensor_id: int, start: Optional[str] = None, end: Optional[str] = None,
                  _: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    sensor = _get(db, Sensor, sensor_id)
    end_dt = parse_time(end, utcnow())
    start_dt = parse_time(start, end_dt - timedelta(days=7))
    rows = _readings(db, sensor_id, start_dt, end_dt)
    alerts = db.scalars(select(Alert).where(Alert.sensor_id == sensor_id, Alert.started_at <= end_dt,
                                            (Alert.resolved_at.is_(None)) | (Alert.resolved_at >= start_dt))
                        .order_by(Alert.started_at)).all()
    return {"sensor": sensor_out(sensor), "device": sensor.device.name, "site": sensor.device.site.name,
            "start": iso(start_dt), "end": iso(end_dt),
            "summary": summarise(sensor, rows, sensor.device.interval_seconds),
            "excursions": [alert_out(a) for a in alerts]}


@app.get("/api/sensors/{sensor_id}/export.csv")
def export_csv(sensor_id: int, start: Optional[str] = None, end: Optional[str] = None,
               _: User = Depends(current_user), db: Session = Depends(get_db)) -> StreamingResponse:
    sensor = _get(db, Sensor, sensor_id)
    end_dt = parse_time(end, utcnow())
    start_dt = parse_time(start, end_dt - timedelta(days=7))
    tz = ZoneInfo(settings.DISPLAY_TZ)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["timestamp_utc", f"timestamp_{settings.DISPLAY_TZ}", "site", "device", "serial", "sensor",
                     f"value_{sensor.unit}", "status"])
    for r in _readings(db, sensor_id, start_dt, end_dt):
        local = r.ts.replace(tzinfo=timezone.utc).astimezone(tz).strftime("%Y-%m-%d %H:%M:%S")
        breach = engine._breach(sensor, r.value)
        writer.writerow([iso(r.ts), local, sensor.device.site.name, sensor.device.name, sensor.device.serial,
                         sensor.label or sensor.key, r.value, breach[0] if breach else "OK"])
    name = f"{sensor.device.serial}-{sensor.key}-{start_dt:%Y%m%d}-{end_dt:%Y%m%d}.csv"
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


# --- Alerts -------------------------------------------------------------------------------------------------

@app.get("/api/alerts")
def list_alerts(status: str = Query("all", pattern="^(active|all|resolved)$"), limit: int = Query(100, le=500),
                _: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    query = select(Alert)
    if status == "active":
        query = query.where(Alert.status.in_(engine.ACTIVE))
    elif status == "resolved":
        query = query.where(Alert.status == "RESOLVED")
    return [alert_out(a) for a in db.scalars(query.order_by(Alert.opened_at.desc()).limit(limit))]


@app.get("/api/alerts/{alert_id}")
def get_alert(alert_id: int, _: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    alert = _get(db, Alert, alert_id)
    sent = db.scalars(select(Notification).where(Notification.alert_id == alert_id).order_by(Notification.id))
    return {**alert_out(alert), "notifications": [
        {"channel": n.channel, "recipient": n.recipient, "event": n.event, "ok": n.ok, "provider": n.provider,
         "error": n.error, "sent_at": iso(n.sent_at)} for n in sent]}


@app.post("/api/alerts/{alert_id}/ack")
def ack_alert(alert_id: int, body: NoteIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    alert = _get(db, Alert, alert_id)
    if alert.status != "OPEN":
        raise HTTPException(400, f"Alert is already {alert.status.lower()}")
    engine.acknowledge(db, alert, user.email, body.note)
    audit(db, user.email, "alert.ack", f"#{alert.id} {body.note}")
    db.commit()
    return alert_out(alert)


@app.post("/api/alerts/{alert_id}/resolve")
def resolve_alert(alert_id: int, body: NoteIn, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    """Close an alert by hand, e.g. the OFFLINE alert of a device that was unplugged on purpose."""
    alert = _get(db, Alert, alert_id)
    if alert.status == "RESOLVED":
        raise HTTPException(400, "Alert is already resolved")
    alert.status, alert.resolved_at = "RESOLVED", utcnow()
    alert.ack_note = (alert.ack_note + "\n" if alert.ack_note else "") + f"Closed manually: {body.note}"
    if alert.sensor:
        alert.sensor.breach_since = alert.sensor.breach_kind = None
    audit(db, admin.email, "alert.resolve", f"#{alert.id} {body.note}")
    db.commit()
    return alert_out(alert)


# --- Contacts -----------------------------------------------------------------------------------------------

def _check_contact(body: ContactIn, db: Session) -> None:
    if body.site_id is not None:
        _get(db, Site, body.site_id)
    if "email" in body.channels and not body.email:
        raise HTTPException(422, "Email channel needs an email address")
    if {"sms", "whatsapp"} & set(body.channels) and not body.phone:
        raise HTTPException(422, "SMS and WhatsApp need a phone number")


@app.get("/api/contacts")
def list_contacts(_: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    return [contact_out(c) for c in db.scalars(select(Contact).order_by(Contact.level, Contact.name))]


@app.post("/api/contacts")
def create_contact(body: ContactIn, admin: User = Depends(admin_user), db: Session = Depends(get_db)) -> dict:
    _check_contact(body, db)
    contact = Contact(**{**body.model_dump(), "channels": ",".join(body.channels)})
    db.add(contact)
    db.flush()
    audit(db, admin.email, "contact.create", f"#{contact.id} {contact.name} level {contact.level}")
    db.commit()
    return contact_out(contact)


@app.put("/api/contacts/{contact_id}")
def update_contact(contact_id: int, body: ContactIn, admin: User = Depends(admin_user),
                   db: Session = Depends(get_db)) -> dict:
    contact = _get(db, Contact, contact_id)
    _check_contact(body, db)
    for field, value in {**body.model_dump(), "channels": ",".join(body.channels)}.items():
        setattr(contact, field, value)
    audit(db, admin.email, "contact.update", f"#{contact.id} {contact.name}")
    db.commit()
    return contact_out(contact)


@app.delete("/api/contacts/{contact_id}")
def delete_contact(contact_id: int, admin: User = Depends(admin_user), db: Session = Depends(get_db)) -> dict:
    contact = _get(db, Contact, contact_id)
    db.delete(contact)
    audit(db, admin.email, "contact.delete", f"#{contact_id} {contact.name}")
    db.commit()
    return {"ok": True}


@app.post("/api/contacts/{contact_id}/test")
def test_contact(contact_id: int, admin: User = Depends(admin_user), db: Session = Depends(get_db)) -> list[dict]:
    contact = _get(db, Contact, contact_id)
    msg = notify.Message(location="Test", summary=f"Test message from {settings.APP_NAME} for {contact.name}",
                         body="If you received this, alerts will reach you on this channel.",
                         link=settings.APP_BASE_URL)
    results = []
    for channel in contact.channel_list:
        to = contact.email if channel == "email" else contact.phone
        r = notify.send(channel, to, msg)
        results.append({"channel": channel, "ok": r.ok, "provider": r.provider, "error": r.error})
    audit(db, admin.email, "contact.test", f"#{contact.id} {contact.name}")
    db.commit()
    return results


@app.get("/api/audit")
def audit_log(limit: int = Query(200, le=1000), _: User = Depends(current_user),
              db: Session = Depends(get_db)) -> list[dict]:
    return [{"at": iso(a.at), "actor": a.actor, "action": a.action, "details": a.details}
            for a in db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(limit))]


@app.get("/api/config")
def public_config(_: User = Depends(current_user)) -> dict:
    return {"app_name": settings.APP_NAME, "display_tz": settings.DISPLAY_TZ,
            "channels": {"email": "smtp" if settings.SMTP_HOST else "log",
                         "whatsapp": settings.WHATSAPP_PROVIDER or "off", "sms": settings.SMS_PROVIDER or "off"},
            "escalation_minutes": settings.ESCALATION_MINUTES, "reminder_minutes": settings.REMINDER_MINUTES}


# --- Dashboard ----------------------------------------------------------------------------------------------

@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
