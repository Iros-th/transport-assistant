from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from core.enums import CrowdingLevel, DataSource, Freshness
from core.freshness import (
    DEFAULT_FRESHNESS_THRESHOLDS,
    FreshnessThresholds,
    classify_freshness,
)
from core.models import CrowdingObservation

@dataclass(frozen=True)
class CrowdingThresholds:

    low_max: float = 0.50
    moderate_max: float = 0.75
    high_max: float = 0.90

    def __post_init__(self) -> None:
        if not (0.0 < self.low_max < self.moderate_max < self.high_max <= 1.0):
            raise ValueError(
                "crowding thresholds must satisfy "
                "0 < low_max < moderate_max < high_max <= 1 "
                f"(got {self.low_max}, {self.moderate_max}, {self.high_max})"
            )

DEFAULT_CROWDING_THRESHOLDS = CrowdingThresholds()

def occupancy_ratio(passenger_count: int, estimated_capacity: int) -> float:
    if passenger_count < 0:
        raise ValueError(f"passenger_count must be non-negative, got {passenger_count}")
    if estimated_capacity <= 0:
        raise ValueError(f"estimated_capacity must be positive, got {estimated_capacity}")
    return passenger_count / estimated_capacity

def crowding_score_for_ratio(ratio: float) -> float:
    if ratio < 0.0:
        return 0.0
    if ratio > 1.0:
        return 1.0
    return ratio

def crowding_level_for_ratio(
    score: float,
    thresholds: CrowdingThresholds = DEFAULT_CROWDING_THRESHOLDS,
) -> CrowdingLevel:
    if score < thresholds.low_max:
        return CrowdingLevel.LOW
    if score < thresholds.moderate_max:
        return CrowdingLevel.MODERATE
    if score < thresholds.high_max:
        return CrowdingLevel.HIGH
    return CrowdingLevel.VERY_HIGH

def _age_seconds(timestamp: datetime, now: datetime) -> float:
    return (now - timestamp).total_seconds()

def build_crowding_observation(
    *,
    transport_id: str,
    route_id: str,
    passenger_count: int | None,
    estimated_capacity: int,
    timestamp: datetime | None,
    source: DataSource,
    confidence: float,
    now: datetime | None = None,
    crowding_thresholds: CrowdingThresholds = DEFAULT_CROWDING_THRESHOLDS,
    freshness_thresholds: FreshnessThresholds = DEFAULT_FRESHNESS_THRESHOLDS,
) -> CrowdingObservation:
    if now is None:
        now = datetime.now(timezone.utc)
    if not (0.0 <= confidence <= 1.0):
        raise ValueError(f"confidence must be in [0, 1], got {confidence}")

    data_missing = passenger_count is None or source == DataSource.UNAVAILABLE

    if data_missing or timestamp is None:
        age = None if timestamp is None else _age_seconds(timestamp, now)
        freshness = Freshness.UNAVAILABLE
        return CrowdingObservation(
            transport_id=transport_id,
            route_id=route_id,
            timestamp=timestamp,
            passenger_count=passenger_count,
            estimated_capacity=estimated_capacity,
            occupancy_ratio=None,
            crowding_score=None,
            crowding_level=CrowdingLevel.UNKNOWN,
            source=DataSource.UNAVAILABLE if data_missing else source,
            confidence=0.0 if data_missing else confidence,
            freshness=freshness,
            age_seconds=age,
        )

    age = _age_seconds(timestamp, now)
    freshness = classify_freshness(age, freshness_thresholds)
    ratio = occupancy_ratio(passenger_count, estimated_capacity)
    score = crowding_score_for_ratio(ratio)
    level = crowding_level_for_ratio(score, crowding_thresholds)

    if freshness == Freshness.UNAVAILABLE:
        level = CrowdingLevel.UNKNOWN

    return CrowdingObservation(
        transport_id=transport_id,
        route_id=route_id,
        timestamp=timestamp,
        passenger_count=passenger_count,
        estimated_capacity=estimated_capacity,
        occupancy_ratio=ratio,
        crowding_score=score,
        crowding_level=level,
        source=source,
        confidence=confidence,
        freshness=freshness,
        age_seconds=age,
    )
