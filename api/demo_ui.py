"""Deterministic DEMO endpoints in the exact shape the web frontend consumes.

Everything here runs the real core planner (``api.planning.build_candidates``
+ ``core.scoring.rank_candidates`` + ``core.occupancy``) on seeded simulated
inputs. No CV service, network or secret is needed, and every payload is
labelled ``source: DEMO`` / ``freshness: SIMULATED`` (or ``STALE`` for the one
deliberately stale feed). Nothing here is live data.

Seeding: a SHA-256 of (origin, destination) -> ``random.Random``. The same
trip always yields identical output (``as_of`` is a fixed demo instant, never
the wall clock).
"""
from __future__ import annotations

import hashlib
import random
from datetime import timedelta
from math import cos, radians, sin
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from core.enums import DataSource, Freshness, TransportMode
from core.models import CrowdingObservation, JourneyCandidate, Parking
from core.occupancy import build_crowding_observation
from core.scoring import rank_candidates, ScoringWeights
from simulation.scenarios import DEMO_NOW
from api.planning import GeoPoint, build_candidates

router = APIRouter(prefix="/demo", tags=["demo"])

TIME_OF_DAY = {
    "OFFPEAK": {"label": "Uden for myldretid", "crowd_center": 0.34, "park_taken": 0.42},
    "RUSH": {"label": "Myldretid", "crowd_center": 0.84, "park_taken": 0.90},
}

LINES = [
    ("Metro M1", "Metro", 300), ("Metro M2", "Metro", 300),
    ("Metro M3", "Metro", 300), ("Metro M4", "Metro", 300),
    ("S-tog linje A", "S-tog", 500), ("S-tog linje B", "S-tog", 500),
    ("S-tog linje C", "S-tog", 500), ("S-tog linje E", "S-tog", 500),
    ("S-tog linje H", "S-tog", 500),
    ("Bus 5C", "Bus", 90), ("Bus 2A", "Bus", 80),
    ("Bus 350S", "Bus", 90), ("Bus 1A", "Bus", 80),
    ("Letbane L", "Letbane", 180),
]

LOTS = [
    ("p-central", "Q-Park Nørreport", 4.5, 350.0, 0.0),
    ("p-ostbane", "P-hus Israels Plads", 8.5, 720.0, -0.45),
]
LOT_SPACES = 500

MODE_LABELS = {
    TransportMode.DRIVE: "Bil",
    TransportMode.DRIVE_PARK: "Bil + parkering",
    TransportMode.PARK_WALK: "Parkér og gå",
    TransportMode.PARK_TRANSIT: "Parkér & rejs",
    TransportMode.TRANSIT_ONLY: "Offentlig transport",
}
FACTOR_LABELS = {
    "time": "rejsetid", "walk": "gåafstand", "crowd": "trængsel",
    "park": "parkering", "uncertainty": "datausikkerhed",
}
CROWD_TOLERANCE_MAX = {"low": 0.50, "moderate": 0.75, "high": 0.90, "any": 1.01}
WEIGHTS = {"time": 0.40, "walk": 0.15, "crowd": 0.25, "park": 0.10, "uncertainty": 0.10}

DEMO_LABEL = "DEMO DATA – simuleret, ikke live"
AS_OF = DEMO_NOW.isoformat()


class TripPrefs(BaseModel):
    parking: str = "any"
    walking_tolerance: int = Field(10, ge=0, le=120)
    crowding_tolerance: str = "moderate"


class DemoPlanRequest(BaseModel):
    origin: str = Field(..., min_length=1, max_length=120)
    destination: str = Field(..., min_length=1, max_length=120)
    time_of_day: str = "OFFPEAK"
    prefs: Optional[TripPrefs] = None
    priority: Optional[str] = None


def _rng(*parts: str) -> random.Random:
    digest = hashlib.sha256("→".join(parts).encode("utf-8")).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def _norm(s: str) -> str:
    return " ".join(s.split())


def _bias(time_of_day: str) -> dict:
    if time_of_day not in TIME_OF_DAY:
        raise HTTPException(status_code=400, detail=f"unknown time_of_day: {time_of_day}")
    return TIME_OF_DAY[time_of_day]


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _ui_freshness(obs_freshness: Freshness, source: DataSource) -> str:
    """Never let simulated data read as live: FRESH+DEMO -> SIMULATED."""
    if obs_freshness == Freshness.FRESH and source == DataSource.DEMO:
        return "SIMULATED"
    return obs_freshness.value


def _trip_world(origin: str, destination: str, time_of_day: str) -> dict:
    """Build the deterministic simulated world for one trip."""
    bias = _bias(time_of_day)
    rng = _rng(_norm(origin).lower(), _norm(destination).lower())
    trip_bias = (rng.random() - 0.5) * 0.36
    pool = list(LINES)
    rng.shuffle(pool)
    lines = pool[:4]

    crowding: list[CrowdingObservation] = []
    for idx, (name, kind, cap) in enumerate(lines):
        ratio = _clamp(bias["crowd_center"] + trip_bias + (rng.random() - 0.5) * 0.40, 0.05, 1.0)
        count = round(ratio * cap)
        stale = idx == len(lines) - 1
        age = 90 if stale else round(2 + rng.random() * 18)
        crowding.append(build_crowding_observation(
            transport_id=name, route_id=kind,
            passenger_count=count, estimated_capacity=cap,
            timestamp=DEMO_NOW - timedelta(seconds=age),
            source=DataSource.DEMO,
            confidence=round(0.90 + rng.random() * 0.05, 3),
            now=DEMO_NOW,
        ))

    departures = [
        {
            "line": name, "kind": kind,
            "stops_away": rng.randint(1, 8),
            "start_stop": _norm(origin),
            "eta_min": rng.randint(1, 12),
            "source": "DEMO", "freshness": "SIMULATED",
        }
        for name, kind, _ in lines
    ]

    parking: list[Parking] = []
    for pid, pname, walk, dist, offset in LOTS:
        taken = _clamp(bias["park_taken"] + offset + (rng.random() - 0.5) * 0.16, 0.02, 0.995)
        parking.append(Parking(
            parking_id=pid, name=pname, lat=55.683, lon=12.571,
            available_spaces=round(LOT_SPACES * (1 - taken)),
            total_spaces=LOT_SPACES,
            distance_to_destination_m=dist, walking_minutes=walk, price=None,
            source=DataSource.DEMO,
            timestamp=DEMO_NOW - timedelta(seconds=round(5 + rng.random() * 20)),
            freshness=Freshness.FRESH,
        ))

    return {
        "lines": lines, "crowding": crowding, "departures": departures,
        "parking": parking,
        "dist_km": 2.5 + rng.random() * 11.0,
        "bearing": rng.random() * 360.0,
    }


def _crowding_out(o: CrowdingObservation) -> dict:
    return {
        "transport_id": o.transport_id,
        "route_id": o.route_id,
        "passenger_count": o.passenger_count,
        "estimated_capacity": o.estimated_capacity,
        "occupancy_ratio": o.occupancy_ratio,
        "crowding_level": o.crowding_level.value,
        "source": o.source.value,
        "confidence": o.confidence,
        "freshness": _ui_freshness(o.freshness, o.source),
        "age_seconds": o.age_seconds,
    }


def _parking_out(p: Parking) -> dict:
    return {
        "parking_id": p.parking_id, "name": p.name,
        "available_spaces": p.available_spaces, "total_spaces": p.total_spaces,
        "distance_to_destination_m": p.distance_to_destination_m,
        "walking_minutes": p.walking_minutes,
        "source": p.source.value,
        "freshness": _ui_freshness(p.freshness, p.source),
        "age_seconds": (DEMO_NOW - p.timestamp).total_seconds() if p.timestamp else None,
    }


def _crowd_word(score: float) -> str:
    if score < 0.5:
        return "lav til moderat"
    return "høj" if score < 0.9 else "meget høj"


def _explain_da(c: JourneyCandidate) -> str:
    comp = c.components
    contrib = {k: WEIGHTS[k] * getattr(comp, k) for k in FACTOR_LABELS}
    top = [k for k, v in sorted(contrib.items(), key=lambda kv: -kv[1]) if v > 1e-9][:2]
    parts = [MODE_LABELS[c.mode] + "."]
    if len(top) == 1:
        parts.append(f"Scoren er primært drevet af {FACTOR_LABELS[top[0]]}.")
    elif len(top) >= 2:
        parts.append(f"Scoren er primært drevet af {FACTOR_LABELS[top[0]]} og {FACTOR_LABELS[top[1]]}.")
    else:
        parts.append("Scorer tæt på ideelt på alle faktorer.")
    if c.crowding is not None and c.crowding.crowding_score is not None:
        parts.append(f"Trængslen er {_crowd_word(comp.crowd)} på simulerede data.")
    return " ".join(parts)


@router.get("/meta")
def meta() -> dict:
    return {
        "demo_mode": True,
        "label": DEMO_LABEL,
        "as_of": AS_OF,
        "note": "Alle tal er deterministisk simulerede. Linjenavne er ægte, men positioner og trængsel er ikke live.",
        "time_of_day": [{"key": k, "label": v["label"]} for k, v in TIME_OF_DAY.items()],
    }


@router.post("/plan")
def demo_plan(req: DemoPlanRequest) -> dict:
    origin_s, dest_s = _norm(req.origin), _norm(req.destination)
    if not origin_s or not dest_s:
        raise HTTPException(status_code=400, detail="origin and destination must be non-empty")
    if origin_s.lower() == dest_s.lower():
        raise HTTPException(status_code=400, detail="Fra og Til er det samme sted.")
    prefs = req.prefs or TripPrefs()
    if prefs.crowding_tolerance not in CROWD_TOLERANCE_MAX:
        raise HTTPException(status_code=400, detail=f"unknown crowding_tolerance: {prefs.crowding_tolerance}")

    world = _trip_world(origin_s, dest_s, req.time_of_day)
    # Pseudo-geocode: fixed Copenhagen origin, destination offset by the seeded
    # distance/bearing. (There is no geocoder in demo mode, by design.)
    o_lat, o_lon = 55.676, 12.568
    d_lat = o_lat + world["dist_km"] * cos(radians(world["bearing"])) / 111.0
    d_lon = o_lon + world["dist_km"] * sin(radians(world["bearing"])) / (111.0 * cos(radians(o_lat)))
    origin = GeoPoint(o_lat, o_lon, origin_s)
    dest = GeoPoint(d_lat, d_lon, dest_s)

    primary = world["crowding"][0]
    lot = world["parking"][0]
    modes = list(TransportMode)
    if prefs.parking == "none":
        modes = [TransportMode.DRIVE, TransportMode.TRANSIT_ONLY]

    # Adjust weights based on priority
    if req.priority == "Sikker parkering":
        weights = ScoringWeights(time=0.1, walk=0.05, crowd=0.1, park=0.6, uncertainty=0.15)
    elif req.priority == "Mindst fyldt offentlig transport":
        weights = ScoringWeights(time=0.1, walk=0.05, crowd=0.6, park=0.1, uncertainty=0.15)
    else:
        weights = ScoringWeights(
            time=WEIGHTS["time"],
            walk=WEIGHTS["walk"],
            crowd=WEIGHTS["crowd"],
            park=WEIGHTS["park"],
            uncertainty=WEIGHTS["uncertainty"],
        )

    ranked = rank_candidates(build_candidates(origin, dest, primary, lot, modes=modes), weights=weights)
    line_for = {
        TransportMode.TRANSIT_ONLY: world["lines"][0][0],
        TransportMode.PARK_TRANSIT: world["lines"][1][0],
    }
    crowd_cap = CROWD_TOLERANCE_MAX[prefs.crowding_tolerance]

    out = []
    for i, c in enumerate(ranked):
        has_crowd = c.crowding is not None and c.crowding.crowding_score is not None
        warnings = []
        if c.walking_minutes > prefs.walking_tolerance:
            warnings.append(f"Gåtid {c.walking_minutes:g} min overskrider din tolerance på {prefs.walking_tolerance} min.")
        if has_crowd and c.crowding.crowding_score >= crowd_cap:
            warnings.append("Trængslen er højere, end du har accepteret.")
        out.append({
            "recommended": i == 0,
            "mode": MODE_LABELS[c.mode],
            "mode_code": c.mode.value,
            "line": line_for.get(c.mode),
            "score": round(c.score, 4),
            "eta_minutes": c.total_time_minutes,
            "walking_minutes": c.walking_minutes,
            "parking": ({"name": c.parking.name, "available_spaces": c.parking.available_spaces}
                        if c.parking is not None else None),
            "crowding": ({
                "level": c.crowding.crowding_level.value,
                "score": round(c.crowding.crowding_score, 4),
                "confidence": c.crowding.confidence,
                "source": c.crowding.source.value,
            } if has_crowd else None),
            "explanation": _explain_da(c),
            "warnings": warnings,
            "score_components": {
                "time": round(c.components.time, 4), "walking": round(c.components.walk, 4),
                "crowding": round(c.components.crowd, 4), "parking": round(c.components.park, 4),
                "uncertainty": round(c.components.uncertainty, 4),
            },
            "data_sources": ["Simuleret model"],
        })
    return {
        "demo_mode": True,
        "label": DEMO_LABEL,
        "as_of": AS_OF,
        "time_of_day": req.time_of_day,
        "scoring_convention": "lavere score er bedre",
        "candidates": out,
    }


@router.get("/crowding")
def demo_crowding(origin: str = Query("Nørreport St."), destination: str = Query("DTU Lyngby"),
                  time_of_day: str = Query("OFFPEAK")) -> list[dict]:
    return [_crowding_out(o) for o in _trip_world(origin, destination, time_of_day)["crowding"]]


@router.get("/parking")
def demo_parking(origin: str = Query("Nørreport St."), destination: str = Query("DTU Lyngby"),
                 time_of_day: str = Query("OFFPEAK")) -> list[dict]:
    return [_parking_out(p) for p in _trip_world(origin, destination, time_of_day)["parking"]]


@router.get("/departures")
def demo_departures(origin: str = Query("Nørreport St."), destination: str = Query("DTU Lyngby"),
                    time_of_day: str = Query("OFFPEAK")) -> list[dict]:
    return _trip_world(origin, destination, time_of_day)["departures"]
