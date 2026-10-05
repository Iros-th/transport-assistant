from __future__ import annotations

from cv_service.providers.base import Counter, CountResult
from cv_service.schema import Signal, Source

class MockCounter(Counter):

    name = "mock"

    def __init__(self, signal: Signal) -> None:
        self.signal = signal

    def count(self, image_bytes: bytes, capacity: int | None = None) -> CountResult:
        if self.signal is Signal.PEOPLE:
            people = self._deterministic_count(image_bytes, 0, 60)
            return CountResult(
                count=people,
                class_counts={"person": people, "car": 0},
                confidence=0.50,
                model="mock-people",
                source=Source.MOCK,
                extra={"note": "deterministic stand-in; no model loaded"},
            )

        cars = self._deterministic_count(image_bytes, 0, 40)
        people = self._deterministic_count(image_bytes, 0, 8)
        return CountResult(
            count=cars,
            class_counts={"person": people, "car": cars},
            confidence=0.50,
            model="mock-cars",
            source=Source.MOCK,
            extra={"note": "deterministic stand-in; no model loaded"},
        )
