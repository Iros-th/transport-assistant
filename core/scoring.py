from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Iterable

from core.enums import CrowdingLevel, Freshness, TransportMode
from core.models import CrowdingObservation, JourneyCandidate, Parking, ScoreComponents

@dataclass(frozen=True)
class ScoringWeights:

    time: float = 0.40
    walk: float = 0.15
    crowd: float = 0.25
    park: float = 0.10
    uncertainty: float = 0.10

    def __post_init__(self) -> None:
        values = (self.time, self.walk, self.crowd, self.park, self.uncertainty)
        if any(w < 0 for w in values):
            raise ValueError("scoring weights must be non-negative")
        if sum(values) <= 0:
            raise ValueError("scoring weights must not all be zero")

    @property
    def total(self) -> float:
        return self.time + self.walk + self.crowd + self.park + self.uncertainty

    def as_dict(self) -> dict:
        return {
            "time": self.time,
            "walk": self.walk,
            "crowd": self.crowd,
            "park": self.park,
            "uncertainty": self.uncertainty,
        }

@dataclass(frozen=True)
class WalkingPenaltyConfig:

    max_penalty_minutes: float = 20.0

    def __post_init__(self) -> None:
        if self.max_penalty_minutes <= 0:
            raise ValueError("max_penalty_minutes must be positive")

DEFAULT_WEIGHTS = ScoringWeights()
DEFAULT_WALK_CONFIG = WalkingPenaltyConfig()

NEUTRAL_CROWD = 0.5

TRANSIT_MODES = frozenset({TransportMode.TRANSIT_ONLY, TransportMode.PARK_TRANSIT})

CROWD_NOT_APPLICABLE = "not_applicable"
CROWD_AVAILABLE = "available"
CROWD_UNAVAILABLE = "unavailable"

_UNCERT_CROWD_STALE = 0.40
_UNCERT_CROWD_UNAVAILABLE = 0.70
_UNCERT_PARK_STALE = 0.25
_UNCERT_PARK_UNAVAILABLE = 0.40

def walking_penalty(
    walking_minutes: float,
    config: WalkingPenaltyConfig = DEFAULT_WALK_CONFIG,
) -> float:
    if walking_minutes <= 0:
        return 0.0
    return min(walking_minutes / config.max_penalty_minutes, 1.0)

def _crowd_component(
    mode: TransportMode, crowding: CrowdingObservation | None
) -> tuple[float, str]:
    if mode not in TRANSIT_MODES:
        return 0.0, CROWD_NOT_APPLICABLE
    if (
        crowding is None
        or crowding.crowding_score is None
        or crowding.freshness == Freshness.UNAVAILABLE
        or crowding.crowding_level == CrowdingLevel.UNKNOWN
    ):
        return NEUTRAL_CROWD, CROWD_UNAVAILABLE
    return crowding.crowding_score, CROWD_AVAILABLE

def _park_component(mode: TransportMode, parking: Parking | None) -> tuple[float, bool]:
    parking_modes = {
        TransportMode.DRIVE_PARK,
        TransportMode.PARK_WALK,
        TransportMode.PARK_TRANSIT,
    }
    if mode not in parking_modes:
        return 0.0, False
    if parking is None:
        return 1.0, True
    taken = parking.occupancy_fraction
    if taken is None:

        return 0.9, True
    return taken, True

def _uncertainty_component(
    crowding: CrowdingObservation | None,
    crowd_status: str,
    parking: Parking | None,
    parking_relevant: bool,
) -> float:
    penalty = 0.0

    if crowd_status == CROWD_UNAVAILABLE:
        penalty += _UNCERT_CROWD_UNAVAILABLE
    elif crowd_status == CROWD_AVAILABLE:
        assert crowding is not None
        if crowding.freshness == Freshness.STALE:
            penalty += _UNCERT_CROWD_STALE

        penalty += (1.0 - crowding.confidence) * 0.30

    if parking_relevant and parking is not None:
        if parking.freshness == Freshness.UNAVAILABLE:
            penalty += _UNCERT_PARK_UNAVAILABLE
        elif parking.freshness == Freshness.STALE:
            penalty += _UNCERT_PARK_STALE
    elif parking_relevant and parking is None:
        penalty += _UNCERT_PARK_UNAVAILABLE

    return min(penalty, 1.0)

def _time_component(total_time_minutes: float, time_min: float, time_max: float) -> float:
    if time_max <= time_min:

        return 0.0
    return (total_time_minutes - time_min) / (time_max - time_min)

_FACTOR_LABELS = {
    "time": "travel time",
    "walk": "walking distance",
    "crowd": "crowding",
    "park": "parking availability",
    "uncertainty": "data uncertainty",
}

def _build_explanation(
    mode: TransportMode,
    components: ScoreComponents,
    weights: ScoringWeights,
    crowd_status: str,
) -> str:
    contributions = {
        "time": weights.time * components.time,
        "walk": weights.walk * components.walk,
        "crowd": weights.crowd * components.crowd,
        "park": weights.park * components.park,
        "uncertainty": weights.uncertainty * components.uncertainty,
    }
    ranked = sorted(contributions.items(), key=lambda kv: kv[1], reverse=True)

    dominant = [name for name, value in ranked if value > 1e-9][:2]

    parts: list[str] = [f"{mode.value} option."]

    if dominant:
        labels = [_FACTOR_LABELS[name] for name in dominant]
        if len(labels) == 1:
            parts.append(f"Score driven mainly by {labels[0]}.")
        else:
            parts.append(f"Score driven mainly by {labels[0]} and {labels[1]}.")
    else:
        parts.append("Scores near-ideal across all factors.")

    if crowd_status == CROWD_UNAVAILABLE:
        parts.append(
            "Crowding data is unavailable, which raises the uncertainty penalty; "
            "crowding is not assumed to be low."
        )
    elif crowd_status == CROWD_AVAILABLE:
        if components.crowd < 0.5:
            parts.append("Crowding is low to moderate on live data.")
        elif components.crowd < 0.9:
            parts.append("Crowding is high on live data.")
        else:
            parts.append("Crowding is very high on live data.")

    if components.uncertainty >= 0.4 and crowd_status == CROWD_AVAILABLE:
        parts.append("Some inputs are stale or low-confidence, raising uncertainty.")

    return " ".join(parts)

def score_candidate(
    candidate: JourneyCandidate,
    *,
    time_min: float,
    time_max: float,
    weights: ScoringWeights = DEFAULT_WEIGHTS,
    walk_config: WalkingPenaltyConfig = DEFAULT_WALK_CONFIG,
) -> JourneyCandidate:
    time_c = _time_component(candidate.total_time_minutes, time_min, time_max)
    walk_c = walking_penalty(candidate.walking_minutes, walk_config)
    crowd_c, crowd_status = _crowd_component(candidate.mode, candidate.crowding)
    park_c, parking_relevant = _park_component(candidate.mode, candidate.parking)
    uncert_c = _uncertainty_component(
        candidate.crowding, crowd_status, candidate.parking, parking_relevant
    )

    components = ScoreComponents(
        time=time_c,
        walk=walk_c,
        crowd=crowd_c,
        park=park_c,
        uncertainty=uncert_c,
        raw={
            "total_time_minutes": candidate.total_time_minutes,
            "walking_minutes": candidate.walking_minutes,
            "time_min_minutes": time_min,
            "time_max_minutes": time_max,
            "crowd_status": crowd_status,
            "parking_relevant": parking_relevant,
        },
    )

    weighted_sum = (
        weights.time * time_c
        + weights.walk * walk_c
        + weights.crowd * crowd_c
        + weights.park * park_c
        + weights.uncertainty * uncert_c
    )
    score = weighted_sum / weights.total

    explanation = _build_explanation(candidate.mode, components, weights, crowd_status)

    return replace(
        candidate, score=score, components=components, explanation=explanation
    )

def rank_candidates(
    candidates: Iterable[JourneyCandidate],
    weights: ScoringWeights = DEFAULT_WEIGHTS,
    walk_config: WalkingPenaltyConfig = DEFAULT_WALK_CONFIG,
) -> list[JourneyCandidate]:
    items = list(candidates)
    if not items:
        return []

    times = [c.total_time_minutes for c in items]
    time_min, time_max = min(times), max(times)

    scored = [
        score_candidate(
            c,
            time_min=time_min,
            time_max=time_max,
            weights=weights,
            walk_config=walk_config,
        )
        for c in items
    ]
    scored.sort(key=lambda c: (c.score, c.candidate_id))
    return scored
