"""Alerts: an optional daily / weekly WhatsApp or email digest of what needs attention.

Off by default. A tenant's OWNER / ADMIN switches it on, picks the time, the sections and the recipients (each with
recorded consent), previews the message and sends a test. A periodic job (Celery beat, or the cron endpoint on
hosts without a worker) calls ``run_due`` and sends each recipient at most one digest per period.

Sections (each skipped when below the tenant's minimum amount):
* COD stuck with couriers longer than N days, per courier
* payouts / remittances that never reached the bank
* fixes waiting for a checker
* recovery: claims past their due date, money recovered this month, money still claimable
"""
from __future__ import annotations

import html
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from email_validator import EmailNotValidError, validate_email
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.config import settings
from app.database import engine
from app.services import mailer, recovery, whatsapp

logger = logging.getLogger("auditx.alerts")

CHANNELS = ("WHATSAPP", "EMAIL")
MAX_RECIPIENTS = 25
STALE_SENDING = timedelta(minutes=15)
DEFAULTS: Dict[str, Any] = {
    "enabled": False, "frequency": "DAILY", "send_hour": 9, "timezone": "Asia/Karachi", "min_amount": Decimal("0"),
    "cod_overdue_days": 7, "include_cod": True, "include_settlements": True, "include_approvals": True,
    "include_recovery": True, "send_when_clear": False, "updated_at": None, "updated_by_email": None,
}
SETTING_FIELDS = tuple(k for k in DEFAULTS if k not in ("updated_at", "updated_by_email"))


class AlertError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


# ----------------------------------------------------------------------------- settings
def load_settings(conn: Connection, org_id: UUID) -> Dict[str, Any]:
    row = conn.execute(text("SELECT * FROM alert_settings WHERE org_id = :o"), {"o": str(org_id)}).mappings().first()
    out = dict(DEFAULTS)
    if row:
        out.update({k: row[k] for k in DEFAULTS})
    return out


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise AlertError(422, f"Unknown time zone '{name}'; use an IANA name such as Asia/Karachi") from exc


def save_settings(conn: Connection, org_id: UUID, values: Dict[str, Any], email: str) -> Dict[str, Any]:
    zone(values["timezone"])
    params = {k: values[k] for k in SETTING_FIELDS}
    columns = ", ".join(SETTING_FIELDS)
    placeholders = ", ".join(f":{k}" for k in SETTING_FIELDS)
    updates = ", ".join(f"{k} = EXCLUDED.{k}" for k in SETTING_FIELDS)
    conn.execute(text(
        f"""INSERT INTO alert_settings (org_id, {columns}, updated_at, updated_by_email)
            VALUES (:o, {placeholders}, now(), :e)
            ON CONFLICT (org_id) DO UPDATE SET {updates}, updated_at = now(), updated_by_email = EXCLUDED.updated_by_email"""),
        {"o": str(org_id), "e": email, **params})
    return load_settings(conn, org_id)


def channel_status() -> Dict[str, Any]:
    problem = whatsapp.configuration_problem()
    return {
        "whatsapp_provider": whatsapp.provider_name() or None,
        "whatsapp_ready": problem is None,
        "whatsapp_problem": problem,
        "email_ready": mailer.email_configured(),
        "scheduler": "Celery beat every 15 minutes, or POST /api/v1/internal/alerts/run-due from a cron job",
    }


# ----------------------------------------------------------------------------- recipients
def mask(channel: str, address: str) -> str:
    if channel == "WHATSAPP":
        return whatsapp.mask_phone(address)
    local, _, domain = address.partition("@")
    return f"{local[:1]}***@{domain}"


def normalise_address(channel: str, address: str) -> str:
    if channel == "WHATSAPP":
        try:
            return whatsapp.normalise_phone(address)
        except ValueError as exc:
            raise AlertError(422, str(exc)) from exc
    try:
        return validate_email(address.strip(), check_deliverability=False).normalized.lower()
    except EmailNotValidError as exc:
        raise AlertError(422, f"Invalid email address: {exc}") from exc


def list_recipients(conn: Connection, org_id: UUID) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(text(
        "SELECT * FROM alert_recipients WHERE org_id = :o ORDER BY created_at"), {"o": str(org_id)}).mappings()]


def add_recipient(conn: Connection, org_id: UUID, name: str, channel: str, address: str, consent: bool,
                  email: str) -> Dict[str, Any]:
    if channel not in CHANNELS:
        raise AlertError(422, "Channel must be WHATSAPP or EMAIL")
    if not consent:
        raise AlertError(422, "Confirm that this person agreed to receive alerts (WhatsApp requires opt-in)")
    address = normalise_address(channel, address)
    count = conn.execute(text("SELECT COUNT(*) FROM alert_recipients WHERE org_id = :o"), {"o": str(org_id)}).scalar_one()
    if count >= MAX_RECIPIENTS:
        raise AlertError(409, f"At most {MAX_RECIPIENTS} alert recipients per company")
    row = conn.execute(text(
        """INSERT INTO alert_recipients (org_id, name, channel, address, consent_at, created_by_email)
           VALUES (:o, :n, :c, :a, now(), :e)
           ON CONFLICT (org_id, channel, address) DO NOTHING RETURNING *"""),
        {"o": str(org_id), "n": name.strip(), "c": channel, "a": address, "e": email}).mappings().first()
    if not row:
        raise AlertError(409, f"{mask(channel, address)} already receives alerts")
    return dict(row)


def update_recipient(conn: Connection, org_id: UUID, recipient_id: UUID, active: bool) -> Dict[str, Any]:
    row = conn.execute(text(
        "UPDATE alert_recipients SET active = :a WHERE recipient_id = :r AND org_id = :o RETURNING *"),
        {"a": active, "r": str(recipient_id), "o": str(org_id)}).mappings().first()
    if not row:
        raise AlertError(404, "Recipient not found")
    return dict(row)


def remove_recipient(conn: Connection, org_id: UUID, recipient_id: UUID) -> None:
    deleted = conn.execute(text("DELETE FROM alert_recipients WHERE recipient_id = :r AND org_id = :o"),
                           {"r": str(recipient_id), "o": str(org_id)}).rowcount
    if not deleted:
        raise AlertError(404, "Recipient not found")


# ----------------------------------------------------------------------------- the digest
@dataclass
class Digest:
    company: str
    currency: str
    lines: List[str] = field(default_factory=list)
    generated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def has_content(self) -> bool:
        return bool(self.lines)

    @property
    def link(self) -> str:
        return f"{settings.APP_BASE_URL.rstrip('/')}/dashboard"

    @property
    def summary(self) -> str:
        """One line for WhatsApp templates (no line breaks allowed in parameters)."""
        return whatsapp.template_param(" | ".join(self.lines) if self.lines else "All clear: nothing needs attention today.")

    @property
    def subject(self) -> str:
        return f"AuditX alert for {self.company}: " + (f"{len(self.lines)} item(s) need attention" if self.lines else "all clear")

    @property
    def text(self) -> str:
        body = "\n".join(f"• {line}" for line in self.lines) if self.lines else "All clear: nothing needs attention today."
        return f"AuditX alert · {self.company}\n\n{body}\n\nOpen the dashboard: {self.link}"

    @property
    def html(self) -> str:
        e = html.escape
        items = "".join(f"<li style='margin:6px 0'>{e(line)}</li>" for line in self.lines) or \
            "<li>All clear: nothing needs attention today.</li>"
        return (f"<div style='font-family:Segoe UI,Arial,sans-serif;max-width:560px;color:#1f2937'>"
                f"<p style='font-size:18px;font-weight:700'>Audit<span style='color:#10b981'>X</span> alert · {e(self.company)}</p>"
                f"<ul style='padding-left:18px'>{items}</ul>"
                f"<p><a href='{e(self.link)}' style='color:#059669'>Open the dashboard</a></p></div>")


def _fmt(amount: Any, currency: str) -> str:
    value = Decimal(str(amount or 0)).quantize(Decimal("0.01"))
    return f"{currency} {value:,.0f}" if value == value.to_integral_value() else f"{currency} {value:,.2f}"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def build_digest(conn: Connection, org_id: UUID, cfg: Dict[str, Any], now: Optional[datetime] = None) -> Digest:
    now = now or datetime.now(timezone.utc)
    org = conn.execute(text("SELECT company_name, brand_currency FROM organizations WHERE org_id = :o"),
                       {"o": str(org_id)}).mappings().one()
    cur = org["brand_currency"]
    digest = Digest(org["company_name"], cur, generated_at=now)
    floor = Decimal(str(cfg["min_amount"] or 0))
    p = {"o": str(org_id)}

    if cfg["include_cod"]:
        rows = conn.execute(text(
            """
            SELECT p.courier_name, COUNT(*) AS orders, SUM(d.variance_amount) AS owed, MIN(p.delivered_at) AS oldest
              FROM discrepancy_logs d
              JOIN LATERAL (SELECT c.courier_name, c.delivered_at FROM courier_remittances c
                             WHERE c.org_id = d.org_id AND c.source_order_number = d.source_order_number
                               AND c.parcel_status = 'DELIVERED' ORDER BY c.delivered_at LIMIT 1) p ON TRUE
             WHERE d.org_id = :o AND d.status = 'UNRESOLVED' AND d.issue_type = 'COD_NOT_REMITTED'
               AND p.delivered_at <= :cutoff
             GROUP BY p.courier_name ORDER BY owed DESC LIMIT 5
            """), {**p, "cutoff": now - timedelta(days=int(cfg["cod_overdue_days"]))}).mappings().all()
        for r in rows:
            if Decimal(r["owed"]) >= floor:
                days = (now - r["oldest"]).days
                digest.lines.append(f"{r['courier_name']} holds {_fmt(r['owed'], cur)} COD for "
                                    f"{_plural(r['orders'], 'order')}, oldest delivered {days} days ago")

    if cfg["include_settlements"]:
        r = conn.execute(text(
            """SELECT COUNT(*) AS n, COALESCE(SUM(variance_amount), 0) AS total,
                      (ARRAY_AGG(source_order_number ORDER BY variance_amount DESC))[1] AS biggest
                 FROM discrepancy_logs WHERE org_id = :o AND status = 'UNRESOLVED'
                  AND issue_type IN ('SETTLEMENT_NOT_DEPOSITED', 'DEPOSIT_MISMATCH') AND variance_amount > 0"""),
            p).mappings().one()
        if r["n"] and Decimal(r["total"]) >= floor:
            digest.lines.append(f"{_plural(r['n'], 'payout / remittance')} worth {_fmt(r['total'], cur)} not fully in the bank"
                                f" (largest: {r['biggest']})")

    if cfg["include_approvals"]:
        r = conn.execute(text(
            """SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total, MIN(created_at) AS oldest
                 FROM resolution_requests WHERE org_id = :o AND status = 'PENDING'"""), p).mappings().one()
        if r["n"]:
            age = (now - r["oldest"]).days
            digest.lines.append(f"{_plural(r['n'], 'fix')} worth {_fmt(r['total'], cur)} waiting for a checker"
                                + (f", oldest {age} days" if age >= 1 else ""))

    if cfg["include_recovery"]:
        overdue = conn.execute(text(
            """SELECT COUNT(*) AS n, COALESCE(SUM(claimed_amount - recovered_amount - written_off_amount), 0) AS total
                 FROM recovery_claims WHERE org_id = :o AND status IN ('SUBMITTED', 'PARTIALLY_RECOVERED')
                  AND due_date < CAST(:today AS date)"""), {**p, "today": now.date()}).mappings().one()
        if overdue["n"] and Decimal(overdue["total"]) >= floor:
            digest.lines.append(f"{_plural(overdue['n'], 'claim')} past due with {_fmt(overdue['total'], cur)} outstanding")
        summary = recovery.summary(conn, org_id)
        if summary["claimable_count"] and summary["claimable_value"] >= floor:
            digest.lines.append(f"{_fmt(summary['claimable_value'], cur)} can be claimed back "
                                f"({_plural(summary['claimable_count'], 'finding')} not yet in a claim)")
        if summary["recovered_this_month"] > 0:
            digest.lines.append(f"Recovered this month: {_fmt(summary['recovered_this_month'], cur)}")
    return digest


# ----------------------------------------------------------------------------- scheduling
def period_for(cfg: Dict[str, Any], now: datetime) -> Optional[str]:
    """The period a digest is due for at ``now``, or None before the send time.

    DAILY: due from send_hour local time, once per local day.
    WEEKLY: due from Monday send_hour local time, once per ISO week (a missed Monday still sends later that week).
    """
    local = now.astimezone(zone(cfg["timezone"]))
    if cfg["frequency"] == "WEEKLY":
        if local.weekday() == 0 and local.hour < cfg["send_hour"]:
            return None
        year, week, _ = local.isocalendar()
        return f"{year}-W{week:02d}"
    if local.hour < cfg["send_hour"]:
        return None
    return local.date().isoformat()


def _send_one(recipient: Dict[str, Any], digest: Digest) -> whatsapp.SendResult:
    if recipient["channel"] == "WHATSAPP":
        return whatsapp.send(recipient["address"], digest.company, digest.summary, digest.link, digest.text)
    ok, error = mailer.send_alert(recipient["address"], digest.subject, digest.text, digest.html)
    return whatsapp.SendResult(ok, "smtp", error=error)


def _finish(conn: Connection, delivery_id: Any, result: whatsapp.SendResult, digest: Digest) -> None:
    conn.execute(text(
        """UPDATE alert_deliveries SET status = :s, provider = :p, provider_message_id = :m, error = :e,
                  summary = :sum, finished_at = now() WHERE delivery_id = :d"""),
        {"s": "SENT" if result.ok else "FAILED", "p": result.provider, "m": result.message_id, "e": result.error,
         "sum": digest.summary, "d": str(delivery_id)})


def run_due(now: Optional[datetime] = None) -> Dict[str, int]:
    """Send every digest that is due. Safe to call often and from several processes at once."""
    now = now or datetime.now(timezone.utc)
    stats = {"tenants": 0, "sent": 0, "failed": 0, "skipped": 0}
    with engine.begin() as conn:
        # A process that died mid-send leaves SENDING rows; free them for a retry.
        conn.execute(text("UPDATE alert_deliveries SET status = 'FAILED', error = 'Interrupted before completion', "
                          "finished_at = now() WHERE status = 'SENDING' AND created_at < :t"),
                     {"t": now - STALE_SENDING})
        tenants = [r[0] for r in conn.execute(text("SELECT org_id FROM alert_settings WHERE enabled"))]
    for org_id in tenants:
        with engine.connect() as conn:
            cfg = load_settings(conn, org_id)
            try:
                period = period_for(cfg, now)
            except AlertError:
                logger.warning("Alerts for org=%s have an invalid time zone %s", org_id, cfg["timezone"])
                continue
            if period is None:
                continue
            recipients = [r for r in list_recipients(conn, org_id) if r["active"]]
        if not recipients:
            continue
        stats["tenants"] += 1
        digest: Optional[Digest] = None
        for recipient in recipients:
            with engine.begin() as conn:
                attempts = conn.execute(text(
                    """SELECT COUNT(*) FROM alert_deliveries WHERE recipient_id = :r AND period_key = :k
                        AND kind = 'DIGEST' AND status = 'FAILED'"""),
                    {"r": str(recipient["recipient_id"]), "k": period}).scalar_one()
                if attempts >= settings.ALERTS_MAX_ATTEMPTS:
                    continue
                if digest is None:
                    digest = build_digest(conn, org_id, cfg, now)
                status = "SENDING" if digest.has_content or cfg["send_when_clear"] else "SKIPPED"
                delivery_id = conn.execute(text(
                    """INSERT INTO alert_deliveries (org_id, recipient_id, channel, address_masked, kind, period_key,
                                                     status, summary, finished_at)
                       VALUES (:o, :r, :c, :m, 'DIGEST', :k, :s, :sum, CASE WHEN :s = 'SKIPPED' THEN now() END)
                       ON CONFLICT (recipient_id, period_key)
                          WHERE kind = 'DIGEST' AND status IN ('SENDING', 'SENT', 'SKIPPED') DO NOTHING
                       RETURNING delivery_id"""),
                    {"o": str(org_id), "r": str(recipient["recipient_id"]), "c": recipient["channel"],
                     "m": mask(recipient["channel"], recipient["address"]), "k": period, "s": status,
                     "sum": digest.summary}).scalar()
            if delivery_id is None:
                continue                                    # already handled this period
            if status == "SKIPPED":
                stats["skipped"] += 1
                continue
            result = _send_one(recipient, digest)            # outside any transaction: network call
            with engine.begin() as conn:
                _finish(conn, delivery_id, result, digest)
            stats["sent" if result.ok else "failed"] += 1
    if any(stats[k] for k in ("sent", "failed")):
        logger.info("Alerts run %s", stats)
    return stats


def send_test(org_id: UUID, recipient_id: Optional[UUID] = None) -> List[Dict[str, Any]]:
    """Send the current digest now to one or every active recipient (works before alerts are switched on)."""
    with engine.connect() as conn:
        cfg = load_settings(conn, org_id)
        recipients = [r for r in list_recipients(conn, org_id)
                      if (recipient_id is None and r["active"]) or (recipient_id is not None and r["recipient_id"] == recipient_id)]
        if recipient_id is not None and not recipients:
            raise AlertError(404, "Recipient not found")
        if not recipients:
            raise AlertError(409, "Add an active recipient first")
        digest = build_digest(conn, org_id, cfg)
    results = []
    for recipient in recipients:
        masked = mask(recipient["channel"], recipient["address"])
        with engine.begin() as conn:
            delivery_id = conn.execute(text(
                """INSERT INTO alert_deliveries (org_id, recipient_id, channel, address_masked, kind, period_key, status, summary)
                   VALUES (:o, :r, :c, :m, 'TEST', 'test', 'SENDING', :sum) RETURNING delivery_id"""),
                {"o": str(org_id), "r": str(recipient["recipient_id"]), "c": recipient["channel"], "m": masked,
                 "sum": digest.summary}).scalar_one()
        result = _send_one(recipient, digest)
        with engine.begin() as conn:
            _finish(conn, delivery_id, result, digest)
        results.append({"recipient_id": recipient["recipient_id"], "name": recipient["name"],
                        "channel": recipient["channel"], "address_masked": masked, "sent": result.ok,
                        "provider": result.provider, "error": result.error})
    return results


def list_deliveries(conn: Connection, org_id: UUID, limit: int = 30) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(text(
        """SELECT d.delivery_id, d.channel, d.address_masked, d.kind, d.period_key, d.status, d.provider,
                  d.provider_message_id, d.error, d.summary, d.created_at, d.finished_at, r.name AS recipient_name
             FROM alert_deliveries d LEFT JOIN alert_recipients r ON r.recipient_id = d.recipient_id
            WHERE d.org_id = :o ORDER BY d.created_at DESC LIMIT :l"""), {"o": str(org_id), "l": limit}).mappings()]


def preview(conn: Connection, org_id: UUID) -> Dict[str, Any]:
    cfg = load_settings(conn, org_id)
    digest = build_digest(conn, org_id, cfg)
    return {"lines": digest.lines, "text": digest.text, "whatsapp_summary": digest.summary,
            "has_content": digest.has_content, "next_period": _safe_period(cfg)}


def _safe_period(cfg: Dict[str, Any]) -> Optional[str]:
    try:
        return period_for(cfg, datetime.now(timezone.utc))
    except AlertError:
        return None

