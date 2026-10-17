"""White-box unit tests for the file parser's pure functions (no database)."""
import math

import pandas as pd
import pytest

from app.database import DATA_DICTIONARY_SEED
from app.services import parser
from app.services.parser import (FieldRule, apply_numeric_ops, apply_string_ops, clean_currency_series,
                                 normalise_header, normalise_parcel_status, parse_transformation_rule,
                                 transform_chunk)

pytestmark = pytest.mark.unit


def identity_rules(target: str):
    """The dictionary's fields for a table, mapped onto columns with their own standard names."""
    return {
        field: FieldRule(field, field, dtype, required)
        for table, field, dtype, required, _ in DATA_DICTIONARY_SEED
        if table == target
    }


# ----------------------------------------------------------------------------- currency cleaning
@pytest.mark.parametrize("raw, expected", [
    ("$1,299.00", 1299.0),
    ("Rs. 4,500", 4500.0),
    ("Rs.1,00,000.00", 100000.0),          # Indian lakh grouping
    ("(12.50)", -12.5),                     # accounting negative
    ("1.234,56-", -1234.56),                # SAP trailing minus, European decimals
    ("€ 1.234,56", 1234.56),
    ("2 500,00", 2500.0),                   # space thousands, comma decimal
    ("USD 99", 99.0),
    ("1,234,567.89", 1234567.89),
    ("12,5", 12.5),
    ("  77.10  ", 77.1),
    ("0.005", 0.01),                        # half a cent rounds up (DEF-01)
    ("2.675", 2.68),                        # float 2.675 is 2.67499999...; still rounds up (DEF-01)
    ("-0.005", -0.01),                      # half away from zero for negatives (DEF-01)
    ("1.2344", 1.23),
    ("-42", -42.0),
    ("£3", 3.0),
])
def test_currency_cleaner_parses_dirty_formats(raw, expected):
    assert clean_currency_series(pd.Series([raw])).iloc[0] == pytest.approx(expected)


@pytest.mark.parametrize("raw", ["abc", "", None, "N/A", "--"])
def test_currency_cleaner_returns_missing_for_non_numbers(raw):
    value = clean_currency_series(pd.Series([raw])).iloc[0]
    assert value is pd.NA or (isinstance(value, float) and math.isnan(value))


def test_currency_cleaner_keeps_index_alignment():
    series = pd.Series(["$1", "bad", "$3"], index=[10, 20, 30])
    cleaned = clean_currency_series(series)
    assert list(cleaned.index) == [10, 20, 30]
    assert cleaned.loc[30] == 3.0


# ----------------------------------------------------------------------------- transformation rules
def test_rule_parsing_handles_pipes_and_arguments():
    ops = parse_transformation_rule("strip_prefix:#| upper |multiply:0.01|date_format:%d.%m.%Y %H:%M")
    assert ops == [("strip_prefix", "#"), ("upper", None), ("multiply", "0.01"), ("date_format", "%d.%m.%Y %H:%M")]


def test_rule_parsing_rejects_unknown_operations():
    with pytest.raises(ValueError, match="Unsupported transformation op 'eval'"):
        parse_transformation_rule("trim|eval:__import__('os')")


def test_empty_rule_is_no_ops():
    assert parse_transformation_rule(None) == []
    assert parse_transformation_rule("") == []


def test_string_ops_apply_in_order():
    series = pd.Series(["  #so-001 ", "#so-002"]).str.strip()
    out = apply_string_ops(series, parse_transformation_rule("strip_prefix:#|upper"))
    assert out.tolist() == ["SO-001", "SO-002"]


def test_numeric_ops_convert_cents_and_signs():
    assert apply_numeric_ops(pd.Series([12345.0]), parse_transformation_rule("divide:100")).iloc[0] == 123.45
    assert apply_numeric_ops(pd.Series([-1.4]), parse_transformation_rule("abs")).iloc[0] == 1.4
    assert apply_numeric_ops(pd.Series([5.0]), parse_transformation_rule("negate")).iloc[0] == -5.0


def test_field_rule_exposes_date_options():
    rule = FieldRule("ordered_at", "Created On", "TIMESTAMP", False, "dayfirst|date_format:%d/%m/%Y|default:01/01/2026")
    assert rule.date_format == "%d/%m/%Y"
    assert rule.dayfirst is True
    assert rule.default == "01/01/2026"


# ----------------------------------------------------------------------------- headers & statuses
@pytest.mark.parametrize("a, b", [("Sales Document", "sales_document"), (" Order Ref ", "ORDER-REF"), ("Doc. Currency", "doc currency")])
def test_header_normalisation_ignores_case_spaces_and_punctuation(a, b):
    assert normalise_header(a) == normalise_header(b)


@pytest.mark.parametrize("wording, state", [
    ("Delivered", "DELIVERED"),
    ("DELIVERED TO CUSTOMER", "DELIVERED"),
    ("Returned to Shipper", "RETURNED"),
    ("RTO", "RETURNED"),
    ("RTO Delivered", "RETURNED"),         # delivered back to the merchant is a return
    ("Refused by consignee", "RETURNED"),
    ("Lost", "LOST"),
    ("Shipment damaged", "LOST"),
    ("Out for delivery", "IN_TRANSIT"),
    ("Delivery attempted", "IN_TRANSIT"),
    ("Undelivered", "IN_TRANSIT"),
    ("Booked", "IN_TRANSIT"),
    (None, "IN_TRANSIT"),
])
def test_courier_status_wording_is_normalised(wording, state):
    assert normalise_parcel_status(pd.Series([wording])).iloc[0] == state


def test_resolve_columns_reports_missing_required_columns():
    rules = identity_rules("ecom_orders")
    with pytest.raises(ValueError, match="source_order_number"):
        parser._resolve_columns(["total_amount", "currency"], rules)


def test_resolve_columns_prefers_client_mapping_then_standard_name():
    rules = identity_rules("ecom_orders")
    rules["source_order_number"] = FieldRule("source_order_number", "Sales Document", "STRING", True)
    resolved = parser._resolve_columns(["SALES document", "total_amount"], rules)
    assert resolved == {"SALES document": "source_order_number", "total_amount": "total_amount"}


# ----------------------------------------------------------------------------- chunk transformation
def test_orders_chunk_normalises_payment_method_and_rejects_incomplete_rows():
    chunk = pd.DataFrame({
        "source_order_number": ["A1", "A2", None, "A4"],
        "total_amount": ["$10.00", "Rs. 20", "$5", ""],
        "currency": ["usd", None, "USD", "USD"],
        "ordered_at": ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"],
        "payment_method": ["Cash on Delivery", "card", "COD", "cod"],
    })
    clean, rejected = transform_chunk(chunk, "ecom_orders", identity_rules("ecom_orders"), "PKR")
    assert rejected == 2                                    # no order number, no amount
    assert clean["payment_method"].tolist() == ["COD", "PREPAID"]
    assert clean["currency"].tolist() == ["USD", "PKR"]     # blank falls back to brand currency


def test_gateway_chunk_derives_fee_or_net():
    chunk = pd.DataFrame({
        "source_order_number": ["A1", "A2"],
        "source_transaction_id": ["ch_1", "ch_2"],
        "gross_amount": ["100.00", "50.00"],
        "net_amount": ["97.10", None],
        "fee_amount": [None, "1.75"],
        "processed_at": ["2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z"],
        "payout_reference": ["po_1", None],
    })
    clean, rejected = transform_chunk(chunk, "gateway_transactions", identity_rules("gateway_transactions"), "USD")
    assert rejected == 0
    assert clean["fee_amount"].tolist() == [2.9, 1.75]
    assert clean["net_amount"].tolist() == [97.1, 48.25]


def test_bank_chunk_derives_signed_amount_from_debit_credit_and_fingerprints_missing_refs():
    chunk = pd.DataFrame({
        "transaction_date": ["2026-10-01", "2026-10-01", "2026-10-01"],
        "description": ["STRIPE PAYOUT po_1", "RENT", "STRIPE PAYOUT po_1"],
        "credit_amount": ["1,000.00", None, "1,000.00"],
        "debit_amount": [None, "-250.00", None],              # debits exported negative are still debits
        "bank_reference": [None, "REF-2", None],
    })
    clean, rejected = transform_chunk(chunk, "bank_transactions", identity_rules("bank_transactions"), "USD")
    assert rejected == 0
    assert clean["amount"].tolist() == [1000.0, -250.0, 1000.0]
    refs = clean["bank_reference"].tolist()
    assert refs[1] == "REF-2"
    assert refs[0].startswith("fp_") and refs[2].startswith("fp_")
    assert refs[0] != refs[2]                                   # identical lines get different occurrence numbers


def test_bank_fingerprints_are_stable_across_uploads_and_chunks():
    def chunk():
        return pd.DataFrame({
            "transaction_date": ["2026-10-01"], "description": ["TCS COD REMITTANCE"],
            "amount": ["500.00"], "bank_reference": [None],
        })
    rules = identity_rules("bank_transactions")
    first_upload = transform_chunk(chunk(), "bank_transactions", rules, "USD", {})[0]["bank_reference"].iloc[0]
    second_upload = transform_chunk(chunk(), "bank_transactions", rules, "USD", {})[0]["bank_reference"].iloc[0]
    assert first_upload == second_upload

    ctx: dict = {}
    a = transform_chunk(chunk(), "bank_transactions", rules, "USD", ctx)[0]["bank_reference"].iloc[0]
    b = transform_chunk(chunk(), "bank_transactions", rules, "USD", ctx)[0]["bank_reference"].iloc[0]
    assert a != b                                               # same line twice in one file = two lines


def test_courier_chunk_derives_net_only_when_remitted_and_uppercases_courier():
    chunk = pd.DataFrame({
        "tracking_number": ["T1", "T2"],
        "source_order_number": ["A1", "A2"],
        "courier_name": ["Leopards", None],
        "parcel_status": ["Delivered", "Delivered"],
        "cod_amount": ["Rs. 1,000", "500"],
        "delivery_charges": ["(150)", "100"],                   # charges exported as negatives are still charges
        "net_remitted": [None, None],
        "remittance_reference": ["CPR-9", None],
    })
    clean, rejected = transform_chunk(chunk, "courier_remittances", identity_rules("courier_remittances"), "PKR")
    assert rejected == 0
    assert clean["courier_name"].tolist() == ["LEOPARDS", "UNKNOWN"]
    assert clean["delivery_charges"].tolist() == [150.0, 100.0]
    assert clean["net_remitted"].tolist() == [850.0, 0.0]


def test_upsert_merge_sql_keeps_last_row_per_parcel():
    sql = parser._merge_sql("courier_remittances", "stg", ["org_id", "tracking_number", "parcel_status"])
    assert "DISTINCT ON (tracking_number)" in sql and "ctid DESC" in sql
    assert "DO UPDATE SET parcel_status = EXCLUDED.parcel_status" in sql
    assert "DO NOTHING" in parser._merge_sql("ecom_orders", "stg", ["org_id", "source_order_number"])
