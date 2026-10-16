"""PostgreSQL engine, session management and the idempotent multi-tenant schema migration.

Run migrations manually with:  python -m app.database
"""
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

engine: Engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    pool_size=settings.DB_POOL_SIZE,
    max_overflow=settings.DB_MAX_OVERFLOW,
    pool_recycle=1800,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)

# Arbitrary constant used to serialise concurrent migrations (several API workers booting at once).
_MIGRATION_LOCK_KEY = 7_734_221_905

SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS organizations (
    org_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name    VARCHAR(255) NOT NULL,
    brand_currency  VARCHAR(3)   NOT NULL DEFAULT 'USD' CHECK (brand_currency ~ '^[A-Z]{3}$'),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    user_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    full_name      VARCHAR(255) NOT NULL,
    email          VARCHAR(320) NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,
    role           VARCHAR(20)  NOT NULL DEFAULT 'ANALYST'
                   CHECK (role IN ('OWNER', 'ADMIN', 'ANALYST', 'AUDITOR', 'VIEWER')),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_users_org ON users (org_id);

CREATE TABLE IF NOT EXISTS data_dictionary_master (
    standard_field_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    core_table_name      VARCHAR(64)  NOT NULL CHECK (core_table_name IN ('ecom_orders', 'gateway_transactions')),
    standard_field_name  VARCHAR(64)  NOT NULL,
    expected_data_type   VARCHAR(20)  NOT NULL CHECK (expected_data_type IN ('STRING', 'DECIMAL', 'TIMESTAMP', 'CURRENCY_CODE')),
    is_required          BOOLEAN      NOT NULL DEFAULT FALSE,
    description          TEXT         NOT NULL DEFAULT '',
    CONSTRAINT uq_dictionary_field UNIQUE (core_table_name, standard_field_name)
);

CREATE TABLE IF NOT EXISTS client_field_mappings (
    mapping_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    standard_field_id       UUID NOT NULL REFERENCES data_dictionary_master(standard_field_id) ON DELETE CASCADE,
    client_erp_column_name  VARCHAR(255) NOT NULL,
    transformation_rule     VARCHAR(500),
    CONSTRAINT uq_org_standard_field UNIQUE (org_id, standard_field_id)
);

CREATE TABLE IF NOT EXISTS ecom_orders (
    order_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    source_order_number  VARCHAR(128) NOT NULL,
    total_amount         NUMERIC(18, 2) NOT NULL,
    currency             VARCHAR(3) NOT NULL DEFAULT 'USD',
    ordered_at           TIMESTAMPTZ,
    CONSTRAINT uq_order_per_org UNIQUE (org_id, source_order_number)
);

CREATE TABLE IF NOT EXISTS gateway_transactions (
    gateway_txn_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                 UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    source_order_number    VARCHAR(128) NOT NULL,
    source_transaction_id  VARCHAR(128) NOT NULL,
    gross_amount           NUMERIC(18, 2) NOT NULL,
    net_amount             NUMERIC(18, 2) NOT NULL,
    fee_amount             NUMERIC(18, 2) NOT NULL DEFAULT 0,
    processed_at           TIMESTAMPTZ,
    CONSTRAINT uq_gateway_txn_per_org UNIQUE (org_id, source_transaction_id)
);
CREATE INDEX IF NOT EXISTS ix_gateway_org_order ON gateway_transactions (org_id, source_order_number);

CREATE TABLE IF NOT EXISTS discrepancy_logs (
    log_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    source_order_number     VARCHAR(128) NOT NULL,
    issue_type              VARCHAR(32) NOT NULL
                            CHECK (issue_type IN ('MISSING_PAYMENT', 'UNTRACKED_REVENUE', 'AMOUNT_MISMATCH')),
    order_amount            NUMERIC(18, 2),
    gateway_amount          NUMERIC(18, 2),
    variance_amount         NUMERIC(18, 2) NOT NULL,
    status                  VARCHAR(16) NOT NULL DEFAULT 'UNRESOLVED' CHECK (status IN ('UNRESOLVED', 'RESOLVED')),
    ai_root_cause_category  VARCHAR(64),
    ai_confidence_score     NUMERIC(5, 4) CHECK (ai_confidence_score IS NULL OR ai_confidence_score BETWEEN 0 AND 1),
    ai_suggested_fix        JSONB,
    auto_resolved           BOOLEAN NOT NULL DEFAULT FALSE,
    detected_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at             TIMESTAMPTZ,
    CONSTRAINT ck_resolution_timestamp CHECK (status = 'UNRESOLVED' OR resolved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_discrepancy_org_status ON discrepancy_logs (org_id, status, issue_type);
CREATE INDEX IF NOT EXISTS ix_discrepancy_org_order ON discrepancy_logs (org_id, source_order_number);

CREATE TABLE IF NOT EXISTS audit_jobs (
    job_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    job_type     VARCHAR(32) NOT NULL CHECK (job_type IN ('INGEST_ORDERS', 'INGEST_GATEWAY', 'RECONCILIATION')),
    status       VARCHAR(16) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    result       JSONB,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_audit_jobs_org ON audit_jobs (org_id, created_at DESC);
"""

# Core canonical schema every client ERP / gateway export is mapped onto.
DATA_DICTIONARY_SEED = [
    ("ecom_orders", "source_order_number", "STRING", True,
     "Merchant-facing order / sales document number used as the reconciliation join key."),
    ("ecom_orders", "total_amount", "DECIMAL", True,
     "Final order value charged to the customer, inclusive of tax and shipping, after discounts."),
    ("ecom_orders", "currency", "CURRENCY_CODE", False,
     "ISO-4217 currency code of the order. Defaults to the organisation brand currency."),
    ("ecom_orders", "ordered_at", "TIMESTAMP", False,
     "Timestamp the order was placed in the storefront / ERP."),
    ("gateway_transactions", "source_order_number", "STRING", True,
     "Order reference propagated to the payment gateway (metadata / merchant reference)."),
    ("gateway_transactions", "source_transaction_id", "STRING", True,
     "Gateway-native unique transaction / charge identifier."),
    ("gateway_transactions", "gross_amount", "DECIMAL", True,
     "Amount captured from the customer before gateway fees."),
    ("gateway_transactions", "net_amount", "DECIMAL", False,
     "Amount settled to the merchant after fees. Derived as gross - fee when absent."),
    ("gateway_transactions", "fee_amount", "DECIMAL", False,
     "Gateway processing fee. Derived as gross - net when absent."),
    ("gateway_transactions", "processed_at", "TIMESTAMP", False,
     "Timestamp the gateway captured / settled the transaction."),
]


def _seed_data_dictionary(conn: Connection) -> None:
    conn.execute(
        text(
            """
            INSERT INTO data_dictionary_master
                (core_table_name, standard_field_name, expected_data_type, is_required, description)
            VALUES (:core_table_name, :standard_field_name, :expected_data_type, :is_required, :description)
            ON CONFLICT (core_table_name, standard_field_name) DO UPDATE
               SET expected_data_type = EXCLUDED.expected_data_type,
                   is_required        = EXCLUDED.is_required,
                   description        = EXCLUDED.description
            """
        ),
        [
            {
                "core_table_name": table,
                "standard_field_name": field,
                "expected_data_type": dtype,
                "is_required": required,
                "description": description,
            }
            for table, field, dtype, required, description in DATA_DICTIONARY_SEED
        ],
    )


def init_db() -> None:
    """Create every table / index and seed the data dictionary. Safe to run repeatedly and concurrently."""
    with engine.begin() as conn:
        conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _MIGRATION_LOCK_KEY})
        conn.exec_driver_sql(SCHEMA_DDL)
        _seed_data_dictionary(conn)


def get_db() -> Iterator[Session]:
    """FastAPI dependency yielding a request-scoped ORM session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transactional scope for workers and scripts: commit on success, rollback on error."""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    init_db()
    print("AuditX schema migrated and data dictionary seeded.")
