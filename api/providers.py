from __future__ import annotations

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import httpx

from core.enums import DataSource
from simulation.scenarios import CrowdingScenario, simulate_crowding

DEFAULT_CV_SERVICE_URL = "http://localhost:8800"
DEFAULT_TIMEOUT_SECONDS = 2.5

@dataclass(frozen=True)
class DetectionResult:

    transport_id: str
    route_id: str
    passenger_count: Optional[int]
    capacity: int
    confidence: float
    timestamp: Optional[datetime]
    source: DataSource

class DetectionProvider(ABC):

    @abstractmethod
    def get_detection(
        self,
        transport_id: str,
        route_id: str,
        estimated_capacity: int,
    ) -> DetectionResult:
        ...

class MockDetectionProvider(DetectionProvider):

    def __init__(self, occupancy_fraction: float = 0.5, confidence: float = 0.85) -> None:
        if not (0.0 <= occupancy_fraction <= 1.5):
            raise ValueError("occupancy_fraction out of sane range")
        if not (0.0 <= confidence <= 1.0):
            raise ValueError("confidence must be in [0, 1]")
        self._fraction = occupancy_fraction
        self._confidence = confidence

    def get_detection(
        self, transport_id: str, route_id: str, estimated_capacity: int
    ) -> DetectionResult:
        count = round(self._fraction * estimated_capacity)
        return DetectionResult(
            transport_id=transport_id,
            route_id=route_id,
            passenger_count=count,
            capacity=estimated_capacity,
            confidence=self._confidence,
            timestamp=datetime.now(timezone.utc),
            source=DataSource.MOCK,
        )

class DemoDetectionProvider(DetectionProvider):

    def __init__(self, scenario: CrowdingScenario = CrowdingScenario.MODERATE) -> None:
        self._scenario = scenario

    def get_detection(
        self, transport_id: str, route_id: str, estimated_capacity: int
    ) -> DetectionResult:
        obs = simulate_crowding(
            self._scenario,
            transport_id=transport_id,
            route_id=route_id,
            estimated_capacity=estimated_capacity,
        )
        return DetectionResult(
            transport_id=obs.transport_id,
            route_id=obs.route_id,
            passenger_count=obs.passenger_count,
            capacity=obs.estimated_capacity,
            confidence=obs.confidence,
            timestamp=obs.timestamp,
            source=obs.source,
        )

class RealDetectionProvider(DetectionProvider):

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        fallback: Optional[DetectionProvider] = None,
        image_path: Optional[str] = None,
        client: Optional[httpx.Client] = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("CV_SERVICE_URL", DEFAULT_CV_SERVICE_URL)).rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.fallback = fallback

        self.image_path = image_path if image_path is not None else os.environ.get("CV_IMAGE_PATH")
        self._client = client

    def _fallback_or_unavailable(
        self, transport_id: str, route_id: str, estimated_capacity: int
    ) -> DetectionResult:
        if self.fallback is not None:
            return self.fallback.get_detection(transport_id, route_id, estimated_capacity)
        return DetectionResult(
            transport_id=transport_id,
            route_id=route_id,
            passenger_count=None,
            capacity=estimated_capacity,
            confidence=0.0,
            timestamp=None,
            source=DataSource.UNAVAILABLE,
        )

    def get_detection(
        self, transport_id: str, route_id: str, estimated_capacity: int
    ) -> DetectionResult:

        url = f"{self.base_url}/count"
        payload: dict = {"signal": "people", "capacity": estimated_capacity}
        if self.image_path is not None:
            payload["image_path"] = self.image_path
        try:
            if self._client is not None:
                resp = self._client.post(url, json=payload, timeout=self.timeout_seconds)
            else:
                with httpx.Client(timeout=self.timeout_seconds) as client:
                    resp = client.post(url, json=payload)
        except (httpx.HTTPError, OSError):

            return self._fallback_or_unavailable(transport_id, route_id, estimated_capacity)

        if resp.status_code != 200:
            return self._fallback_or_unavailable(transport_id, route_id, estimated_capacity)

        try:
            body = resp.json()
            count = body["count"]
            confidence = float(body.get("confidence", 0.5))
            capacity = int(body.get("capacity") or estimated_capacity)
        except (ValueError, KeyError, TypeError):
            return self._fallback_or_unavailable(transport_id, route_id, estimated_capacity)

        if count is None:

            return self._fallback_or_unavailable(transport_id, route_id, estimated_capacity)

        timestamp = _parse_timestamp(body.get("timestamp"))

        source = _map_source(body.get("source"))

        return DetectionResult(
            transport_id=transport_id,
            route_id=route_id,
            passenger_count=int(count),
            capacity=capacity,
            confidence=max(0.0, min(1.0, confidence)),
            timestamp=timestamp,
            source=source,
        )

def _map_source(value) -> DataSource:
    if value == DataSource.MOCK.value:
        return DataSource.MOCK
    return DataSource.LIVE

def _parse_timestamp(value) -> Optional[datetime]:
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.now(timezone.utc)
