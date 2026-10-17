"""Outgoing WhatsApp messages for alerts.

Providers (``WHATSAPP_PROVIDER``):

* ``meta``   WhatsApp Business Cloud API. Business-initiated messages must use a pre-approved template; ours takes
             three body parameters: {{1}} company, {{2}} one-line summary, {{3}} dashboard link.
* ``twilio`` Twilio's WhatsApp API: a Content template (``WHATSAPP_TWILIO_CONTENT_SID``, same three variables) or,
             without one, a plain body (only delivered inside the 24-hour window / sandbox).
* ``log``    development and demos: nothing leaves the server; the message is logged and reported as sent.
* ``""``     not configured: sends fail with a clear reason, so the dashboard can say so.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger("auditx.whatsapp")

PROVIDERS = ("meta", "twilio", "log")
E164 = re.compile(r"^\+[1-9]\d{7,14}$")
# Meta rejects template parameters containing newlines, tabs or more than four consecutive spaces,
# so every run of whitespace becomes one space.
_PARAM_BAD = re.compile(r"\s+")
MAX_PARAM_CHARS = 900


@dataclass
class SendResult:
    ok: bool
    provider: str
    message_id: Optional[str] = None
    error: Optional[str] = None


def normalise_phone(raw: str) -> str:
    """Return an E.164 number ('+923001234567') or raise ValueError. Accepts spaces, dashes and a 00 prefix."""
    digits = re.sub(r"[\s\-().]", "", raw or "")
    if digits.startswith("00"):
        digits = "+" + digits[2:]
    if not E164.match(digits):
        raise ValueError("Enter the WhatsApp number in international format, e.g. +923001234567")
    return digits


def mask_phone(phone: str) -> str:
    return phone[:4] + "*" * max(len(phone) - 7, 0) + phone[-3:] if len(phone) > 7 else "***"


def template_param(value: str) -> str:
    """Make text safe for a WhatsApp template parameter: one line, no long runs of spaces, bounded length."""
    cleaned = _PARAM_BAD.sub(" ", value or "").strip()
    return cleaned if len(cleaned) <= MAX_PARAM_CHARS else cleaned[: MAX_PARAM_CHARS - 1].rstrip() + "…"


def provider_name() -> str:
    name = (settings.WHATSAPP_PROVIDER or "").strip().lower()
    return name if name in PROVIDERS else ""


def configuration_problem() -> Optional[str]:
    """Why WhatsApp cannot send right now, or None when it can."""
    name = provider_name()
    if not name:
        return "WhatsApp is not configured on this server (WHATSAPP_PROVIDER is empty)."
    if name == "meta" and not (settings.WHATSAPP_META_TOKEN and settings.WHATSAPP_META_PHONE_NUMBER_ID):
        return "WhatsApp Cloud API needs WHATSAPP_META_TOKEN and WHATSAPP_META_PHONE_NUMBER_ID."
    if name == "twilio" and not (settings.WHATSAPP_TWILIO_ACCOUNT_SID and settings.WHATSAPP_TWILIO_AUTH_TOKEN
                                 and settings.WHATSAPP_TWILIO_FROM):
        return "Twilio WhatsApp needs WHATSAPP_TWILIO_ACCOUNT_SID, WHATSAPP_TWILIO_AUTH_TOKEN and WHATSAPP_TWILIO_FROM."
    return None


def meta_payload(to: str, company: str, summary: str, link: str) -> dict:
    return {
        "messaging_product": "whatsapp",
        "to": to.lstrip("+"),
        "type": "template",
        "template": {
            "name": settings.WHATSAPP_TEMPLATE_NAME,
            "language": {"code": settings.WHATSAPP_TEMPLATE_LANGUAGE},
            "components": [{
                "type": "body",
                "parameters": [{"type": "text", "text": template_param(v)} for v in (company, summary, link)],
            }],
        },
    }


def twilio_form(to: str, company: str, summary: str, link: str, text: str) -> dict:
    form = {"From": f"whatsapp:{settings.WHATSAPP_TWILIO_FROM}", "To": f"whatsapp:{to}"}
    if settings.WHATSAPP_TWILIO_CONTENT_SID:
        form["ContentSid"] = settings.WHATSAPP_TWILIO_CONTENT_SID
        form["ContentVariables"] = json.dumps(
            {"1": template_param(company), "2": template_param(summary), "3": template_param(link)})
    else:
        form["Body"] = text[:1500]
    return form


def _error_text(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return f"HTTP {response.status_code}"
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):                                        # Meta
        return f"HTTP {response.status_code}: {err.get('message', 'error')} (code {err.get('code')})"
    if isinstance(body, dict) and body.get("message"):               # Twilio
        return f"HTTP {response.status_code}: {body['message']} (code {body.get('code')})"
    return f"HTTP {response.status_code}"


def send(to: str, company: str, summary: str, link: str, text: str) -> SendResult:
    """Send one alert. ``summary`` is the one-line version for templates; ``text`` the full message."""
    name = provider_name()
    problem = configuration_problem()
    if problem:
        return SendResult(False, name or "none", error=problem)
    if name == "log":
        logger.info("WhatsApp (log provider) to %s: %s", mask_phone(to), text)
        return SendResult(True, "log", message_id=f"log-{uuid.uuid4().hex[:12]}")
    try:
        if name == "meta":
            response = httpx.post(
                f"https://graph.facebook.com/{settings.WHATSAPP_META_API_VERSION}/"
                f"{settings.WHATSAPP_META_PHONE_NUMBER_ID}/messages",
                headers={"Authorization": f"Bearer {settings.WHATSAPP_META_TOKEN}"},
                json=meta_payload(to, company, summary, link),
                timeout=settings.WHATSAPP_TIMEOUT_SECONDS,
            )
            if response.status_code >= 400:
                return SendResult(False, name, error=_error_text(response))
            messages = response.json().get("messages") or [{}]
            return SendResult(True, name, message_id=messages[0].get("id"))
        response = httpx.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{settings.WHATSAPP_TWILIO_ACCOUNT_SID}/Messages.json",
            auth=(settings.WHATSAPP_TWILIO_ACCOUNT_SID, settings.WHATSAPP_TWILIO_AUTH_TOKEN),
            data=twilio_form(to, company, summary, link, text),
            timeout=settings.WHATSAPP_TIMEOUT_SECONDS,
        )
        if response.status_code >= 400:
            return SendResult(False, name, error=_error_text(response))
        return SendResult(True, name, message_id=response.json().get("sid"))
    except httpx.HTTPError as exc:
        logger.warning("WhatsApp send via %s failed: %s", name, exc)
        return SendResult(False, name, error=f"{type(exc).__name__}: {exc}")
