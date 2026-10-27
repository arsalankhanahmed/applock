"""Runtime configuration for the ColdChain monitor (12-factor, environment driven)."""
from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "ColdChain Monitor"
    ENVIRONMENT: str = "development"

    # SQLite for a laptop / single box; PostgreSQL (postgres:// URLs from Render or Neon work too) in production.
    DATABASE_URL: str = "sqlite:///./coldchain.db"

    JWT_SECRET: str = "change-me-in-production-use-64-random-bytes"
    JWT_EXPIRE_MINUTES: int = 720

    # The first admin is created on start-up when the users table is empty.
    ADMIN_EMAIL: str = "admin@example.com"
    ADMIN_PASSWORD: str = "admin12345"

    # Public URL of the dashboard, used for links in alert messages.
    APP_BASE_URL: str = "http://localhost:8000"
    CORS_ORIGINS: str = ""

    # --- Device defaults -------------------------------------------------------------------------------
    # Times in alert messages and reports are shown in this zone.
    DISPLAY_TZ: str = "Asia/Karachi"

    DEFAULT_INTERVAL_SECONDS: int = 60
    # A device is offline when nothing arrived for max(this, 3 x its interval).
    OFFLINE_AFTER_MINUTES: int = 5
    # Readings timestamped further in the future than this are clamped to server time (bad device clock).
    MAX_CLOCK_SKEW_SECONDS: int = 300

    # --- Stock & cooling control (ERP integration) ----------------------------------------------------------
    # Grace period between the ERP saying "empty" and cooling actually going off (a mistaken update can be
    # corrected in this window). Only for devices with auto_cooling_off enabled.
    COOLING_OFF_DELAY_MINUTES: int = 30
    # How often an empty appliance that is not sharing data still checks in (to receive "restocked").
    EMPTY_HEARTBEAT_SECONDS: int = 900
    # After restocking, HIGH alerts wait until the temperature is back in range, or this long at most.
    PULLDOWN_MAX_MINUTES: int = 180

    # --- Firmware updates (OTA) ------------------------------------------------------------------------------
    FIRMWARE_DIR: str = "./firmware_store"
    MAX_FIRMWARE_MB: int = 4

    # --- Alerting --------------------------------------------------------------------------------------
    # Unacknowledged alerts move to the next contact level after this long.
    ESCALATION_MINUTES: int = 15
    # Repeat reminders to the current level while an alert stays open and unacknowledged (0 = never).
    REMINDER_MINUTES: int = 30
    # How often the background loop checks for offline devices and due escalations.
    TICK_SECONDS: int = 30
    # Run the loop inside the API process. Turn off when an external cron calls POST /api/internal/tick.
    RUN_BACKGROUND_LOOP: bool = True
    # Shared secret for POST /api/internal/tick. Empty disables the endpoint.
    TICK_TOKEN: str = ""

    # Email over SMTP. Empty host = email not configured.
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = "ColdChain Monitor <alerts@coldchain.local>"
    SMTP_STARTTLS: bool = True
    SMTP_SSL: bool = False

    # WhatsApp: "" (off), "meta" (WhatsApp Business Cloud API, approved template), "log" (development).
    # The Meta template body takes three parameters: {{1}} location, {{2}} summary, {{3}} dashboard link.
    WHATSAPP_PROVIDER: str = "log"
    WHATSAPP_META_TOKEN: str = ""
    WHATSAPP_META_PHONE_NUMBER_ID: str = ""
    WHATSAPP_META_API_VERSION: str = "v21.0"
    WHATSAPP_TEMPLATE_NAME: str = "coldchain_alert"
    WHATSAPP_TEMPLATE_LANGUAGE: str = "en"

    # SMS: "" (off), "twilio", "http" (any bulk-SMS gateway with an HTTP API, e.g. a local aggregator), "log".
    SMS_PROVIDER: str = "log"
    SMS_TWILIO_ACCOUNT_SID: str = ""
    SMS_TWILIO_AUTH_TOKEN: str = ""
    SMS_TWILIO_FROM: str = ""
    # For "http": a URL template with {to} and {text} placeholders (both URL-encoded), sent as GET,
    # e.g. https://sms.example.pk/api/send?key=XXX&mask=MYBRAND&to={to}&msg={text}
    SMS_HTTP_URL: str = ""

    HTTP_TIMEOUT_SECONDS: float = 15.0

    @field_validator("DATABASE_URL")
    @classmethod
    def _normalise_db_url(cls, value: str) -> str:
        if value.startswith("postgres://"):
            return "postgresql+psycopg2://" + value[len("postgres://"):]
        if value.startswith("postgresql://"):
            return "postgresql+psycopg2://" + value[len("postgresql://"):]
        return value

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
