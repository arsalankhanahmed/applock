"""Pydantic v2 request / response validation layer for the AuditX API."""
from datetime import date, datetime
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
    PENDING_APPROVAL = "PENDING_APPROVAL"
    RESOLVED = "RESOLVED"


class RequestStatus(str, Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    WITHDRAWN = "WITHDRAWN"


class AutoHealMode(str, Enum):
    AUTO = "AUTO"
    THRESHOLD = "THRESHOLD"
    ALWAYS_APPROVE = "ALWAYS_APPROVE"


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
    must_change_password: bool = False


class CurrentUser(BaseModel):
    user_id: UUID
    org_id: UUID
    role: UserRole
    email: EmailStr
    must_change_password: bool = False


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
    claim_number: Optional[str] = None


class DiscrepancyPage(BaseModel):
    total: int
    limit: int
    offset: int
    items: List[DiscrepancyOut]


class UserCreate(BaseModel):
    full_name: str = Field(min_length=2, max_length=255)
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    role: UserRole


class UserOut(BaseModel):
    user_id: UUID
    full_name: str
    email: EmailStr
    role: UserRole
    created_at: datetime


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=10, max_length=128)


class InviteStatus(str, Enum):
    PENDING = "PENDING"
    ACCEPTED = "ACCEPTED"
    REVOKED = "REVOKED"
    EXPIRED = "EXPIRED"


class InviteCreate(BaseModel):
    email: EmailStr
    role: UserRole
    full_name: Optional[str] = Field(default=None, min_length=2, max_length=255)


class InviteOut(BaseModel):
    invite_id: UUID
    email: EmailStr
    full_name: Optional[str]
    role: UserRole
    status: InviteStatus
    invited_by_email: Optional[str]
    send_count: int
    last_sent_at: Optional[datetime]
    last_send_error: Optional[str]
    created_at: datetime
    expires_at: datetime
    accepted_at: Optional[datetime]


class InviteSent(InviteOut):
    invite_url: str
    email_sent: bool
    email_error: Optional[str]


class InvitePublic(BaseModel):
    email: EmailStr
    full_name: Optional[str]
    role: UserRole
    company_name: str
    invited_by_email: Optional[str]
    expires_at: datetime


class InviteAccept(BaseModel):
    full_name: str = Field(min_length=2, max_length=255)
    password: str = Field(min_length=10, max_length=128)


class UserUpdate(BaseModel):
    full_name: Optional[str] = Field(default=None, min_length=2, max_length=255)
    role: Optional[UserRole] = None
    password: Optional[str] = Field(default=None, min_length=10, max_length=128)


# ---------------------------------------------------------------- maker-checker
class ApprovalPolicyIn(BaseModel):
    auto_heal_mode: AutoHealMode = AutoHealMode.THRESHOLD
    auto_heal_max_amount: Decimal = Field(default=Decimal("1.00"), ge=0, max_digits=18, decimal_places=2)
    manual_requires_approval: bool = True
    manual_auto_approve_max: Decimal = Field(default=Decimal("0"), ge=0, max_digits=18, decimal_places=2)


class ApprovalPolicyOut(ApprovalPolicyIn):
    updated_at: Optional[datetime] = None
    updated_by_email: Optional[str] = None


class ApprovalRequestOut(BaseModel):
    request_id: UUID
    log_id: Optional[UUID]
    source_order_number: str
    issue_type: IssueType
    channel: Channel
    amount: Decimal
    root_cause_category: Optional[str]
    proposed_fix: Optional[Dict[str, Any]]
    proposed_by_type: str
    proposed_by_email: Optional[str]
    maker_note: Optional[str]
    status: RequestStatus
    decided_by_email: Optional[str]
    checker_note: Optional[str]
    created_at: datetime
    decided_at: Optional[datetime]
    is_mine: bool = False


class ApprovalPage(BaseModel):
    total: int
    pending_value: Decimal
    limit: int
    offset: int
    items: List[ApprovalRequestOut]


class DecisionRequest(BaseModel):
    note: Optional[str] = Field(default=None, max_length=1000)


class BulkDecisionRequest(BaseModel):
    request_ids: List[UUID] = Field(min_length=1, max_length=500)
    note: Optional[str] = Field(default=None, max_length=1000)


class BulkDecisionResult(BaseModel):
    approved: List[UUID]
    failed: Dict[str, str]


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
    pending_approval_count: int
    pending_approval_value: Decimal
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


# ---------------------------------------------------------------- recovery & claims
class ClaimStatus(str, Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    PARTIALLY_RECOVERED = "PARTIALLY_RECOVERED"
    RECOVERED = "RECOVERED"
    REJECTED = "REJECTED"
    WRITTEN_OFF = "WRITTEN_OFF"
    CANCELLED = "CANCELLED"


class CounterpartyType(str, Enum):
    COURIER = "COURIER"
    GATEWAY = "GATEWAY"
    BANK = "BANK"


class ClaimableFinding(BaseModel):
    log_id: UUID
    source_order_number: str
    issue_type: IssueType
    channel: Channel
    amount: Decimal
    root_cause_category: Optional[str]
    counterparty_type: CounterpartyType
    counterparty_name: str
    evidence: Dict[str, Any]


class ClaimableGroup(BaseModel):
    counterparty_type: CounterpartyType
    counterparty_name: str
    total: Decimal
    count: int
    items: List[ClaimableFinding]


class ClaimCreate(BaseModel):
    log_ids: List[UUID] = Field(min_length=1, max_length=500)
    counterparty_contact: Optional[EmailStr] = None
    notes: Optional[str] = Field(default=None, max_length=1000)
    due_days: int = Field(default=14, ge=1, le=120)


class ClaimSubmit(BaseModel):
    send_email: bool = False
    counterparty_contact: Optional[EmailStr] = None


class ClaimPayment(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=2)
    reference: Optional[str] = Field(default=None, max_length=128)
    received_on: Optional[date] = None
    note: Optional[str] = Field(default=None, max_length=1000)


class ClaimNote(BaseModel):
    note: str = Field(min_length=3, max_length=1000)


class ClaimItemOut(BaseModel):
    item_id: UUID
    source_order_number: str
    issue_type: IssueType
    channel: Channel
    amount: Decimal
    root_cause_category: Optional[str]
    evidence: Dict[str, Any]
    data_cleared_amount: Decimal
    active: bool
    finding_status: Optional[str]


class ClaimEventOut(BaseModel):
    event_id: UUID
    kind: str
    amount: Optional[Decimal]
    reference: Optional[str]
    note: Optional[str]
    actor_email: Optional[str]
    occurred_on: date
    created_at: datetime


class ClaimSummaryRow(BaseModel):
    claim_id: UUID
    claim_number: str
    counterparty_type: CounterpartyType
    counterparty_name: str
    counterparty_contact: Optional[str]
    currency: str
    status: ClaimStatus
    claimed_amount: Decimal
    recovered_amount: Decimal
    written_off_amount: Decimal
    outstanding_amount: Decimal
    due_date: Optional[date]
    notes: Optional[str]
    created_by_email: Optional[str]
    created_at: datetime
    submitted_at: Optional[datetime]
    closed_at: Optional[datetime]
    item_count: Optional[int] = None


class ClaimOut(ClaimSummaryRow):
    items: List[ClaimItemOut]
    events: List[ClaimEventOut]
    letter_subject: str
    letter_text: str
    email_sent: Optional[bool] = None
    email_error: Optional[str] = None
    resolutions: List[Dict[str, Any]] = []


class ClaimPage(BaseModel):
    total: int
    limit: int
    offset: int
    items: List[ClaimSummaryRow]


class CounterpartyRecovery(BaseModel):
    counterparty_type: CounterpartyType
    counterparty_name: str
    open_claims: int
    claimed: Decimal
    recovered: Decimal
    outstanding: Decimal


class RecoverySummary(BaseModel):
    currency: str
    claimable_count: int
    claimable_value: Decimal
    open_claims: int
    open_value: Decimal
    recovered_total: Decimal
    recovered_this_month: Decimal
    written_off_total: Decimal
    recovery_rate_pct: Optional[Decimal]
    by_counterparty: List[CounterpartyRecovery]
