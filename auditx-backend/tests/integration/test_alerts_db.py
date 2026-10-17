"""Integration: alert digests against PostgreSQL: content, opt-in, scheduling, once-per-period and retries."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from app.config import settings
from app.services import alerts
from app.services.alerts import AlertError
from app.services.auto_healer import heal_org
from app.services.reconciliation import reconcile_org
from tests.helpers import make_org
from tests.integration.test_reconciliation_db import build_company

pytestmark = pytest.mark.integration


@pytest.fixture
def company(db, monkeypatch):
    monkeypatch.setattr(settings, "WHATSAPP_PROVIDER", "log")
    with db.begin() as conn:
        org = build_company(conn)
    reconcile_org(org)
    heal_org(org)
    return org


def configure(db, org, **kw):
    with db.begin() as conn:
        return alerts.save_settings(conn, org, {**alerts.DEFAULTS, "enabled": True, "send_hour": 0, **kw}, "o@co.test")


def recipient(db, org, channel="WHATSAPP", address="+923001234567", name="Ayesha"):
    with db.begin() as conn:
        return alerts.add_recipient(conn, org, name, channel, address, True, "o@co.test")


def digest(db, org, **kw):
    with db.connect() as conn:
        return alerts.build_digest(conn, org, {**alerts.DEFAULTS, **kw})


def deliveries(db, org):
    with db.connect() as conn:
        return conn.execute(text("SELECT kind, status, channel, period_key, error FROM alert_deliveries "
                                 "WHERE org_id = :o ORDER BY created_at"), {"o": str(org)}).mappings().all()


def test_digest_lists_what_needs_attention(db, company):
    d = digest(db, company)
    assert d.lines == [
        "TCS holds USD 67.50 COD for 1 order, oldest delivered 25 days ago",
        "1 payout / remittance worth USD 72.52 not fully in the bank (largest: po_two)",    # CPR-ONE 0.40 was auto-healed
        "1 fix worth USD 5 waiting for a checker",
        "USD 194.52 can be claimed back (5 findings not yet in a claim)",
    ]
    assert "\n" not in d.summary and d.summary.count(" | ") == 3


def test_sections_thresholds_and_overdue_days(db, company):
    assert not any("COD" in line for line in digest(db, company, cod_overdue_days=30).lines)       # 25 days < 30
    big = digest(db, company, min_amount=100).lines
    assert big == ["1 fix worth USD 5 waiting for a checker",                                    # count-based: always
                   "USD 194.52 can be claimed back (5 findings not yet in a claim)"]
    only_approvals = digest(db, company, include_cod=False, include_settlements=False, include_recovery=False).lines
    assert only_approvals == ["1 fix worth USD 5 waiting for a checker"]


def test_recipients_need_consent_and_a_valid_address(db, company):
    with db.begin() as conn, pytest.raises(AlertError, match="agreed"):
        alerts.add_recipient(conn, company, "No Consent", "WHATSAPP", "+923001234567", False, "o@co.test")
    with db.begin() as conn, pytest.raises(AlertError, match="international format"):
        alerts.add_recipient(conn, company, "Local", "WHATSAPP", "03001234567", True, "o@co.test")
    with db.begin() as conn, pytest.raises(AlertError, match="Invalid email"):
        alerts.add_recipient(conn, company, "Bad", "EMAIL", "not-an-email", True, "o@co.test")
    added = recipient(db, company, address="0092 300 1234567")
    assert added["address"] == "+923001234567" and added["consent_at"] is not None
    with db.begin() as conn, pytest.raises(AlertError) as dup:
        alerts.add_recipient(conn, company, "Again", "WHATSAPP", "+92 300 1234567", True, "o@co.test")
    assert dup.value.status_code == 409
    assert recipient(db, company, "EMAIL", "CFO@Acme.Example.com")["address"] == "cfo@acme.example.com"


def test_one_digest_per_period_and_failed_sends_retry_up_to_the_limit(db, company):
    configure(db, company)
    recipient(db, company)                                         # WhatsApp via the log provider: succeeds
    recipient(db, company, "EMAIL", "cfo@acme.example.com")        # no SMTP in tests: fails
    first = alerts.run_due()
    assert (first["sent"], first["failed"]) == (1, 1)
    second = alerts.run_due()
    assert (second["sent"], second["failed"]) == (0, 1)            # WhatsApp not repeated; email retried
    alerts.run_due()
    assert alerts.run_due() == {"tenants": 1, "sent": 0, "failed": 0, "skipped": 0}   # 3 attempts used up
    rows = deliveries(db, company)
    assert [(r["channel"], r["status"]) for r in rows].count(("EMAIL", "FAILED")) == settings.ALERTS_MAX_ATTEMPTS
    assert [(r["channel"], r["status"]) for r in rows].count(("WHATSAPP", "SENT")) == 1
    assert "SMTP" in rows[-1]["error"]


def test_nothing_is_sent_when_disabled_or_before_the_hour(db, company):
    configure(db, company, enabled=False)
    recipient(db, company)
    assert alerts.run_due()["sent"] == 0
    configure(db, company, send_hour=23)
    late_evening = datetime.now(ZoneInfo("Asia/Karachi")).replace(hour=22, minute=0).astimezone(timezone.utc)
    assert alerts.run_due(late_evening)["sent"] == 0
    assert alerts.run_due(late_evening + timedelta(hours=1))["sent"] == 1           # 23:00 local
    assert alerts.run_due(late_evening + timedelta(hours=11))["sent"] == 0          # 09:00 next day: before 23:00
    assert alerts.run_due(late_evening + timedelta(hours=25))["sent"] == 1          # 23:00 next day: a new period


def test_quiet_days_are_skipped_unless_asked_for(db, monkeypatch):
    monkeypatch.setattr(settings, "WHATSAPP_PROVIDER", "log")
    with db.begin() as conn:
        org = make_org(conn, "Quiet Co")
    configure(db, org)
    recipient(db, org)
    assert alerts.run_due()["skipped"] == 1 and deliveries(db, org)[0]["status"] == "SKIPPED"
    with db.begin() as conn:
        quiet2 = make_org(conn, "Quiet Two")
    configure(db, quiet2, send_when_clear=True)
    recipient(db, quiet2)
    alerts.run_due()
    assert deliveries(db, quiet2)[0]["status"] == "SENT"


def test_interrupted_sends_are_released_for_a_retry(db, company):
    configure(db, company)
    r = recipient(db, company)
    period = alerts.period_for({**alerts.DEFAULTS, "send_hour": 0}, datetime.now(timezone.utc))
    with db.begin() as conn:
        conn.execute(text("""INSERT INTO alert_deliveries (org_id, recipient_id, channel, address_masked, kind,
                                                           period_key, status, created_at)
                             VALUES (:o, :r, 'WHATSAPP', 'x', 'DIGEST', :k, 'SENDING', now() - interval '1 hour')"""),
                     {"o": str(company), "r": str(r["recipient_id"]), "k": period})
    assert alerts.run_due()["sent"] == 1
    assert [d["status"] for d in deliveries(db, company)] == ["FAILED", "SENT"]


def test_test_send_works_while_switched_off_and_skips_inactive_recipients(db, company):
    a = recipient(db, company)
    b = recipient(db, company, address="+923331112223", name="Off")
    with db.begin() as conn:
        alerts.update_recipient(conn, company, b["recipient_id"], False)
    results = alerts.send_test(company)
    assert [(r["name"], r["sent"], r["provider"]) for r in results] == [("Ayesha", True, "log")]
    assert alerts.send_test(company, b["recipient_id"])[0]["name"] == "Off"        # explicit pick is allowed
    assert {d["kind"] for d in deliveries(db, company)} == {"TEST"}
    assert a["active"] is True


def test_recipients_are_tenant_scoped(db, company):
    r = recipient(db, company)
    with db.begin() as conn:
        other = make_org(conn, "Other Co")
    with db.begin() as conn, pytest.raises(AlertError) as err:
        alerts.update_recipient(conn, other, r["recipient_id"], False)
    assert err.value.status_code == 404
    with db.begin() as conn, pytest.raises(AlertError):
        alerts.remove_recipient(conn, other, r["recipient_id"])
    with pytest.raises(AlertError):
        alerts.send_test(other, r["recipient_id"])
