"""Black-box API tests: the courier scorecard (HTTP only)."""
import pytest

from tests.api.test_ingest_recon_api import full_dataset
from tests.helpers import add_member, auth, register

pytestmark = pytest.mark.api


@pytest.fixture
def company(client):
    owner = register(client)["access_token"]
    viewer = add_member(client, owner, "viewer@acme.test", "VIEWER")
    full_dataset(client, owner)
    client.post("/api/v1/reconciliation/run", headers=auth(owner))
    return {"owner": owner, "viewer": viewer}


def test_every_role_can_read_the_scorecard(client, company):
    res = client.get("/api/v1/couriers/scorecard", headers=auth(company["viewer"]))
    assert res.status_code == 200
    body = res.json()
    assert body["days"] == 90 and body["currency"] == "USD" and body["as_of"].startswith("2026-10-10")
    tcs = body["couriers"][0]
    assert tcs["courier_name"] == "TCS" and (tcs["booked"], tcs["delivered"], tcs["in_transit"]) == (3, 2, 1)
    assert tcs["avg_remit_days"] == 7.0 and tcs["on_time_pct"] == 50.0           # C1 in 7 days; C2 never remitted
    assert float(tcs["with_courier"]) == 67.5 and float(tcs["owed_now"]) == 67.5
    assert tcs["grade"] in "ABCDF" and tcs["low_volume"] is True
    assert body["best"] == {}                                                   # one courier: nothing to compare


@pytest.mark.parametrize("days", [6, 731, "abc"])
def test_window_is_validated(client, company, days):
    assert client.get(f"/api/v1/couriers/scorecard?days={days}", headers=auth(company["owner"])).status_code == 422


def test_csv_download(client, company):
    res = client.get("/api/v1/couriers/scorecard.csv?days=30", headers=auth(company["owner"]))
    assert res.status_code == 200 and res.headers["content-type"].startswith("text/csv")
    assert 'filename="courier-scorecard-30d.csv"' in res.headers["content-disposition"]
    header, row = res.text.strip().splitlines()
    assert header.startswith("courier_name,grade,score") and row.startswith("TCS,")


def test_scorecard_is_tenant_scoped_and_needs_a_login(client, company):
    other = register(client, "Other Co", "x@other.test")["access_token"]
    assert client.get("/api/v1/couriers/scorecard", headers=auth(other)).json()["couriers"] == []
    assert client.get("/api/v1/couriers/scorecard").status_code == 401


def test_agent_ranks_couriers(client, company):
    res = client.post("/api/v1/agent/query", headers=auth(company["owner"]),
                      json={"question": "Which is the best courier for us?"}).json()
    assert "avg_days_to_remit" in res["sql"] and res["rows"][0]["courier_name"] == "TCS"
