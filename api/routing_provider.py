"""Real routing provider using Photon, OSRM, and Transitous APIs."""

from __future__ import annotations

import hashlib
import random
from datetime import datetime, time, timedelta
from typing import Optional, Tuple, Dict, Any, List

import httpx

from core.enums import DataSource, Freshness, TransportMode
from core.models import CrowdingObservation, Parking, JourneyCandidate
from api.demo_ui import (
    DEMO_NOW,
    TripPrefs,
    _rng,
    _norm,
    _bias,
    _clamp,
    _trip_world,
    _crowding_out,
    _parking_out,
    _explain_da,
    MODE_LABELS,
    FACTOR_LABELS,
    WEIGHTS,
    CROWD_TOLERANCE_MAX,
    DEMO_LABEL,
    AS_OF,
    LINES,
    LOTS,
    LOT_SPACES,
)
from api.planning import GeoPoint, build_candidates
from core.scoring import rank_candidates, ScoringWeights


class RealRoutingProvider:
    """Provider that fetches real routing data and computes simulated fill scores."""

    def __init__(self, timeout_seconds: float = 8.0):
        self.timeout_seconds = timeout_seconds
        self._geocode_cache: Dict[str, Tuple[float, float]] = {}
        self._osrm_cache: Dict[str, Dict[str, Any]] = {}
        self._transitous_cache: Dict[str, Dict[str, Any]] = {}

    def _geocode(self, query: str) -> Optional[Tuple[float, float]]:
        """Geocode a query string using Photon API."""
        key = _norm(query).lower()
        if key in self._geocode_cache:
            return self._geocode_cache[key]

        url = "https://photon.komoot.io/api/"
        params = {
            "q": query,
            "limit": 5,
            "lat": 55.68,
            "lon": 12.57,
        }
        try:
            with httpx.Client(timeout=self.timeout_seconds) as client:
                resp = client.get(url, params=params)
                resp.raise_for_status()
                data = resp.json()
                if data["features"]:
                    props = data["features"][0]["properties"]
                    lat = props.get("lat")
                    lon = props.get("lon")
                    if lat is not None and lon is not None:
                        self._geocode_cache[key] = (lat, lon)
                        return lat, lon
        except (httpx.HTTPError, KeyError, ValueError):
            pass
        return None

    def _osrm_route(self, start: Tuple[float, float], end: Tuple[float, float]) -> Optional[Dict[str, Any]]:
        """Get driving route from OSRM."""
        key = f"{start[0]},{start[1]};{end[0]},{end[1]}"
        if key in self._osrm_cache:
            return self._osrm_cache[key]

        url = f"http://router.project-osrm.org/route/v1/driving/{key}"
        params = {
            "overview": "full",
            "geometries": "geojson",
        }
        try:
            with httpx.Client(timeout=self.timeout_seconds) as client:
                resp = client.get(url, params=params)
                resp.raise_for_status()
                data = resp.json()
                if data["routes"]:
                    route = data["routes"][0]
                    self._osrm_cache[key] = route
                    return route
        except (httpx.HTTPError, KeyError, ValueError):
            pass
        return None

    def _transitous_plan(self, start: Tuple[float, float], end: Tuple[float, float],
                         dt: datetime) -> Optional[Dict[str, Any]]:
        """Get transit plan from Transitous/MOTIS."""
        key = f"{start[0]},{start[1]};{end[0]},{end[1]};{dt.isoformat()}"
        if key in self._transitous_cache:
            return self._transitous_cache[key]

        url = "https://api.transitous.org/api/v5/plan"
        params = {
            "fromPlace": f"{start[0]},{start[1]}",
            "toPlace": f"{end[0]},{end[1]}",
            "time": dt.isoformat(),
        }
        headers = {
            "User-Agent": "TransportAssistant/1.0",
        }
        try:
            with httpx.Client(timeout=self.timeout_seconds) as client:
                resp = client.get(url, params=params, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                self._transitous_cache[key] = data
                return data
        except (httpx.HTTPError, KeyError, ValueError):
            pass
        return None

    def _transit_fill_score(self, line: str, stop: str, hour: int, weekday: int) -> float:
        """Compute simulated fill score for a transit leg."""
        seed = f"{line}|{stop}|{hour}|{weekday}"
        rng = _rng(seed)
        return rng.random() * 100.0

    def _parking_consistency_score(self, destination: str, hour: int, weekday: int) -> float:
        """Compute simulated parking consistency (low variance -> high score)."""
        seed_base = f"{destination}|{hour}|{weekday}"
        rng_base = _rng(seed_base)
        # We'll take 4 samples across the hour (every 15 minutes)
        seeds = [f"{destination}|{hour}|{weekday}|{m}" for m in range(0, 60, 15)]
        scores = [_rng(s).random() * 100.0 for s in seeds]
        # Variance of the scores
        mean = sum(scores) / len(scores)
        variance = sum((x - mean) ** 2 for x in scores) / len(scores)
        # Consistency is inversely related to variance: we want a score where low variance -> high consistency
        # We'll map variance to [0, 100] where 0 variance -> 100 consistency, high variance -> 0
        # We'll clip variance to [0, 2500] (since scores are 0-100, max variance is 2500)
        consistency = max(0.0, 100.0 - (variance / 2500.0) * 100.0)
        return consistency

    def _get_copenhagen_time(self, time_of_day: str) -> datetime:
        """Get the current date in Copenhagen with hour set based on time_of_day."""
        # We'll use UTC+1 for simplicity (Copenhagen is UTC+1 in winter, UTC+2 in summer)
        # We'll ignore DST for now and use UTC+1.
        utc_now = datetime.utcnow()
        # Offset to Copenhagen time: +1 hour
        copenhagen_time = utc_now + timedelta(hours=1)
        date = copenhagen_time.date()
        if time_of_day == "RUSH":
            # Morning rush: 8:00
            t = time(8, 0)
        else:  # OFFPEAK
            t = time(10, 0)
        return datetime.combine(date, t)
