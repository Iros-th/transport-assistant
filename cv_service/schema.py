from __future__ import annotations

from enum import Enum
from typing import Dict, Optional

from pydantic import BaseModel, Field

class Signal(str, Enum):

    PEOPLE = "people"
    CARS = "cars"

class Source(str, Enum):

    LIVE = "LIVE"
    MOCK = "MOCK"

class ClassCounts(BaseModel):

    person: int = Field(0, ge=0, description="Number of people detected/estimated.")
    car: int = Field(0, ge=0, description="Number of cars detected.")

class CountRequest(BaseModel):

    signal: Signal = Field(..., description="people | cars")
    image_path: Optional[str] = Field(
        None,
        description=(
            "Server-visible path to an image/frame. Required for /count. "
            "Ignored by /count/upload, which takes the bytes directly."
        ),
    )
    capacity: Optional[int] = Field(
        None,
        ge=1,
        description=(
            "Optional capacity (bus seats+standing, or parking spaces). The "
            "service does not compute occupancy; it passes capacity back "
            "untouched so the backend can derive a ratio itself."
        ),
    )

class CountResponse(BaseModel):

    count: int = Field(..., ge=0, description="Primary count for the requested signal.")
    class_counts: ClassCounts = Field(..., description="Per-class breakdown (person, car).")
    confidence: float = Field(
        ..., ge=0.0, le=1.0, description="Model/heuristic confidence in [0,1]."
    )
    model: str = Field(..., description="Model or estimator that produced the count.")
    source: Source = Field(..., description="LIVE (real inference) or MOCK.")
    signal: Signal = Field(..., description="Echo of the requested signal.")
    capacity: Optional[int] = Field(
        None, description="Echo of the supplied capacity, if any (no image data)."
    )
    timestamp: str = Field(..., description="ISO-8601 UTC time the count was produced.")
    latency_ms: float = Field(..., ge=0.0, description="Inference wall-time in milliseconds.")

class HealthResponse(BaseModel):

    status: str
    version: str
    force_mock: bool
    people_provider: str
    people_mode: Source
    cars_provider: str
    cars_mode: Source
