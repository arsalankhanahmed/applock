"""Database engine, session handling and the ORM schema.

All timestamps are stored as naive UTC datetimes so SQLite and PostgreSQL behave the same.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator, Optional

from sqlalchemy import (Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, create_engine,
                        event)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

from app.config import settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _make_engine(url: str):
    if url.startswith("sqlite"):
        eng = create_engine(url, connect_args={"check_same_thread": False}, future=True)

        @event.listens_for(eng, "connect")
        def _sqlite_pragmas(dbapi_conn, _):                     # pragma: no cover - driver hook
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()
        return eng
    return create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=5, pool_recycle=1800, future=True)


engine = _make_engine(settings.DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    full_name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    # ADMIN manages devices, thresholds and contacts; OPERATOR can view and acknowledge alerts.
    role: Mapped[str] = mapped_column(String(20), default="OPERATOR")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Site(Base):
    """A physical location: a warehouse, a cold room, a server room."""
    __tablename__ = "sites"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    address: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    devices: Mapped[list["Device"]] = relationship(back_populates="site")


class Device(Base):
    __tablename__ = "devices"
    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="RESTRICT"))
    # Public identifier printed on the device label / QR code, e.g. "CC-7F3A2B".
    serial: Mapped[str] = mapped_column(String(32), unique=True)
    # SHA-256 of the device secret; the secret itself is shown once, when the device is created.
    secret_hash: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(200))
    interval_seconds: Mapped[int] = mapped_column(Integer, default=60)
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    firmware: Mapped[str] = mapped_column(String(40), default="")
    rssi: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    battery_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # False while the device reports it is running on battery (mains failure / load-shedding).
    mains_power: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    network: Mapped[str] = mapped_column(String(20), default="")       # "wifi" / "cellular"
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    # --- Stock & cooling control (see services/stock.py) ---
    # The ERP's own code for this fridge / cold room, so it can address it without knowing our serial.
    erp_code: Mapped[Optional[str]] = mapped_column(String(64), unique=True, nullable=True)
    stock_state: Mapped[str] = mapped_column(String(10), default="UNKNOWN")      # UNKNOWN | STOCKED | EMPTY
    stock_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Opt-in: switch cooling off once the appliance has been empty for COOLING_OFF_DELAY_MINUTES.
    auto_cooling_off: Mapped[bool] = mapped_column(Boolean, default=False)
    # While empty: keep recording readings (True) or only send a heartbeat (False).
    share_data_when_empty: Mapped[bool] = mapped_column(Boolean, default=True)
    # Manual override from the dashboard: None = automatic, "on" / "off" = forced.
    cooling_override: Mapped[Optional[str]] = mapped_column(String(3), nullable=True)
    # What the device last reported its relay doing ("on" / "off"); None = no relay fitted.
    cooling_reported: Mapped[Optional[str]] = mapped_column(String(3), nullable=True)
    # After restocking, HIGH temperature alerts wait until the appliance has pulled down into range.
    pulldown_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # --- Firmware updates ---
    target_firmware_id: Mapped[Optional[int]] = mapped_column(ForeignKey("firmware.id", ondelete="SET NULL"),
                                                              nullable=True)
    ota_status: Mapped[str] = mapped_column(String(200), default="")

    site: Mapped[Site] = relationship(back_populates="devices")
    target_firmware: Mapped[Optional["Firmware"]] = relationship()
    sensors: Mapped[list["Sensor"]] = relationship(back_populates="device", cascade="all, delete-orphan")


class Firmware(Base):
    """A firmware image uploaded by an admin and offered to devices over the air."""
    __tablename__ = "firmware"
    id: Mapped[int] = mapped_column(primary_key=True)
    version: Mapped[str] = mapped_column(String(40), unique=True)
    filename: Mapped[str] = mapped_column(String(200))
    size: Mapped[int] = mapped_column(Integer)
    md5: Mapped[str] = mapped_column(String(32))
    sha256: Mapped[str] = mapped_column(String(64))
    notes: Mapped[str] = mapped_column(Text, default="")
    uploaded_by: Mapped[str] = mapped_column(String(320), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ApiKey(Base):
    """Key for a machine client such as the ERP. Only the SHA-256 is stored; the key is shown once."""
    __tablename__ = "api_keys"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    prefix: Mapped[str] = mapped_column(String(16))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_by: Mapped[str] = mapped_column(String(320), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class StockEvent(Base):
    """Every stock-state change, from the ERP or the dashboard, for traceability."""
    __tablename__ = "stock_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    state: Mapped[str] = mapped_column(String(10))
    quantity: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    reference: Mapped[str] = mapped_column(String(120), default="")
    source: Mapped[str] = mapped_column(String(200))      # "erp:<key name>" or "dashboard:<email>"
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Sensor(Base):
    """One measured channel on a device. Created automatically the first time a device reports it."""
    __tablename__ = "sensors"
    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(String(40))                       # key in the payload, e.g. "temp", "hum"
    kind: Mapped[str] = mapped_column(String(20), default="temperature")   # temperature | humidity | other
    label: Mapped[str] = mapped_column(String(200), default="")
    unit: Mapped[str] = mapped_column(String(10), default="°C")
    min_value: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    max_value: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Out of range must last this long before an alert opens (ignores a door opened for a minute).
    delay_minutes: Mapped[int] = mapped_column(Integer, default=5)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_value: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Start of the current out-of-range run (not yet an alert while shorter than delay_minutes).
    breach_since: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    breach_kind: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    device: Mapped[Device] = relationship(back_populates="sensors")

    __table_args__ = (Index("uq_sensor_device_key", "device_id", "key", unique=True),)


class Reading(Base):
    __tablename__ = "readings"
    id: Mapped[int] = mapped_column(primary_key=True)
    sensor_id: Mapped[int] = mapped_column(ForeignKey("sensors.id", ondelete="CASCADE"))
    ts: Mapped[datetime] = mapped_column(DateTime)
    value: Mapped[float] = mapped_column(Float)

    __table_args__ = (Index("uq_reading_sensor_ts", "sensor_id", "ts", unique=True),)


class Contact(Base):
    """Someone who receives alerts. Level 1 is told first; higher levels only on escalation."""
    __tablename__ = "contacts"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str] = mapped_column(String(320), default="")
    phone: Mapped[str] = mapped_column(String(20), default="")         # E.164, used for SMS and WhatsApp
    channels: Mapped[str] = mapped_column(String(60), default="email")  # comma list: email,whatsapp,sms
    level: Mapped[int] = mapped_column(Integer, default=1)
    # Empty = every site.
    site_id: Mapped[Optional[int]] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    @property
    def channel_list(self) -> list[str]:
        return [c.strip() for c in self.channels.split(",") if c.strip()]


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    sensor_id: Mapped[Optional[int]] = mapped_column(ForeignKey("sensors.id", ondelete="CASCADE"), nullable=True)
    kind: Mapped[str] = mapped_column(String(10))        # HIGH | LOW | OFFLINE | POWER
    status: Mapped[str] = mapped_column(String(10), default="OPEN")   # OPEN | ACKED | RESOLVED
    started_at: Mapped[datetime] = mapped_column(DateTime)            # when the condition began
    opened_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    threshold: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    peak_value: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    level: Mapped[int] = mapped_column(Integer, default=1)
    escalated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_notified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    acked_by: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    acked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ack_note: Mapped[str] = mapped_column(Text, default="")
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    device: Mapped[Device] = relationship()
    sensor: Mapped[Optional[Sensor]] = relationship()

    __table_args__ = (Index("ix_alert_status", "status"),)


class Notification(Base):
    """Delivery log: one row per message attempted."""
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    # Empty for informational messages that belong to no alert (stock empty, cooling switched off, ...).
    alert_id: Mapped[Optional[int]] = mapped_column(ForeignKey("alerts.id", ondelete="CASCADE"), nullable=True)
    device_id: Mapped[Optional[int]] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), nullable=True)
    contact_id: Mapped[Optional[int]] = mapped_column(ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    channel: Mapped[str] = mapped_column(String(10))
    recipient: Mapped[str] = mapped_column(String(320))
    event: Mapped[str] = mapped_column(String(20))        # opened | escalated | reminder | resolved | excursion | info
    ok: Mapped[bool] = mapped_column(Boolean)
    provider: Mapped[str] = mapped_column(String(20), default="")
    error: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AuditLog(Base):
    """Append-only record of who changed what (GxP / 21 CFR Part 11 style audit trail)."""
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    actor: Mapped[str] = mapped_column(String(320))
    action: Mapped[str] = mapped_column(String(60))
    details: Mapped[str] = mapped_column(Text, default="")


def init_db() -> None:
    Base.metadata.create_all(engine)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def audit(db: Session, actor: str, action: str, details: str = "") -> None:
    db.add(AuditLog(actor=actor, action=action, details=details))
