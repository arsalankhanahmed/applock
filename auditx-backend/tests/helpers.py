"""Builders shared by integration and API tests."""
from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, Optional
from uuid import UUID

from sqlalchemy import text

PASSWORD = "Str0ng#Passw0rd"


def now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def days_ago(days: float) -> datetime:
    return now() - timedelta(days=days)


# ----------------------------------------------------------------------------- database builders
def make_org(conn, name: str = "Test Co", currency: str = "USD") -> UUID:
    return conn.execute(
        text("INSERT INTO organizations (company_name, brand_currency) VALUES (:n, :c) RETURNING org_id"),
        {"n": name, "c": currency},
    ).scalar_one()


def make_user(conn, org_id, email: str, role: str = "OWNER", must_change: bool = False) -> UUID:
    from app.main import hash_password

    return conn.execute(
        text("INSERT INTO users (org_id, full_name, email, password_hash, role, must_change_password) "
             "VALUES (:o, :n, :e, :p, :r, :m) RETURNING user_id"),
        {"o": str(org_id), "n": email.split("@")[0].title(), "e": email, "p": hash_password(PASSWORD),
         "r": role, "m": must_change},
    ).scalar_one()


def add_orders(conn, org_id, rows: Iterable[Dict[str, Any]]) -> None:
    for r in rows:
        conn.execute(
            text("INSERT INTO ecom_orders (org_id, source_order_number, total_amount, currency, ordered_at, payment_method) "
                 "VALUES (:o, :n, :a, 'USD', :t, :m)"),
            {"o": str(org_id), "n": r["n"], "a": r["amount"], "t": r.get("at", days_ago(30)), "m": r.get("method", "PREPAID")},
        )


def add_captures(conn, org_id, rows: Iterable[Dict[str, Any]]) -> None:
    for i, r in enumerate(rows):
        gross = r["gross"]
        fee = r.get("fee", 0)
        conn.execute(
            text("INSERT INTO gateway_transactions (org_id, source_order_number, source_transaction_id, gross_amount, "
                 "net_amount, fee_amount, processed_at, payout_reference) VALUES (:o, :n, :t, :g, :net, :f, :p, :po)"),
            {"o": str(org_id), "n": r["n"], "t": r.get("txn", f"ch_{r['n']}_{i}"), "g": gross, "net": gross - fee,
             "f": fee, "p": r.get("at", days_ago(30)), "po": r.get("payout")},
        )


def add_parcels(conn, org_id, rows: Iterable[Dict[str, Any]]) -> None:
    for i, r in enumerate(rows):
        conn.execute(
            text("INSERT INTO courier_remittances (org_id, tracking_number, source_order_number, courier_name, "
                 "parcel_status, cod_amount, delivery_charges, net_remitted, remittance_reference, booked_at, "
                 "delivered_at, remitted_at) VALUES (:o, :trk, :n, :c, :s, :cod, :chg, :net, :ref, :b, :d, :r)"),
            {"o": str(org_id), "trk": r.get("trk", f"TRK-{r['n']}-{i}"), "n": r["n"], "c": r.get("courier", "TCS"),
             "s": r.get("status", "DELIVERED"), "cod": r.get("cod", 0), "chg": r.get("charge", 0),
             "net": r.get("net", 0), "ref": r.get("ref"), "b": r.get("booked", days_ago(30)),
             "d": r.get("delivered"), "r": r.get("remitted")},
        )


def add_bank(conn, org_id, rows: Iterable[Dict[str, Any]]) -> None:
    for i, r in enumerate(rows):
        conn.execute(
            text("INSERT INTO bank_transactions (org_id, transaction_date, description, amount, bank_reference) "
                 "VALUES (:o, :t, :d, :a, :ref)"),
            {"o": str(org_id), "t": r["at"], "d": r["desc"], "a": r["amount"], "ref": r.get("ref", f"BNK-{i}")},
        )


def findings(conn, org_id, status: Optional[str] = None) -> Dict[tuple, Dict[str, Any]]:
    sql = "SELECT * FROM discrepancy_logs WHERE org_id = :o" + (" AND status = :s" if status else "")
    rows = conn.execute(text(sql), {"o": str(org_id), "s": status}).mappings().all()
    return {(r["issue_type"], r["source_order_number"]): dict(r) for r in rows}


# ----------------------------------------------------------------------------- API helpers
def auth(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def register(client, company: str = "Acme Retail", email: str = "owner@acme.test", password: str = PASSWORD,
             currency: str = "USD") -> Dict[str, Any]:
    res = client.post("/api/v1/auth/register", json={
        "company_name": company, "brand_currency": currency, "full_name": "Owner Person",
        "email": email, "password": password,
    })
    assert res.status_code == 201, res.text
    return res.json()


def login(client, email: str, password: str = PASSWORD):
    return client.post("/api/v1/auth/login", json={"email": email, "password": password})


def add_member(client, owner_token: str, email: str, role: str, password: str = PASSWORD) -> str:
    """Create a member with a temporary password, then sign in and set their own (as a real user would)."""
    temp = "Temporary#123"
    res = client.post("/api/v1/users", headers=auth(owner_token), json={
        "full_name": "Team Member", "email": email, "password": temp, "role": role,
    })
    assert res.status_code == 201, res.text
    token = login(client, email, temp).json()["access_token"]
    res = client.post("/api/v1/me/password", headers=auth(token),
                      json={"current_password": temp, "new_password": password})
    assert res.status_code == 200, res.text
    return res.json()["access_token"]


def csv_file(name: str, header: str, rows: Iterable[str]) -> Dict[str, Any]:
    body = "\n".join([header, *rows]) + "\n"
    return {"file": (name, io.BytesIO(body.encode()), "text/csv")}
