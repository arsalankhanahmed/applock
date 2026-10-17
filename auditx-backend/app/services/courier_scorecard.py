"""Courier scorecard: how each courier performs on the things that cost a COD business money.

Measured over parcels booked in the last N days up to the latest date in the tenant's courier reports (the same
"as of" the COD reconciliation uses), so a scorecard does not change just because the calendar moved on.

Per courier:
* volume and outcomes: booked, delivered, returned, lost or stuck in transit; delivery success %
* cash: COD collected on delivered parcels, remitted, still with the courier
* speed: average and 90th-percentile days from delivery to remittance; % remitted within the SLA
* charges: average delivery charge, parcels flagged as overcharged and the excess
* issues: money the courier owes in open findings; claims raised, recovered and rejected

The score (0-100) is a weighted mix of five components; a component without data is left out and the remaining
weights are scaled up. Grades: A >= 85, B >= 70, C >= 55, D >= 40, otherwise F.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.config import settings

WEIGHTS = {"speed": 0.30, "on_time": 0.20, "delivery": 0.20, "charges": 0.15, "issues": 0.15}
GRADES = ((85, "A"), (70, "B"), (55, "C"), (40, "D"))
LOW_VOLUME = 20
OWED_ISSUES = ("COD_NOT_REMITTED", "COD_REMITTANCE_SHORTFALL", "COURIER_OVERCHARGE", "PARCEL_LOST_OR_STUCK")

_AS_OF_SQL = """SELECT GREATEST(MAX(booked_at), MAX(delivered_at), MAX(remitted_at))
                  FROM courier_remittances WHERE org_id = :o"""

_PARCELS_SQL = """
    SELECT courier_name,
           COUNT(*)                                                                       AS booked,
           COUNT(*) FILTER (WHERE parcel_status = 'DELIVERED')                            AS delivered,
           COUNT(*) FILTER (WHERE parcel_status = 'RETURNED')                             AS returned,
           COUNT(*) FILTER (WHERE parcel_status = 'LOST'
                            OR (parcel_status = 'IN_TRANSIT' AND booked_at < :stuck))      AS lost_or_stuck,
           COUNT(*) FILTER (WHERE parcel_status = 'IN_TRANSIT' AND booked_at >= :stuck)    AS in_transit,
           COALESCE(SUM(cod_amount) FILTER (WHERE parcel_status = 'DELIVERED'), 0)        AS cod_collected,
           COALESCE(SUM(net_remitted) FILTER (WHERE remittance_reference IS NOT NULL), 0) AS remitted,
           COALESCE(SUM(cod_amount - delivery_charges)
                    FILTER (WHERE parcel_status = 'DELIVERED' AND remittance_reference IS NULL), 0) AS with_courier,
           AVG(delivery_charges) FILTER (WHERE parcel_status = 'DELIVERED')               AS avg_charge,
           AVG(EXTRACT(EPOCH FROM (remitted_at - delivered_at)) / 86400)
               FILTER (WHERE remitted_at IS NOT NULL AND delivered_at IS NOT NULL)        AS avg_remit_days,
           PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (remitted_at - delivered_at)) / 86400)
               FILTER (WHERE remitted_at IS NOT NULL AND delivered_at IS NOT NULL)        AS p90_remit_days,
           COUNT(*) FILTER (WHERE remitted_at IS NOT NULL AND delivered_at IS NOT NULL
                            AND remitted_at - delivered_at <= :sla)                       AS remitted_on_time,
           COUNT(*) FILTER (WHERE remitted_at IS NOT NULL AND delivered_at IS NOT NULL)    AS remitted_count,
           COUNT(*) FILTER (WHERE parcel_status = 'DELIVERED' AND remittance_reference IS NULL
                            AND delivered_at < :overdue)                                  AS overdue_unremitted
      FROM courier_remittances
     WHERE org_id = :o AND COALESCE(booked_at, delivered_at) >= :since
     GROUP BY courier_name
"""

# Findings are matched to couriers through the parcel of the same order, booked inside the same window.
_FINDINGS_SQL = """
    SELECT p.courier_name,
           COUNT(*) FILTER (WHERE d.issue_type = 'COURIER_OVERCHARGE')                    AS overcharged,
           COALESCE(SUM(d.variance_amount) FILTER (WHERE d.issue_type = 'COURIER_OVERCHARGE'), 0) AS overcharge_value,
           COALESCE(SUM(d.variance_amount) FILTER (WHERE d.status <> 'RESOLVED' AND d.variance_amount > 0
                                                   AND d.issue_type = ANY(:owed)), 0)     AS owed_now
      FROM discrepancy_logs d
      JOIN LATERAL (SELECT c.courier_name FROM courier_remittances c
                     WHERE c.org_id = d.org_id AND c.source_order_number = d.source_order_number
                       AND COALESCE(c.booked_at, c.delivered_at) >= :since
                     ORDER BY c.booked_at DESC NULLS LAST LIMIT 1) p ON TRUE
     WHERE d.org_id = :o AND d.channel = 'COD'
     GROUP BY p.courier_name
"""

_CLAIMS_SQL = """
    SELECT counterparty_name AS courier_name,
           COALESCE(SUM(claimed_amount) FILTER (WHERE status NOT IN ('DRAFT', 'CANCELLED')), 0) AS claimed,
           COALESCE(SUM(recovered_amount), 0)                                             AS recovered,
           COUNT(*) FILTER (WHERE status = 'REJECTED')                                    AS claims_rejected
      FROM recovery_claims WHERE org_id = :o AND counterparty_type = 'COURIER'
     GROUP BY counterparty_name
"""


def _pct(part: Any, whole: Any) -> Optional[float]:
    whole = float(whole or 0)
    return round(100.0 * float(part or 0) / whole, 1) if whole else None


def _clamp(value: float) -> float:
    return max(0.0, min(100.0, value))


@dataclass
class Components:
    speed: Optional[float]
    on_time: Optional[float]
    delivery: Optional[float]
    charges: Optional[float]
    issues: Optional[float]

    def as_dict(self) -> Dict[str, Optional[float]]:
        return {k: (None if v is None else round(v, 1)) for k, v in self.__dict__.items()}


def components(row: Dict[str, Any], sla_days: int) -> Components:
    """Turn raw courier numbers into five 0-100 component scores (None when there is no data)."""
    avg_days = row.get("avg_remit_days")
    # 100 when remitted within 2 days, falling to 0 at twice the SLA.
    speed = None if avg_days is None else _clamp(100 * (2 * sla_days - float(avg_days)) / (2 * sla_days - 2))
    judged = int(row.get("remitted_count") or 0) + int(row.get("overdue_unremitted") or 0)
    on_time = _pct(row.get("remitted_on_time"), judged)
    closed = sum(int(row.get(k) or 0) for k in ("delivered", "returned", "lost_or_stuck"))
    delivery = _pct(row.get("delivered"), closed)
    delivered = int(row.get("delivered") or 0)
    # Each 1% of delivered parcels overcharged costs 5 points.
    charges = None if not delivered else _clamp(100 - 5 * 100 * int(row.get("overcharged") or 0) / delivered)
    collected = float(row.get("cod_collected") or 0)
    # Each 1% of collected COD still owed in open findings costs 10 points.
    issues = None if not collected else _clamp(100 - 10 * 100 * float(row.get("owed_now") or 0) / collected)
    return Components(speed, on_time, delivery, charges, issues)


def score(parts: Components) -> Optional[float]:
    present = {k: v for k, v in parts.__dict__.items() if v is not None}
    if not present:
        return None
    weight = sum(WEIGHTS[k] for k in present)
    return round(sum(WEIGHTS[k] * v for k, v in present.items()) / weight, 1)


def grade(value: Optional[float]) -> Optional[str]:
    if value is None:
        return None
    return next((g for floor, g in GRADES if value >= floor), "F")


def _money(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"))


def build(conn: Connection, org_id: UUID, days: int = 90) -> Dict[str, Any]:
    as_of = conn.execute(text(_AS_OF_SQL), {"o": str(org_id)}).scalar()
    currency = conn.execute(text("SELECT brand_currency FROM organizations WHERE org_id = :o"),
                            {"o": str(org_id)}).scalar_one()
    if as_of is None:
        return {"as_of": None, "days": days, "currency": currency, "couriers": [], "best": {}}
    sla = settings.COD_REMITTANCE_SLA_DAYS
    params = {"o": str(org_id), "since": as_of - timedelta(days=days),
              "stuck": as_of - timedelta(days=settings.PARCEL_STUCK_DAYS),
              "overdue": as_of - timedelta(days=sla), "sla": timedelta(days=sla)}
    rows = {r["courier_name"]: dict(r) for r in conn.execute(text(_PARCELS_SQL), params).mappings()}
    findings = {r["courier_name"]: dict(r) for r in conn.execute(
        text(_FINDINGS_SQL), {"o": str(org_id), "owed": list(OWED_ISSUES), "since": params["since"]}).mappings()}
    claims = {r["courier_name"]: dict(r) for r in conn.execute(text(_CLAIMS_SQL), {"o": str(org_id)}).mappings()}

    couriers = []
    for name, row in rows.items():
        row.update({k: v for k, v in findings.get(name, {}).items() if k != "courier_name"})
        row.update({k: v for k, v in claims.get(name, {}).items() if k != "courier_name"})
        parts = components(row, sla)
        value = score(parts)
        couriers.append({
            "courier_name": name,
            "score": value,
            "grade": grade(value),
            "low_volume": int(row["booked"]) < LOW_VOLUME,
            "components": parts.as_dict(),
            "booked": int(row["booked"]),
            "delivered": int(row["delivered"]),
            "returned": int(row["returned"]),
            "lost_or_stuck": int(row["lost_or_stuck"]),
            "in_transit": int(row["in_transit"]),
            "delivery_rate_pct": _pct(row["delivered"], int(row["delivered"]) + int(row["returned"]) + int(row["lost_or_stuck"])),
            "return_rate_pct": _pct(row["returned"], row["booked"]),
            "cod_collected": _money(row["cod_collected"]),
            "remitted": _money(row["remitted"]),
            "with_courier": _money(row["with_courier"]),
            "avg_remit_days": None if row["avg_remit_days"] is None else round(float(row["avg_remit_days"]), 1),
            "p90_remit_days": None if row["p90_remit_days"] is None else round(float(row["p90_remit_days"]), 1),
            "on_time_pct": parts.on_time,
            "overdue_unremitted": int(row["overdue_unremitted"]),
            "avg_charge": None if row["avg_charge"] is None else _money(row["avg_charge"]),
            "overcharged": int(row.get("overcharged") or 0),
            "overcharge_value": _money(row.get("overcharge_value")),
            "owed_now": _money(row.get("owed_now")),
            "claimed": _money(row.get("claimed")),
            "recovered": _money(row.get("recovered")),
            "claims_rejected": int(row.get("claims_rejected") or 0),
        })
    couriers.sort(key=lambda c: (c["score"] is None, -(c["score"] or 0), c["courier_name"]))
    return {"as_of": as_of, "days": days, "currency": currency, "couriers": couriers, "best": _best(couriers)}


def _best(couriers: List[Dict[str, Any]]) -> Dict[str, str]:
    """Which courier leads on each headline measure (only couriers with enough volume compete when any do)."""
    pool = [c for c in couriers if not c["low_volume"]] or couriers
    best: Dict[str, str] = {}
    for key, metric, reverse in (("overall", "score", True), ("fastest_remittance", "avg_remit_days", False),
                                 ("best_delivery", "delivery_rate_pct", True), ("cheapest", "avg_charge", False)):
        ranked = [c for c in pool if c[metric] is not None]
        if len(ranked) >= 2:
            winner = sorted(ranked, key=lambda c: c[metric], reverse=reverse)[0]
            best[key] = winner["courier_name"]
    return best


CSV_COLUMNS = ("courier_name", "grade", "score", "booked", "delivered", "returned", "lost_or_stuck", "delivery_rate_pct",
               "return_rate_pct", "cod_collected", "remitted", "with_courier", "avg_remit_days", "p90_remit_days",
               "on_time_pct", "overdue_unremitted", "avg_charge", "overcharged", "overcharge_value", "owed_now",
               "claimed", "recovered", "claims_rejected")


def to_csv(card: Dict[str, Any]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(CSV_COLUMNS)
    for c in card["couriers"]:
        writer.writerow(["" if c[k] is None else c[k] for k in CSV_COLUMNS])
    return buffer.getvalue()
