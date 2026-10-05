from __future__ import annotations

REQUIRED_KEYS = {
    "count",
    "class_counts",
    "confidence",
    "model",
    "source",
    "signal",
    "capacity",
    "timestamp",
    "latency_ms",
}

def test_response_has_exact_contract(client, png_bytes):
    r = client.post(
        "/count/upload",
        data={"signal": "people", "capacity": 50},
        files={"file": ("frame.png", png_bytes, "image/png")},
    )
    assert r.status_code == 200
    body = r.json()

    assert set(body.keys()) == REQUIRED_KEYS

    assert isinstance(body["count"], int) and body["count"] >= 0
    assert set(body["class_counts"].keys()) == {"person", "car"}
    assert 0.0 <= body["confidence"] <= 1.0
    assert body["source"] in {"LIVE", "MOCK"}
    assert body["signal"] in {"people", "cars"}
    assert isinstance(body["latency_ms"], (int, float)) and body["latency_ms"] >= 0
    assert isinstance(body["model"], str) and body["model"]

    from datetime import datetime

    datetime.fromisoformat(body["timestamp"])

def test_empty_payload_rejected(client):
    r = client.post(
        "/count/upload",
        data={"signal": "cars"},
        files={"file": ("empty.png", b"", "image/png")},
    )
    assert r.status_code == 400

def test_bad_signal_rejected(client, png_bytes):
    r = client.post(
        "/count/upload",
        data={"signal": "aliens"},
        files={"file": ("frame.png", png_bytes, "image/png")},
    )
    assert r.status_code == 422

def test_count_by_path_missing_file(client):
    r = client.post("/count", json={"signal": "people", "image_path": "/no/such.png"})
    assert r.status_code == 404

def test_count_by_path_requires_path(client):
    r = client.post("/count", json={"signal": "people"})
    assert r.status_code == 400
