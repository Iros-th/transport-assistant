"""Occupancy math and crowding threshold boundaries."""
import math
from datetime import datetime, timezone

import pytest

from core.enums import CrowdingLevel, DataSource, Freshness
from core.occupancy import (
    CrowdingThresholds,
    build_crowding_observation,
    crowding_level_for_ratio,
    crowding_score_for_ratio,
    occupancy_ratio,
)

NOW = datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)


def test_occupancy_ratio_basic():
    assert occupancy_ratio(30, 60) == 0.5
    assert occupancy_ratio(0, 60) == 0.0
    assert occupancy_ratio(90, 60) == 1.5  # over capacity is allowed, unclamped


def test_occupancy_ratio_rejects_bad_inputs():
    with pytest.raises(ValueError):
        occupancy_ratio(-1, 60)
    with pytest.raises(ValueError):
        occupancy_ratio(10, 0)
    with pytest.raises(ValueError):
        occupancy_ratio(10, -5)


def test_crowding_score_clamps():
    assert crowding_score_for_ratio(-0.2) == 0.0
    assert crowding_score_for_ratio(0.0) == 0.0
    assert crowding_score_for_ratio(0.63) == 0.63
    assert crowding_score_for_ratio(1.0) == 1.0
    assert crowding_score_for_ratio(1.5) == 1.0


@pytest.mark.parametrize(
    "score, expected",
    [
        (0.0, CrowdingLevel.LOW),
        (0.49, CrowdingLevel.LOW),
        (0.4999, CrowdingLevel.LOW),
        (0.50, CrowdingLevel.MODERATE),   # boundary: exactly low_max -> MODERATE
        (0.74, CrowdingLevel.MODERATE),
        (0.75, CrowdingLevel.HIGH),       # boundary: exactly moderate_max -> HIGH
        (0.89, CrowdingLevel.HIGH),
        (0.90, CrowdingLevel.VERY_HIGH),  # boundary: exactly high_max -> VERY_HIGH
        (1.0, CrowdingLevel.VERY_HIGH),
    ],
)
def test_crowding_level_boundaries(score, expected):
    assert crowding_level_for_ratio(score) == expected


def test_configurable_thresholds_shift_boundaries():
    strict = CrowdingThresholds(low_max=0.3, moderate_max=0.5, high_max=0.7)
    assert crowding_level_for_ratio(0.35, strict) == CrowdingLevel.MODERATE
    assert crowding_level_for_ratio(0.29, strict) == CrowdingLevel.LOW
    assert crowding_level_for_ratio(0.7, strict) == CrowdingLevel.VERY_HIGH


def test_invalid_thresholds_rejected():
    with pytest.raises(ValueError):
        CrowdingThresholds(low_max=0.8, moderate_max=0.5, high_max=0.9)  # out of order
    with pytest.raises(ValueError):
        CrowdingThresholds(low_max=0.0, moderate_max=0.5, high_max=0.9)  # low_max must be >0


def test_build_observation_full():
    obs = build_crowding_observation(
        transport_id="b1",
        route_id="r1",
        passenger_count=45,
        estimated_capacity=60,
        timestamp=NOW,
        source=DataSource.LIVE,
        confidence=0.9,
        now=NOW,
    )
    assert math.isclose(obs.occupancy_ratio, 0.75)
    assert obs.crowding_score == 0.75
    assert obs.crowding_level == CrowdingLevel.HIGH
    assert obs.freshness == Freshness.FRESH
    assert obs.age_seconds == 0.0
    assert obs.source == DataSource.LIVE


def test_build_observation_missing_count_is_unknown():
    obs = build_crowding_observation(
        transport_id="b1",
        route_id="r1",
        passenger_count=None,
        estimated_capacity=60,
        timestamp=NOW,
        source=DataSource.UNAVAILABLE,
        confidence=0.0,
        now=NOW,
    )
    assert obs.passenger_count is None
    assert obs.occupancy_ratio is None
    assert obs.crowding_score is None
    assert obs.crowding_level == CrowdingLevel.UNKNOWN
    assert obs.freshness == Freshness.UNAVAILABLE
    assert obs.source == DataSource.UNAVAILABLE
    assert obs.confidence == 0.0


def test_build_observation_aged_out_is_unknown_level():
    old = datetime(2026, 9, 29, 11, 55, 0, tzinfo=timezone.utc)  # 5 min old
    obs = build_crowding_observation(
        transport_id="b1",
        route_id="r1",
        passenger_count=45,
        estimated_capacity=60,
        timestamp=old,
        source=DataSource.LIVE,
        confidence=0.9,
        now=NOW,
    )
    # Numbers reported, but level not trusted as current.
    assert obs.occupancy_ratio == 0.75
    assert obs.freshness == Freshness.UNAVAILABLE
    assert obs.crowding_level == CrowdingLevel.UNKNOWN


def test_build_observation_rejects_bad_confidence():
    with pytest.raises(ValueError):
        build_crowding_observation(
            transport_id="b1", route_id="r1", passenger_count=10,
            estimated_capacity=60, timestamp=NOW, source=DataSource.LIVE,
            confidence=1.5, now=NOW,
        )
