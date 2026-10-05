from __future__ import annotations

from enum import Enum

class CrowdingLevel(str, Enum):

    LOW = "LOW"
    MODERATE = "MODERATE"
    HIGH = "HIGH"
    VERY_HIGH = "VERY_HIGH"
    UNKNOWN = "UNKNOWN"

class DataSource(str, Enum):

    LIVE = "LIVE"
    DEMO = "DEMO"
    MOCK = "MOCK"
    UNAVAILABLE = "UNAVAILABLE"

class Freshness(str, Enum):

    FRESH = "FRESH"
    STALE = "STALE"
    UNAVAILABLE = "UNAVAILABLE"

class TransportMode(str, Enum):

    DRIVE = "DRIVE"
    DRIVE_PARK = "DRIVE+PARK"
    PARK_WALK = "PARK+WALK"
    PARK_TRANSIT = "PARK+TRANSIT"
    TRANSIT_ONLY = "TRANSIT_ONLY"
