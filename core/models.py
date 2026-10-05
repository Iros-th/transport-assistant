from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from core.enums import CrowdingLevel, DataSource, Freshness, TransportMode

@dataclass(frozen=True)
class CrowdingObservation:

    transport_id: str
    route_id: str
    timestamp: Optional[datetime]
    passenger_count: Optional[int]
    estimated_capacity: int
    occupancy_ratio: Optional[float]
    crowding_score: Optional[float]
    crowding_level: CrowdingLevel
    source: DataSource
    confidence: float
    freshness: Freshness
    age_seconds: Optional[float]

@dataclass(frozen=True)
class Parking:

    parking_id: str
    name: str
    lat: float
    lon: float
    available_spaces: Optional[int]
    total_spaces: int
    distance_to_destination_m: float
    walking_minutes: float
    price: Optional[float]
    source: DataSource
    timestamp: Optional[datetime]
    freshness: Freshness

    @property
    def occupancy_fraction(self) -> Optional[float]:
        if self.available_spaces is None or self.total_spaces <= 0:
            return None
        taken = self.total_spaces - self.available_spaces
        return max(0.0, min(1.0, taken / self.total_spaces))

@dataclass(frozen=True)
class ScoreComponents:

    time: float
    walk: float
    crowd: float
    park: float
    uncertainty: float
    raw: dict = field(default_factory=dict)

@dataclass(frozen=True)
class JourneyCandidate:

    candidate_id: str
    mode: TransportMode
    total_time_minutes: float
    walking_minutes: float
    crowding: Optional[CrowdingObservation]
    parking: Optional[Parking]
    description: str = ""

    score: Optional[float] = None
    components: Optional[ScoreComponents] = None
    explanation: str = ""
