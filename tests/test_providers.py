"""Detection providers: determinism, privacy contract, and graceful fallback.

The RealDetectionProvider speaks the CV service's `POST /count` contract:
request {signal, capacity, image_path?}, success response
{count, confidence, source (LIVE|MOCK), capacity?, timestamp?, ...}.
"""
import httpx
import pytest

from core.enums import DataSource
from api.providers import (
    DetectionProvider,
    MockDetectionProvider,
    RealDetectionProvider,
)


def test_mock_is_deterministic_and_labeled_mock():
    p = MockDetectionProvider(occupancy_fraction=0.5)
    a = p.get_detection("v1", "r1", 60)
    b = p.get_detection("v1", "r1", 60)
    assert a.passenger_count == b.passenger_count == 30
    assert a.source == DataSource.MOCK


def test_privacy_contract_accepts_only_counts():
    """The interface signature must not accept image/biometric inputs."""
    import inspect

    sig = inspect.signature(DetectionProvider.get_detection)
    params = set(sig.parameters)
    assert params == {"self", "transport_id", "route_id", "estimated_capacity"}
    # And the result carries no per-person / biometric fields.
    result = MockDetectionProvider().get_detection("v", "r", 60)
    forbidden = {"image", "images", "frame", "frames", "faces", "face", "identity",
                 "embeddings", "track_ids", "biometric", "biometrics"}
    assert forbidden.isdisjoint(vars(result).keys())


def _transport_error_client():
    def handler(request):
        raise httpx.ConnectError("service down", request=request)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_real_provider_falls_back_to_mock_when_service_down():
    client = _transport_error_client()
    p = RealDetectionProvider(
        base_url="http://localhost:8800",
        fallback=MockDetectionProvider(occupancy_fraction=0.5),
        client=client,
    )
    result = p.get_detection("v", "r", 60)
    assert result.source == DataSource.MOCK  # honestly labelled, not LIVE
    assert result.passenger_count == 30


def test_real_provider_unavailable_when_down_and_no_fallback():
    client = _transport_error_client()
    p = RealDetectionProvider(base_url="http://localhost:8800", client=client)
    result = p.get_detection("v", "r", 60)
    assert result.source == DataSource.UNAVAILABLE
    assert result.passenger_count is None  # never fabricated


def test_real_provider_posts_count_contract():
    """Verify it hits /count with the people signal and capacity."""
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        import json as _json
        seen["body"] = _json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "count": 42, "class_counts": {"person": 42, "car": 0},
                "confidence": 0.88, "model": "test", "source": "LIVE",
                "signal": "people", "capacity": 60,
                "timestamp": "2026-09-29T12:00:00+00:00", "latency_ms": 5.0,
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    p = RealDetectionProvider(base_url="http://localhost:8800", client=client)
    result = p.get_detection("v", "r", 60)
    assert seen["url"].endswith("/count")
    assert seen["body"]["signal"] == "people"
    assert seen["body"]["capacity"] == 60
    assert result.source == DataSource.LIVE
    assert result.passenger_count == 42
    assert result.confidence == 0.88
    assert result.capacity == 60


def test_real_provider_honors_mock_source_label():
    """A count the service produced in MOCK mode must not be relabelled LIVE."""
    def handler(request):
        return httpx.Response(
            200,
            json={"count": 30, "class_counts": {"person": 30, "car": 0},
                  "confidence": 0.5, "model": "mock", "source": "MOCK",
                  "signal": "people", "capacity": 60,
                  "timestamp": "2026-09-29T12:00:00+00:00", "latency_ms": 1.0},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    p = RealDetectionProvider(base_url="http://localhost:8800", client=client)
    result = p.get_detection("v", "r", 60)
    assert result.source == DataSource.MOCK
    assert result.passenger_count == 30


def test_real_provider_forwards_image_path_when_configured():
    seen = {}

    def handler(request):
        import json as _json
        seen["body"] = _json.loads(request.content)
        return httpx.Response(
            200,
            json={"count": 10, "class_counts": {"person": 10, "car": 0},
                  "confidence": 0.7, "model": "t", "source": "LIVE",
                  "signal": "people", "capacity": 60,
                  "timestamp": "2026-09-29T12:00:00+00:00", "latency_ms": 2.0},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    p = RealDetectionProvider(base_url="http://localhost:8800",
                              image_path="/frames/veh-001.jpg", client=client)
    p.get_detection("v", "r", 60)
    assert seen["body"]["image_path"] == "/frames/veh-001.jpg"


def test_real_provider_null_count_degrades():
    def handler(request):
        return httpx.Response(200, json={"count": None, "confidence": 0.5,
                                         "source": "LIVE", "signal": "people"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    p = RealDetectionProvider(
        base_url="http://localhost:8800",
        fallback=MockDetectionProvider(),
        client=client,
    )
    result = p.get_detection("v", "r", 60)
    assert result.source == DataSource.MOCK  # explicit no-count -> not fabricated as LIVE


def test_real_provider_bad_status_degrades():
    def handler(request):
        return httpx.Response(500, text="boom")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    p = RealDetectionProvider(base_url="http://localhost:8800", client=client)
    result = p.get_detection("v", "r", 60)
    assert result.source == DataSource.UNAVAILABLE


def test_real_provider_malformed_body_degrades():
    def handler(request):
        return httpx.Response(200, text="not json")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    p = RealDetectionProvider(base_url="http://localhost:8800", client=client)
    result = p.get_detection("v", "r", 60)
    assert result.source == DataSource.UNAVAILABLE
