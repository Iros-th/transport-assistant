"""Freshness classification at the boundaries."""
import pytest

from core.enums import Freshness
from core.freshness import FreshnessThresholds, classify_freshness

T = FreshnessThresholds(fresh_max_seconds=60.0, stale_max_seconds=120.0)


@pytest.mark.parametrize(
    "age, expected",
    [
        (None, Freshness.UNAVAILABLE),
        (-1.0, Freshness.UNAVAILABLE),   # future timestamp / clock skew
        (0.0, Freshness.FRESH),
        (60.0, Freshness.FRESH),         # boundary: exactly fresh_max -> FRESH
        (60.01, Freshness.STALE),
        (120.0, Freshness.STALE),        # boundary: exactly stale_max -> STALE
        (120.01, Freshness.UNAVAILABLE),
        (10000.0, Freshness.UNAVAILABLE),
    ],
)
def test_classify_boundaries(age, expected):
    assert classify_freshness(age, T) == expected


def test_invalid_thresholds():
    with pytest.raises(ValueError):
        FreshnessThresholds(fresh_max_seconds=120, stale_max_seconds=60)  # stale < fresh
    with pytest.raises(ValueError):
        FreshnessThresholds(fresh_max_seconds=-1, stale_max_seconds=60)
