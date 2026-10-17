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
    core_table_name      VARCHAR(64)  NOT NULL,
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
    issue_type              VARCHAR(32) NOT NULL,
    order_amount            NUMERIC(18, 2),
    gateway_amount          NUMERIC(18, 2),
    variance_amount         NUMERIC(18, 2) NOT NULL,
    status                  VARCHAR(16) NOT NULL DEFAULT 'UNRESOLVED',
    ai_root_cause_category  VARCHAR(64),
    ai_confidence_score     NUMERIC(5, 4) CHECK (ai_confidence_score IS NULL OR ai_confidence_score BETWEEN 0 AND 1),
    ai_suggested_fix        JSONB,
    auto_resolved           BOOLEAN NOT NULL DEFAULT FALSE,
    detected_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_discrepancy_org_status ON discrepancy_logs (org_id, status, issue_type);
CREATE INDEX IF NOT EXISTS ix_discrepancy_org_order ON discrepancy_logs (org_id, source_order_number);

CREATE TABLE IF NOT EXISTS audit_jobs (
    job_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    job_type     VARCHAR(32) NOT NULL,
    status       VARCHAR(16) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    result       JSONB,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_audit_jobs_org ON audit_jobs (org_id, created_at DESC);

-- Bank statement lines (credits positive, debits negative).
CREATE TABLE IF NOT EXISTS bank_transactions (
    bank_txn_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    bank_account      VARCHAR(64) NOT NULL DEFAULT 'PRIMARY',
    transaction_date  TIMESTAMPTZ NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    amount            NUMERIC(18, 2) NOT NULL,
    bank_reference    VARCHAR(128) NOT NULL,
    CONSTRAINT uq_bank_ref_per_org UNIQUE (org_id, bank_reference)
);
CREATE INDEX IF NOT EXISTS ix_bank_org_date ON bank_transactions (org_id, transaction_date);

-- Courier / COD parcel reports (TCS, Leopards, PostEx, Trax ...). Re-uploads update a parcel's latest state.
CREATE TABLE IF NOT EXISTS courier_remittances (
    parcel_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    tracking_number       VARCHAR(128) NOT NULL,
    source_order_number   VARCHAR(128) NOT NULL,
    courier_name          VARCHAR(64) NOT NULL DEFAULT 'UNKNOWN',
    parcel_status         VARCHAR(16) NOT NULL
                          CHECK (parcel_status IN ('IN_TRANSIT', 'DELIVERED', 'RETURNED', 'LOST')),
    cod_amount            NUMERIC(18, 2) NOT NULL DEFAULT 0,
    delivery_charges      NUMERIC(18, 2) NOT NULL DEFAULT 0,
    net_remitted          NUMERIC(18, 2) NOT NULL DEFAULT 0,
    remittance_reference  VARCHAR(128),
    booked_at             TIMESTAMPTZ,
    delivered_at          TIMESTAMPTZ,
    remitted_at           TIMESTAMPTZ,
    CONSTRAINT uq_parcel_per_org UNIQUE (org_id, tracking_number)
);
CREATE INDEX IF NOT EXISTS ix_courier_org_order ON courier_remittances (org_id, source_order_number);
CREATE INDEX IF NOT EXISTS ix_courier_org_remittance ON courier_remittances (org_id, remittance_reference);

-- Additive evolution of earlier tables (safe to re-run).
ALTER TABLE ecom_orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(8) NOT NULL DEFAULT 'PREPAID'
    CHECK (payment_method IN ('PREPAID', 'COD'));
ALTER TABLE gateway_transactions ADD COLUMN IF NOT EXISTS payout_reference VARCHAR(128);
CREATE INDEX IF NOT EXISTS ix_gateway_org_payout ON gateway_transactions (org_id, payout_reference);
ALTER TABLE discrepancy_logs ADD COLUMN IF NOT EXISTS channel VARCHAR(16) NOT NULL DEFAULT 'GATEWAY'
    CHECK (channel IN ('GATEWAY', 'BANK', 'COD'));
CREATE INDEX IF NOT EXISTS ix_discrepancy_org_channel ON discrepancy_logs (org_id, channel, status);

-- Enumerations live in named constraints so new values can be added by re-running this migration.
ALTER TABLE data_dictionary_master DROP CONSTRAINT IF EXISTS data_dictionary_master_core_table_name_check;
ALTER TABLE data_dictionary_master DROP CONSTRAINT IF EXISTS ck_dictionary_core_table;
ALTER TABLE data_dictionary_master ADD CONSTRAINT ck_dictionary_core_table CHECK (core_table_name IN
    ('ecom_orders', 'gateway_transactions', 'bank_transactions', 'courier_remittances'));

ALTER TABLE discrepancy_logs DROP CONSTRAINT IF EXISTS discrepancy_logs_issue_type_check;
ALTER TABLE discrepancy_logs DROP CONSTRAINT IF EXISTS ck_discrepancy_issue_type;
ALTER TABLE discrepancy_logs ADD CONSTRAINT ck_discrepancy_issue_type CHECK (issue_type IN (
    'MISSING_PAYMENT', 'UNTRACKED_REVENUE', 'AMOUNT_MISMATCH',
    'SETTLEMENT_NOT_DEPOSITED', 'DEPOSIT_MISMATCH', 'UNMATCHED_DEPOSIT',
    'COD_PARCEL_UNTRACKED', 'COD_ORDER_NOT_BOOKED', 'COD_NOT_REMITTED', 'COD_REMITTANCE_SHORTFALL',
    'COURIER_OVERCHARGE', 'RETURNED_ORDER_BOOKED', 'PARCEL_LOST_OR_STUCK'));

ALTER TABLE discrepancy_logs DROP CONSTRAINT IF EXISTS discrepancy_logs_status_check;
ALTER TABLE discrepancy_logs DROP CONSTRAINT IF EXISTS ck_discrepancy_status;
ALTER TABLE discrepancy_logs ADD CONSTRAINT ck_discrepancy_status
    CHECK (status IN ('UNRESOLVED', 'PENDING_APPROVAL', 'RESOLVED'));
ALTER TABLE discrepancy_logs DROP CONSTRAINT IF EXISTS ck_resolution_timestamp;
ALTER TABLE discrepancy_logs ADD CONSTRAINT ck_resolution_timestamp
    CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL);

-- Maker-checker: every resolution (AI or human) is a request; a different person approves it.
-- The finding is snapshotted so the trail survives reconciliation rebuilding open findings.
CREATE TABLE IF NOT EXISTS resolution_requests (
    request_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    log_id               UUID REFERENCES discrepancy_logs(log_id) ON DELETE SET NULL,
    source_order_number  VARCHAR(128) NOT NULL,
    issue_type           VARCHAR(32) NOT NULL,
    channel              VARCHAR(16) NOT NULL,
    amount               NUMERIC(18, 2) NOT NULL,
    root_cause_category  VARCHAR(64),
    proposed_fix         JSONB,
    proposed_by_type     VARCHAR(8) NOT NULL CHECK (proposed_by_type IN ('AI', 'USER')),
    proposed_by          UUID REFERENCES users(user_id) ON DELETE SET NULL,
    proposed_by_email    VARCHAR(320),
    maker_note           TEXT,
    status               VARCHAR(16) NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
    decided_by           UUID REFERENCES users(user_id) ON DELETE SET NULL,
    decided_by_email     VARCHAR(320),
    checker_note         TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at           TIMESTAMPTZ,
    CONSTRAINT ck_request_decision CHECK (status IN ('PENDING') OR decided_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_pending_request_per_log
    ON resolution_requests (log_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS ix_requests_org_status ON resolution_requests (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_requests_org_key ON resolution_requests (org_id, source_order_number, issue_type);

CREATE TABLE IF NOT EXISTS approval_policies (
    org_id                    UUID PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
    auto_heal_mode            VARCHAR(16) NOT NULL DEFAULT 'THRESHOLD'
                              CHECK (auto_heal_mode IN ('AUTO', 'THRESHOLD', 'ALWAYS_APPROVE')),
    auto_heal_max_amount      NUMERIC(18, 2) NOT NULL DEFAULT 1.00 CHECK (auto_heal_max_amount >= 0),
    manual_requires_approval  BOOLEAN NOT NULL DEFAULT TRUE,
    manual_auto_approve_max   NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (manual_auto_approve_max >= 0),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by_email          VARCHAR(320)
);

-- Passwords: an admin-set (temporary) password must be replaced at next sign-in; tokens issued before the
-- last password change stop working.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- Email invitations. Only a SHA-256 hash of the link token is stored.
CREATE TABLE IF NOT EXISTS invitations (
    invite_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    email             VARCHAR(320) NOT NULL,
    full_name         VARCHAR(255),
    role              VARCHAR(20) NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'ANALYST', 'AUDITOR', 'VIEWER')),
    token_hash        CHAR(64) NOT NULL UNIQUE,
    status            VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED')),
    invited_by        UUID REFERENCES users(user_id) ON DELETE SET NULL,
    invited_by_email  VARCHAR(320),
    send_count        INT NOT NULL DEFAULT 0,
    last_sent_at      TIMESTAMPTZ,
    last_send_error   TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at        TIMESTAMPTZ NOT NULL,
    accepted_at       TIMESTAMPTZ,
    accepted_user_id  UUID REFERENCES users(user_id) ON DELETE SET NULL,
    revoked_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_invitations_org ON invitations (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_invitations_email ON invitations (lower(email)) WHERE status = 'PENDING';

ALTER TABLE audit_jobs DROP CONSTRAINT IF EXISTS audit_jobs_job_type_check;
ALTER TABLE audit_jobs DROP CONSTRAINT IF EXISTS ck_audit_job_type;
ALTER TABLE audit_jobs ADD CONSTRAINT ck_audit_job_type CHECK (job_type IN
    ('INGEST_ORDERS', 'INGEST_GATEWAY', 'INGEST_BANK', 'INGEST_COURIER', 'RECONCILIATION'));
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
    ("ecom_orders", "payment_method", "STRING", False,
     "PREPAID or COD. Values containing 'cod' or 'cash' are read as COD; blank defaults to PREPAID."),
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
    ("gateway_transactions", "payout_reference", "STRING", False,
     "Payout / settlement batch id the capture was paid out in. Matched against bank statement credits."),
    ("bank_transactions", "transaction_date", "TIMESTAMP", True,
     "Value / posting date of the statement line."),
    ("bank_transactions", "description", "STRING", False,
     "Narration. Payout and remittance references are read from it."),
    ("bank_transactions", "amount", "DECIMAL", False,
     "Signed amount (credit positive). Derived from credit_amount - debit_amount when absent."),
    ("bank_transactions", "credit_amount", "DECIMAL", False,
     "Credit column for statements with separate debit / credit columns."),
    ("bank_transactions", "debit_amount", "DECIMAL", False,
     "Debit column for statements with separate debit / credit columns."),
    ("bank_transactions", "bank_reference", "STRING", False,
     "Bank's unique line reference. A stable fingerprint is generated when absent."),
    ("bank_transactions", "bank_account", "STRING", False,
     "Account name or number, for organisations reconciling several accounts."),
    ("courier_remittances", "tracking_number", "STRING", True,
     "Courier consignment / tracking number (unique per parcel)."),
    ("courier_remittances", "source_order_number", "STRING", True,
     "Merchant order reference printed on the parcel."),
    ("courier_remittances", "courier_name", "STRING", False,
     "Courier company, e.g. TCS, Leopards, PostEx, Trax."),
    ("courier_remittances", "parcel_status", "STRING", True,
     "Delivered / Returned / Lost / In transit (courier wording is normalised)."),
    ("courier_remittances", "cod_amount", "DECIMAL", False,
     "Cash collected from the customer by the rider."),
    ("courier_remittances", "delivery_charges", "DECIMAL", False,
     "Courier charges deducted from the COD amount."),
    ("courier_remittances", "net_remitted", "DECIMAL", False,
     "Amount paid to the merchant for the parcel. Derived as cod - charges when a remittance reference exists."),
    ("courier_remittances", "remittance_reference", "STRING", False,
     "Remittance / payment batch number (CPR). Matched against bank statement credits."),
    ("courier_remittances", "booked_at", "TIMESTAMP", False,
     "Date the parcel was booked with the courier."),
    ("courier_remittances", "delivered_at", "TIMESTAMP", False,
     "Date the parcel was delivered or returned."),
    ("courier_remittances", "remitted_at", "TIMESTAMP", False,
     "Date the courier paid the remittance."),
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
