"""Integration: the forensic agent's database sandbox (defence in depth behind the SQL guard)."""
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.services import ai_agent
from app.services.ai_agent import execute_readonly, guard_sql
from tests.helpers import add_orders, make_org, make_user

pytestmark = pytest.mark.integration


@pytest.fixture
def two_tenants(db):
    with db.begin() as conn:
        a, b = make_org(conn, "A"), make_org(conn, "B")
        add_orders(conn, a, [{"n": "A1", "amount": 10}, {"n": "A2", "amount": 20}])
        add_orders(conn, b, [{"n": "B1", "amount": 999}])
        make_user(conn, b, "secret@b.test")
        conn.execute(text("INSERT INTO invitations (org_id, email, role, token_hash, expires_at) "
                          "VALUES (:o, 'invitee@b.test', 'VIEWER', repeat('a', 64), now())"), {"o": str(b)})
    return a, b


@pytest.mark.parametrize("table, visible", [
    ("ecom_orders", 2), ("organizations", 1), ("users", 0), ("invitations", 0), ("audit_jobs", 0),
    ("client_field_mappings", 0), ("approval_policies", 0), ("resolution_requests", 0),
])
def test_or_1_eq_1_cannot_see_other_tenants(two_tenants, table, visible):
    """Even if a query slips past the guard, the shadow views only expose the caller's rows."""
    a, _ = two_tenants
    frame, _ = execute_readonly(f"SELECT * FROM {table} WHERE org_id = :org_id OR 1 = 1", a)
    assert len(frame) == visible


def test_sandbox_is_read_only_even_without_the_guard(two_tenants):
    a, _ = two_tenants
    with pytest.raises(DBAPIError, match="read-only transaction"):
        execute_readonly("SELECT * FROM ecom_orders WHERE org_id = :org_id) x; DELETE FROM ecom_orders --", a)


def test_sandbox_leaves_no_temp_views_on_pooled_connections(two_tenants, db):
    a, _ = two_tenants
    execute_readonly(guard_sql("SELECT COUNT(*) AS n FROM ecom_orders WHERE org_id = :org_id"), a)
    with db.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM pg_views WHERE schemaname LIKE 'pg_temp%'")).scalar() == 0
        assert conn.execute(text("SELECT COUNT(*) FROM ecom_orders")).scalar() == 3           # nothing changed


def test_statement_timeout_stops_runaway_queries(two_tenants, monkeypatch):
    a, _ = two_tenants
    monkeypatch.setattr(ai_agent.settings, "AGENT_STATEMENT_TIMEOUT_MS", 50)
    heavy = ("SELECT COUNT(*) FROM ecom_orders o, generate_series(1, 20000000) g WHERE o.org_id = :org_id")
    with pytest.raises(DBAPIError, match="statement timeout"):
        execute_readonly(heavy, a)


def test_row_cap_marks_results_as_truncated(two_tenants, monkeypatch):
    a, _ = two_tenants
    monkeypatch.setattr(ai_agent.settings, "AGENT_MAX_ROWS", 1)
    frame, truncated = execute_readonly("SELECT * FROM ecom_orders WHERE org_id = :org_id", a)
    assert len(frame) == 1 and truncated


def test_ask_end_to_end_with_the_free_router(two_tenants):
    a, _ = two_tenants
    answer = ai_agent.ask("total leakage please", a)
    assert answer.engine == "heuristic-router" and answer.sql.startswith("SELECT")
    assert answer.row_count == 0                         # no findings yet for tenant A


def test_llm_path_retries_once_after_a_rejected_query(two_tenants, monkeypatch):
    a, _ = two_tenants
    replies = iter([("SELECT * FROM users", "bad"),
                    ("SELECT o.source_order_number FROM ecom_orders o WHERE o.org_id = :org_id", "orders")])
    monkeypatch.setattr(ai_agent.settings, "OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(ai_agent, "_llm_generate_sql", lambda q, err=None: next(replies))
    monkeypatch.setattr(ai_agent, "_llm_narrative", lambda q, s, f: "Two orders.")
    answer = ai_agent.ask("list orders", a)
    assert answer.row_count == 2 and answer.narrative == "Two orders."


def test_llm_path_gives_up_after_two_unsafe_queries(two_tenants, monkeypatch):
    a, _ = two_tenants
    monkeypatch.setattr(ai_agent.settings, "OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(ai_agent, "_llm_generate_sql", lambda q, err=None: ("DROP TABLE ecom_orders", ""))
    with pytest.raises(ai_agent.UnsafeQueryError):
        ai_agent.ask("delete everything", a)
