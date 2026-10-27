"""Request bodies."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from app.services.notify import CHANNELS, normalise_phone


class DeviceReading(BaseModel):
    # Unix seconds from the device clock (NTP). Missing or implausible values are replaced by server time.
    ts: Optional[int] = None
    # Before its clock has synced a device sends its uptime (ms) and boot counter instead; the server then works
    # the time out from the uptime it reports with the upload. Readings from an earlier boot get server time.
    up: Optional[int] = None
    boot: Optional[int] = None
    values: dict[str, Optional[float]] = Field(default_factory=dict)


class IngestIn(BaseModel):
    readings: list[DeviceReading] = Field(default_factory=list, max_length=500)
    firmware: Optional[str] = Field(default=None, max_length=40)
    rssi: Optional[int] = None
    battery_pct: Optional[float] = None
    mains_power: Optional[bool] = None
    network: Optional[str] = Field(default=None, max_length=20)
    uptime_ms: Optional[int] = None
    boot: Optional[int] = None
    # What the cooling relay is doing right now; absent when no relay is fitted.
    cooling: Optional[str] = Field(default=None, pattern="^(on|off)$")
    # Set by the device when an over-the-air update failed.
    ota_error: Optional[str] = Field(default=None, max_length=200)


class LoginIn(BaseModel):
    email: str
    password: str


class UserIn(BaseModel):
    email: EmailStr
    full_name: str = ""
    password: str = Field(min_length=8)
    role: str = Field(default="OPERATOR", pattern="^(ADMIN|OPERATOR)$")


class SiteIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    address: str = ""


class DeviceIn(BaseModel):
    site_id: int
    name: str = Field(min_length=1, max_length=200)
    interval_seconds: int = Field(default=60, ge=10, le=3600)


class DevicePatch(BaseModel):
    site_id: Optional[int] = None
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    interval_seconds: Optional[int] = Field(default=None, ge=10, le=3600)
    erp_code: Optional[str] = Field(default=None, max_length=64)        # "" clears it
    auto_cooling_off: Optional[bool] = None
    share_data_when_empty: Optional[bool] = None
    cooling_mode: Optional[str] = Field(default=None, pattern="^(auto|on|off)$")
    target_firmware_id: Optional[int] = None                             # 0 clears it


class StockIn(BaseModel):
    """One stock update from the ERP. Give ``state``, or ``quantity`` (0 or less means empty)."""
    device: str = Field(min_length=1, max_length=64, description="Device serial (CC-XXXXXX) or its ERP code")
    state: Optional[str] = Field(default=None, pattern="^(?i)(empty|stocked)$")
    quantity: Optional[float] = None
    reference: str = Field(default="", max_length=120)

    @model_validator(mode="after")
    def _state_from_quantity(self):
        if self.state is None:
            if self.quantity is None:
                raise ValueError("give either state ('empty' / 'stocked') or quantity")
            self.state = "empty" if self.quantity <= 0 else "stocked"
        self.state = self.state.upper()
        return self


class ErpStockIn(BaseModel):
    updates: list[StockIn] = Field(min_length=1, max_length=200)


class ManualStockIn(BaseModel):
    state: str = Field(pattern="^(?i)(empty|stocked)$")
    note: str = Field(default="", max_length=120)


class ApiKeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class RolloutIn(BaseModel):
    device_ids: list[int] = Field(default_factory=list)
    all_devices: bool = False


class SensorPatch(BaseModel):
    label: Optional[str] = Field(default=None, max_length=200)
    kind: Optional[str] = Field(default=None, pattern="^(temperature|humidity|other)$")
    unit: Optional[str] = Field(default=None, max_length=10)
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    delay_minutes: Optional[int] = Field(default=None, ge=0, le=240)
    enabled: Optional[bool] = None
    # min_value / max_value are nullable, so "absent" and "clear it" need telling apart.
    clear_min: bool = False
    clear_max: bool = False


class ContactIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: str = ""
    phone: str = ""
    channels: list[str] = Field(default_factory=lambda: ["email"])
    level: int = Field(default=1, ge=1, le=9)
    site_id: Optional[int] = None
    active: bool = True

    @field_validator("phone")
    @classmethod
    def _phone(cls, value: str) -> str:
        return normalise_phone(value) if value.strip() else ""

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        value = value.strip()
        if value and "@" not in value:
            raise ValueError("Enter a valid email address")
        return value

    @field_validator("channels")
    @classmethod
    def _channels(cls, value: list[str]) -> list[str]:
        bad = [c for c in value if c not in CHANNELS]
        if bad:
            raise ValueError(f"Unknown channel(s): {', '.join(bad)}")
        return list(dict.fromkeys(value))


class NoteIn(BaseModel):
    note: str = Field(default="", max_length=2000)
