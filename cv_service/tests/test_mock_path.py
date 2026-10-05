from __future__ import annotations

from cv_service.providers.mock import MockCounter
from cv_service.schema import Signal, Source

def test_health_reports_mock_mode(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["force_mock"] is True
    assert body["people_mode"] == "MOCK"
    assert body["cars_mode"] == "MOCK"

def test_people_upload_returns_mock(client, png_bytes):
    r = client.post(
        "/count/upload",
        data={"signal": "people", "capacity": 60},
        files={"file": ("frame.png", png_bytes, "image/png")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "MOCK"
    assert body["signal"] == "people"
    assert body["count"] == body["class_counts"]["person"]
    assert body["class_counts"]["car"] == 0
    assert body["capacity"] == 60

def test_cars_upload_returns_mock(client, png_bytes):
    r = client.post(
        "/count/upload",
        data={"signal": "cars"},
        files={"file": ("lot.png", png_bytes, "image/png")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "MOCK"
    assert body["signal"] == "cars"
    assert body["count"] == body["class_counts"]["car"]

def test_mock_is_deterministic(png_bytes):
    c = MockCounter(Signal.PEOPLE)
    a = c.count(png_bytes)
    b = c.count(png_bytes)
    assert a.count == b.count
    assert a.source is Source.MOCK
