"""The alert engine: turns readings and device status into alerts, escalates them, and sends the messages.

State changes (``process_*`` and ``tick``) only touch the database and return a list of events; ``dispatch``
sends the messages for those events afterwards, so an HTTP request from a device is never held up by a slow
SMS gateway, and the logic can be tested without sending anything.

Alert kinds:
  HIGH / LOW  a sensor stayed above max / below min for at least its delay_minutes
  POWER       the device reports it is running on battery (mains failure, load-shedding)
  OFFLINE     nothing has arrived from the device for max(OFFLINE_AFTER_MINUTES, 3 x interval)

Escalation: an alert first goes to the lowest contact level for its site. While nobody acknowledges it, every
ESCALATION_MINUTES it moves to the next level up (each level is told once, when reached); once the top level is
reached, everyone notified so far gets a reminder every REMINDER_MINUTES. Acknowledging stops escalation and
reminders; the alert still resolves on its own when the condition clears, and everyone notified is told.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import Alert, Contact, Device, Notification, Sensor, session_scope, utcnow
from app.services import notify

logger = logging.getLogger("coldchain.alerts")

ACTIVE = ("OPEN", "ACKED")
SENSOR_KINDS = ("HIGH", "LOW")


@dataclass(frozen=True)
class Event:
    name: str          # opened | escalated | reminder | resolved | excursion | info
    alert_id: int      # 0 for "info" events, which carry their own text and device instead
    device_id: int = 0
    text: str = ""


# --- Helpers ------------------------------------------------------------------------------------------------

def _active_alert(db: Session, device_id: int, kinds: tuple[str, ...], sensor_id: Optional[int] = None):
    query = select(Alert).where(Alert.device_id == device_id, Alert.kind.in_(kinds), Alert.status.in_(ACTIVE))
    if sensor_id is not None:
        query = query.where(Alert.sensor_id == sensor_id)
    return db.scalars(query.order_by(Alert.id.desc())).first()


def _contacts(db: Session, site_id: int) -> list[Contact]:
    return list(db.scalars(select(Contact).where(
        Contact.active.is_(True), or_(Contact.site_id.is_(None), Contact.site_id == site_id)
    ).order_by(Contact.level, Contact.id)))


def _levels(db: Session, site_id: int) -> list[int]:
    return sorted({c.level for c in _contacts(db, site_id)})


def _open(db: Session, device: Device, kind: str, started_at: datetime, now: datetime,
          sensor: Optional[Sensor] = None, threshold: Optional[float] = None,
          value: Optional[float] = None) -> Alert:
    levels = _levels(db, device.site_id)
    alert = Alert(device_id=device.id, sensor_id=sensor.id if sensor else None, kind=kind, status="OPEN",
                  started_at=started_at, opened_at=now, threshold=threshold, peak_value=value,
                  level=levels[0] if levels else 1, escalated_at=now)
    db.add(alert)
    db.flush()
    logger.info("Alert %s opened: %s on device %s", alert.id, kind, device.serial)
    return alert


def _resolve(alert: Alert, at: datetime) -> None:
    alert.status = "RESOLVED"
    alert.resolved_at = at
    logger.info("Alert %s resolved", alert.id)


def _breach(sensor: Sensor, value: float) -> Optional[tuple[str, float]]:
    if sensor.max_value is not None and value > sensor.max_value:
        return "HIGH", sensor.max_value
    if sensor.min_value is not None and value < sensor.min_value:
        return "LOW", sensor.min_value
    return None


# --- State changes ------------------------------------------------------------------------------------------

def process_reading(db: Session, sensor: Sensor, ts: datetime, value: float, now: datetime) -> list[Event]:
    """Evaluate one reading. Readings must be fed oldest first; late or duplicate readings are not evaluated."""
    if sensor.last_at is not None and ts <= sensor.last_at:
        return []
    sensor.last_value, sensor.last_at = value, ts
    device = sensor.device
    alert = _active_alert(db, sensor.device_id, SENSOR_KINDS, sensor.id)
    # An empty appliance (cooling may be off on purpose) raises no temperature alerts.
    breach = _breach(sensor, value) if sensor.enabled and device.stock_state != "EMPTY" else None
    if device.pulldown_until is not None:
        if ts >= device.pulldown_until:
            device.pulldown_until = None
        elif sensor.kind == "temperature" and breach is None and sensor.enabled:
            device.pulldown_until = None              # back in range after restocking: normal alerting resumes
        elif breach is not None and breach[0] == "HIGH":
            breach = None                             # still cooling down after restocking
    events: list[Event] = []

    if breach is None:
        sensor.breach_since = sensor.breach_kind = None
        if alert:
            _resolve(alert, ts)
            events.append(Event("resolved", alert.id))
        return events

    kind, threshold = breach
    if alert and alert.kind != kind:                    # jumped straight from above max to below min
        _resolve(alert, ts)
        events.append(Event("resolved", alert.id))
        alert = None
    if sensor.breach_kind != kind or sensor.breach_since is None:
        sensor.breach_since, sensor.breach_kind = ts, kind
    if alert:
        worse = value > (alert.peak_value or value) if kind == "HIGH" else value < (alert.peak_value or value)
        if alert.peak_value is None or worse:
            alert.peak_value = value
        return events
    if ts - sensor.breach_since >= timedelta(minutes=max(sensor.delay_minutes, 0)):
        alert = _open(db, sensor.device, kind, sensor.breach_since, now, sensor, threshold, value)
        events.append(Event("opened", alert.id))
    return events


def process_device_status(db: Session, device: Device, mains_power: Optional[bool], now: datetime) -> list[Event]:
    """Called on every check-in: closes an OFFLINE alert and opens / closes the POWER alert."""
    events: list[Event] = []
    offline = _active_alert(db, device.id, ("OFFLINE",))
    if offline:
        _resolve(offline, now)
        events.append(Event("resolved", offline.id))
    if mains_power is None:
        return events
    power = _active_alert(db, device.id, ("POWER",))
    if mains_power is False and power is None and device.stock_state != "EMPTY":
        events.append(Event("opened", _open(db, device, "POWER", now, now).id))
    elif mains_power is True and power is not None:
        _resolve(power, now)
        events.append(Event("resolved", power.id))
    return events


def collapse(events: list[Event]) -> list[Event]:
    """An alert that opened and resolved within one batch (buffered readings uploaded after an outage) is reported
    once, as an excursion, instead of as an alarm immediately followed by an all-clear."""
    opened = {e.alert_id for e in events if e.name == "opened"}
    resolved = {e.alert_id for e in events if e.name == "resolved"}
    both = opened & resolved
    out = [e for e in events if e.alert_id not in both]
    seen: set[int] = set()
    for e in events:
        if e.alert_id in both and e.alert_id not in seen:
            seen.add(e.alert_id)
            out.append(Event("excursion", e.alert_id))
    return out


def tick(db: Session, now: Optional[datetime] = None) -> list[Event]:
    """Periodic job: open OFFLINE alerts, escalate unacknowledged alerts and send reminders."""
    now = now or utcnow()
    events: list[Event] = []

    from app.services.stock import effective_interval   # stock imports this module

    for device in db.scalars(select(Device).where(Device.last_seen_at.is_not(None))):
        limit = timedelta(seconds=max(settings.OFFLINE_AFTER_MINUTES * 60, 3 * effective_interval(device)))
        if now - device.last_seen_at > limit and _active_alert(db, device.id, ("OFFLINE",)) is None:
            events.append(Event("opened", _open(db, device, "OFFLINE", device.last_seen_at, now).id))

    escalate_after = timedelta(minutes=settings.ESCALATION_MINUTES)
    remind_after = timedelta(minutes=settings.REMINDER_MINUTES) if settings.REMINDER_MINUTES > 0 else None
    for alert in db.scalars(select(Alert).where(Alert.status == "OPEN")):
        higher = [lvl for lvl in _levels(db, alert.device.site_id) if lvl > alert.level]
        if higher and now - alert.escalated_at >= escalate_after:
            alert.level, alert.escalated_at = higher[0], now
            events.append(Event("escalated", alert.id))
        elif (not higher and remind_after and alert.last_notified_at is not None
              and now - alert.last_notified_at >= remind_after):
            events.append(Event("reminder", alert.id))
    return events


def acknowledge(db: Session, alert: Alert, who: str, note: str, now: Optional[datetime] = None) -> None:
    alert.status, alert.acked_by, alert.acked_at, alert.ack_note = "ACKED", who, now or utcnow(), note


# --- Messages -----------------------------------------------------------------------------------------------

def _local(ts: datetime) -> str:
    return ts.replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo(settings.DISPLAY_TZ)).strftime("%d %b %H:%M")


def _fmt(value: Optional[float], unit: str) -> str:
    return "—" if value is None else f"{value:.1f}{unit}"


def build_message(alert: Alert, event: str) -> notify.Message:
    device, sensor = alert.device, alert.sensor
    location = f"{device.site.name} / {device.name}"
    what = sensor.label or sensor.key if sensor else device.name
    unit = sensor.unit if sensor else ""
    since = _local(alert.started_at)
    if alert.kind in SENSOR_KINDS:
        bound = "max" if alert.kind == "HIGH" else "min"
        word = "HIGH" if alert.kind == "HIGH" else "LOW"
        noun = sensor.kind if sensor else "reading"
        condition = (f"{word} {noun}: {what} at {location} reached {_fmt(alert.peak_value, unit)} "
                     f"({bound} {_fmt(alert.threshold, unit)}) since {since}")
    elif alert.kind == "POWER":
        condition = f"POWER FAILURE: {location} is running on battery since {since}"
    else:
        condition = f"DEVICE OFFLINE: no data from {location} since {since}"

    if event == "resolved":
        summary = f"RECOVERED: {condition}. Back to normal at {_local(alert.resolved_at or utcnow())}"
    elif event == "excursion":
        summary = (f"EXCURSION (from buffered data): {condition}, recovered at "
                   f"{_local(alert.resolved_at or utcnow())}. Review and record a corrective action")
    elif event == "escalated":
        summary = f"ESCALATED (not acknowledged): {condition}"
    elif event == "reminder":
        summary = f"REMINDER (still not acknowledged): {condition}"
    else:
        summary = condition

    link = f"{settings.APP_BASE_URL.rstrip('/')}/#/alerts/{alert.id}"
    body = "\n".join([
        summary, "",
        f"Location: {location}",
        f"Device:   {device.serial}",
        f"Alert:    #{alert.id} ({alert.kind}, level {alert.level}, {alert.status})",
        "",
        "Acknowledge it in the dashboard so the team knows someone is on it.",
    ])
    return notify.Message(location=location, summary=summary, body=body, link=link)


def _deliver_info(db: Session, event: Event) -> int:
    """Informational message (stock / cooling changes) to the first contact level of the device's site."""
    device = db.get(Device, event.device_id)
    if device is None:
        return 0
    contacts = _contacts(db, device.site_id)
    first = contacts[0].level if contacts else 1
    msg = notify.Message(location=f"{device.site.name} / {device.name}", summary=event.text, body=event.text,
                         link=f"{settings.APP_BASE_URL.rstrip('/')}/#/devices")
    sent = 0
    for contact in (c for c in contacts if c.level == first):
        for channel in contact.channel_list:
            to = contact.email if channel == "email" else contact.phone
            if channel not in notify.CHANNELS or not to:
                continue
            result = notify.send(channel, to, msg)
            db.add(Notification(alert_id=None, device_id=device.id, contact_id=contact.id, channel=channel,
                                recipient=notify.mask(to), event="info", ok=result.ok, provider=result.provider,
                                error=result.error))
            sent += int(result.ok)
    return sent


def recipients(db: Session, alert: Alert, event: str) -> list[Contact]:
    contacts = _contacts(db, alert.device.site_id)
    if event == "escalated":
        return [c for c in contacts if c.level == alert.level]
    return [c for c in contacts if c.level <= alert.level]


def deliver(db: Session, events: list[Event]) -> int:
    """Send the messages for ``events`` using ``db``; returns how many were sent successfully."""
    sent = 0
    for event in events:
        if event.name == "info":
            sent += _deliver_info(db, event)
            continue
        alert = db.get(Alert, event.alert_id)
        if alert is None:
            continue
        msg = build_message(alert, event.name)
        for contact in recipients(db, alert, event.name):
            for channel in contact.channel_list:
                to = contact.email if channel == "email" else contact.phone
                if channel not in notify.CHANNELS or not to:
                    continue
                result = notify.send(channel, to, msg)
                db.add(Notification(alert_id=alert.id, device_id=alert.device_id, contact_id=contact.id,
                                    channel=channel, recipient=notify.mask(to), event=event.name, ok=result.ok,
                                    provider=result.provider, error=result.error))
                sent += int(result.ok)
        alert.last_notified_at = utcnow()
    db.flush()
    return sent


def dispatch(events: list[Event]) -> None:
    """Background-task entry point: deliver in a fresh session."""
    if not events:
        return
    try:
        with session_scope() as db:
            deliver(db, events)
    except Exception:                                    # never let a delivery failure kill the worker loop
        logger.exception("Delivering %d alert event(s) failed", len(events))
