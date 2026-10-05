"""Route scoring: walking penalty monotonicity, component breakdown,
normalization (no unit-based dominance), and honest crowding handling."""
from datetime import datetime, timezone

import pytest

from core.enums import CrowdingLevel, DataSource, Freshness, TransportMode
from core.models import CrowdingObservation, JourneyCandidate, Parking
from core.occupancy import build_crowding_observation
from core.scoring import (
    DEFAULT_WEIGHTS,
    ScoringWeights,
    WalkingPenaltyConfig,
    rank_candidates,
    score_candidate,
    walking_penalty,
)

NOW = datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)


def _crowd(count, cap=60, source=DataSource.LIVE, conf=0.9, ts=NOW):
    return build_crowding_observation(
        transport_id="v", route_id="r", passenger_count=count,
        estimated_capacity=cap, timestamp=ts, source=source, confidence=conf, now=NOW,
    )


def _parking(available, total=100):
    return Parking(
        parking_id="p", name="P", lat=0.0, lon=0.0, available_spaces=available,
        total_spaces=total, distance_to_destination_m=300.0, walking_minutes=4.0,
        price=5.0, source=DataSource.DEMO, timestamp=NOW, freshness=Freshness.FRESH,
    )


def test_walking_penalty_monotonic_nondecreasing():
    cfg = WalkingPenaltyConfig(max_penalty_minutes=20.0)
    xs = [0, 1, 2, 5, 10, 15, 19.9, 20, 25, 100]
    ys = [walking_penalty(x, cfg) for x in xs]
    for a, b in zip(ys, ys[1:]):
        assert b >= a
    assert ys[0] == 0.0
    assert ys[-1] == 1.0  # saturates at the cap
    assert walking_penalty(10, cfg) == 0.5


def test_walking_penalty_strictly_increases_in_active_range():
    cfg = WalkingPenaltyConfig(max_penalty_minutes=20.0)
    assert walking_penalty(5, cfg) < walking_penalty(10, cfg) < walking_penalty(15, cfg)


def test_score_components_present_and_in_range():
    c = JourneyCandidate(
        candidate_id="t", mode=TransportMode.TRANSIT_ONLY,
        total_time_minutes=30.0, walking_minutes=8.0, crowding=_crowd(30), parking=None,
    )
    scored = score_candidate(c, time_min=30.0, time_max=30.0)
    comp = scored.components
    assert comp is not None
    for v in (comp.time, comp.walk, comp.crowd, comp.park, comp.uncertainty):
        assert 0.0 <= v <= 1.0
    assert 0.0 <= scored.score <= 1.0
    assert scored.explanation


def test_time_component_minmax_normalization():
    # Two candidates identical except travel time; time normalized to 0 and 1.
    fast = JourneyCandidate("f", TransportMode.DRIVE, 10.0, 2.0, None, None)
    slow = JourneyCandidate("s", TransportMode.DRIVE, 40.0, 2.0, None, None)
    ranked = rank_candidates([fast, slow])
    by_id = {c.candidate_id: c for c in ranked}
    assert by_id["f"].components.time == 0.0
    assert by_id["s"].components.time == 1.0
    assert by_id["f"].score < by_id["s"].score  # faster is better


def test_no_component_dominates_by_unit():
    """A huge raw time gap and a full bus must both land within 0..1, so time
    (measured in minutes) cannot swamp crowd (a fraction) just by unit scale."""
    a = JourneyCandidate("a", TransportMode.TRANSIT_ONLY, 5.0, 4.0, _crowd(6), None)     # fast, empty
    b = JourneyCandidate("b", TransportMode.TRANSIT_ONLY, 500.0, 4.0, _crowd(60), None)  # slow, packed
    ranked = rank_candidates([a, b])
    for c in ranked:
        assert 0.0 <= c.components.time <= 1.0
        assert 0.0 <= c.components.crowd <= 1.0
        assert 0.0 <= c.score <= 1.0


def test_crowding_unavailable_raises_uncertainty_and_no_low_claim():
    missing = build_crowding_observation(
        transport_id="v", route_id="r", passenger_count=None, estimated_capacity=60,
        timestamp=NOW, source=DataSource.UNAVAILABLE, confidence=0.0, now=NOW,
    )
    c = JourneyCandidate("t", TransportMode.TRANSIT_ONLY, 30.0, 6.0, missing, None)
    scored = score_candidate(c, time_min=30.0, time_max=30.0)
    # Neutral crowd, not zero (never rewarded as empty).
    assert scored.components.crowd == 0.5
    assert scored.components.uncertainty > 0.0
    assert "unavailable" in scored.explanation.lower()
    assert "not assumed to be low" in scored.explanation.lower()


def test_private_car_has_no_crowd_or_crowd_uncertainty():
    c = JourneyCandidate("d", TransportMode.DRIVE, 20.0, 2.0, None, None)
    scored = score_candidate(c, time_min=20.0, time_max=20.0)
    assert scored.components.crowd == 0.0
    # No crowding sentence, no crowd-driven uncertainty for a private car.
    assert "crowding" not in scored.explanation.lower()
    assert scored.components.uncertainty == 0.0


def test_fuller_parking_scores_worse_than_emptier():
    empty = JourneyCandidate("e", TransportMode.DRIVE_PARK, 20.0, 4.0, None, _parking(90, 100))
    full = JourneyCandidate("x", TransportMode.DRIVE_PARK, 20.0, 4.0, None, _parking(5, 100))
    ranked = rank_candidates([empty, full])
    by_id = {c.candidate_id: c for c in ranked}
    assert by_id["x"].components.park > by_id["e"].components.park
    assert by_id["x"].score > by_id["e"].score


def test_higher_crowding_scores_worse_on_transit():
    quiet = JourneyCandidate("q", TransportMode.TRANSIT_ONLY, 30.0, 6.0, _crowd(12), None)
    packed = JourneyCandidate("p", TransportMode.TRANSIT_ONLY, 30.0, 6.0, _crowd(58), None)
    ranked = rank_candidates([quiet, packed])
    by_id = {c.candidate_id: c for c in ranked}
    assert by_id["p"].score > by_id["q"].score


def test_stale_crowding_adds_uncertainty():
    fresh = JourneyCandidate("f", TransportMode.TRANSIT_ONLY, 30.0, 6.0, _crowd(30), None)
    stale_obs = _crowd(30, ts=datetime(2026, 9, 29, 11, 58, 30, tzinfo=timezone.utc))  # 90s old
    assert stale_obs.freshness == Freshness.STALE
    stale = JourneyCandidate("s", TransportMode.TRANSIT_ONLY, 30.0, 6.0, stale_obs, None)
    sf = score_candidate(fresh, time_min=30, time_max=30)
    ss = score_candidate(stale, time_min=30, time_max=30)
    assert ss.components.uncertainty > sf.components.uncertainty


def test_ranking_deterministic_and_sorted():
    cands = [
        JourneyCandidate("a", TransportMode.DRIVE, 10.0, 2.0, None, None),
        JourneyCandidate("b", TransportMode.TRANSIT_ONLY, 25.0, 6.0, _crowd(50), None),
        JourneyCandidate("c", TransportMode.DRIVE_PARK, 18.0, 5.0, None, _parking(40, 100)),
    ]
    r1 = rank_candidates(cands)
    r2 = rank_candidates(list(reversed(cands)))
    assert [c.candidate_id for c in r1] == [c.candidate_id for c in r2]
    scores = [c.score for c in r1]
    assert scores == sorted(scores)


def test_weights_are_configurable_and_validated():
    with pytest.raises(ValueError):
        ScoringWeights(time=-1, walk=0, crowd=0, park=0, uncertainty=0)
    with pytest.raises(ValueError):
        ScoringWeights(time=0, walk=0, crowd=0, park=0, uncertainty=0)
    w = ScoringWeights(time=1, walk=0, crowd=0, park=0, uncertainty=0)
    # With only time weighted, the fastest candidate must win.
    fast = JourneyCandidate("f", TransportMode.DRIVE, 10.0, 30.0, None, None)  # lots of walking
    slow = JourneyCandidate("s", TransportMode.DRIVE, 40.0, 0.0, None, None)
    ranked = rank_candidates([fast, slow], weights=w)
    assert ranked[0].candidate_id == "f"


def test_empty_candidate_list():
    assert rank_candidates([]) == []
