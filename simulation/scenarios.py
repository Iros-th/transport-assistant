from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import random
from enum import Enum

from core.enums import DataSource, Freshness
from core.freshness import DEFAULT_FRESHNESS_THRESHOLDS, FreshnessThresholds
from core.models import CrowdingObservation, Parking
from core.occupancy import (
    DEFAULT_CROWDING_THRESHOLDS,
    CrowdingThresholds,
    build_crowding_observation,
)

DEMO_NOW = datetime(2026, 9, 29, 9, 0, 0, tzinfo=timezone.utc)

class CrowdingScenario(str, Enum):
    LOW = "LOW"
    MODERATE = "MODERATE"
    HIGH = "HIGH"
    VERY_HIGH = "VERY_HIGH"
    STALE_DATA = "STALE_DATA"
    MISSING_DATA = "MISSING_DATA"
    SENSOR_FAILURE = "SENSOR_FAILURE"

class ParkingScenario(str, Enum):
    PARKING_AVAILABLE = "PARKING_AVAILABLE"
    NEARLY_FULL = "NEARLY_FULL"

_SCENARIO_SEEDS = {
    CrowdingScenario.LOW: 1001,
    CrowdingScenario.MODERATE: 1002,
    CrowdingScenario.HIGH: 1003,
    CrowdingScenario.VERY_HIGH: 1004,
    CrowdingScenario.STALE_DATA: 1005,
    CrowdingScenario.MISSING_DATA: 1006,
    CrowdingScenario.SENSOR_FAILURE: 1007,
    ParkingScenario.PARKING_AVAILABLE: 2001,
    ParkingScenario.NEARLY_FULL: 2002,
}

_CROWD_RATIO_CENTER = {
    CrowdingScenario.LOW: 0.30,
    CrowdingScenario.MODERATE: 0.62,
    CrowdingScenario.HIGH: 0.82,
    CrowdingScenario.VERY_HIGH: 0.97,
}

SCENARIOS = [s.value for s in CrowdingScenario] + [s.value for s in ParkingScenario]

def list_scenarios() -> list[str]:
    return list(SCENARIOS)

def _rng(scenario) -> random.Random:
    return random.Random(_SCENARIO_SEEDS[scenario])

def simulate_crowding(
    scenario: CrowdingScenario,
    *,
    transport_id: str = "veh-001",
    route_id: str = "route-42",
    estimated_capacity: int = 60,
    now: datetime | None = None,
    crowding_thresholds: CrowdingThresholds = DEFAULT_CROWDING_THRESHOLDS,
    freshness_thresholds: FreshnessThresholds = DEFAULT_FRESHNESS_THRESHOLDS,
) -> CrowdingObservation:
    if now is None:
        now = DEMO_NOW
    rng = _rng(scenario)

    if scenario in _CROWD_RATIO_CENTER:
        center = _CROWD_RATIO_CENTER[scenario]

        ratio = center + rng.uniform(-0.03, 0.03)
        ratio = max(0.0, min(1.0, ratio))
        count = round(ratio * estimated_capacity)
        return build_crowding_observation(
            transport_id=transport_id,
            route_id=route_id,
            passenger_count=count,
            estimated_capacity=estimated_capacity,
            timestamp=now - timedelta(seconds=rng.randint(2, 20)),
            source=DataSource.DEMO,
            confidence=0.90 + rng.uniform(0.0, 0.05),
            now=now,
            crowding_thresholds=crowding_thresholds,
            freshness_thresholds=freshness_thresholds,
        )

    if scenario == CrowdingScenario.STALE_DATA:

        stale_age = freshness_thresholds.fresh_max_seconds + 30
        count = round(0.55 * estimated_capacity)
        return build_crowding_observation(
            transport_id=transport_id,
            route_id=route_id,
            passenger_count=count,
            estimated_capacity=estimated_capacity,
            timestamp=now - timedelta(seconds=stale_age),
            source=DataSource.DEMO,
            confidence=0.80,
            now=now,
            crowding_thresholds=crowding_thresholds,
            freshness_thresholds=freshness_thresholds,
        )

    if scenario == CrowdingScenario.MISSING_DATA:
        return build_crowding_observation(
            transport_id=transport_id,
            route_id=route_id,
            passenger_count=None,
            estimated_capacity=estimated_capacity,
            timestamp=now - timedelta(seconds=10),
            source=DataSource.UNAVAILABLE,
            confidence=0.0,
            now=now,
            crowding_thresholds=crowding_thresholds,
            freshness_thresholds=freshness_thresholds,
        )

    if scenario == CrowdingScenario.SENSOR_FAILURE:

        too_old = freshness_thresholds.stale_max_seconds + 60
        return build_crowding_observation(
            transport_id=transport_id,
            route_id=route_id,
            passenger_count=None,
            estimated_capacity=estimated_capacity,
            timestamp=now - timedelta(seconds=too_old),
            source=DataSource.UNAVAILABLE,
            confidence=0.0,
            now=now,
            crowding_thresholds=crowding_thresholds,
            freshness_thresholds=freshness_thresholds,
        )

    raise ValueError(f"unknown crowding scenario: {scenario}")

def simulate_parking(
    scenario: ParkingScenario,
    *,
    parking_id: str = "lot-central",
    name: str = "Central Deck",
    now: datetime | None = None,
    freshness_thresholds: FreshnessThresholds = DEFAULT_FRESHNESS_THRESHOLDS,
) -> Parking:
    if now is None:
        now = DEMO_NOW
    rng = _rng(scenario)
    total = 500

    if scenario == ParkingScenario.PARKING_AVAILABLE:
        available = rng.randint(180, 260)
    elif scenario == ParkingScenario.NEARLY_FULL:
        available = rng.randint(3, 18)
    else:
        raise ValueError(f"unknown parking scenario: {scenario}")

    age = rng.randint(5, 25)
    return Parking(
        parking_id=parking_id,
        name=name,
        lat=40.7128,
        lon=-74.0060,
        available_spaces=available,
        total_spaces=total,
        distance_to_destination_m=350.0,
        walking_minutes=4.5,
        price=6.0,
        source=DataSource.DEMO,
        timestamp=now - timedelta(seconds=age),
        freshness=Freshness.FRESH,
    )

def build_scenario_bundle(
    crowding_scenario: CrowdingScenario = CrowdingScenario.MODERATE,
    parking_scenario: ParkingScenario = ParkingScenario.PARKING_AVAILABLE,
    *,
    now: datetime | None = None,
) -> dict:
    return {
        "crowding": simulate_crowding(crowding_scenario, now=now),
        "parking": simulate_parking(parking_scenario, now=now),
    }
