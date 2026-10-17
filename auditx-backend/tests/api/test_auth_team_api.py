"""Black-box API tests: authentication, tenancy and team management (HTTP only)."""
import jwt
import pytest

from tests.helpers import PASSWORD, add_member, auth, login, register

pytestmark = pytest.mark.api


def test_health(client):
    assert client.get("/health").json()["status"] == "ok"


def test_register_and_login(client):
    reg = register(client)
    assert reg["role"] == "OWNER" and reg["must_change_password"] is False
    res = login(client, "OWNER@ACME.TEST")                       # emails are case-insensitive
    assert res.status_code == 200 and res.json()["org_id"] == reg["org_id"]


@pytest.mark.parametrize("payload, status", [
    ({"company_name": "A", "full_name": "Owner", "email": "a@b.co", "password": PASSWORD}, 422),           # name too short
    ({"company_name": "Acme", "full_name": "Owner", "email": "not-an-email", "password": PASSWORD}, 422),
    ({"company_name": "Acme", "full_name": "Owner", "email": "a@b.co", "password": "short"}, 422),
    ({"company_name": "Acme", "full_name": "Owner", "email": "a@b.co", "password": PASSWORD, "brand_currency": "U$D"}, 422),
])
def test_register_validation(client, payload, status):
    assert client.post("/api/v1/auth/register", json=payload).status_code == status


def test_duplicate_email_is_rejected(client):
    register(client)
    res = client.post("/api/v1/auth/register", json={"company_name": "Other", "full_name": "X Y",
                                                       "email": "owner@acme.test", "password": PASSWORD})
    assert res.status_code == 409


@pytest.mark.parametrize("email, password", [("owner@acme.test", "Wrong#Password1"), ("nobody@acme.test", PASSWORD)])
def test_bad_credentials_give_the_same_answer(client, email, password):
    register(client)
    res = login(client, email, password)
    assert res.status_code == 401 and res.json()["detail"] == "Invalid email or password"   # no user enumeration


@pytest.mark.parametrize("header", [None, "Bearer", "Bearer not.a.jwt", "Basic Zm9vOmJhcg=="])
def test_protected_endpoints_need_a_valid_token(client, header):
    headers = {"Authorization": header} if header else {}
    assert client.get("/api/v1/dashboard/metrics", headers=headers).status_code == 401


def test_tampered_token_is_rejected(client):
    reg = register(client)
    claims = jwt.decode(reg["access_token"], options={"verify_signature": False})
    claims["role"] = "OWNER"
    claims["org"] = "00000000-0000-0000-0000-000000000000"
    forged = jwt.encode(claims, "guessed-secret", algorithm="HS256")
    assert client.get("/api/v1/me", headers=auth(forged)).status_code == 401
    none_alg = jwt.encode(claims, key="", algorithm="none") if hasattr(jwt, "encode") else forged
    assert client.get("/api/v1/me", headers=auth(none_alg)).status_code == 401


def test_team_listing_is_tenant_scoped(client):
    a = register(client, "Alpha Co", "a@alpha.test")
    register(client, "Beta Co", "b@beta.test")
    emails = [u["email"] for u in client.get("/api/v1/users", headers=auth(a["access_token"])).json()]
    assert emails == ["a@alpha.test"]


def test_owner_rules(client):
    owner = register(client)["access_token"]
    admin = add_member(client, owner, "admin@acme.test", "ADMIN")
    users = {u["email"]: u for u in client.get("/api/v1/users", headers=auth(owner)).json()}
    owner_id = users["owner@acme.test"]["user_id"]
    new_owner = {"full_name": "Second Owner", "email": "o2@acme.test", "password": PASSWORD, "role": "OWNER"}
    assert client.post("/api/v1/users", headers=auth(admin), json=new_owner).status_code == 403
    assert client.patch(f"/api/v1/users/{owner_id}", headers=auth(admin), json={"full_name": "Hacked"}).status_code == 403
    assert client.delete(f"/api/v1/users/{owner_id}", headers=auth(admin)).status_code == 403
    assert client.patch(f"/api/v1/users/{owner_id}", headers=auth(owner), json={"role": "ADMIN"}).status_code == 403
    assert client.delete(f"/api/v1/users/{owner_id}", headers=auth(owner)).status_code == 403
    assert client.post("/api/v1/users", headers=auth(owner), json=new_owner).status_code == 201


@pytest.mark.parametrize("role", ["ANALYST", "AUDITOR", "VIEWER"])
def test_non_admins_cannot_manage_the_team(client, role):
    owner = register(client)["access_token"]
    member = add_member(client, owner, f"{role.lower()}@acme.test", role)
    res = client.post("/api/v1/users", headers=auth(member), json={
        "full_name": "New Person", "email": "n@acme.test", "password": PASSWORD, "role": "VIEWER"})
    assert res.status_code == 403


def test_role_change_and_removal_apply_to_existing_sessions(client):
    owner = register(client)["access_token"]
    member = add_member(client, owner, "m@acme.test", "ANALYST")
    member_id = next(u["user_id"] for u in client.get("/api/v1/users", headers=auth(owner)).json() if u["email"] == "m@acme.test")
    client.patch(f"/api/v1/users/{member_id}", headers=auth(owner), json={"role": "AUDITOR"})
    assert client.get("/api/v1/me", headers=auth(member)).json()["user"]["role"] == "AUDITOR"
    assert client.delete(f"/api/v1/users/{member_id}", headers=auth(owner)).status_code == 204
    assert client.get("/api/v1/me", headers=auth(member)).status_code == 401


def test_cannot_manage_members_of_another_company(client):
    a = register(client, "Alpha Co", "a@alpha.test")["access_token"]
    b = register(client, "Beta Co", "b@beta.test")["access_token"]
    b_id = client.get("/api/v1/me", headers=auth(b)).json()["user"]["user_id"]
    assert client.patch(f"/api/v1/users/{b_id}", headers=auth(a), json={"full_name": "Pwned"}).status_code == 404
    assert client.delete(f"/api/v1/users/{b_id}", headers=auth(a)).status_code == 404
