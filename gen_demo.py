"""Generate the deterministic demo dataset for the standalone dashboard.

Runs the real backend simulation + core scorer and serializes the output into
the JSON shape the frontend rendering consumes for /plan, /crowding, /parking.
Two scenarios: LOW crowding and HIGH crowding.
"""
import json

from core.enums import TransportMode
from core.scoring import rank_candidates
from simulation.scenarios import (
    CrowdingScenario,
    ParkingScenario,
    DEMO_NOW,
    simulate_crowding,
    simulate_parking,
)
from api.planning import GeoPoint, build_candidates

ORIGIN = GeoPoint(40.7015, -74.0180, "Harbor View Apartments")
DESTINATION = GeoPoint(40.7538, -73.9820, "Midtown Medical Center")

MODE_LABELS = {
    "DRIVE": "Drive",
    "DRIVE+PARK": "Drive + Park",
    "PARK+WALK": "Park & Walk",
    "PARK+TRANSIT": "Park & Ride",
    "TRANSIT_ONLY": "Transit",
}


def crowding_to_json(obs, freshness_override=None):
    return {
        "transport_id": obs.transport_id,
        "route_id": obs.route_id,
        "passenger_count": obs.passenger_count,
        "estimated_capacity": obs.estimated_capacity,
        "occupancy_ratio": round(obs.occupancy_ratio, 4) if obs.occupancy_ratio is not None else None,
        "crowding_level": obs.crowding_level.value,
        "source": obs.source.value,
        "confidence": round(obs.confidence, 3),
        "freshness": freshness_override or ("SIMULATED" if obs.source.value == "DEMO" else obs.freshness.value),
        "age_seconds": round(obs.age_seconds, 1) if obs.age_seconds is not None else None,
    }


def parking_to_json(p, freshness_override="SIMULATED"):
    age = round((DEMO_NOW - p.timestamp).total_seconds(), 1) if p.timestamp is not None else None
    return {
        "parking_id": p.parking_id,
        "name": p.name,
        "available_spaces": p.available_spaces,
        "total_spaces": p.total_spaces,
        "distance_to_destination_m": p.distance_to_destination_m,
        "walking_minutes": p.walking_minutes,
        "source": p.source.value,
        "freshness": freshness_override,
        "age_seconds": age,
    }


def candidate_to_json(c, recommended):
    crowding = None
    if c.crowding is not None and c.crowding.crowding_score is not None:
        crowding = {
            "level": c.crowding.crowding_level.value,
            "score": round(c.crowding.crowding_score, 4),
            "confidence": round(c.crowding.confidence, 3),
            "source": c.crowding.source.value,
        }
    parking = None
    if c.parking is not None:
        parking = {"name": c.parking.name, "available_spaces": c.parking.available_spaces}
    comp = c.components
    score_components = {
        "time": round(comp.time, 4),
        "walking": round(comp.walk, 4),
        "crowding": round(comp.crowd, 4),
        "parking": round(comp.park, 4),
        "uncertainty": round(comp.uncertainty, 4),
    }
    sources = ["DEMO simulation"]
    return {
        "recommended": recommended,
        "mode": MODE_LABELS.get(c.mode.value, c.mode.value),
        "score": round(c.score, 4),
        "eta_minutes": round(c.total_time_minutes, 1),
        "walking_minutes": round(c.walking_minutes, 1),
        "parking": parking,
        "crowding": crowding,
        "explanation": c.explanation,
        "score_components": score_components,
        "data_sources": sources,
    }


def build_plan(crowding_scenario, parking_scenario):
    crowding_obs = simulate_crowding(crowding_scenario, estimated_capacity=60)
    parking_opt = simulate_parking(parking_scenario)
    candidates = build_candidates(ORIGIN, DESTINATION, crowding_obs, parking_opt, modes=list(TransportMode))
    ranked = rank_candidates(candidates)
    out = [candidate_to_json(c, i == 0) for i, c in enumerate(ranked)]
    return {"demo_mode": True, "candidates": out}


def build_crowding_panel(specs):
    rows = []
    for transport_id, route_id, scenario, capacity, fresh in specs:
        obs = simulate_crowding(scenario, transport_id=transport_id, route_id=route_id, estimated_capacity=capacity)
        rows.append(crowding_to_json(obs, freshness_override=fresh))
    return rows


def build_parking_panel(specs):
    rows = []
    for parking_id, name, scenario, walk, dist, fresh in specs:
        p = simulate_parking(scenario, parking_id=parking_id, name=name)
        j = parking_to_json(p, freshness_override=fresh)
        j["walking_minutes"] = walk
        j["distance_to_destination_m"] = dist
        rows.append(j)
    return rows


LOW = {
    "label": "Off-peak - low crowding",
    "plan": build_plan(CrowdingScenario.LOW, ParkingScenario.PARKING_AVAILABLE),
    "crowding": build_crowding_panel([
        ("Bus 12", "route-42 Downtown", CrowdingScenario.LOW, 60, "SIMULATED"),
        ("Bus 30", "route-8 Riverside", CrowdingScenario.MODERATE, 45, "SIMULATED"),
        ("Tram A", "route-15 Uptown", CrowdingScenario.LOW, 90, "SIMULATED"),
        ("Bus 47", "route-3 Airport", CrowdingScenario.STALE_DATA, 60, "STALE"),
    ]),
    "parking": build_parking_panel([
        ("lot-central", "Central Deck", ParkingScenario.PARKING_AVAILABLE, 4.5, 350.0, "SIMULATED"),
        ("lot-river", "Riverside Garage", ParkingScenario.NEARLY_FULL, 9.5, 780.0, "SIMULATED"),
    ]),
}

HIGH = {
    "label": "Rush hour - high crowding",
    "plan": build_plan(CrowdingScenario.HIGH, ParkingScenario.NEARLY_FULL),
    "crowding": build_crowding_panel([
        ("Bus 12", "route-42 Downtown", CrowdingScenario.HIGH, 60, "SIMULATED"),
        ("Bus 30", "route-8 Riverside", CrowdingScenario.VERY_HIGH, 45, "SIMULATED"),
        ("Tram A", "route-15 Uptown", CrowdingScenario.HIGH, 90, "SIMULATED"),
        ("Bus 47", "route-3 Airport", CrowdingScenario.STALE_DATA, 60, "STALE"),
    ]),
    "parking": build_parking_panel([
        ("lot-central", "Central Deck", ParkingScenario.NEARLY_FULL, 4.5, 350.0, "SIMULATED"),
        ("lot-river", "Riverside Garage", ParkingScenario.PARKING_AVAILABLE, 9.5, 780.0, "SIMULATED"),
    ]),
}

DATASETS = {"LOW": LOW, "HIGH": HIGH}
print(json.dumps(DATASETS, indent=2))
