"""Unit (white box): the courier score formula, grades, leaders and CSV export."""
from decimal import Decimal

import pytest

from app.services import courier_scorecard as sc

pytestmark = pytest.mark.unit

PERFECT = {"avg_remit_days": 2, "remitted_count": 10, "remitted_on_time": 10, "overdue_unremitted": 0, "delivered": 10,
           "returned": 0, "lost_or_stuck": 0, "overcharged": 0, "cod_collected": 1000, "owed_now": 0}


def test_a_perfect_courier_scores_100():
    parts = sc.components(PERFECT, sla_days=10)
    assert parts.as_dict() == {"speed": 100.0, "on_time": 100.0, "delivery": 100.0, "charges": 100.0, "issues": 100.0}
    assert sc.score(parts) == 100.0 and sc.grade(100.0) == "A"


@pytest.mark.parametrize("days, expected", [(2, 100.0), (1, 100.0), (11, 50.0), (20, 0.0), (35, 0.0)])
def test_speed_falls_from_two_days_to_twice_the_sla(days, expected):
    assert sc.components({**PERFECT, "avg_remit_days": days}, sla_days=10).speed == pytest.approx(expected)


def test_each_component_reacts_to_its_own_problem():
    row = {**PERFECT, "remitted_on_time": 6, "overdue_unremitted": 2,      # 6 of 12 judged on time
           "returned": 3, "lost_or_stuck": 1,                              # 10 of 14 closed delivered
           "overcharged": 1,                                               # 10% overcharged -> -50
           "owed_now": 25}                                                 # 2.5% still owed -> -25
    parts = sc.components(row, sla_days=10).as_dict()
    assert parts == {"speed": 100.0, "on_time": 50.0, "delivery": 71.4, "charges": 50.0, "issues": 75.0}


def test_missing_components_are_left_out_and_weights_rescaled():
    parts = sc.Components(speed=None, on_time=None, delivery=80.0, charges=None, issues=None)
    assert sc.score(parts) == 80.0
    assert sc.score(sc.Components(None, None, None, None, None)) is None
    assert sc.components({"delivered": 0, "returned": 0, "lost_or_stuck": 0}, 10).as_dict() == {
        "speed": None, "on_time": None, "delivery": None, "charges": None, "issues": None}


@pytest.mark.parametrize("value, letter", [(85, "A"), (84.9, "B"), (70, "B"), (55, "C"), (40, "D"), (39.9, "F"), (None, None)])
def test_grade_bands(value, letter):
    assert sc.grade(value) == letter


def courier(name, score, days, rate, charge, low=False):
    return {"courier_name": name, "score": score, "avg_remit_days": days, "delivery_rate_pct": rate,
            "avg_charge": charge, "low_volume": low}


def test_leaders_ignore_low_volume_couriers_when_others_qualify():
    best = sc._best([courier("TCS", 70, 9.0, 92.0, Decimal("2.50")), courier("TRAX", 95, 1.0, 99.0, Decimal("1.00"), low=True),
                     courier("LEOPARDS", 80, 6.0, 90.0, Decimal("2.20"))])
    assert best == {"overall": "LEOPARDS", "fastest_remittance": "LEOPARDS", "best_delivery": "TCS", "cheapest": "LEOPARDS"}
    assert sc._best([courier("TCS", 70, 9.0, 92.0, Decimal("2.50"))]) == {}           # nothing to compare


def test_csv_export_has_one_row_per_courier():
    card = {"couriers": [{**{k: None for k in sc.CSV_COLUMNS}, "courier_name": "TCS", "grade": "B", "score": 72.5}]}
    lines = sc.to_csv(card).strip().splitlines()
    assert lines[0].startswith("courier_name,grade,score,booked") and lines[1].startswith("TCS,B,72.5,")
