"""Unit (white box): WhatsApp providers, phone handling, scheduling and digest formatting."""
from datetime import datetime, timezone

import httpx
import pytest

from app.config import settings
from app.services import alerts, whatsapp
from app.services.alerts import AlertError, Digest

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("raw, expected", [
    ("+923001234567", "+923001234567"), ("0092 300-1234567", "+923001234567"), ("+1 (415) 523-8886", "+14155238886"),
])
def test_phone_numbers_are_normalised_to_e164(raw, expected):
    assert whatsapp.normalise_phone(raw) == expected


@pytest.mark.parametrize("raw", ["03001234567", "+0123456789", "+92abc", "", "+12345"])
def test_local_or_malformed_numbers_are_refused(raw):
    with pytest.raises(ValueError, match="international format"):
        whatsapp.normalise_phone(raw)


def test_masking_hides_most_of_the_address():
    assert whatsapp.mask_phone("+923001234567") == "+923******567"
    assert alerts.mask("EMAIL", "finance@acme.com") == "f***@acme.com"


def test_template_parameters_are_single_line_and_bounded():
    assert whatsapp.template_param("a\nb\t c     d") == "a b c d"
    long = whatsapp.template_param("x" * 2000)
    assert len(long) == whatsapp.MAX_PARAM_CHARS and long.endswith("…")


def cfg(**kw):
    return {**alerts.DEFAULTS, **kw}


@pytest.mark.parametrize("utc, expected", [
    (datetime(2026, 10, 17, 3, 59, tzinfo=timezone.utc), None),            # 08:59 in Karachi
    (datetime(2026, 10, 17, 4, 0, tzinfo=timezone.utc), "2026-10-17"),     # 09:00 in Karachi
    (datetime(2026, 10, 17, 20, 0, tzinfo=timezone.utc), None),            # 01:00 on the 18th in Karachi: not yet
    (datetime(2026, 10, 18, 4, 30, tzinfo=timezone.utc), "2026-10-18"),    # the next local day
])
def test_daily_period_uses_the_tenant_time_zone(utc, expected):
    assert alerts.period_for(cfg(), utc) == expected


@pytest.mark.parametrize("utc, expected", [
    (datetime(2026, 10, 19, 3, 0, tzinfo=timezone.utc), None),             # Monday 08:00 Karachi
    (datetime(2026, 10, 19, 5, 0, tzinfo=timezone.utc), "2026-W43"),       # Monday 10:00
    (datetime(2026, 10, 21, 1, 0, tzinfo=timezone.utc), "2026-W43"),       # Wednesday: a missed Monday still sends
])
def test_weekly_period_is_due_from_monday(utc, expected):
    assert alerts.period_for(cfg(frequency="WEEKLY"), utc) == expected


def test_unknown_time_zone_is_rejected():
    with pytest.raises(AlertError) as err:
        alerts.period_for(cfg(timezone="Mars/Olympus"), datetime.now(timezone.utc))
    assert err.value.status_code == 422


def test_digest_text_summary_and_html():
    d = Digest("Acme <Ltd>", "PKR", lines=["TCS holds PKR 1,200 COD for 2 orders", "1 fix waiting for a checker"])
    assert d.summary == "TCS holds PKR 1,200 COD for 2 orders | 1 fix waiting for a checker"
    assert d.text.startswith("AuditX alert · Acme <Ltd>\n\n• TCS holds") and d.text.endswith("/dashboard")
    assert "Acme &lt;Ltd&gt;" in d.html and "<li" in d.html
    assert d.subject == "AuditX alert for Acme <Ltd>: 2 item(s) need attention"
    empty = Digest("Acme", "PKR")
    assert not empty.has_content and "All clear" in empty.summary and empty.subject.endswith("all clear")


@pytest.mark.parametrize("amount, text", [("1200", "PKR 1,200"), ("67.5", "PKR 67.50"), ("0", "PKR 0")])
def test_money_formatting(amount, text):
    assert alerts._fmt(amount, "PKR") == text


# ----------------------------------------------------------------------------- providers
@pytest.fixture
def provider(monkeypatch):
    def use(name, **extra):
        monkeypatch.setattr(settings, "WHATSAPP_PROVIDER", name)
        for key, value in extra.items():
            monkeypatch.setattr(settings, key, value)
    return use


def test_not_configured_is_reported_not_raised(provider):
    provider("")
    result = whatsapp.send("+923001234567", "Acme", "s", "l", "t")
    assert not result.ok and "not configured" in result.error


@pytest.mark.parametrize("name, missing", [("meta", "WHATSAPP_META_TOKEN"), ("twilio", "WHATSAPP_TWILIO_ACCOUNT_SID")])
def test_missing_credentials_are_named(provider, name, missing):
    provider(name, WHATSAPP_META_TOKEN="", WHATSAPP_TWILIO_ACCOUNT_SID="")
    assert missing in whatsapp.configuration_problem()


def test_log_provider_sends_nothing_externally(provider, monkeypatch):
    provider("log")
    monkeypatch.setattr(httpx, "post", lambda *a, **k: pytest.fail("no network call expected"))
    result = whatsapp.send("+923001234567", "Acme", "s", "l", "t")
    assert result.ok and result.provider == "log" and result.message_id.startswith("log-")


def test_meta_cloud_api_template_call(provider, monkeypatch):
    provider("meta", WHATSAPP_META_TOKEN="tok", WHATSAPP_META_PHONE_NUMBER_ID="1234", WHATSAPP_TEMPLATE_NAME="auditx_alert")
    calls = []

    def fake_post(url, **kw):
        calls.append((url, kw))
        return httpx.Response(200, json={"messages": [{"id": "wamid.ABC"}]})

    monkeypatch.setattr(httpx, "post", fake_post)
    result = whatsapp.send("+923001234567", "Acme", "line one\nline two", "https://app/dashboard", "full text")
    assert result.ok and result.message_id == "wamid.ABC"
    url, kw = calls[0]
    assert url.endswith("/1234/messages") and kw["headers"]["Authorization"] == "Bearer tok"
    template = kw["json"]["template"]
    assert kw["json"]["to"] == "923001234567" and template["name"] == "auditx_alert"
    assert [p["text"] for p in template["components"][0]["parameters"]] == ["Acme", "line one line two", "https://app/dashboard"]


def test_meta_error_message_is_surfaced(provider, monkeypatch):
    provider("meta", WHATSAPP_META_TOKEN="tok", WHATSAPP_META_PHONE_NUMBER_ID="1234")
    monkeypatch.setattr(httpx, "post", lambda *a, **k: httpx.Response(
        400, json={"error": {"message": "Template name does not exist", "code": 132001}}))
    result = whatsapp.send("+923001234567", "Acme", "s", "l", "t")
    assert not result.ok and result.error == "HTTP 400: Template name does not exist (code 132001)"


@pytest.mark.parametrize("content_sid", ["", "HX123"])
def test_twilio_uses_a_content_template_when_configured(provider, monkeypatch, content_sid):
    provider("twilio", WHATSAPP_TWILIO_ACCOUNT_SID="AC1", WHATSAPP_TWILIO_AUTH_TOKEN="secret",
             WHATSAPP_TWILIO_FROM="+14155238886", WHATSAPP_TWILIO_CONTENT_SID=content_sid)
    sent = {}

    def fake_post(url, **kw):
        sent.update(url=url, **kw)
        return httpx.Response(201, json={"sid": "SM1"})

    monkeypatch.setattr(httpx, "post", fake_post)
    result = whatsapp.send("+923001234567", "Acme", "summary", "link", "full text")
    assert result.ok and result.message_id == "SM1" and sent["auth"] == ("AC1", "secret")
    form = sent["data"]
    assert form["From"] == "whatsapp:+14155238886" and form["To"] == "whatsapp:+923001234567"
    if content_sid:
        assert form["ContentSid"] == "HX123" and '"2": "summary"' in form["ContentVariables"] and "Body" not in form
    else:
        assert form["Body"] == "full text" and "ContentSid" not in form


def test_network_errors_do_not_raise(provider, monkeypatch):
    provider("meta", WHATSAPP_META_TOKEN="tok", WHATSAPP_META_PHONE_NUMBER_ID="1234")

    def boom(*a, **k):
        raise httpx.ConnectTimeout("timed out")

    monkeypatch.setattr(httpx, "post", boom)
    result = whatsapp.send("+923001234567", "Acme", "s", "l", "t")
    assert not result.ok and "ConnectTimeout" in result.error
