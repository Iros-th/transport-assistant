from __future__ import annotations

from dataclasses import dataclass
from math import asin, cos, radians, sin, sqrt
from typing import Optional

from core.enums import TransportMode
from core.models import CrowdingObservation, JourneyCandidate, Parking

_DRIVE_SPEED_KMH = 32.0
_TRANSIT_SPEED_KMH = 22.0
_WALK_SPEED_KMH = 4.8
_PARK_SEARCH_MINUTES = 4.0
_PARK_AND_RIDE_DRIVE_FRACTION = 0.55
_TRANSIT_ACCESS_WALK_MIN = 6.0
_CURBSIDE_WALK_MIN = 1.5

@dataclass(frozen=True)
class GeoPoint:
    lat: float
    lon: float
    name: str = ""

def haversine_km(a: GeoPoint, b: GeoPoint) -> float:
    r = 6371.0
    dlat = radians(b.lat - a.lat)
    dlon = radians(b.lon - a.lon)
    lat1, lat2 = radians(a.lat), radians(b.lat)
    h = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * r * asin(sqrt(h))

def _minutes(distance_km: float, speed_kmh: float) -> float:
    return (distance_km / speed_kmh) * 60.0 if speed_kmh > 0 else 0.0

def build_candidates(
    origin: GeoPoint,
    destination: GeoPoint,
    crowding: Optional[CrowdingObservation],
    parking: Optional[Parking],
    *,
    modes: Optional[list[TransportMode]] = None,
) -> list[JourneyCandidate]:
    if modes is None:
        modes = list(TransportMode)

    dist_km = haversine_km(origin, destination)
    drive_min = _minutes(dist_km, _DRIVE_SPEED_KMH)
    transit_min = _minutes(dist_km, _TRANSIT_SPEED_KMH)

    park_walk_min = parking.walking_minutes if parking is not None else 5.0

    candidates: list[JourneyCandidate] = []

    for mode in modes:
        if mode == TransportMode.DRIVE:
            total = drive_min + _PARK_SEARCH_MINUTES
            walk = _CURBSIDE_WALK_MIN
            crowd_obs = None
            park_opt = None
            desc = "Drive door-to-door and find street parking on arrival."
        elif mode == TransportMode.DRIVE_PARK:
            total = drive_min + _PARK_SEARCH_MINUTES + park_walk_min
            walk = park_walk_min
            crowd_obs = None
            park_opt = parking
            desc = "Drive to a parking facility near the destination, then walk in."
        elif mode == TransportMode.PARK_WALK:

            total = drive_min * 0.9 + park_walk_min + 3.0
            walk = park_walk_min + 3.0
            crowd_obs = None
            park_opt = parking
            desc = "Park a short distance away and walk the remainder."
        elif mode == TransportMode.PARK_TRANSIT:
            drive_leg = drive_min * _PARK_AND_RIDE_DRIVE_FRACTION
            transit_leg = transit_min * (1 - _PARK_AND_RIDE_DRIVE_FRACTION)
            total = drive_leg + transit_leg + _TRANSIT_ACCESS_WALK_MIN
            walk = _TRANSIT_ACCESS_WALK_MIN
            crowd_obs = crowding
            park_opt = parking
            desc = "Drive to a park-and-ride, then take transit the rest of the way."
        elif mode == TransportMode.TRANSIT_ONLY:
            total = transit_min + _TRANSIT_ACCESS_WALK_MIN
            walk = _TRANSIT_ACCESS_WALK_MIN
            crowd_obs = crowding
            park_opt = None
            desc = "Take transit the whole way from origin to destination."
        else:
            continue

        candidates.append(
            JourneyCandidate(
                candidate_id=mode.value,
                mode=mode,
                total_time_minutes=round(total, 1),
                walking_minutes=round(walk, 1),
                crowding=crowd_obs,
                parking=park_opt,
                description=desc,
            )
        )

    return candidates
