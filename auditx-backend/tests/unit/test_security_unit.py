"""White-box unit tests for security-relevant code: the agent's SQL guard, passwords, tokens, approval policy,
the mailer and configuration."""
from decimal import Decimal

import jwt
import pytest

from app.config import Settings, settings
from app.main import hash_password, issue_token, verify_password
from app.services import ai_agent, mailer
from app.services.ai_agent import UnsafeQueryError, guard_sql
from app.services.approvals import ApprovalPolicy

pytestmark = pytest.mark.unit
OK = "SELECT d.issue_type FROM discrepancy_logs d WHERE d.org_id = :org_id"


# ----------------------------------------------------------------------------- SQL guard
@pytest.mark.parametrize("sql, reason", [
    ("DELETE FROM ecom_orders WHERE org_id = :org_id", "Only SELECT"),
    ("UPDATE ecom_orders SET total_amount = 0 WHERE org_id = :org_id", "Only SELECT"),
    ("SELECT 1 FROM ecom_orders WHERE org_id = :org_id; DROP TABLE users", "one SQL statement"),
    ("WITH x AS (DELETE FROM ecom_orders WHERE org_id = :org_id RETURNING *) SELECT * FROM x", "DELETE"),
    ("SELECT * INTO stolen FROM ecom_orders WHERE org_id = :org_id", "INTO"),
    ("SELECT * FROM ecom_orders", "tenant filter"),
    ("SELECT * FROM ecom_orders WHERE org_id = '00000000-0000-0000-0000-000000000000'", "tenant filter"),
    ("SELECT * FROM public.ecom_orders WHERE org_id = :org_id", "Schema-qualified"),
    ("SELECT * FROM pg_catalog.pg_user WHERE org_id = :org_id", "Schema-qualified"),
    ("SELECT pg_sleep(10) FROM ecom_orders WHERE org_id = :org_id", "pg_sleep"),
    ("SELECT set_config('x','y',false) FROM ecom_orders WHERE org_id = :org_id", "set_config"),
    ("SELECT current_setting('is_superuser') FROM ecom_orders WHERE org_id = :org_id", "current_setting"),
    ("SELECT email, password_hash FROM users WHERE org_id = :org_id", "restricted"),
    ("SELECT * FROM audit_jobs WHERE org_id = :org_id", "restricted"),
    ("SELECT * FROM invitations WHERE org_id = :org_id OR 1=1", "restricted"),   # DEF-03
    ("SELECT * FROM ecom_orders WHERE org_id = :org_id AND x = :other", "Unknown bind"),
    ("", "Empty"),
    ("COPY ecom_orders TO '/tmp/x'", "Only SELECT"),
    ("SELECT 1 FROM ecom_orders WHERE org_id = :org_id; ", None),   # trailing semicolon alone is fine
])
def test_guard_rejects_unsafe_sql(sql, reason):
    if reason is None:
        assert guard_sql(sql).endswith(":org_id")
        return
    with pytest.raises(UnsafeQueryError, match=reason):
        guard_sql(sql)


def test_guard_strips_comments_and_code_fences():
    assert guard_sql(f"```sql\n{OK} -- trailing comment\n```") == OK


def test_guard_ignores_keywords_inside_string_literals():
    sql = OK + " AND d.ai_root_cause_category <> 'DROP; DELETE'"
    assert guard_sql(sql) == sql


def test_guard_clamps_oversized_limits():
    assert guard_sql(OK + " LIMIT 100000").endswith(f"LIMIT {settings.AGENT_MAX_ROWS}")
    assert guard_sql(OK + " LIMIT 5").endswith("LIMIT 5")


def test_every_built_in_question_template_passes_the_guard():
    """White-box consistency: the zero-cost router must never produce SQL its own guard rejects."""
    for _, _, sql in ai_agent._INTENTS:
        guard_sql(sql)
    guard_sql(ai_agent._DEFAULT_INTENT[1])


@pytest.mark.parametrize("question, keyword", [
    ("Which courier owes us the most COD?", "courier_remittances"),
    ("Which payouts never reached the bank?", "'BANK'"),
    ("What is waiting for approval?", "resolution_requests"),
    ("show me fraud", "POTENTIAL_FRAUD"),
    ("hello", "leakage"),
])
def test_heuristic_router_picks_the_right_template(question, keyword):
    sql, _ = ai_agent._heuristic_generate_sql(question)
    assert keyword in sql


def test_every_tenant_table_is_shadowed_in_the_sandbox():
    """White-box: any table the agent can name must have a tenant-filtered (or empty) shadow view."""
    from app.database import SCHEMA_DDL
    import re

    tables = set(re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", SCHEMA_DDL))
    global_tables = {"data_dictionary_master"}
    assert tables - global_tables <= set(ai_agent.TENANT_VIEWS) | {"organizations"}
    for name, body in ai_agent.TENANT_VIEWS.items():
        assert "{org}" in body or "WHERE FALSE" in body, name


# ----------------------------------------------------------------------------- passwords & tokens
def test_password_hash_round_trip_and_salting():
    first, second = hash_password("Correct#Horse1"), hash_password("Correct#Horse1")
    assert first != second                                   # random salt
    assert first.startswith("pbkdf2_sha256$390000$")
    assert verify_password("Correct#Horse1", first)
    assert not verify_password("wrong", first)


@pytest.mark.parametrize("stored", ["", "plaintext", "md5$abc", "pbkdf2_sha256$1$bad"])
def test_malformed_hashes_never_verify(stored):
    assert verify_password("anything", stored) is False


def test_token_contains_tenant_and_expiry():
    token = issue_token("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "ANALYST", "a@b.co")
    claims = jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"], issuer="auditx")
    assert claims["org"] == "22222222-2222-2222-2222-222222222222" and claims["role"] == "ANALYST"
    assert claims["exp"] - claims["iat"] == settings.JWT_EXPIRE_MINUTES * 60


def test_token_signed_with_another_secret_is_rejected():
    forged = jwt.encode({"sub": "x", "org": "y", "iss": "auditx"}, "attacker-secret", algorithm="HS256")
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(forged, settings.JWT_SECRET, algorithms=["HS256"], issuer="auditx")


# ----------------------------------------------------------------------------- approval policy
@pytest.mark.parametrize("mode, amount, needs", [
    ("AUTO", "999999", False),
    ("ALWAYS_APPROVE", "0.01", True),
    ("THRESHOLD", "1.00", False),
    ("THRESHOLD", "1.01", True),
])
def test_ai_approval_policy(mode, amount, needs):
    assert ApprovalPolicy(auto_heal_mode=mode, auto_heal_max_amount=Decimal("1.00")).ai_needs_approval(Decimal(amount)) is needs


def test_manual_approval_policy():
    strict = ApprovalPolicy()
    assert strict.manual_needs_approval(Decimal("0.01"))
    relaxed = ApprovalPolicy(manual_requires_approval=True, manual_auto_approve_max=Decimal("50"))
    assert not relaxed.manual_needs_approval(Decimal("50")) and relaxed.manual_needs_approval(Decimal("50.01"))
    assert not ApprovalPolicy(manual_requires_approval=False).manual_needs_approval(Decimal("1e9"))


# ----------------------------------------------------------------------------- mailer
class FakeSMTP:
    sent = []

    def __init__(self, host, port, timeout=None, **_):
        self.host, self.port = host, port

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self, context=None):
        self.tls = True

    def login(self, user, password):
        self.user = user

    def send_message(self, message):
        FakeSMTP.sent.append(message)


def test_mailer_skips_when_smtp_is_not_configured(monkeypatch):
    monkeypatch.setattr(settings, "SMTP_HOST", "")
    sent, error = mailer.send_invite("a@b.co", None, "Co", "VIEWER", "Boss", "http://x/invite?token=t", __import__("datetime").datetime.now())
    assert sent is False and "not configured" in error


def test_mailer_builds_text_and_escaped_html(monkeypatch):
    from datetime import datetime

    FakeSMTP.sent.clear()
    monkeypatch.setattr(settings, "SMTP_HOST", "smtp.test")
    monkeypatch.setattr(mailer.smtplib, "SMTP", FakeSMTP)
    sent, error = mailer.send_invite("new@co.test", "Ayesha", "<script>alert(1)</script> Ltd", "AUDITOR", "Boss",
                                     "http://app.test/invite?token=abc", datetime(2026, 10, 24))
    assert (sent, error) == (True, None)
    message = FakeSMTP.sent[-1]
    assert message["To"] == "new@co.test"
    html = message.get_body(("html",)).get_content()
    assert "<script>" not in html and "&lt;script&gt;" in html          # company name cannot inject markup
    assert "http://app.test/invite?token=abc" in message.get_body(("plain",)).get_content()


def test_mailer_reports_smtp_failures(monkeypatch):
    from datetime import datetime

    class Down(FakeSMTP):
        def __init__(self, *a, **k):
            raise ConnectionRefusedError("refused")

    monkeypatch.setattr(settings, "SMTP_HOST", "smtp.test")
    monkeypatch.setattr(mailer.smtplib, "SMTP", Down)
    sent, error = mailer.send_invite("a@b.co", None, "Co", "VIEWER", "Boss", "http://x", datetime(2026, 1, 1))
    assert sent is False and "ConnectionRefusedError" in error


# ----------------------------------------------------------------------------- configuration
@pytest.mark.parametrize("url, normalised", [
    ("postgres://u:p@h/db", "postgresql+psycopg2://u:p@h/db"),
    ("postgresql://u:p@h/db?sslmode=require", "postgresql+psycopg2://u:p@h/db?sslmode=require"),
    ("postgresql+psycopg2://u:p@h/db", "postgresql+psycopg2://u:p@h/db"),
])
def test_database_url_normalisation(url, normalised):
    assert Settings(DATABASE_URL=url).DATABASE_URL == normalised


def test_cors_origins_are_split_and_trimmed():
    assert Settings(CORS_ORIGINS=" https://a.test , https://b.test ,").cors_origin_list == ["https://a.test", "https://b.test"]


def test_checker_login_naming():
    from app.utils.seeder import checker_email

    assert checker_email("demo@auditx.io") == "demo+checker@auditx.io"
