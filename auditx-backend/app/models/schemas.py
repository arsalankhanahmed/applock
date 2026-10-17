"""Pydantic v2 request / response validation layer for the AuditX API."""
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class IssueType(str, Enum):
    # Gateway leg
    MISSING_PAYMENT = "MISSING_PAYMENT"
    UNTRACKED_REVENUE = "UNTRACKED_REVENUE"
    AMOUNT_MISMATCH = "AMOUNT_MISMATCH"
    # Bank leg
    SETTLEMENT_NOT_DEPOSITED = "SETTLEMENT_NOT_DEPOSITED"
    DEPOSIT_MISMATCH = "DEPOSIT_MISMATCH"
    UNMATCHED_DEPOSIT = "UNMATCHED_DEPOSIT"
    # COD leg
    COD_PARCEL_UNTRACKED = "COD_PARCEL_UNTRACKED"
    COD_ORDER_NOT_BOOKED = "COD_ORDER_NOT_BOOKED"
    COD_NOT_REMITTED = "COD_NOT_REMITTED"
    COD_REMITTANCE_SHORTFALL = "COD_REMITTANCE_SHORTFALL"
    COURIER_OVERCHARGE = "COURIER_OVERCHARGE"
    RETURNED_ORDER_BOOKED = "RETURNED_ORDER_BOOKED"
    PARCEL_LOST_OR_STUCK = "PARCEL_LOST_OR_STUCK"


class Channel(str, Enum):
    GATEWAY = "GATEWAY"
    BANK = "BANK"
    COD = "COD"


class DiscrepancyStatus(str, Enum):
    UNRESOLVED = "UNRESOLVED"
    RESOLVED = "RESOLVED"


class UserRole(str, Enum):
    OWNER = "OWNER"
    ADMIN = "ADMIN"
    ANALYST = "ANALYST"
    AUDITOR = "AUDITOR"
    VIEWER = "VIEWER"


class IngestTarget(str, Enum):
    ecom_orders = "ecom_orders"
    gateway_transactions = "gateway_transactions"
    bank_transactions = "bank_transactions"
    courier_remittances = "courier_remittances"


class JobType(str, Enum):
    INGEST_ORDERS = "INGEST_ORDERS"
    INGEST_GATEWAY = "INGEST_GATEWAY"
    INGEST_BANK = "INGEST_BANK"
    INGEST_COURIER = "INGEST_COURIER"
    RECONCILIATION = "RECONCILIATION"


class JobStatus(str, Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"


# ---------------------------------------------------------------- auth / tenancy
class RegisterRequest(BaseModel):
    company_name: str = Field(min_length=2, max_length=255)
    brand_currency: str = Field(default="USD", min_length=3, max_length=3)
    full_name: str = Field(min_length=2, max_length=255)
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)

    @field_validator("brand_currency")
    @classmethod
    def upper_currency(cls, value: str) -> str:
        value = value.upper()
        if not value.isalpha():
            raise ValueError("brand_currency must be an ISO-4217 alpha code")
        return value


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    org_id: UUID
    user_id: UUID
    role: UserRole
    company_name: str


class CurrentUser(BaseModel):
    user_id: UUID
    org_id: UUID
    role: UserRole
    email: EmailStr


# ---------------------------------------------------------------- data dictionary / mappings
class DataDictionaryField(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    standard_field_id: UUID
    core_table_name: IngestTarget
    standard_field_name: str
    expected_data_type: str
    is_required: bool
    description: str


class FieldMappingIn(BaseModel):
    standard_field_id: UUID
    client_erp_column_name: str = Field(min_length=1, max_length=255)
    transformation_rule: Optional[str] = Field(
        default=None,
        max_length=500,
        description="Pipe separated ops, e.g. 'strip_prefix:#|upper' or 'multiply:0.01' or 'date_format:%d.%m.%Y'.",
    )


class FieldMappingBulkIn(BaseModel):
    mappings: List[FieldMappingIn] = Field(min_length=1, max_length=200)


class FieldMappingOut(BaseModel):
    mapping_id: UUID
    standard_field_id: UUID
    core_table_name: IngestTarget
    standard_field_name: str
    client_erp_column_name: str
    transformation_rule: Optional[str]


# ---------------------------------------------------------------- jobs
class JobAccepted(BaseModel):
    job_id: UUID
    job_type: JobType
    status: JobStatus
    status_url: str


class JobOut(BaseModel):
    job_id: UUID
    job_type: JobType
    status: JobStatus
    payload: Dict[str, Any]
    result: Optional[Dict[str, Any]]
    error: Optional[str]
    created_at: datetime
    started_at: Optional[datetime]
    finished_at: Optional[datetime]


class ReconciliationRequest(BaseModel):
    auto_heal: bool = True


# ---------------------------------------------------------------- discrepancies
class DiscrepancyOut(BaseModel):
    log_id: UUID
    source_order_number: str
    issue_type: IssueType
    channel: Channel
    order_amount: Optional[Decimal]
    gateway_amount: Optional[Decimal]
    variance_amount: Decimal
    status: DiscrepancyStatus
    ai_root_cause_category: Optional[str]
    ai_confidence_score: Optional[Decimal]
    ai_suggested_fix: Optional[Dict[str, Any]]
    auto_resolved: bool
    detected_at: datetime
    resolved_at: Optional[datetime]


class DiscrepancyPage(BaseModel):
    total: int
    limit: int
    offset: int
    items: List[DiscrepancyOut]


class ManualResolveRequest(BaseModel):
    resolution_note: str = Field(min_length=3, max_length=1000)
    root_cause_category: Optional[str] = Field(default=None, max_length=64)


# ---------------------------------------------------------------- dashboard
class IssueBreakdown(BaseModel):
    issue_type: IssueType
    channel: Channel
    open_count: int
    open_exposure: Decimal
    resolved_count: int


class RootCauseBreakdown(BaseModel):
    category: str
    count: int
    exposure: Decimal
    avg_confidence: Optional[Decimal]


class ChannelBreakdown(BaseModel):
    channel: Channel
    open_count: int
    open_exposure: Decimal
    resolved_count: int


class CourierSummary(BaseModel):
    courier_name: str
    parcels: int
    delivered: int
    returned: int
    cod_collected: Decimal
    charges: Decimal
    remitted: Decimal
    pending_remittance: Decimal
    overdue_remittance: Decimal
    return_rate_pct: Decimal


class DashboardMetrics(BaseModel):
    company_name: str
    brand_currency: str
    total_orders: int
    total_order_value: Decimal
    total_gateway_transactions: int
    total_gateway_gross: Decimal
    total_gateway_fees: Decimal
    open_discrepancies: int
    open_leakage_exposure: Decimal
    auto_healed_count: int
    auto_healed_value: Decimal
    manual_resolved_count: int
    match_rate_pct: Decimal
    auto_heal_rate_pct: Decimal
    bank_credits_total: Decimal
    settlements_expected_total: Decimal
    settlements_not_deposited: Decimal
    cod_orders: int
    cod_pending_remittance: Decimal
    by_channel: List[ChannelBreakdown]
    by_issue_type: List[IssueBreakdown]
    by_root_cause: List[RootCauseBreakdown]
    courier_summary: List[CourierSummary]
    last_reconciliation_at: Optional[datetime]


# ---------------------------------------------------------------- forensic agent
class AgentQueryRequest(BaseModel):
    question: str = Field(min_length=3, max_length=2000)


class AgentQueryResponse(BaseModel):
    question: str
    sql: str
    explanation: str
    narrative: str
    columns: List[str]
    rows: List[Dict[str, Any]]
    row_count: int
    truncated: bool
    engine: str
    elapsed_ms: int
