"""Deterministic demo data: same seed/scenario -> identical output."""
from core.enums import CrowdingLevel, DataSource, Freshness
from simulation.scenarios import (
    CrowdingScenario,
    ParkingScenario,
    simulate_crowding,
    simulate_parking,
)


def test_crowding_scenarios_hit_expected_levels():
    assert simulate_crowding(CrowdingScenario.LOW).crowding_level == CrowdingLevel.LOW
    assert simulate_crowding(CrowdingScenario.MODERATE).crowding_level == CrowdingLevel.MODERATE
    assert simulate_crowding(CrowdingScenario.HIGH).crowding_level == CrowdingLevel.HIGH
    assert simulate_crowding(CrowdingScenario.VERY_HIGH).crowding_level == CrowdingLevel.VERY_HIGH


def test_stale_scenario_is_stale():
    obs = simulate_crowding(CrowdingScenario.STALE_DATA)
    assert obs.freshness == Freshness.STALE
    assert obs.passenger_count is not None  # count exists but is aged


def test_missing_and_sensor_failure_are_unavailable():
    for sc in (CrowdingScenario.MISSING_DATA, CrowdingScenario.SENSOR_FAILURE):
        obs = simulate_crowding(sc)
        assert obs.passenger_count is None
        assert obs.source == DataSource.UNAVAILABLE
        assert obs.crowding_level == CrowdingLevel.UNKNOWN


def test_determinism_crowding():
    for sc in CrowdingScenario:
        a = simulate_crowding(sc)
        b = simulate_crowding(sc)
        assert a == b  # frozen dataclasses compare by value


def test_determinism_parking():
    for sc in ParkingScenario:
        assert simulate_parking(sc) == simulate_parking(sc)


def test_parking_scenarios_availability():
    avail = simulate_parking(ParkingScenario.PARKING_AVAILABLE)
    full = simulate_parking(ParkingScenario.NEARLY_FULL)
    assert avail.available_spaces > full.available_spaces
    assert full.occupancy_fraction > 0.9


def test_demo_source_labeled():
    assert simulate_crowding(CrowdingScenario.LOW).source == DataSource.DEMO
    assert simulate_parking(ParkingScenario.NEARLY_FULL).source == DataSource.DEMO
