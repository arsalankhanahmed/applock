"""Shared fixtures.

The suite runs against a dedicated PostgreSQL database (never the development one):
    TEST_DATABASE_URL=postgresql://auditx:auditx@localhost:5432/auditx_test pytest
Settings are fixed here, before any app module is imported, so every test sees the same configuration:
background jobs run in-process (no Redis), no OpenAI key (heuristic agent), no SMTP.
"""
import os
import tempfile

os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://auditx:auditx@127.0.0.1:5432/auditx_test"
)
os.environ["CELERY_TASK_ALWAYS_EAGER"] = "true"
os.environ["UPLOAD_DIR"] = tempfile.mkdtemp(prefix="auditx-test-uploads-")
os.environ["OPENAI_API_KEY"] = ""
os.environ["SMTP_HOST"] = ""
os.environ["JWT_SECRET"] = "test-secret-not-for-production-0123456789abcdef"
os.environ["APP_BASE_URL"] = "http://app.test"

import email_validator  # noqa: E402
import pytest  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.exc import OperationalError  # noqa: E402

# Test fixtures use the reserved ".test" domain (RFC 2606); production keeps rejecting it.
email_validator.TEST_ENVIRONMENT = True

assert "auditx_test" in os.environ["DATABASE_URL"] or os.environ.get("AUDITX_ALLOW_ANY_TEST_DB"), (
    "Refusing to run: TEST_DATABASE_URL must point at a database named auditx_test "
    "(the suite truncates every tenant table)."
)


@pytest.fixture(scope="session")
def database():
    from app.database import engine, init_db

    try:
        init_db()
    except OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"PostgreSQL test database not reachable: {exc}")
    return engine


@pytest.fixture
def db(database):
    """A clean slate: every tenant row is removed (organizations cascade to all tenant tables)."""
    with database.begin() as conn:
        conn.execute(text("TRUNCATE organizations CASCADE"))
    yield database


@pytest.fixture
def client(db):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
