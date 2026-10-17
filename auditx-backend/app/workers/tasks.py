"""Celery application and background audit jobs.

Start a worker with:  celery -A app.workers.tasks worker --loglevel=INFO --concurrency=4
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional
from uuid import UUID

from celery import Celery
from sqlalchemy import text

from app.config import settings
from app.database import engine

logger = logging.getLogger("auditx.tasks")

# Eager mode (single-container free tier) runs tasks in-process and needs no Redis at all.
_broker = "memory://" if settings.CELERY_TASK_ALWAYS_EAGER else settings.broker_url
_backend = "cache+memory://" if settings.CELERY_TASK_ALWAYS_EAGER else settings.result_backend
celery_app = Celery("auditx", broker=_broker, backend=_backend)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_track_started=True,
    result_expires=60 * 60 * 24,
    task_time_limit=60 * 60 * 2,
    task_soft_time_limit=60 * 60 * 2 - 60,
    task_always_eager=settings.CELERY_TASK_ALWAYS_EAGER,
    task_eager_propagates=False,
    broker_connection_retry_on_startup=True,
    task_routes={
        "auditx.ingest_file": {"queue": "ingest"},
        "auditx.run_reconciliation": {"queue": "reconcile"},
    },
    task_default_queue="default",
    # Alert digests: the job is cheap when nothing is due, and each recipient gets at most one per period.
    beat_schedule={"send-due-alerts": {"task": "auditx.send_due_alerts", "schedule": 15 * 60}},
)


def _mark_job(job_id: str, status: str, result: Optional[Dict[str, Any]] = None, error: Optional[str] = None) -> None:
    timestamp_column = "started_at" if status == "RUNNING" else "finished_at"
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE audit_jobs
                   SET status = :status,
                       result = COALESCE(CAST(:result AS jsonb), result),
                       error = :error,
                       {timestamp_column} = now()
                 WHERE job_id = :job_id
                """
            ),
            {
                "job_id": job_id,
                "status": status,
                "result": json.dumps(result, default=str) if result is not None else None,
                "error": error,
            },
        )


@celery_app.task(name="auditx.ingest_file", bind=True, max_retries=0)
def ingest_file(self, job_id: str, org_id: str, target_table: str, file_path: str, delete_after: bool = True) -> Dict[str, Any]:
    from app.services.parser import parse_file

    _mark_job(job_id, "RUNNING")
    try:
        def progress(report) -> None:
            try:
                self.update_state(state="PROGRESS", meta=report.as_dict())
            except Exception:  # progress is best-effort; never fail an ingestion over it
                logger.debug("Progress update skipped for job %s", job_id)

        report = parse_file(file_path, UUID(org_id), target_table, progress=progress)
        result = report.as_dict()
        _mark_job(job_id, "SUCCEEDED", result=result)
        return result
    except Exception as exc:
        logger.exception("Ingestion job %s failed", job_id)
        _mark_job(job_id, "FAILED", error=f"{type(exc).__name__}: {exc}")
        raise
    finally:
        if delete_after and os.path.exists(file_path):
            os.remove(file_path)


@celery_app.task(name="auditx.run_reconciliation", bind=True, max_retries=0)
def run_reconciliation(self, job_id: str, org_id: str, auto_heal: bool = True) -> Dict[str, Any]:
    from app.services.auto_healer import heal_org
    from app.services.reconciliation import reconcile_org

    _mark_job(job_id, "RUNNING")
    try:
        report = reconcile_org(UUID(org_id))
        result: Dict[str, Any] = {"reconciliation": report.as_dict()}
        if auto_heal:
            result["auto_healer"] = heal_org(UUID(org_id))
        _mark_job(job_id, "SUCCEEDED", result=result)
        return result
    except Exception as exc:
        logger.exception("Reconciliation job %s failed", job_id)
        _mark_job(job_id, "FAILED", error=f"{type(exc).__name__}: {exc}")
        raise


@celery_app.task(name="auditx.send_due_alerts")
def send_due_alerts() -> Dict[str, int]:
    """Periodic (Celery beat): send WhatsApp / email digests that are due."""
    from app.services.alerts import run_due

    return run_due()
