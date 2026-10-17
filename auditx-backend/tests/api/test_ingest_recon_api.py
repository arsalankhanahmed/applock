"""Black-box API tests: uploads, background jobs, reconciliation and the discrepancy list."""
import io

import pytest

from tests.helpers import add_member, auth, csv_file, register

pytestmark = pytest.mark.api


@pytest.fixture
def owner(client):
    return register(client)["access_token"]


def upload(client, token, target, header, *rows, name="data.csv"):
    return client.post(f"/api/v1/ingest/{target}", headers=auth(token), files=csv_file(name, header, rows))


def job(client, token, job_id):
    return client.get(f"/api/v1/jobs/{job_id}", headers=auth(token)).json()


def test_upload_is_accepted_and_processed_in_the_background(client, owner):
    res = upload(client, owner, "ecom_orders", "source_order_number,total_amount", "A1,$10.00", "A2,\"Rs. 1,250\"")
    assert res.status_code == 202
    body = res.json()
    assert body["status"] == "QUEUED" and body["status_url"].endswith(body["job_id"])
    done = job(client, owner, body["job_id"])
    assert done["status"] == "SUCCEEDED" and done["result"]["rows_inserted"] == 2


@pytest.mark.parametrize("name, content, status", [
    ("orders.xlsx", "x", 415),
    ("orders.csv", "", 422),
    ("../../etc/passwd.csv", "source_order_number,total_amount\nA,1\n", 202),   # path in name is ignored
])
def test_upload_validation(client, owner, name, content, status):
    files = {"file": (name, io.BytesIO(content.encode()), "text/csv")}
    assert client.post("/api/v1/ingest/ecom_orders", headers=auth(owner), files=files).status_code == status


def test_unknown_target_is_rejected(client, owner):
    assert upload(client, owner, "users", "email", "x@y.z").status_code == 422


def test_bad_file_marks_the_job_failed_with_a_reason(client, owner):
    res = upload(client, owner, "gateway_transactions", "source_order_number,gross_amount", "A1,10")
    failed = job(client, owner, res.json()["job_id"])
    assert failed["status"] == "FAILED" and "source_transaction_id" in failed["error"]


def test_viewers_cannot_upload_or_reconcile(client, owner):
    viewer = add_member(client, owner, "v@acme.test", "VIEWER")
    assert upload(client, viewer, "ecom_orders", "source_order_number,total_amount", "A,1").status_code == 403
    assert client.post("/api/v1/reconciliation/run", headers=auth(viewer)).status_code == 403


def test_jobs_are_tenant_scoped(client, owner):
    job_id = upload(client, owner, "ecom_orders", "source_order_number,total_amount", "A,1").json()["job_id"]
    other = register(client, "Other Co", "x@other.test")["access_token"]
    assert client.get(f"/api/v1/jobs/{job_id}", headers=auth(other)).status_code == 404
    assert client.get("/api/v1/jobs", headers=auth(other)).json() == []


def full_dataset(client, token):
    upload(client, token, "ecom_orders", "source_order_number,total_amount,payment_method",
           "O1,100.00,card", "O2,55.00,card", "O4,80.00,card", "C1,60.00,COD", "C2,70.00,COD")
    upload(client, token, "gateway_transactions",
           "source_order_number,source_transaction_id,gross_amount,fee_amount,processed_at,payout_reference",
           "O1,ch_1,100.00,3.20,2026-09-01T10:00:00Z,po_A", "O3,ch_3,42.00,1.52,2026-09-01T11:00:00Z,po_A",
           "O4,ch_4,75.00,2.48,2026-09-01T12:00:00Z,po_A")
    upload(client, token, "courier_remittances",
           "tracking_number,source_order_number,courier_name,parcel_status,cod_amount,delivery_charges,"
           "remittance_reference,booked_at,delivered_at,remitted_at",
           "T1,C1,TCS,Delivered,60.00,2.50,CPR-1,2026-09-01,2026-09-03,2026-09-10",
           "T2,C2,TCS,Delivered,70.00,2.50,,2026-09-01,2026-09-03,",
           "T9,LATE,TCS,In transit,0,0,,2026-10-10,,")
    upload(client, token, "bank_transactions", "transaction_date,description,credit_amount,debit_amount",
           "2026-09-03,STRIPE PAYOUT po_A,\"209.80\",", "2026-09-11,TCS CPR-1,\"57.50\",")


def test_reconciliation_end_to_end_through_the_api(client, owner):
    full_dataset(client, owner)
    res = client.post("/api/v1/reconciliation/run", headers=auth(owner), json={"auto_heal": True})
    assert res.status_code == 202
    result = job(client, owner, res.json()["job_id"])["result"]
    issues = result["reconciliation"]["by_issue_type"]
    assert issues == {"MISSING_PAYMENT": 1, "UNTRACKED_REVENUE": 1, "AMOUNT_MISMATCH": 1, "COD_NOT_REMITTED": 1}
    assert result["reconciliation"]["bank"]["matched_by_reference"] == 2
    assert result["auto_healer"]["queued_for_approval"] == 1          # the $5 promo waits for a checker


def test_discrepancy_filters_and_paging(client, owner):
    full_dataset(client, owner)
    client.post("/api/v1/reconciliation/run", headers=auth(owner))
    get = lambda q: client.get(f"/api/v1/discrepancies?{q}", headers=auth(owner)).json()  # noqa: E731
    assert get("limit=500")["total"] == 4
    assert get("channel=COD")["total"] == 1
    assert get("status=PENDING_APPROVAL")["items"][0]["source_order_number"] == "O4"
    assert get("issue_type=MISSING_PAYMENT")["items"][0]["source_order_number"] == "O2"
    assert get("search=o3")["total"] == 1                              # case-insensitive search
    page = get("limit=2&offset=0&sort=variance")
    assert page["limit"] == 2 and len(page["items"]) == 2
    assert abs(float(page["items"][0]["variance_amount"])) >= abs(float(page["items"][1]["variance_amount"]))
    assert client.get("/api/v1/discrepancies?limit=0", headers=auth(owner)).status_code == 422
    assert client.get("/api/v1/discrepancies?sort=drop", headers=auth(owner)).status_code == 422


def test_search_input_is_not_sql(client, owner):
    full_dataset(client, owner)
    client.post("/api/v1/reconciliation/run", headers=auth(owner))
    res = client.get("/api/v1/discrepancies", headers=auth(owner), params={"search": "' OR 1=1 --"})
    assert res.status_code == 200 and res.json()["total"] == 0


def test_mappings_round_trip_and_reject_unknown_rules(client, owner):
    fields = client.get("/api/v1/data-dictionary", headers=auth(owner)).json()
    order_no = next(f for f in fields if f["core_table_name"] == "ecom_orders" and f["standard_field_name"] == "source_order_number")
    ok = client.put("/api/v1/mappings", headers=auth(owner), json={"mappings": [
        {"standard_field_id": order_no["standard_field_id"], "client_erp_column_name": "Sales Doc", "transformation_rule": "trim|upper"}]})
    assert ok.status_code == 200 and ok.json()[0]["client_erp_column_name"] == "Sales Doc"
    bad = client.put("/api/v1/mappings", headers=auth(owner), json={"mappings": [
        {"standard_field_id": order_no["standard_field_id"], "client_erp_column_name": "X", "transformation_rule": "exec:rm -rf"}]})
    assert bad.status_code == 422
    unknown = client.put("/api/v1/mappings", headers=auth(owner), json={"mappings": [
        {"standard_field_id": "00000000-0000-0000-0000-000000000000", "client_erp_column_name": "X"}]})
    assert unknown.status_code == 422
