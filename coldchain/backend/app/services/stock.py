"""Stock-aware cooling control: when the ERP says an appliance is empty, cooling can be switched off.

Flow
  1. The ERP calls POST /api/erp/stock with {"device": "<serial or ERP code>", "state": "empty"}.
  2. The appliance is marked EMPTY. Temperature and power alerts are paused (an empty fridge warming up is
     expected) and the team is told.
  3. If the admin enabled ``auto_cooling_off`` for that appliance, the device is told to switch cooling off once
     it has been empty for COOLING_OFF_DELAY_MINUTES. Each upload response carries the command; the device
     drives a relay and reports back what the relay is doing.
  4. While empty, the device keeps recording (``share_data_when_empty``) or only sends a heartbeat every
     EMPTY_HEARTBEAT_SECONDS, so it can still receive the next command.
  5. When the ERP says "stocked", cooling comes back on immediately. HIGH temperature alerts wait until the
     appliance has pulled back into range (at most PULLDOWN_MAX_MINUTES).

Safety: nothing switches off unless an admin opted that appliance in, the device firmware turns cooling back on
by itself if it loses contact with the server for an hour, and the relay is wired so that a dead or unplugged
controller leaves cooling ON.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import Alert, Device, StockEvent
from app.services.alerts import ACTIVE, Event, _local, _resolve

STATES = ("STOCKED", "EMPTY")


def cooling_off_at(device: Device) -> Optional[datetime]:
    """When automatic switch-off takes (or took) effect, or None if it does not apply."""
    if device.stock_state != "EMPTY" or not device.auto_cooling_off or device.stock_updated_at is None:
        return None
    return device.stock_updated_at + timedelta(minutes=settings.COOLING_OFF_DELAY_MINUTES)


def cooling_command(device: Device, now: datetime) -> str:
    if device.cooling_override in ("on", "off"):
        return device.cooling_override
    off_at = cooling_off_at(device)
    return "off" if off_at is not None and now >= off_at else "on"


def recording(device: Device) -> bool:
    """Whether readings are stored. An empty appliance with data sharing off only checks in."""
    return not (device.stock_state == "EMPTY" and not device.share_data_when_empty)


def effective_interval(device: Device) -> int:
    return device.interval_seconds if recording(device) else max(device.interval_seconds,
                                                                  settings.EMPTY_HEARTBEAT_SECONDS)


def set_state(db: Session, device: Device, state: str, now: datetime, source: str, reference: str = "",
              quantity: Optional[float] = None, online: bool = True) -> tuple[bool, list[Event]]:
    """Record a stock update. Returns (changed, events). Repeating the current state is logged but changes nothing."""
    state = state.upper()
    if state not in STATES:
        raise ValueError(f"state must be one of {', '.join(s.lower() for s in STATES)}")
    db.add(StockEvent(device_id=device.id, state=state, quantity=quantity, reference=reference[:120],
                      source=source[:200], at=now))
    previous = device.stock_state
    if state == previous:
        return False, []
    device.stock_state, device.stock_updated_at = state, now
    location = f"{device.site.name} / {device.name}"
    ref = f" (ref {reference})" if reference else ""

    if state == "EMPTY":
        device.pulldown_until = None
        for alert in db.scalars(select(Alert).where(Alert.device_id == device.id, Alert.status.in_(ACTIVE),
                                                    Alert.kind.in_(("HIGH", "LOW", "POWER")))):
            _resolve(alert, now)
            alert.ack_note = (alert.ack_note + "\n" if alert.ack_note else "") + "Closed: appliance reported empty"
        for sensor in device.sensors:
            sensor.breach_since = sensor.breach_kind = None
        off_at = cooling_off_at(device)
        if device.cooling_override == "on":
            plan = "Cooling is forced ON from the dashboard."
        elif off_at:
            plan = f"Cooling will switch OFF at {_local(off_at)} unless it is restocked first."
        else:
            plan = "Cooling stays on (automatic switch-off is not enabled for this appliance)."
        text = f"STOCK EMPTY: {location} reported empty by {source}{ref}. Temperature alerts paused. {plan}"
    else:
        if previous == "EMPTY":
            device.pulldown_until = now + timedelta(minutes=settings.PULLDOWN_MAX_MINUTES)
        text = (f"RESTOCKED: {location} reported stocked by {source}{ref}. Cooling ON; temperature alerts resume "
                f"once it is back in range (at most {settings.PULLDOWN_MAX_MINUTES} min).")
        if not online:
            text += " WARNING: the device is OFFLINE and cannot receive the command - check the appliance by hand."
    return True, [Event("info", 0, device_id=device.id, text=text)]
