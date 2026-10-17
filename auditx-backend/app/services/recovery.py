"""Recovery & claims: turn findings where a courier, gateway or bank owes money into claims and track the cash back.

Lifecycle of a claim::

    DRAFT --submit--> SUBMITTED --payment--> PARTIALLY_RECOVERED --payment--> RECOVERED
      |                  |  \\                        |  \\
    cancel            reject  write-off            reject  write-off
      v                  v       v                    v       v
    CANCELLED         REJECTED  WRITTEN_OFF        REJECTED  WRITTEN_OFF

* Items snapshot each finding by its natural key (channel, issue_type, reference) because reconciliation
  rebuilds open findings with fresh log_ids on every run.
* Cash comes back two ways: a person records a payment, or a later reconciliation shows the courier / bank data
  now matches (``sync_with_data`` books a DATA_MATCH event). Both are capped at what is still outstanding, so the
  same money is never counted twice.
* Closing a claim never resolves findings directly: fully recovered or written-off claims submit each still-open
  finding through maker-checker (``approvals.submit_manual_resolution``), so the approval policy still applies.
"""
from __future__ import annotations

import html
import json
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError

from app.database import engine
from app.services import approvals, mailer

logger = logging.getLogger("auditx.recovery")

# Finding types where the money sits with a counterparty that can be asked to pay it back.
CLAIMABLE = {
    "COD": ("COD_NOT_REMITTED", "COD_REMITTANCE_SHORTFALL", "COURIER_OVERCHARGE", "PARCEL_LOST_OR_STUCK"),
    "BANK": ("SETTLEMENT_NOT_DEPOSITED", "DEPOSIT_MISMATCH"),
}
# A finding can change type as data arrives (an unpaid COD order becomes a short remittance once part is paid),
# so a claim item covers every claimable finding with the same channel and reference.
_TYPES_SQL = " OR ".join(
    f"(d.channel = '{ch}' AND d.issue_type IN ({', '.join(repr(t) for t in types)}))" for ch, types in CLAIMABLE.items()
)
SAME_FAMILY = ("d.org_id = i.org_id AND d.channel = i.channel AND d.source_order_number = i.source_order_number "
               f"AND ({_TYPES_SQL})")
OPEN_STATUSES = ("DRAFT", "SUBMITTED", "PARTIALLY_RECOVERED")
COLLECTING_STATUSES = ("SUBMITTED", "PARTIALLY_RECOVERED")
RECOVERED_CATEGORY = "RECOVERED_FROM_COUNTERPARTY"
WRITE_OFF_CATEGORY = "WRITE_OFF"
DEFAULT_DUE_DAYS = 14
CENT = Decimal("0.01")

ISSUE_WORDING = {
    "COD_NOT_REMITTED": "Cash collected on delivery but not remitted",
    "COD_REMITTANCE_SHORTFALL": "Remittance short of cash collected",
    "COURIER_OVERCHARGE": "Delivery charges above the agreed rate",
    "PARCEL_LOST_OR_STUCK": "Parcel lost or stuck in transit",
    "SETTLEMENT_NOT_DEPOSITED": "Settlement never deposited to our bank account",
    "DEPOSIT_MISMATCH": "Settlement deposited short",
}


class RecoveryError(Exception):
    """A business-rule violation with the HTTP status that best describes it."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


def _money(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(CENT)


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


# ----------------------------------------------------------------------------- claimable findings
_OPEN_CLAIMABLE_SQL = """
    SELECT d.log_id, d.source_order_number, d.issue_type, d.channel, d.order_amount, d.gateway_amount,
           d.variance_amount, d.ai_root_cause_category, d.detected_at
      FROM discrepancy_logs d
     WHERE d.org_id = :o AND d.status = 'UNRESOLVED' AND d.variance_amount > 0
       AND ((d.channel = 'COD' AND d.issue_type = ANY(:cod)) OR (d.channel = 'BANK' AND d.issue_type = ANY(:bank)))
       AND NOT EXISTS (SELECT 1 FROM recovery_claim_items i
                        WHERE i.org_id = d.org_id AND i.active AND i.channel = d.channel
                          AND i.source_order_number = d.source_order_number)
"""

_PARCEL_SQL = """
    SELECT DISTINCT ON (source_order_number)
           source_order_number, tracking_number, courier_name, parcel_status, cod_amount, delivery_charges,
           net_remitted, remittance_reference, booked_at, delivered_at
      FROM courier_remittances
     WHERE org_id = :o AND source_order_number = ANY(:refs)
     ORDER BY source_order_number,
              CASE parcel_status WHEN 'DELIVERED' THEN 0 WHEN 'LOST' THEN 1 WHEN 'RETURNED' THEN 2 ELSE 3 END
"""

_SETTLEMENT_SQL = """
    SELECT payout_reference AS reference, 'GATEWAY' AS kind, NULL::text AS courier,
           COUNT(*)::int AS transactions, MAX(processed_at) AS closed_at
      FROM gateway_transactions WHERE org_id = :o AND payout_reference = ANY(:refs) GROUP BY payout_reference
    UNION ALL
    SELECT remittance_reference, 'COURIER', MIN(courier_name), COUNT(*)::int, MAX(COALESCE(remitted_at, delivered_at))
      FROM courier_remittances WHERE org_id = :o AND remittance_reference = ANY(:refs) GROUP BY remittance_reference
"""


def counterparty_for(finding: Dict[str, Any], parcel: Optional[Dict[str, Any]],
                     settlement: Optional[Dict[str, Any]]) -> Tuple[str, str]:
    """Who owes the money for a claimable finding: (counterparty_type, counterparty_name)."""
    if finding["channel"] == "COD":
        return "COURIER", ((parcel or {}).get("courier_name") or "UNKNOWN COURIER").upper()
    if finding.get("ai_root_cause_category") == "BANK_CHARGES_DEDUCTED":
        return "BANK", "BANK"
    if settlement and settlement.get("kind") == "COURIER":
        return "COURIER", (settlement.get("courier") or "UNKNOWN COURIER").upper()
    return "GATEWAY", "PAYMENT GATEWAY"


def _evidence(finding: Dict[str, Any], parcel: Optional[Dict[str, Any]],
              settlement: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    evidence: Dict[str, Any] = {
        "expected": str(_money(finding["order_amount"])) if finding["order_amount"] is not None else None,
        "received": str(_money(finding["gateway_amount"])) if finding["gateway_amount"] is not None else None,
        "detected_at": _iso(finding["detected_at"]),
    }
    if parcel:
        evidence.update({
            "tracking_number": parcel["tracking_number"], "parcel_status": parcel["parcel_status"],
            "cod_amount": str(_money(parcel["cod_amount"])), "delivery_charges": str(_money(parcel["delivery_charges"])),
            "net_remitted": str(_money(parcel["net_remitted"])), "remittance_reference": parcel["remittance_reference"],
            "booked_at": _iso(parcel["booked_at"]), "delivered_at": _iso(parcel["delivered_at"]),
        })
    if settlement:
        evidence.update({"settlement_transactions": settlement["transactions"],
                         "settlement_closed_at": _iso(settlement["closed_at"])})
    return evidence


def claimable_findings(conn: Connection, org_id: UUID, log_ids: Optional[Sequence[UUID]] = None) -> List[Dict[str, Any]]:
    """Open findings that can be claimed and are not already in an open claim, with counterparty and evidence."""
    sql = _OPEN_CLAIMABLE_SQL
    params: Dict[str, Any] = {"o": str(org_id), "cod": list(CLAIMABLE["COD"]), "bank": list(CLAIMABLE["BANK"])}
    if log_ids is not None:
        sql += " AND d.log_id = ANY(CAST(:ids AS uuid[]))"
        params["ids"] = [str(i) for i in log_ids]
    rows = [dict(r) for r in conn.execute(text(sql + " ORDER BY d.variance_amount DESC"), params).mappings()]
    cod_refs = [r["source_order_number"] for r in rows if r["channel"] == "COD"]
    bank_refs = [r["source_order_number"] for r in rows if r["channel"] == "BANK"]
    parcels = {p["source_order_number"]: dict(p) for p in conn.execute(
        text(_PARCEL_SQL), {"o": str(org_id), "refs": cod_refs}).mappings()} if cod_refs else {}
    settlements: Dict[str, Dict[str, Any]] = {}
    if bank_refs:
        for s in conn.execute(text(_SETTLEMENT_SQL), {"o": str(org_id), "refs": bank_refs}).mappings():
            settlements.setdefault(s["reference"], dict(s))
    out = []
    for r in rows:
        parcel = parcels.get(r["source_order_number"]) if r["channel"] == "COD" else None
        settlement = settlements.get(r["source_order_number"]) if r["channel"] == "BANK" else None
        kind, name = counterparty_for(r, parcel, settlement)
        out.append({
            "log_id": r["log_id"], "source_order_number": r["source_order_number"], "issue_type": r["issue_type"],
            "channel": r["channel"], "amount": _money(r["variance_amount"]),
            "root_cause_category": r["ai_root_cause_category"], "counterparty_type": kind,
            "counterparty_name": name, "evidence": _evidence(r, parcel, settlement),
        })
    return out


def group_by_counterparty(findings: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    groups: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for f in findings:
        key = (f["counterparty_type"], f["counterparty_name"])
        group = groups.setdefault(key, {"counterparty_type": key[0], "counterparty_name": key[1],
                                        "total": Decimal("0.00"), "count": 0, "items": []})
        group["items"].append(f)
        group["total"] += f["amount"]
        group["count"] += 1
    return sorted(groups.values(), key=lambda g: (-g["total"], g["counterparty_name"]))


# ----------------------------------------------------------------------------- reading claims
def _claim_row(conn: Connection, org_id: UUID, claim_id: UUID, lock: bool = False) -> Dict[str, Any]:
    row = conn.execute(
        text("SELECT * FROM recovery_claims WHERE claim_id = :c AND org_id = :o" + (" FOR UPDATE" if lock else "")),
        {"c": str(claim_id), "o": str(org_id)},
    ).mappings().first()
    if not row:
        raise RecoveryError(404, "Claim not found")
    return dict(row)


def _with_outstanding(claim: Dict[str, Any]) -> Dict[str, Any]:
    claim["outstanding_amount"] = _money(claim["claimed_amount"]) - _money(claim["recovered_amount"]) \
        - _money(claim["written_off_amount"])
    return claim


def _items(conn: Connection, org_id: UUID, claim_id: UUID) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(text(
        f"""
        SELECT i.*,
               (SELECT d.status FROM discrepancy_logs d
                 WHERE {SAME_FAMILY}
                 ORDER BY CASE d.status WHEN 'UNRESOLVED' THEN 0 WHEN 'PENDING_APPROVAL' THEN 1 ELSE 2 END
                 LIMIT 1) AS finding_status
          FROM recovery_claim_items i WHERE i.claim_id = :c AND i.org_id = :o
         ORDER BY i.amount DESC, i.source_order_number
        """), {"c": str(claim_id), "o": str(org_id)}).mappings()]


def _events(conn: Connection, org_id: UUID, claim_id: UUID) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(text(
        "SELECT * FROM recovery_events WHERE claim_id = :c AND org_id = :o ORDER BY created_at, event_id"),
        {"c": str(claim_id), "o": str(org_id)}).mappings()]


def _company(conn: Connection, org_id: UUID) -> Dict[str, Any]:
    return dict(conn.execute(text("SELECT company_name, brand_currency FROM organizations WHERE org_id = :o"),
                             {"o": str(org_id)}).mappings().one())


def get_claim(conn: Connection, org_id: UUID, claim_id: UUID) -> Dict[str, Any]:
    claim = _with_outstanding(_claim_row(conn, org_id, claim_id))
    claim["items"] = _items(conn, org_id, claim_id)
    claim["events"] = _events(conn, org_id, claim_id)
    subject, body, _ = render_letter(claim, claim["items"], _company(conn, org_id)["company_name"])
    claim["letter_subject"], claim["letter_text"] = subject, body
    return claim


def list_claims(conn: Connection, org_id: UUID, status: Optional[str] = None, limit: int = 50,
                offset: int = 0) -> Dict[str, Any]:
    clauses, params = ["org_id = :o"], {"o": str(org_id), "l": limit, "off": offset}
    if status == "OPEN":
        clauses.append("status = ANY(:open)")
        params["open"] = list(OPEN_STATUSES)
    elif status:
        clauses.append("status = :s")
        params["s"] = status
    where = " AND ".join(clauses)
    total = conn.execute(text(f"SELECT COUNT(*) FROM recovery_claims WHERE {where}"), params).scalar_one()
    rows = conn.execute(text(
        f"""SELECT c.*, (SELECT COUNT(*) FROM recovery_claim_items i WHERE i.claim_id = c.claim_id) AS item_count
              FROM recovery_claims c WHERE {where} ORDER BY c.created_at DESC LIMIT :l OFFSET :off"""), params).mappings()
    return {"total": total, "limit": limit, "offset": offset, "items": [_with_outstanding(dict(r)) for r in rows]}


# ----------------------------------------------------------------------------- claim letter
def _fmt(amount: Any, currency: str) -> str:
    return f"{currency} {_money(amount):,.2f}"


def _item_line(item: Dict[str, Any]) -> Tuple[str, str, str]:
    ev = item.get("evidence") or {}
    if isinstance(ev, str):
        ev = json.loads(ev)
    if item["channel"] == "COD":
        ref = f"Order {item['source_order_number']}" + (f" / CN {ev['tracking_number']}" if ev.get("tracking_number") else "")
        when = ev.get("delivered_at") or ev.get("booked_at")
    else:
        ref = f"Reference {item['source_order_number']}"
        when = ev.get("settlement_closed_at")
    detail = ISSUE_WORDING.get(item["issue_type"], item["issue_type"].replace("_", " ").title())
    if when:
        detail += f" (dated {str(when)[:10]})"
    return ref, detail, str(_money(item["amount"]))


def render_letter(claim: Dict[str, Any], items: Sequence[Dict[str, Any]], company: str) -> Tuple[str, str, str]:
    """Build the claim letter. Returns (subject, plain_text, html). All user-controlled text is HTML-escaped."""
    currency = claim["currency"]
    number = claim["claim_number"]
    due = claim.get("due_date")
    due_text = due.strftime("%d %b %Y") if hasattr(due, "strftime") else (str(due) if due else None)
    issued = claim.get("submitted_at") or claim.get("created_at") or datetime.now(timezone.utc)
    issued_text = issued.strftime("%d %b %Y") if hasattr(issued, "strftime") else str(issued)[:10]
    subject = f"{company} - claim {number} for {_fmt(claim['claimed_amount'], currency)}"
    lines = [_item_line(i) for i in items]
    pay_by = f"by {due_text}" if due_text else "within 14 days"

    text_rows = "\n".join(f"  {i + 1}. {ref} - {detail}: {currency} {Decimal(amount):,.2f}"
                          for i, (ref, detail, amount) in enumerate(lines))
    body = (
        f"To: {claim['counterparty_name']}\n"
        f"From: {company}\n"
        f"Date: {issued_text}\n"
        f"Claim number: {number}\n\n"
        f"Dear {claim['counterparty_name']} team,\n\n"
        f"Our reconciliation of your reports against our order and bank records shows the following amounts are "
        f"due to {company}:\n\n{text_rows}\n\n"
        f"Total claimed: {_fmt(claim['claimed_amount'], currency)}\n\n"
        f"Please remit the total {pay_by}, quoting claim number {number} as the payment reference, or reply with "
        f"evidence for any item you dispute. Supporting order, parcel and settlement details are available on request.\n"
        + (f"\nNotes: {claim['notes']}\n" if claim.get("notes") else "")
        + f"\nRegards,\n{company} Finance\n"
    )

    e = html.escape
    html_rows = "".join(
        f"<tr><td style='padding:6px 8px;border-bottom:1px solid #e5e7eb'>{i + 1}</td>"
        f"<td style='padding:6px 8px;border-bottom:1px solid #e5e7eb'>{e(ref)}</td>"
        f"<td style='padding:6px 8px;border-bottom:1px solid #e5e7eb'>{e(detail)}</td>"
        f"<td style='padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right'>{e(currency)} {Decimal(amount):,.2f}</td></tr>"
        for i, (ref, detail, amount) in enumerate(lines)
    )
    notes = f"<p><b>Notes:</b> {e(claim['notes'])}</p>" if claim.get("notes") else ""
    body_html = f"""\
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:680px;margin:0 auto;color:#1f2937;font-size:14px">
  <p style="font-size:18px;font-weight:700;margin:0 0 4px">{e(company)}</p>
  <p style="color:#6b7280;margin:0 0 20px">Claim {e(number)} &middot; {e(issued_text)}</p>
  <p>To: <b>{e(claim['counterparty_name'])}</b></p>
  <p>Dear {e(claim['counterparty_name'])} team,</p>
  <p>Our reconciliation of your reports against our order and bank records shows the following amounts are due
     to {e(company)}:</p>
  <table style="border-collapse:collapse;width:100%;margin:12px 0">
    <thead><tr style="text-align:left;color:#6b7280;font-size:12px">
      <th style="padding:6px 8px">#</th><th style="padding:6px 8px">Reference</th>
      <th style="padding:6px 8px">Issue</th><th style="padding:6px 8px;text-align:right">Amount</th></tr></thead>
    <tbody>{html_rows}</tbody>
    <tfoot><tr><td colspan="3" style="padding:8px;font-weight:700">Total claimed</td>
      <td style="padding:8px;text-align:right;font-weight:700">{e(_fmt(claim['claimed_amount'], currency))}</td></tr></tfoot>
  </table>
  <p>Please remit the total {e(pay_by)}, quoting claim number <b>{e(number)}</b> as the payment reference, or reply
     with evidence for any item you dispute.</p>
  {notes}
  <p>Regards,<br>{e(company)} Finance</p>
</div>"""
    return subject, body, body_html


# ----------------------------------------------------------------------------- writing
def _event(conn: Connection, org_id: UUID, claim_id: UUID, kind: str, email: Optional[str], amount: Any = None,
           reference: Optional[str] = None, note: Optional[str] = None, occurred_on: Optional[date] = None) -> None:
    conn.execute(text(
        # clock_timestamp(), not now(): several events in one transaction must keep their order on the timeline.
        """INSERT INTO recovery_events (claim_id, org_id, kind, amount, reference, note, actor_email, occurred_on, created_at)
           VALUES (:c, :o, :k, :a, :r, :n, :e, COALESCE(:d, CURRENT_DATE), clock_timestamp())"""),
        {"c": str(claim_id), "o": str(org_id), "k": kind, "a": amount, "r": reference, "n": note, "e": email,
         "d": occurred_on})


def create_claim(conn: Connection, org_id: UUID, user_id: UUID, email: str, log_ids: Sequence[UUID],
                 contact: Optional[str] = None, notes: Optional[str] = None,
                 due_days: int = DEFAULT_DUE_DAYS) -> Dict[str, Any]:
    """Create a DRAFT claim from open findings that all belong to one counterparty."""
    wanted = list(dict.fromkeys(log_ids))
    if not wanted:
        raise RecoveryError(422, "Pick at least one finding to claim")
    found = claimable_findings(conn, org_id, wanted)
    if len(found) != len(wanted):
        missing = len(wanted) - len(found)
        raise RecoveryError(409, f"{missing} of the selected findings can no longer be claimed "
                                 "(already claimed, resolved, or not money owed by a courier, gateway or bank)")
    parties = {(f["counterparty_type"], f["counterparty_name"]) for f in found}
    if len(parties) > 1:
        names = ", ".join(sorted(name for _, name in parties))
        raise RecoveryError(422, f"A claim goes to one counterparty; the selection mixes {names}")
    kind, name = parties.pop()
    currency = _company(conn, org_id)["brand_currency"]
    total = sum((f["amount"] for f in found), Decimal("0.00"))

    # Serialise claim numbering per tenant; the unique constraint is the safety net.
    conn.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"claims:{org_id}"})
    seq = conn.execute(text("SELECT COALESCE(MAX(claim_seq), 0) + 1 FROM recovery_claims WHERE org_id = :o"),
                       {"o": str(org_id)}).scalar_one()
    claim_id = conn.execute(text(
        """INSERT INTO recovery_claims (org_id, claim_seq, claim_number, counterparty_type, counterparty_name,
                                        counterparty_contact, currency, claimed_amount, due_date, notes,
                                        created_by, created_by_email)
           VALUES (:o, :seq, :num, :kind, :name, :contact, :cur, :total, :due, :notes, :u, :e)
           RETURNING claim_id"""),
        {"o": str(org_id), "seq": seq, "num": f"CLM-{seq:04d}", "kind": kind, "name": name, "contact": contact,
         "cur": currency, "total": total, "due": date.today() + timedelta(days=due_days), "notes": notes,
         "u": str(user_id), "e": email}).scalar_one()
    try:
        with conn.begin_nested():
            for f in found:
                conn.execute(text(
                    """INSERT INTO recovery_claim_items (claim_id, org_id, source_order_number, issue_type, channel,
                                                         amount, root_cause_category, evidence)
                       VALUES (:c, :o, :ref, :issue, :ch, :amt, :cat, CAST(:ev AS jsonb))"""),
                    {"c": str(claim_id), "o": str(org_id), "ref": f["source_order_number"], "issue": f["issue_type"],
                     "ch": f["channel"], "amt": f["amount"], "cat": f["root_cause_category"],
                     "ev": json.dumps(f["evidence"])})
    except IntegrityError as exc:
        raise RecoveryError(409, "One of the selected findings was just added to another claim") from exc
    _event(conn, org_id, claim_id, "CREATED", email, total, note=f"{len(found)} finding{'' if len(found) == 1 else 's'} for {name}")
    return get_claim(conn, org_id, claim_id)


def _require(claim: Dict[str, Any], allowed: Sequence[str], action: str) -> None:
    if claim["status"] not in allowed:
        raise RecoveryError(409, f"Cannot {action} a claim that is {claim['status'].replace('_', ' ').lower()}")


def submit_claim(conn: Connection, org_id: UUID, claim_id: UUID, email: str, send_email: bool = False,
                 contact: Optional[str] = None) -> Tuple[Dict[str, Any], bool, Optional[str]]:
    """Mark a draft as sent to the counterparty, optionally emailing the letter. Returns (claim, sent, error)."""
    claim = _claim_row(conn, org_id, claim_id, lock=True)
    _require(claim, ("DRAFT",), "submit")
    if contact:
        claim["counterparty_contact"] = contact
    conn.execute(text(
        """UPDATE recovery_claims SET status = 'SUBMITTED', submitted_at = now(), updated_at = now(),
                  counterparty_contact = :contact WHERE claim_id = :c"""),
        {"c": str(claim_id), "contact": claim["counterparty_contact"]})
    _event(conn, org_id, claim_id, "SUBMITTED", email)
    sent, error = False, None
    if send_email:
        if not claim["counterparty_contact"]:
            error = "No email address for the counterparty; copy or print the claim letter instead."
        else:
            fresh = _claim_row(conn, org_id, claim_id)
            subject, body, body_html = render_letter(fresh, _items(conn, org_id, claim_id),
                                                     _company(conn, org_id)["company_name"])
            sent, error = mailer.send_claim(claim["counterparty_contact"], subject, body, body_html, reply_to=email)
            if sent:
                _event(conn, org_id, claim_id, "EMAILED", email, note=f"Sent to {claim['counterparty_contact']}")
    return get_claim(conn, org_id, claim_id), sent, error


def _open_findings(conn: Connection, org_id: UUID, claim_id: UUID) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(text(
        f"""SELECT DISTINCT d.log_id, d.source_order_number FROM recovery_claim_items i
              JOIN discrepancy_logs d ON {SAME_FAMILY} AND d.status = 'UNRESOLVED'
             WHERE i.claim_id = :c AND i.org_id = :o"""), {"c": str(claim_id), "o": str(org_id)}).mappings()]


def _close(conn: Connection, org_id: UUID, claim: Dict[str, Any], status: str, user_id: Optional[UUID],
           email: str, note: str, category: Optional[str]) -> List[Dict[str, Any]]:
    """Finish a claim, release its items and (when a person is acting) route open findings through maker-checker."""
    conn.execute(text("UPDATE recovery_claims SET status = :s, closed_at = now(), updated_at = now() WHERE claim_id = :c"),
                 {"s": status, "c": str(claim["claim_id"])})
    resolutions: List[Dict[str, Any]] = []
    if category and user_id is not None:
        for finding in _open_findings(conn, org_id, claim["claim_id"]):
            row = approvals.submit_manual_resolution(conn, org_id, finding["log_id"], user_id, email, note, category)
            resolutions.append({"source_order_number": finding["source_order_number"], "status": row["status"]})
    conn.execute(text("UPDATE recovery_claim_items SET active = FALSE WHERE claim_id = :c"), {"c": str(claim["claim_id"])})
    return resolutions


def _apply_recovery(conn: Connection, org_id: UUID, claim: Dict[str, Any], amount: Decimal, kind: str,
                    user_id: Optional[UUID], email: str, reference: Optional[str], note: Optional[str],
                    occurred_on: Optional[date]) -> List[Dict[str, Any]]:
    recovered = _money(claim["recovered_amount"]) + amount
    remaining = _money(claim["claimed_amount"]) - recovered - _money(claim["written_off_amount"])
    status = "RECOVERED" if remaining <= 0 else "PARTIALLY_RECOVERED"
    conn.execute(text(
        "UPDATE recovery_claims SET recovered_amount = :r, status = :s, updated_at = now() WHERE claim_id = :c"),
        {"r": recovered, "s": status, "c": str(claim["claim_id"])})
    _event(conn, org_id, claim["claim_id"], kind, email, amount, reference, note, occurred_on)
    claim.update(recovered_amount=recovered, status=status)
    if status == "RECOVERED":
        why = f"Recovered from {claim['counterparty_name']} under claim {claim['claim_number']}" \
              + (f" (ref {reference})" if reference else "")
        return _close(conn, org_id, claim, "RECOVERED", user_id, email, why, RECOVERED_CATEGORY)
    return []


def record_payment(conn: Connection, org_id: UUID, claim_id: UUID, user_id: UUID, email: str, amount: Decimal,
                   reference: Optional[str] = None, received_on: Optional[date] = None,
                   note: Optional[str] = None) -> Dict[str, Any]:
    """Book money the counterparty paid against the claim. Overpaying the outstanding balance is refused."""
    claim = _with_outstanding(_claim_row(conn, org_id, claim_id, lock=True))
    _require(claim, COLLECTING_STATUSES, "record a payment on")
    amount = _money(amount)
    if amount <= 0:
        raise RecoveryError(422, "Payment amount must be positive")
    if amount > claim["outstanding_amount"]:
        raise RecoveryError(422, f"Payment of {amount} is more than the {claim['outstanding_amount']} still outstanding")
    resolutions = _apply_recovery(conn, org_id, claim, amount, "PAYMENT", user_id, email, reference, note, received_on)
    result = get_claim(conn, org_id, claim_id)
    result["resolutions"] = resolutions
    return result


def reject_claim(conn: Connection, org_id: UUID, claim_id: UUID, email: str, note: str) -> Dict[str, Any]:
    """The counterparty refused. Findings stay open and can be claimed again or written off."""
    claim = _claim_row(conn, org_id, claim_id, lock=True)
    _require(claim, COLLECTING_STATUSES, "reject")
    if not note or not note.strip():
        raise RecoveryError(422, "Record why the counterparty rejected the claim")
    _close(conn, org_id, claim, "REJECTED", None, email, note, None)
    _event(conn, org_id, claim_id, "REJECTED", email, note=note.strip())
    return get_claim(conn, org_id, claim_id)


def write_off(conn: Connection, org_id: UUID, claim_id: UUID, user_id: UUID, email: str, note: str) -> Dict[str, Any]:
    """Give up on the outstanding balance. Open findings are written off through maker-checker."""
    claim = _with_outstanding(_claim_row(conn, org_id, claim_id, lock=True))
    _require(claim, COLLECTING_STATUSES, "write off")
    if not note or not note.strip():
        raise RecoveryError(422, "A write-off needs a reason")
    remaining = claim["outstanding_amount"]
    conn.execute(text("UPDATE recovery_claims SET written_off_amount = written_off_amount + :w WHERE claim_id = :c"),
                 {"w": remaining, "c": str(claim_id)})
    _event(conn, org_id, claim_id, "WRITTEN_OFF", email, remaining, note=note.strip())
    why = f"Written off under claim {claim['claim_number']}: {note.strip()}"
    resolutions = _close(conn, org_id, claim, "WRITTEN_OFF", user_id, email, why, WRITE_OFF_CATEGORY)
    result = get_claim(conn, org_id, claim_id)
    result["resolutions"] = resolutions
    return result


def cancel_claim(conn: Connection, org_id: UUID, claim_id: UUID, email: str) -> Dict[str, Any]:
    claim = _claim_row(conn, org_id, claim_id, lock=True)
    _require(claim, ("DRAFT",), "cancel")
    _close(conn, org_id, claim, "CANCELLED", None, email, "", None)
    _event(conn, org_id, claim_id, "CANCELLED", email)
    return get_claim(conn, org_id, claim_id)


# ----------------------------------------------------------------------------- recovery seen in the data
@dataclass
class SyncResult:
    claims_checked: int = 0
    claims_updated: int = 0
    recovered_via_data: Decimal = Decimal("0.00")
    claims_closed: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {"claims_checked": self.claims_checked, "claims_updated": self.claims_updated,
                "recovered_via_data": float(self.recovered_via_data), "claims_closed": self.claims_closed}


def sync_with_data(org_id: UUID) -> SyncResult:
    """After reconciliation: credit claims whose findings shrank or disappeared because the data now matches.

    * finding gone                    -> the whole item was paid
    * finding still open but smaller  -> the difference was paid
    * finding RESOLVED by a person    -> not evidence of payment; ignored
    """
    result = SyncResult()
    with engine.begin() as conn:
        claims = [dict(r) for r in conn.execute(text(
            "SELECT * FROM recovery_claims WHERE org_id = :o AND status = ANY(:s) ORDER BY created_at FOR UPDATE"),
            {"o": str(org_id), "s": list(COLLECTING_STATUSES)}).mappings()]
        for claim in claims:
            result.claims_checked += 1
            items = conn.execute(text(
                f"""SELECT i.item_id, i.channel, i.source_order_number, i.amount, i.data_cleared_amount,
                           (SELECT SUM(GREATEST(d.variance_amount, 0)) FROM discrepancy_logs d
                             WHERE {SAME_FAMILY} AND d.status IN ('UNRESOLVED', 'PENDING_APPROVAL')) AS still_owed,
                           EXISTS (SELECT 1 FROM discrepancy_logs d WHERE {SAME_FAMILY} AND d.status = 'RESOLVED') AS resolved
                      FROM recovery_claim_items i WHERE i.claim_id = :c AND i.active
                     ORDER BY i.amount DESC"""),
                {"c": str(claim["claim_id"])}).mappings().all()
            groups: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
            for item in items:
                groups.setdefault((item["channel"], item["source_order_number"]), []).append(dict(item))
            credit, cleared_refs = Decimal("0.00"), []
            for (_, ref), members in groups.items():
                still_owed = members[0]["still_owed"]
                if still_owed is None and members[0]["resolved"]:
                    continue                                   # closed by a person, not paid in the data
                claimed = sum((_money(m["amount"]) for m in members), Decimal("0.00"))
                cleared = min(claimed, max(claimed - _money(still_owed), Decimal("0.00")))
                delta = cleared - sum((_money(m["data_cleared_amount"]) for m in members), Decimal("0.00"))
                if delta <= 0:
                    continue
                credit += delta
                cleared_refs.append(ref)
                for m in members:                              # fill items largest first
                    room = _money(m["amount"]) - _money(m["data_cleared_amount"])
                    take = min(room, delta)
                    if take > 0:
                        conn.execute(text("UPDATE recovery_claim_items SET data_cleared_amount = data_cleared_amount + :v "
                                          "WHERE item_id = :i"), {"v": take, "i": str(m["item_id"])})
                        delta -= take
            outstanding = _with_outstanding(dict(claim))["outstanding_amount"]
            credit = min(credit, outstanding)
            if credit > 0:
                note = "Latest reconciliation shows payment received for " + ", ".join(cleared_refs[:10]) \
                       + (" and more" if len(cleared_refs) > 10 else "")
                _apply_recovery(conn, org_id, claim, credit, "DATA_MATCH", None, "auditx:reconciliation", None, note, None)
                result.claims_updated += 1
                result.recovered_via_data += credit
                result.claims_closed += int(claim["status"] == "RECOVERED")
    if result.claims_updated:
        logger.info("Recovery sync org=%s %s", org_id, result.as_dict())
    return result


# ----------------------------------------------------------------------------- summary
def summary(conn: Connection, org_id: UUID) -> Dict[str, Any]:
    claimable = claimable_findings(conn, org_id)
    head = conn.execute(text(
        """
        SELECT COUNT(*) FILTER (WHERE status = ANY(:open))                                     AS open_claims,
               COALESCE(SUM(claimed_amount - recovered_amount - written_off_amount)
                        FILTER (WHERE status = ANY(:open)), 0)                                 AS open_value,
               COALESCE(SUM(recovered_amount), 0)                                              AS recovered_total,
               COALESCE(SUM(written_off_amount), 0)                                            AS written_off_total,
               COALESCE(SUM(claimed_amount) FILTER (WHERE status NOT IN ('DRAFT', 'CANCELLED')), 0) AS claimed_total
          FROM recovery_claims WHERE org_id = :o
        """), {"o": str(org_id), "open": list(OPEN_STATUSES)}).mappings().one()
    month = conn.execute(text(
        """SELECT COALESCE(SUM(amount), 0) FROM recovery_events
            WHERE org_id = :o AND kind IN ('PAYMENT', 'DATA_MATCH') AND occurred_on >= date_trunc('month', CURRENT_DATE)"""),
        {"o": str(org_id)}).scalar_one()
    parties = conn.execute(text(
        """SELECT counterparty_type, counterparty_name,
                  COUNT(*) FILTER (WHERE status = ANY(:open)) AS open_claims,
                  COALESCE(SUM(claimed_amount) FILTER (WHERE status NOT IN ('DRAFT', 'CANCELLED')), 0) AS claimed,
                  COALESCE(SUM(recovered_amount), 0) AS recovered,
                  COALESCE(SUM(claimed_amount - recovered_amount - written_off_amount)
                           FILTER (WHERE status = ANY(:open)), 0) AS outstanding
             FROM recovery_claims WHERE org_id = :o
            GROUP BY counterparty_type, counterparty_name ORDER BY outstanding DESC, recovered DESC"""),
        {"o": str(org_id), "open": list(OPEN_STATUSES)}).mappings().all()
    claimed_total = _money(head["claimed_total"])
    return {
        "currency": _company(conn, org_id)["brand_currency"],
        "claimable_count": len(claimable),
        "claimable_value": sum((f["amount"] for f in claimable), Decimal("0.00")),
        "open_claims": head["open_claims"],
        "open_value": _money(head["open_value"]),
        "recovered_total": _money(head["recovered_total"]),
        "recovered_this_month": _money(month),
        "written_off_total": _money(head["written_off_total"]),
        "recovery_rate_pct": (_money(head["recovered_total"]) * 100 / claimed_total).quantize(CENT) if claimed_total else None,
        "by_counterparty": [dict(p) for p in parties],
    }
