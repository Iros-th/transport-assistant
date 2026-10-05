from __future__ import annotations

from dataclasses import dataclass

from core.enums import Freshness

@dataclass(frozen=True)
class FreshnessThresholds:

    fresh_max_seconds: float = 60.0
    stale_max_seconds: float = 120.0

    def __post_init__(self) -> None:
        if self.fresh_max_seconds < 0 or self.stale_max_seconds < 0:
            raise ValueError("freshness thresholds must be non-negative")
        if self.stale_max_seconds < self.fresh_max_seconds:
            raise ValueError(
                "stale_max_seconds must be >= fresh_max_seconds "
                f"(got fresh={self.fresh_max_seconds}, stale={self.stale_max_seconds})"
            )

DEFAULT_FRESHNESS_THRESHOLDS = FreshnessThresholds()

def classify_freshness(
    age_seconds: float | None,
    thresholds: FreshnessThresholds = DEFAULT_FRESHNESS_THRESHOLDS,
) -> Freshness:
    if age_seconds is None:
        return Freshness.UNAVAILABLE
    if age_seconds < 0:
        return Freshness.UNAVAILABLE
    if age_seconds <= thresholds.fresh_max_seconds:
        return Freshness.FRESH
    if age_seconds <= thresholds.stale_max_seconds:
        return Freshness.STALE
    return Freshness.UNAVAILABLE
