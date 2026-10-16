"""Centralised runtime configuration for AuditX (12-factor, environment driven)."""
from functools import lru_cache
from typing import List

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "AuditX"
    ENVIRONMENT: str = "development"
    API_PREFIX: str = "/api/v1"

    # Accepts postgres://, postgresql:// or postgresql+psycopg2:// (Render / Neon style URLs).
    DATABASE_URL: str = "postgresql+psycopg2://auditx:auditx@localhost:5432/auditx"
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 20

    REDIS_URL: str = "redis://localhost:6379/0"
    CELERY_BROKER_URL: str = ""
    CELERY_RESULT_BACKEND: str = ""
    # When true, Celery tasks run inline in the API process (single-container free-tier hosting).
    CELERY_TASK_ALWAYS_EAGER: bool = False

    JWT_SECRET: str = "change-me-in-production-use-64-random-bytes"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 720

    CORS_ORIGINS: str = "http://localhost:3000"

    UPLOAD_DIR: str = "/data/uploads"
    MAX_UPLOAD_MB: int = 2048
    UPLOAD_STREAM_BLOCK_BYTES: int = 1024 * 1024
    PARSER_CHUNK_ROWS: int = 100_000

    # Reconciliation tolerance in cents: variances at or below this are treated as matched.
    RECON_MATCH_TOLERANCE_CENTS: int = 0

    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"
    OPENAI_TIMEOUT_SECONDS: float = 30.0
    AGENT_MAX_ROWS: int = 500
    AGENT_STATEMENT_TIMEOUT_MS: int = 8000

    @field_validator("DATABASE_URL")
    @classmethod
    def normalise_db_url(cls, value: str) -> str:
        if value.startswith("postgres://"):
            value = "postgresql+psycopg2://" + value[len("postgres://"):]
        elif value.startswith("postgresql://"):
            value = "postgresql+psycopg2://" + value[len("postgresql://"):]
        return value

    @property
    def broker_url(self) -> str:
        return self.CELERY_BROKER_URL or self.REDIS_URL

    @property
    def result_backend(self) -> str:
        return self.CELERY_RESULT_BACKEND or self.REDIS_URL

    @property
    def cors_origin_list(self) -> List[str]:
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
