"""Integration: file parsing into PostgreSQL through the tenant's header mappings."""
import io

import pytest
from sqlalchemy import text

from app.services.parser import parse_stream
from tests.helpers import make_org

pytestmark = pytest.mark.integration


def stream(*lines: str, bom: bool = False) -> io.BytesIO:
    body = "\n".join(lines) + "\n"
    return io.BytesIO((("﻿" if bom else "") + body).encode())


def rows(conn, sql, org):
    return conn.execute(text(sql), {"o": str(org)}).mappings().all()


def map_header(conn, org, table, field, column, rule=None):
    conn.execute(text(
        "INSERT INTO client_field_mappings (org_id, standard_field_id, client_erp_column_name, transformation_rule) "
        "SELECT :o, standard_field_id, :c, :r FROM data_dictionary_master "
        "WHERE core_table_name = :t AND standard_field_name = :f"),
        {"o": str(org), "c": column, "r": rule, "t": table, "f": field})


def test_orders_load_with_mapped_headers_and_rules(db):
    with db.begin() as conn:
        org = make_org(conn, currency="PKR")
        map_header(conn, org, "ecom_orders", "source_order_number", "Order #", "strip_prefix:#|upper")
        map_header(conn, org, "ecom_orders", "total_amount", "Amount (paisa)", "divide:100")
        map_header(conn, org, "ecom_orders", "ordered_at", "Placed", "date_format:%d/%m/%Y")
        map_header(conn, org, "ecom_orders", "payment_method", "Pay Mode")
    report = parse_stream(stream(
        "Order #;Amount (paisa);Placed;Pay Mode;Ignored Column",
        "#so-1;125050;03/04/2026;COD;x",
        "#so-2;99;04/04/2026;Card;y",
        ";5000;05/04/2026;COD;z",                   # no order number: rejected
        bom=True,                                    # Excel's UTF-8 BOM and ';' delimiter
    ), org, "ecom_orders")
    assert (report.rows_read, report.rows_inserted, report.rows_rejected) == (3, 2, 1)
    with db.connect() as conn:
        loaded = rows(conn, "SELECT source_order_number, total_amount, currency, payment_method, "
                            "to_char(ordered_at, 'YYYY-MM-DD') AS d FROM ecom_orders WHERE org_id = :o ORDER BY 1", org)
    assert [{**r, "total_amount": float(r["total_amount"])} for r in loaded] == [
        {"source_order_number": "SO-1", "total_amount": 1250.50, "currency": "PKR", "payment_method": "COD", "d": "2026-04-03"},
        {"source_order_number": "SO-2", "total_amount": 0.99, "currency": "PKR", "payment_method": "PREPAID", "d": "2026-04-04"},
    ]


def test_reupload_is_idempotent(db):
    with db.begin() as conn:
        org = make_org(conn)
    csv = ("source_order_number,total_amount", "A1,10", "A2,20")
    first = parse_stream(stream(*csv), org, "ecom_orders")
    second = parse_stream(stream(*csv), org, "ecom_orders")
    assert (first.rows_inserted, second.rows_inserted, second.rows_duplicate) == (2, 0, 2)


def test_missing_required_column_fails_with_a_clear_message(db):
    with db.begin() as conn:
        org = make_org(conn)
    with pytest.raises(ValueError, match="source_transaction_id"):
        parse_stream(stream("source_order_number,gross_amount", "A1,10"), org, "gateway_transactions")


def test_large_file_is_processed_in_chunks(db):
    with db.begin() as conn:
        org = make_org(conn)
    lines = ["source_order_number,total_amount"] + [f"SO-{i},{i}.25" for i in range(2_500)]
    report = parse_stream(stream(*lines), org, "ecom_orders", chunk_rows=1_000)
    assert (report.chunks_processed, report.rows_inserted) == (3, 2_500)


def test_courier_reupload_updates_parcels_in_place(db):
    with db.begin() as conn:
        org = make_org(conn)
    header = "tracking_number,source_order_number,courier_name,parcel_status,cod_amount,delivery_charges,remittance_reference"
    parse_stream(stream(header, "T1,A1,TCS,In Transit,0,0,"), org, "courier_remittances")
    report = parse_stream(stream(header, "T1,A1,TCS,Delivered,1000,150,", "T1,A1,TCS,Delivered,1000,150,CPR-1"),
                          org, "courier_remittances")
    assert report.rows_inserted == 1                        # the file's last row for T1 wins
    with db.connect() as conn:
        parcel = rows(conn, "SELECT parcel_status, net_remitted, remittance_reference FROM courier_remittances WHERE org_id = :o", org)
    assert [dict(p) for p in parcel] == [{"parcel_status": "DELIVERED", "net_remitted": 850, "remittance_reference": "CPR-1"}]


def test_bank_statement_without_references_is_idempotent(db):
    with db.begin() as conn:
        org = make_org(conn)
    csv = ("transaction_date,description,credit_amount,debit_amount",
           "2026-10-01,STRIPE PAYOUT po_1,\"1,000.00\",",
           "2026-10-01,STRIPE PAYOUT po_1,\"1,000.00\",",          # two genuinely identical lines
           "2026-10-02,RENT,,500.00")
    assert parse_stream(stream(*csv), org, "bank_transactions").rows_inserted == 3
    again = parse_stream(stream(*csv), org, "bank_transactions")
    assert (again.rows_inserted, again.rows_duplicate) == (0, 3)
    with db.connect() as conn:
        total = conn.execute(text("SELECT SUM(amount) FROM bank_transactions WHERE org_id = :o"), {"o": str(org)}).scalar()
    assert total == 1500


def test_tenants_do_not_share_rows_or_mappings(db):
    with db.begin() as conn:
        a, b = make_org(conn, "A"), make_org(conn, "B")
        map_header(conn, a, "ecom_orders", "source_order_number", "Order ID")
    parse_stream(stream("Order ID,total_amount", "X1,5"), a, "ecom_orders")
    with pytest.raises(ValueError):                         # B has no such mapping
        parse_stream(stream("Order ID,total_amount", "X1,5"), b, "ecom_orders")
    parse_stream(stream("source_order_number,total_amount", "X1,7"), b, "ecom_orders")   # same number, other tenant
    with db.connect() as conn:
        counts = conn.execute(text("SELECT org_id, COUNT(*) FROM ecom_orders GROUP BY 1")).all()
    assert len(counts) == 2 and all(c == 1 for _, c in counts)
