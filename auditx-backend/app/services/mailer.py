"""Outgoing email (team invitations) over plain SMTP.

Works with any SMTP provider: Gmail / Google Workspace (app password), Microsoft 365, Brevo, Mailgun,
Amazon SES, Resend's SMTP relay, or a local catcher such as Mailpit in development. When SMTP_HOST is empty
nothing is sent and callers fall back to showing the invite link in the dashboard.
"""
from __future__ import annotations

import html
import logging
import smtplib
import ssl
from datetime import datetime
from email.message import EmailMessage
from email.utils import make_msgid
from typing import Optional, Tuple

from app.config import settings

logger = logging.getLogger("auditx.mailer")

ROLE_SUMMARY = {
    "OWNER": "full control of the workspace",
    "ADMIN": "managing the team and approval policy, and approving fixes",
    "ANALYST": "uploading files, running reconciliation and proposing fixes",
    "AUDITOR": "approving or rejecting proposed fixes",
    "VIEWER": "read-only access to the dashboard",
}


def email_configured() -> bool:
    return bool(settings.SMTP_HOST)


def _send(message: EmailMessage) -> Tuple[bool, Optional[str]]:
    if not email_configured():
        return False, "Email is not configured (SMTP_HOST is empty); share the invite link instead."
    try:
        if settings.SMTP_SSL:
            server: smtplib.SMTP = smtplib.SMTP_SSL(
                settings.SMTP_HOST, settings.SMTP_PORT, timeout=settings.SMTP_TIMEOUT_SECONDS,
                context=ssl.create_default_context(),
            )
        else:
            server = smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=settings.SMTP_TIMEOUT_SECONDS)
        with server:
            if settings.SMTP_STARTTLS and not settings.SMTP_SSL:
                server.starttls(context=ssl.create_default_context())
            if settings.SMTP_USERNAME:
                server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
            server.send_message(message)
        return True, None
    except (smtplib.SMTPException, OSError) as exc:
        logger.warning("Email to %s failed: %s", message["To"], exc)
        return False, f"Email could not be sent ({type(exc).__name__}: {exc}); share the invite link instead."


def send_invite(
    to: str,
    full_name: Optional[str],
    company: str,
    role: str,
    inviter: str,
    link: str,
    expires_at: datetime,
) -> Tuple[bool, Optional[str]]:
    """Send a team invitation. Returns (sent, error)."""
    greeting = f"Hi {full_name}," if full_name else "Hi,"
    expiry = expires_at.strftime("%d %b %Y")
    duty = ROLE_SUMMARY.get(role, "")
    text = (
        f"{greeting}\n\n"
        f"{inviter} has invited you to join {company} on AuditX as {role.title()} ({duty}).\n\n"
        f"Accept the invitation and choose your password here:\n{link}\n\n"
        f"The link works once and expires on {expiry}. If you weren't expecting this, you can ignore this email.\n"
    )
    safe = {k: html.escape(v) for k, v in {
        "greeting": greeting, "inviter": inviter, "company": company, "role": role.title(), "duty": duty,
        "link": link, "expiry": expiry,
    }.items()}
    body_html = f"""\
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
  <p style="font-size:20px;font-weight:700;margin:0 0 16px">Audit<span style="color:#10b981">X</span></p>
  <p>{safe['greeting']}</p>
  <p><b>{safe['inviter']}</b> has invited you to join <b>{safe['company']}</b> on AuditX as
     <b>{safe['role']}</b> ({safe['duty']}).</p>
  <p style="margin:28px 0">
    <a href="{safe['link']}" style="background:#10b981;color:#05070d;text-decoration:none;font-weight:600;
       padding:12px 20px;border-radius:8px">Accept invitation</a>
  </p>
  <p style="font-size:13px;color:#6b7280">The link works once and expires on {safe['expiry']}.
     If the button doesn't work, paste this address into your browser:<br>{safe['link']}</p>
  <p style="font-size:13px;color:#6b7280">If you weren't expecting this, you can ignore this email.</p>
</div>"""

    message = EmailMessage()
    message["Subject"] = f"{inviter} invited you to {company} on AuditX"
    message["From"] = settings.SMTP_FROM
    message["To"] = to
    message["Message-ID"] = make_msgid(domain="auditx")
    message.set_content(text)
    message.add_alternative(body_html, subtype="html")
    return _send(message)
