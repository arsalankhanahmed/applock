"""AuditX FastAPI gateway: async, tenant-scoped REST API.

Heavy jobs (file ingestion, reconciliation + auto-healing) are queued to Celery and answered with
202 Accepted plus a job status URL; interactive reads are served directly.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional
from uuid import UUID, uuid4

import jwt
from fastapi import (BackgroundTasks, Depends, FastAPI, File, HTTPException, Query, Request, UploadFile,
                     status)
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError

from app.config import settings
from app.database import engine, init_db
from app.models.schemas import (AgentQueryRequest, AgentQueryResponse, CurrentUser, DashboardMetrics,
                                DataDictionaryField, DiscrepancyOut, DiscrepancyPage, DiscrepancyStatus,
                                FieldMappingBulkIn, FieldMappingOut, IngestTarget, IssueType, JobAccepted,
                                JobOut, JobStatus, JobType, LoginRequest, ManualResolveRequest,
                                ReconciliationRequest, RegisterRequest, TokenResponse, UserRole)
from app.services import ai_agent
from app.workers.tasks import ingest_file, run_reconciliation

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("auditx.api")

PBKDF2_ITERATIONS = 390_000
WRITE_ROLES = (UserRole.OWNER, UserRole.ADMIN, UserRole.ANALYST)
ADMIN_ROLES = (UserRole.OWNER, UserRole.ADMIN)


# ----------------------------------------------------------------------------- security helpers
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS, base64.b64encode(salt).decode(), base64.b64encode(digest).decode()
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, iterations, salt_b64, digest_b64 = stored.split("$")
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt_b64), int(iterations))
    return hmac.compare_digest(digest, base64.b64decode(digest_b64))


def issue_token(user_id: UUID, org_id: UUID, role: str, email: str) -> str:
    now = datetime.now(timezone.utc)
    claims = {
        "sub": str(user_id),
        "org": str(org_id),
        "role": role,
        "email": email,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.JWT_EXPIRE_MINUTES)).timestamp()),
        "iss": "auditx",
    }
    return jwt.encode(claims, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


bearer = HTTPBearer(auto_error=False)


async def current_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> CurrentUser:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token",
                            headers={"WWW-Authenticate": "Bearer"})
    try:
        claims = jwt.decode(creds.credentials, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM],
                            issuer="auditx")
        return CurrentUser(user_id=claims["sub"], org_id=claims["org"], role=claims["role"], email=claims["email"])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token: {exc}",
                            headers={"WWW-Authenticate": "Bearer"}) from exc


def require_roles(*roles: UserRole) -> Callable[..., Any]:
    async def dependency(user: CurrentUser = Depends(current_user)) -> CurrentUser:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Role {user.role.value} may not perform this action")
        return user

    return dependency


# ----------------------------------------------------------------------------- db helpers (sync, run in threadpool)
def _fetch_all(sql: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
    with engine.connect() as conn:
        return [dict(r) for r in conn.execute(text(sql), params).mappings().all()]


def _fetch_one(sql: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    with engine.connect() as conn:
        row = conn.execute(text(sql), params).mappings().first()
        return dict(row) if row else None


def _execute(sql: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    with engine.begin() as conn:
        row = conn.execute(text(sql), params).mappings().first()
        return dict(row) if row else None


def _create_job(org_id: UUID, job_type: JobType, payload: Dict[str, Any]) -> UUID:
    row = _execute(
        "INSERT INTO audit_jobs (org_id, job_type, payload) VALUES (:org_id, :job_type, CAST(:payload AS jsonb)) "
        "RETURNING job_id",
        {"org_id": str(org_id), "job_type": job_type.value, "payload": json.dumps(payload)},
    )
    return row["job_id"]


def _dispatch(task: Any, background: BackgroundTasks, kwargs: Dict[str, Any]) -> None:
    """Queue to Celery, or run after the response in eager single-container mode."""
    if settings.CELERY_TASK_ALWAYS_EAGER:
        background.add_task(task.apply, kwargs=kwargs)
    else:
        task.apply_async(kwargs=kwargs)


# ----------------------------------------------------------------------------- application
@asynccontextmanager
async def lifespan(_: FastAPI):
    for attempt in range(1, 16):
        try:
            await run_in_threadpool(init_db)
            logger.info("Database schema ready")
            break
        except OperationalError as exc:
            logger.warning("Database not ready (attempt %d/15): %s", attempt, str(exc).splitlines()[0])
            await asyncio.sleep(2)
    else:
        raise RuntimeError("Database unavailable after 15 attempts")
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    yield


app = FastAPI(
    title="AuditX API",
    version="1.0.0",
    description="Autonomous multi-channel financial reconciliation, AI auto-healing and forensic ledger chat.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(ai_agent.UnsafeQueryError)
async def unsafe_query_handler(_: Request, exc: ai_agent.UnsafeQueryError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": f"Forensic agent refused the query: {exc}"})


@app.get("/health", tags=["ops"])
async def health() -> Dict[str, Any]:
    def probe() -> bool:
        with engine.connect() as conn:
            return conn.execute(text("SELECT 1")).scalar_one() == 1

    db_ok = await run_in_threadpool(probe)
    return {"status": "ok" if db_ok else "degraded", "database": db_ok, "eager_tasks": settings.CELERY_TASK_ALWAYS_EAGER}


P = settings.API_PREFIX


# ----------------------------------------------------------------------------- auth
@app.post(f"{P}/auth/register", response_model=TokenResponse, status_code=201, tags=["auth"])
async def register(body: RegisterRequest) -> TokenResponse:
    def create() -> Dict[str, Any]:
        with engine.begin() as conn:
            org = conn.execute(
                text("INSERT INTO organizations (company_name, brand_currency) VALUES (:n, :c) RETURNING org_id"),
                {"n": body.company_name, "c": body.brand_currency},
            ).mappings().one()
            user = conn.execute(
                text(
                    "INSERT INTO users (org_id, full_name, email, password_hash, role) "
                    "VALUES (:o, :n, lower(:e), :p, 'OWNER') RETURNING user_id"
                ),
                {"o": org["org_id"], "n": body.full_name, "e": body.email, "p": hash_password(body.password)},
            ).mappings().one()
        return {"org_id": org["org_id"], "user_id": user["user_id"]}

    try:
        ids = await run_in_threadpool(create)
    except IntegrityError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists") from exc
    token = issue_token(ids["user_id"], ids["org_id"], UserRole.OWNER.value, body.email.lower())
    return TokenResponse(access_token=token, expires_in=settings.JWT_EXPIRE_MINUTES * 60, org_id=ids["org_id"],
                         user_id=ids["user_id"], role=UserRole.OWNER, company_name=body.company_name)


@app.post(f"{P}/auth/login", response_model=TokenResponse, tags=["auth"])
async def login(body: LoginRequest) -> TokenResponse:
    row = await run_in_threadpool(
        _fetch_one,
        "SELECT u.user_id, u.org_id, u.password_hash, u.role, u.email, o.company_name "
        "FROM users u JOIN organizations o ON o.org_id = u.org_id WHERE u.email = lower(:e)",
        {"e": body.email},
    )
    if not row or not await run_in_threadpool(verify_password, body.password, row["password_hash"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    token = issue_token(row["user_id"], row["org_id"], row["role"], row["email"])
    return TokenResponse(access_token=token, expires_in=settings.JWT_EXPIRE_MINUTES * 60, org_id=row["org_id"],
                         user_id=row["user_id"], role=row["role"], company_name=row["company_name"])


@app.get(f"{P}/me", tags=["auth"])
async def me(user: CurrentUser = Depends(current_user)) -> Dict[str, Any]:
    org = await run_in_threadpool(
        _fetch_one, "SELECT org_id, company_name, brand_currency, created_at FROM organizations WHERE org_id = :o",
        {"o": str(user.org_id)},
    )
    return {"user": user.model_dump(mode="json"), "organization": org}


# ----------------------------------------------------------------------------- data dictionary & mappings
@app.get(f"{P}/data-dictionary", response_model=List[DataDictionaryField], tags=["mappings"])
async def data_dictionary(_: CurrentUser = Depends(current_user)) -> List[Dict[str, Any]]:
    return await run_in_threadpool(
        _fetch_all, "SELECT * FROM data_dictionary_master ORDER BY core_table_name, standard_field_name", {}
    )


_MAPPINGS_SQL = """
    SELECT m.mapping_id, m.standard_field_id, d.core_table_name, d.standard_field_name,
           m.client_erp_column_name, m.transformation_rule
      FROM client_field_mappings m
      JOIN data_dictionary_master d ON d.standard_field_id = m.standard_field_id
     WHERE m.org_id = :o
     ORDER BY d.core_table_name, d.standard_field_name
"""


@app.get(f"{P}/mappings", response_model=List[FieldMappingOut], tags=["mappings"])
async def list_mappings(user: CurrentUser = Depends(current_user)) -> List[Dict[str, Any]]:
    return await run_in_threadpool(_fetch_all, _MAPPINGS_SQL, {"o": str(user.org_id)})


@app.put(f"{P}/mappings", response_model=List[FieldMappingOut], tags=["mappings"])
async def upsert_mappings(body: FieldMappingBulkIn, user: CurrentUser = Depends(require_roles(*ADMIN_ROLES))) -> List[Dict[str, Any]]:
    from app.services.parser import parse_transformation_rule

    for mapping in body.mappings:
        try:
            parse_transformation_rule(mapping.transformation_rule)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    def upsert() -> None:
        with engine.begin() as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO client_field_mappings (org_id, standard_field_id, client_erp_column_name, transformation_rule)
                    VALUES (:o, :f, :c, :r)
                    ON CONFLICT (org_id, standard_field_id) DO UPDATE
                       SET client_erp_column_name = EXCLUDED.client_erp_column_name,
                           transformation_rule    = EXCLUDED.transformation_rule
                    """
                ),
                [
                    {"o": str(user.org_id), "f": str(m.standard_field_id), "c": m.client_erp_column_name,
                     "r": m.transformation_rule}
                    for m in body.mappings
                ],
            )

    try:
        await run_in_threadpool(upsert)
    except IntegrityError as exc:
        raise HTTPException(422, "Unknown standard_field_id in payload") from exc
    return await run_in_threadpool(_fetch_all, _MAPPINGS_SQL, {"o": str(user.org_id)})


# ----------------------------------------------------------------------------- async jobs
@app.post(f"{P}/ingest/{{target}}", response_model=JobAccepted, status_code=status.HTTP_202_ACCEPTED, tags=["jobs"])
async def ingest(
    target: IngestTarget,
    background: BackgroundTasks,
    file: UploadFile = File(..., description="CSV export (any size; streamed to disk in blocks)"),
    user: CurrentUser = Depends(require_roles(*WRITE_ROLES)),
) -> JobAccepted:
    if not (file.filename or "").lower().endswith((".csv", ".txt", ".tsv")):
        raise HTTPException(415, "Only CSV / TSV / TXT exports are supported")

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    path = os.path.join(settings.UPLOAD_DIR, f"{user.org_id}_{uuid4().hex}.csv")
    limit = settings.MAX_UPLOAD_MB * 1024 * 1024
    written = 0
    try:
        with open(path, "wb") as out:
            while block := await file.read(settings.UPLOAD_STREAM_BLOCK_BYTES):
                written += len(block)
                if written > limit:
                    raise HTTPException(413, f"File exceeds {settings.MAX_UPLOAD_MB} MB limit")
                out.write(block)
    except HTTPException:
        os.remove(path)
        raise
    finally:
        await file.close()
    if written == 0:
        os.remove(path)
        raise HTTPException(422, "Uploaded file is empty")

    job_type = JobType.INGEST_ORDERS if target == IngestTarget.ecom_orders else JobType.INGEST_GATEWAY
    job_id = await run_in_threadpool(
        _create_job, user.org_id, job_type,
        {"filename": file.filename, "bytes": written, "target_table": target.value, "requested_by": user.email},
    )
    _dispatch(ingest_file, background, {
        "job_id": str(job_id), "org_id": str(user.org_id), "target_table": target.value, "file_path": path,
    })
    return JobAccepted(job_id=job_id, job_type=job_type, status=JobStatus.QUEUED, status_url=f"{P}/jobs/{job_id}")


@app.post(f"{P}/reconciliation/run", response_model=JobAccepted, status_code=status.HTTP_202_ACCEPTED, tags=["jobs"])
async def start_reconciliation(
    background: BackgroundTasks,
    body: ReconciliationRequest = ReconciliationRequest(),
    user: CurrentUser = Depends(require_roles(*WRITE_ROLES)),
) -> JobAccepted:
    job_id = await run_in_threadpool(
        _create_job, user.org_id, JobType.RECONCILIATION, {"auto_heal": body.auto_heal, "requested_by": user.email}
    )
    _dispatch(run_reconciliation, background, {
        "job_id": str(job_id), "org_id": str(user.org_id), "auto_heal": body.auto_heal,
    })
    return JobAccepted(job_id=job_id, job_type=JobType.RECONCILIATION, status=JobStatus.QUEUED,
                       status_url=f"{P}/jobs/{job_id}")


@app.get(f"{P}/jobs", response_model=List[JobOut], tags=["jobs"])
async def list_jobs(limit: int = Query(20, ge=1, le=100), user: CurrentUser = Depends(current_user)) -> List[Dict[str, Any]]:
    return await run_in_threadpool(
        _fetch_all, "SELECT * FROM audit_jobs WHERE org_id = :o ORDER BY created_at DESC LIMIT :l",
        {"o": str(user.org_id), "l": limit},
    )


@app.get(f"{P}/jobs/{{job_id}}", response_model=JobOut, tags=["jobs"])
async def get_job(job_id: UUID, user: CurrentUser = Depends(current_user)) -> Dict[str, Any]:
    row = await run_in_threadpool(
        _fetch_one, "SELECT * FROM audit_jobs WHERE job_id = :j AND org_id = :o", {"j": str(job_id), "o": str(user.org_id)}
    )
    if not row:
        raise HTTPException(404, "Job not found")
    return row


# ----------------------------------------------------------------------------- discrepancies
@app.get(f"{P}/discrepancies", response_model=DiscrepancyPage, tags=["discrepancies"])
async def list_discrepancies(
    status_filter: Optional[DiscrepancyStatus] = Query(None, alias="status"),
    issue_type: Optional[IssueType] = None,
    auto_resolved: Optional[bool] = None,
    search: Optional[str] = Query(None, max_length=128),
    sort: str = Query("variance", pattern="^(variance|recent)$"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(current_user),
) -> DiscrepancyPage:
    clauses = ["org_id = :o"]
    params: Dict[str, Any] = {"o": str(user.org_id), "l": limit, "off": offset}
    if status_filter:
        clauses.append("status = :s")
        params["s"] = status_filter.value
    if issue_type:
        clauses.append("issue_type = :t")
        params["t"] = issue_type.value
    if auto_resolved is not None:
        clauses.append("auto_resolved = :a")
        params["a"] = auto_resolved
    if search:
        clauses.append("source_order_number ILIKE :q")
        params["q"] = f"%{search}%"
    where = " AND ".join(clauses)
    order = "ABS(variance_amount) DESC, detected_at DESC" if sort == "variance" else "detected_at DESC, log_id"

    def query() -> DiscrepancyPage:
        with engine.connect() as conn:
            total = conn.execute(text(f"SELECT COUNT(*) FROM discrepancy_logs WHERE {where}"), params).scalar_one()
            rows = conn.execute(
                text(f"SELECT * FROM discrepancy_logs WHERE {where} ORDER BY {order} LIMIT :l OFFSET :off"), params
            ).mappings().all()
        return DiscrepancyPage(total=total, limit=limit, offset=offset, items=[DiscrepancyOut(**r) for r in rows])

    return await run_in_threadpool(query)


@app.post(f"{P}/discrepancies/{{log_id}}/resolve", response_model=DiscrepancyOut, tags=["discrepancies"])
async def resolve_discrepancy(
    log_id: UUID, body: ManualResolveRequest, user: CurrentUser = Depends(require_roles(*WRITE_ROLES, UserRole.AUDITOR))
) -> Dict[str, Any]:
    resolution = {
        "manual_resolution": {
            "note": body.resolution_note,
            "resolved_by": user.email,
            "resolved_at": datetime.now(timezone.utc).isoformat(),
        }
    }
    row = await run_in_threadpool(
        _execute,
        """
        UPDATE discrepancy_logs
           SET status = 'RESOLVED',
               resolved_at = now(),
               auto_resolved = FALSE,
               ai_root_cause_category = COALESCE(:c, ai_root_cause_category),
               ai_suggested_fix = COALESCE(ai_suggested_fix, '{}'::jsonb) || CAST(:fix AS jsonb)
         WHERE log_id = :l AND org_id = :o AND status = 'UNRESOLVED'
        RETURNING *
        """,
        {"l": str(log_id), "o": str(user.org_id), "c": body.root_cause_category, "fix": json.dumps(resolution)},
    )
    if not row:
        raise HTTPException(404, "Open discrepancy not found")
    return row


# ----------------------------------------------------------------------------- dashboard
_METRICS_SQL = """
WITH o AS (
    SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS v FROM ecom_orders WHERE org_id = :o
), g AS (
    SELECT COUNT(*) AS n, COALESCE(SUM(gross_amount), 0) AS gross, COALESCE(SUM(fee_amount), 0) AS fees
      FROM gateway_transactions WHERE org_id = :o
), d AS (
    SELECT COUNT(*) FILTER (WHERE status = 'UNRESOLVED') AS open_n,
           COALESCE(SUM(variance_amount) FILTER (WHERE status = 'UNRESOLVED' AND variance_amount > 0), 0) AS leakage,
           COUNT(*) FILTER (WHERE auto_resolved) AS healed_n,
           COALESCE(SUM(ABS(variance_amount)) FILTER (WHERE auto_resolved), 0) AS healed_v,
           COUNT(*) FILTER (WHERE status = 'RESOLVED' AND NOT auto_resolved) AS manual_n,
           COUNT(*) AS total_n,
           COUNT(DISTINCT source_order_number) FILTER (WHERE issue_type IN ('MISSING_PAYMENT', 'AMOUNT_MISMATCH')) AS bad_orders
      FROM discrepancy_logs WHERE org_id = :o
)
SELECT org.company_name, org.brand_currency,
       o.n AS total_orders, o.v AS total_order_value,
       g.n AS total_gateway_transactions, g.gross AS total_gateway_gross, g.fees AS total_gateway_fees,
       d.open_n AS open_discrepancies, d.leakage AS open_leakage_exposure,
       d.healed_n AS auto_healed_count, d.healed_v AS auto_healed_value, d.manual_n AS manual_resolved_count,
       CASE WHEN o.n = 0 THEN 0 ELSE ROUND(100.0 * (o.n - d.bad_orders) / o.n, 2) END AS match_rate_pct,
       CASE WHEN d.total_n = 0 THEN 0 ELSE ROUND(100.0 * d.healed_n / d.total_n, 2) END AS auto_heal_rate_pct,
       (SELECT MAX(finished_at) FROM audit_jobs
         WHERE org_id = :o AND job_type = 'RECONCILIATION' AND status = 'SUCCEEDED') AS last_reconciliation_at
  FROM organizations org, o, g, d
 WHERE org.org_id = :o
"""

_ISSUE_SQL = """
SELECT t.issue_type,
       COUNT(l.log_id) FILTER (WHERE l.status = 'UNRESOLVED') AS open_count,
       COALESCE(SUM(ABS(l.variance_amount)) FILTER (WHERE l.status = 'UNRESOLVED'), 0) AS open_exposure,
       COUNT(l.log_id) FILTER (WHERE l.status = 'RESOLVED') AS resolved_count
  FROM (VALUES ('MISSING_PAYMENT'), ('UNTRACKED_REVENUE'), ('AMOUNT_MISMATCH')) AS t(issue_type)
  LEFT JOIN discrepancy_logs l ON l.issue_type = t.issue_type AND l.org_id = :o
 GROUP BY t.issue_type
 ORDER BY t.issue_type
"""

_ROOT_CAUSE_SQL = """
SELECT COALESCE(ai_root_cause_category, 'PENDING_ANALYSIS') AS category,
       COUNT(*) AS count,
       COALESCE(SUM(ABS(variance_amount)), 0) AS exposure,
       ROUND(AVG(ai_confidence_score), 4) AS avg_confidence
  FROM discrepancy_logs
 WHERE org_id = :o
 GROUP BY 1
 ORDER BY exposure DESC
"""


@app.get(f"{P}/dashboard/metrics", response_model=DashboardMetrics, tags=["dashboard"])
async def dashboard_metrics(user: CurrentUser = Depends(current_user)) -> DashboardMetrics:
    def collect() -> DashboardMetrics:
        params = {"o": str(user.org_id)}
        with engine.connect() as conn:
            head = conn.execute(text(_METRICS_SQL), params).mappings().one()
            issues = conn.execute(text(_ISSUE_SQL), params).mappings().all()
            causes = conn.execute(text(_ROOT_CAUSE_SQL), params).mappings().all()
        return DashboardMetrics(**head, by_issue_type=[dict(r) for r in issues], by_root_cause=[dict(r) for r in causes])

    return await run_in_threadpool(collect)


# ----------------------------------------------------------------------------- forensic agent
@app.post(f"{P}/agent/query", response_model=AgentQueryResponse, tags=["agent"])
async def agent_query(body: AgentQueryRequest, user: CurrentUser = Depends(current_user)) -> Dict[str, Any]:
    answer = await run_in_threadpool(ai_agent.ask, body.question, user.org_id)
    return answer.as_dict()
