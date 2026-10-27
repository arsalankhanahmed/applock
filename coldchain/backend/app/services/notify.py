"""Outgoing alert messages over email, WhatsApp and SMS.

Every channel has a ``log`` provider for development: nothing leaves the server, the message is written to the
log and recorded as sent, so the whole alert flow can be demonstrated without accounts.
"""
from __future__ import annotations

import logging
import re
import smtplib
import ssl
import uuid
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Optional
from urllib.parse import quote

import httpx

from app.config import settings

logger = logging.getLogger("coldchain.notify")

CHANNELS = ("email", "whatsapp", "sms")
E164 = re.compile(r"^\+[1-9]\d{7,14}$")
_WS = re.compile(r"\s+")


@dataclass
class Message:
    location: str        # "Karachi Warehouse / Cold Room 2"
    summary: str         # one line, used for SMS and WhatsApp template parameters
    body: str            # full text for email
    link: str


@dataclass
class SendResult:
    ok: bool
    provider: str
    error: str = ""
    message_id: Optional[str] = None


def normalise_phone(raw: str) -> str:
    """Return an E.164 number or raise ValueError. Accepts spaces, dashes, a 00 prefix and Pakistani 03xx numbers."""
    digits = re.sub(r"[\s\-().]", "", raw or "")
    if digits.startswith("00"):
        digits = "+" + digits[2:]
    elif digits.startswith("03") and len(digits) == 11:
        digits = "+92" + digits[1:]
    if not E164.match(digits):
        raise ValueError("Enter the phone number in international format, e.g. +923001234567")
    return digits


def mask(recipient: str) -> str:
    if "@" in recipient:
        name, _, domain = recipient.partition("@")
        return name[:2] + "***@" + domain
    return recipient[:4] + "*" * max(len(recipient) - 7, 0) + recipient[-3:] if len(recipient) > 7 else "***"


def _one_line(text: str, limit: int) -> str:
    cleaned = _WS.sub(" ", text or "").strip()
    return cleaned if len(cleaned) <= limit else cleaned[: limit - 1].rstrip() + "…"


# --- Email --------------------------------------------------------------------------------------------------

def send_email(to: str, msg: Message) -> SendResult:
    if not settings.SMTP_HOST:
        logger.info("Email (not configured, logged only) to %s: %s", mask(to), msg.summary)
        return SendResult(True, "log")
    email = EmailMessage()
    email["From"] = settings.SMTP_FROM
    email["To"] = to
    email["Subject"] = _one_line(f"[ALERT] {msg.summary}", 180)
    email.set_content(f"{msg.body}\n\nOpen the dashboard: {msg.link}\n")
    try:
        if settings.SMTP_SSL:
            server: smtplib.SMTP = smtplib.SMTP_SSL(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15,
                                                     context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15)
        with server:
            if settings.SMTP_STARTTLS and not settings.SMTP_SSL:
                server.starttls(context=ssl.create_default_context())
            if settings.SMTP_USERNAME:
                server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
            server.send_message(email)
        return SendResult(True, "smtp")
    except (smtplib.SMTPException, OSError) as exc:
        logger.warning("Email to %s failed: %s", mask(to), exc)
        return SendResult(False, "smtp", error=f"{type(exc).__name__}: {exc}")


# --- WhatsApp -----------------------------------------------------------------------------------------------

def send_whatsapp(to: str, msg: Message) -> SendResult:
    provider = (settings.WHATSAPP_PROVIDER or "").lower()
    if provider == "log":
        logger.info("WhatsApp (log) to %s: %s", mask(to), msg.summary)
        return SendResult(True, "log", message_id=f"log-{uuid.uuid4().hex[:10]}")
    if provider != "meta":
        return SendResult(False, provider or "none", error="WhatsApp is not configured (WHATSAPP_PROVIDER).")
    if not (settings.WHATSAPP_META_TOKEN and settings.WHATSAPP_META_PHONE_NUMBER_ID):
        return SendResult(False, "meta", error="Set WHATSAPP_META_TOKEN and WHATSAPP_META_PHONE_NUMBER_ID.")
    payload = {
        "messaging_product": "whatsapp",
        "to": to.lstrip("+"),
        "type": "template",
        "template": {
            "name": settings.WHATSAPP_TEMPLATE_NAME,
            "language": {"code": settings.WHATSAPP_TEMPLATE_LANGUAGE},
            "components": [{"type": "body", "parameters": [
                {"type": "text", "text": _one_line(v, 900)} for v in (msg.location, msg.summary, msg.link)]}],
        },
    }
    try:
        response = httpx.post(
            f"https://graph.facebook.com/{settings.WHATSAPP_META_API_VERSION}/"
            f"{settings.WHATSAPP_META_PHONE_NUMBER_ID}/messages",
            headers={"Authorization": f"Bearer {settings.WHATSAPP_META_TOKEN}"},
            json=payload, timeout=settings.HTTP_TIMEOUT_SECONDS)
    except httpx.HTTPError as exc:
        return SendResult(False, "meta", error=f"{type(exc).__name__}: {exc}")
    if response.status_code >= 400:
        return SendResult(False, "meta", error=f"HTTP {response.status_code}: {response.text[:300]}")
    messages = response.json().get("messages") or [{}]
    return SendResult(True, "meta", message_id=messages[0].get("id"))


# --- SMS ----------------------------------------------------------------------------------------------------

def send_sms(to: str, msg: Message) -> SendResult:
    provider = (settings.SMS_PROVIDER or "").lower()
    text = _one_line(f"{msg.summary} {msg.link}", 300)
    if provider == "log":
        logger.info("SMS (log) to %s: %s", mask(to), text)
        return SendResult(True, "log")
    try:
        if provider == "twilio":
            if not (settings.SMS_TWILIO_ACCOUNT_SID and settings.SMS_TWILIO_AUTH_TOKEN and settings.SMS_TWILIO_FROM):
                return SendResult(False, "twilio", error="Set SMS_TWILIO_ACCOUNT_SID, _AUTH_TOKEN and _FROM.")
            response = httpx.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{settings.SMS_TWILIO_ACCOUNT_SID}/Messages.json",
                auth=(settings.SMS_TWILIO_ACCOUNT_SID, settings.SMS_TWILIO_AUTH_TOKEN),
                data={"From": settings.SMS_TWILIO_FROM, "To": to, "Body": text},
                timeout=settings.HTTP_TIMEOUT_SECONDS)
        elif provider == "http":
            if "{to}" not in settings.SMS_HTTP_URL or "{text}" not in settings.SMS_HTTP_URL:
                return SendResult(False, "http", error="SMS_HTTP_URL needs {to} and {text} placeholders.")
            url = settings.SMS_HTTP_URL.replace("{to}", quote(to.lstrip("+"))).replace("{text}", quote(text))
            response = httpx.get(url, timeout=settings.HTTP_TIMEOUT_SECONDS)
        else:
            return SendResult(False, provider or "none", error="SMS is not configured (SMS_PROVIDER).")
    except httpx.HTTPError as exc:
        return SendResult(False, provider, error=f"{type(exc).__name__}: {exc}")
    if response.status_code >= 400:
        return SendResult(False, provider, error=f"HTTP {response.status_code}: {response.text[:300]}")
    return SendResult(True, provider)


SENDERS = {"email": send_email, "whatsapp": send_whatsapp, "sms": send_sms}


def send(channel: str, to: str, msg: Message) -> SendResult:
    return SENDERS[channel](to, msg)
