"""Maker-checker approval workflow for resolving discrepancies.

Every resolution is a `resolution_requests` row, whether it was proposed by the AI Auto-Healer or by a person:

  maker (AI or user) proposes  ->  finding moves to PENDING_APPROVAL  ->  a checker approves or rejects
                                                                         (approve: finding RESOLVED,
                                                                          reject:  finding back to UNRESOLVED)

The tenant's `approval_policies` row decides what skips the queue:
  auto_heal_mode  AUTO            every AI fix posts immediately (no queue)
                  THRESHOLD       AI fixes up to auto_heal_max_amount post immediately, larger ones queue
                  ALWAYS_APPROVE  every AI fix queues
  manual_requires_approval / manual_auto_approve_max  the same for fixes proposed by people.
Fixes that skip the queue are still recorded, as requests approved by "policy:auto".

Segregation of duties: only CHECKER_ROLES may decide, and nobody may decide a request they proposed.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Connection

CHECKER_ROLES = ("OWNER", "ADMIN", "AUDITOR")
POLICY_AUTO = "policy:auto"


class ApprovalError(Exception):
    """A request that cannot be decided. `status_code` maps to the HTTP response."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class ApprovalPolicy:
    auto_heal_mode: str = "THRESHOLD"
    auto_heal_max_amount: Decimal = Decimal("1.00")
    manual_requires_approval: bool = True
    manual_auto_approve_max: Decimal = Decimal("0")
    updated_at: Optional[datetime] = None
    updated_by_email: Optional[str] = None

    def ai_needs_approval(self, amount: Decimal) -> bool:
        if self.auto_heal_mode == "AUTO":
            return False
        if self.auto_heal_mode == "ALWAYS_APPROVE":
            return True
        return amount > self.auto_heal_max_amount

    def manual_needs_approval(self, amount: Decimal) -> bool:
        return self.manual_requires_approval and amount > self.manual_auto_approve_max

    def as_dict(self) -> Dict[str, Any]:
        return dict(self.__dict__)


def load_policy(conn: Connection, org_id: UUID) -> ApprovalPolicy:
    row = conn.execute(
        text("SELECT auto_heal_mode, auto_heal_max_amount, manual_requires_approval, manual_auto_approve_max, "
             "updated_at, updated_by_email FROM approval_policies WHERE org_id = :o"),
        {"o": str(org_id)},
    ).mappings().first()
    return ApprovalPolicy(**row) if row else ApprovalPolicy()


def save_policy(conn: Connection, org_id: UUID, policy: Dict[str, Any], email: str) -> ApprovalPolicy:
    conn.execute(
        text(
            """
            INSERT INTO approval_policies (org_id, auto_heal_mode, auto_heal_max_amount, manual_requires_approval,
                                           manual_auto_approve_max, updated_at, updated_by_email)
            VALUES (:o, :mode, :ai_max, :manual, :manual_max, now(), :email)
            ON CONFLICT (org_id) DO UPDATE
               SET auto_heal_mode = EXCLUDED.auto_heal_mode,
                   auto_heal_max_amount = EXCLUDED.auto_heal_max_amount,
                   manual_requires_approval = EXCLUDED.manual_requires_approval,
                   manual_auto_approve_max = EXCLUDED.manual_auto_approve_max,
                   updated_at = now(),
                   updated_by_email = EXCLUDED.updated_by_email
            """
        ),
        {"o": str(org_id), "mode": policy["auto_heal_mode"], "ai_max": policy["auto_heal_max_amount"],
         "manual": policy["manual_requires_approval"], "manual_max": policy["manual_auto_approve_max"],
         "email": email},
    )
    return load_policy(conn, org_id)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def submit_manual_resolution(
    conn: Connection,
    org_id: UUID,
    log_id: UUID,
    user_id: UUID,
    email: str,
    note: str,
    category: Optional[str],
) -> Dict[str, Any]:
    """A person proposes to resolve an open finding. Returns the updated discrepancy row."""
    log = conn.execute(
        text("SELECT * FROM discrepancy_logs WHERE log_id = :l AND org_id = :o AND status = 'UNRESOLVED' FOR UPDATE"),
        {"l": str(log_id), "o": str(org_id)},
    ).mappings().first()
    if not log:
        raise ApprovalError(404, "Open discrepancy not found")

    policy = load_policy(conn, org_id)
    amount = abs(Decimal(log["variance_amount"]))
    needs_approval = policy.manual_needs_approval(amount)
    request = conn.execute(
        text(
            """
            INSERT INTO resolution_requests
                (org_id, log_id, source_order_number, issue_type, channel, amount, root_cause_category,
                 proposed_fix, proposed_by_type, proposed_by, proposed_by_email, maker_note,
                 status, decided_by_email, decided_at)
            VALUES (:o, :l, :ref, :issue, :channel, :amount, :category, CAST(:fix AS jsonb), 'USER', :u, :email,
                    :note, :status, :decider, CASE WHEN :status = 'APPROVED' THEN now() END)
            RETURNING request_id
            """
        ),
        {"o": str(org_id), "l": str(log_id), "ref": log["source_order_number"], "issue": log["issue_type"],
         "channel": log["channel"], "amount": amount, "category": category or log["ai_root_cause_category"],
         "fix": json.dumps(log["ai_suggested_fix"]) if log["ai_suggested_fix"] is not None else None,
         "u": str(user_id), "email": email, "note": note,
         "status": "PENDING" if needs_approval else "APPROVED",
         "decider": None if needs_approval else POLICY_AUTO},
    ).scalar_one()

    approval = {
        "request_id": str(request),
        "status": "PENDING" if needs_approval else "APPROVED",
        "proposed_by": email,
        "proposed_at": _now(),
        "maker_note": note,
    }
    if needs_approval:
        sql = """UPDATE discrepancy_logs
                    SET status = 'PENDING_APPROVAL',
                        ai_suggested_fix = COALESCE(ai_suggested_fix, '{}'::jsonb) || CAST(:fix AS jsonb)
                  WHERE log_id = :l RETURNING *"""
    else:
        approval.update({"approved_by": POLICY_AUTO, "approved_at": _now()})
        sql = """UPDATE discrepancy_logs
                    SET status = 'RESOLVED', resolved_at = now(), auto_resolved = FALSE,
                        ai_root_cause_category = COALESCE(:c, ai_root_cause_category),
                        ai_suggested_fix = COALESCE(ai_suggested_fix, '{}'::jsonb) || CAST(:fix AS jsonb)
                  WHERE log_id = :l RETURNING *"""
    fix = {"approval": approval, "manual_resolution": {"note": note, "resolved_by": email, "resolved_at": _now()}}
    return dict(conn.execute(text(sql), {"l": str(log_id), "c": category, "fix": json.dumps(fix)}).mappings().one())


def _locked_request(conn: Connection, org_id: UUID, request_id: UUID) -> Dict[str, Any]:
    row = conn.execute(
        text("SELECT * FROM resolution_requests WHERE request_id = :r AND org_id = :o FOR UPDATE"),
        {"r": str(request_id), "o": str(org_id)},
    ).mappings().first()
    if not row:
        raise ApprovalError(404, "Approval request not found")
    if row["status"] != "PENDING":
        raise ApprovalError(409, f"Request is already {row['status'].lower()}")
    return dict(row)


def decide(
    conn: Connection,
    org_id: UUID,
    request_id: UUID,
    user_id: UUID,
    email: str,
    role: str,
    approve: bool,
    note: Optional[str],
) -> Dict[str, Any]:
    """A checker approves or rejects a pending request. Returns the updated request row."""
    if role not in CHECKER_ROLES:
        raise ApprovalError(403, f"Role {role} may not approve; checkers are {', '.join(CHECKER_ROLES)}")
    request = _locked_request(conn, org_id, request_id)
    if request["proposed_by"] is not None and str(request["proposed_by"]) == str(user_id):
        raise ApprovalError(403, "Segregation of duties: you cannot decide a request you proposed")
    if not approve and not (note and note.strip()):
        raise ApprovalError(422, "A rejection needs a reason")

    status = "APPROVED" if approve else "REJECTED"
    decided = conn.execute(
        text(
            """
            UPDATE resolution_requests
               SET status = :s, decided_by = :u, decided_by_email = :e, checker_note = :n, decided_at = now()
             WHERE request_id = :r
            RETURNING *
            """
        ),
        {"s": status, "u": str(user_id), "e": email, "n": note, "r": str(request_id)},
    ).mappings().one()

    if request["log_id"] is not None:
        approval = {
            "request_id": str(request_id),
            "status": status,
            "proposed_by": request["proposed_by_email"] or "AI Auto-Healer",
            "proposed_at": request["created_at"].isoformat(),
            "maker_note": request["maker_note"],
            "approved_by" if approve else "rejected_by": email,
            "approved_at" if approve else "rejected_at": _now(),
            "checker_note": note,
        }
        if approve:
            sql = """UPDATE discrepancy_logs
                        SET status = 'RESOLVED', resolved_at = now(), auto_resolved = :ai,
                            ai_root_cause_category = COALESCE(:c, ai_root_cause_category),
                            ai_suggested_fix = COALESCE(ai_suggested_fix, '{}'::jsonb) || CAST(:fix AS jsonb)
                      WHERE log_id = :l AND status = 'PENDING_APPROVAL'"""
        else:
            sql = """UPDATE discrepancy_logs
                        SET status = 'UNRESOLVED',
                            ai_suggested_fix = COALESCE(ai_suggested_fix, '{}'::jsonb) || CAST(:fix AS jsonb)
                      WHERE log_id = :l AND status = 'PENDING_APPROVAL'"""
        conn.execute(text(sql), {
            "l": str(request["log_id"]), "ai": request["proposed_by_type"] == "AI",
            "c": request["root_cause_category"], "fix": json.dumps({"approval": approval}),
        })
    return dict(decided)


def withdraw(conn: Connection, org_id: UUID, request_id: UUID, user_id: UUID) -> Dict[str, Any]:
    """The maker takes back their own pending request; the finding reopens."""
    request = _locked_request(conn, org_id, request_id)
    if request["proposed_by"] is None or str(request["proposed_by"]) != str(user_id):
        raise ApprovalError(403, "Only the person who proposed a request can withdraw it")
    withdrawn = conn.execute(
        text("UPDATE resolution_requests SET status = 'WITHDRAWN', decided_by = :u, decided_by_email = proposed_by_email, "
             "decided_at = now() WHERE request_id = :r RETURNING *"),
        {"u": str(user_id), "r": str(request_id)},
    ).mappings().one()
    if request["log_id"] is not None:
        conn.execute(
            text("UPDATE discrepancy_logs SET status = 'UNRESOLVED', "
                 "ai_suggested_fix = ai_suggested_fix - 'approval' - 'manual_resolution' "
                 "WHERE log_id = :l AND status = 'PENDING_APPROVAL'"),
            {"l": str(request["log_id"])},
        )
    return dict(withdrawn)
