from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Dict

from cv_service.schema import Source

@dataclass(frozen=True)
class CountResult:

    count: int
    class_counts: Dict[str, int]
    confidence: float
    model: str
    source: Source
    extra: Dict[str, str] = field(default_factory=dict)

class Counter:

    name: str = "base"

    def count(self, image_bytes: bytes, capacity: int | None = None) -> CountResult:
        raise NotImplementedError

    @staticmethod
    def _fingerprint(image_bytes: bytes) -> int:

        digest = hashlib.sha256(image_bytes).digest()
        return int.from_bytes(digest[:4], "big")

    @classmethod
    def _deterministic_count(cls, image_bytes: bytes, low: int, high: int) -> int:

        span = max(1, high - low + 1)
        return low + (cls._fingerprint(image_bytes) % span)
