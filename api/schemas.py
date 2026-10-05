from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from core.models import CrowdingObservation, JourneyCandidate, Parking

class GeoPointIn(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    name: str = ""

class WeightsIn(BaseModel):

    time: float = Field(..., ge=0)
    walk: float = Field(..., ge=0)
    crowd: float = Field(..., ge=0)
    park: float = Field(..., ge=0)
    uncertainty: float = Field(..., ge=0)

class PlanRequest(BaseModel):
    origin: GeoPointIn
    destination: GeoPointIn
    modes: Optional[list[str]] = Field(
        default=None,
        description="Subset of DRIVE, DRIVE+PARK, PARK+WALK, PARK+TRANSIT, "
        "TRANSIT_ONLY. Omit for all modes.",
    )
    weights: Optional[WeightsIn] = None

    demo: bool = Field(
        default=True,
        description="If true, crowding/parking come from the deterministic "
        "simulation (labelled DEMO). If false, the configured live provider is "
        "used, degrading to MOCK/UNAVAILABLE when the CV service is down.",
    )
    crowding_scenario: Optional[str] = None
    parking_scenario: Optional[str] = None
    estimated_capacity: int = Field(default=60, gt=0)
    time_of_day: str = Field(
        default="OFFPEAK",
        description="Time of day for routing and fill scores: OFFPEAK or RUSH.",
    )
    priority: Optional[str] = Field(
        default=None,
        description="Priority for ranking: 'Sikker parkering' or 'Mindst fyldt offentlig transport'.",
    )

class ComponentsOut(BaseModel):
    time: float
    walk: float
    crowd: float
    park: float
    uncertainty: float
    raw: dict

class CrowdingOut(BaseModel):
    transport_id: str
    route_id: str
    timestamp: Optional[str]
    passenger_count: Optional[int]
    estimated_capacity: int
    occupancy_ratio: Optional[float]
    crowding_score: Optional[float]
    crowding_level: str
    source: str
    confidence: float
    freshness: str
    age_seconds: Optional[float]

    @classmethod
    def from_domain(cls, obs: CrowdingObservation) -> "CrowdingOut":
        return cls(
            transport_id=obs.transport_id,
            route_id=obs.route_id,
            timestamp=obs.timestamp.isoformat() if obs.timestamp else None,
            passenger_count=obs.passenger_count,
            estimated_capacity=obs.estimated_capacity,
            occupancy_ratio=obs.occupancy_ratio,
            crowding_score=obs.crowding_score,
            crowding_level=obs.crowding_level.value,
            source=obs.source.value,
            confidence=obs.confidence,
            freshness=obs.freshness.value,
            age_seconds=obs.age_seconds,
        )

class ParkingOut(BaseModel):
    parking_id: str
    name: str
    lat: float
    lon: float
    available_spaces: Optional[int]
    total_spaces: int
    distance_to_destination_m: float
    walking_minutes: float
    price: Optional[float]
    source: str
    timestamp: Optional[str]
    freshness: str

    @classmethod
    def from_domain(cls, p: Parking) -> "ParkingOut":
        return cls(
            parking_id=p.parking_id,
            name=p.name,
            lat=p.lat,
            lon=p.lon,
            available_spaces=p.available_spaces,
            total_spaces=p.total_spaces,
            distance_to_destination_m=p.distance_to_destination_m,
            walking_minutes=p.walking_minutes,
            price=p.price,
            source=p.source.value,
            timestamp=p.timestamp.isoformat() if p.timestamp else None,
            freshness=p.freshness.value,
        )

class CandidateOut(BaseModel):
    candidate_id: str
    mode: str
    total_time_minutes: float
    walking_minutes: float
    score: Optional[float]
    components: Optional[ComponentsOut]
    explanation: str
    description: str
    crowding: Optional[CrowdingOut]
    parking: Optional[ParkingOut]

    @classmethod
    def from_domain(cls, c: JourneyCandidate) -> "CandidateOut":
        return cls(
            candidate_id=c.candidate_id,
            mode=c.mode.value,
            total_time_minutes=c.total_time_minutes,
            walking_minutes=c.walking_minutes,
            score=c.score,
            components=(
                ComponentsOut(
                    time=c.components.time,
                    walk=c.components.walk,
                    crowd=c.components.crowd,
                    park=c.components.park,
                    uncertainty=c.components.uncertainty,
                    raw=c.components.raw,
                )
                if c.components is not None
                else None
            ),
            explanation=c.explanation,
            description=c.description,
            crowding=CrowdingOut.from_domain(c.crowding) if c.crowding else None,
            parking=ParkingOut.from_domain(c.parking) if c.parking else None,
        )

class PlanResponse(BaseModel):
    recommended: Optional[CandidateOut]
    candidates: list[CandidateOut]
    data_notes: list[str]
    scoring_convention: str = "lower score is better"
