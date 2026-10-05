"""API endpoint behaviour via FastAPI TestClient."""
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)

PLAN_BODY = {
    "origin": {"lat": 40.70, "lon": -74.01, "name": "A"},
    "destination": {"lat": 40.75, "lon": -73.99, "name": "B"},
    "demo": True,
}


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_scenarios_lists_all():
    r = client.get("/scenarios")
    assert r.status_code == 200
    body = r.json()
    assert "MISSING_DATA" in body["crowding"]
    assert "NEARLY_FULL" in body["parking"]


def test_plan_returns_ranked_scored_explained():
    r = client.post("/plan", json={**PLAN_BODY, "crowding_scenario": "HIGH"})
    assert r.status_code == 200
    body = r.json()
    assert body["recommended"] is not None
    assert body["scoring_convention"] == "lower score is better"
    scores = [c["score"] for c in body["candidates"]]
    assert scores == sorted(scores)  # best-first
    for c in body["candidates"]:
        assert c["components"] is not None
        assert c["explanation"]
        assert 0.0 <= c["score"] <= 1.0


def test_plan_labels_data_sources_in_demo():
    r = client.post("/plan", json=PLAN_BODY)
    body = r.json()
    # Demo crowding must be labelled DEMO, never LIVE.
    transit = [c for c in body["candidates"] if c["crowding"] is not None]
    assert transit
    assert all(c["crowding"]["source"] == "DEMO" for c in transit)
    assert any("Demo mode" in n for n in body["data_notes"])


def test_plan_missing_data_never_claims_low_crowding():
    r = client.post("/plan", json={**PLAN_BODY, "crowding_scenario": "SENSOR_FAILURE"})
    body = r.json()
    transit = [c for c in body["candidates"] if c["mode"] in ("TRANSIT_ONLY", "PARK+TRANSIT")]
    assert transit
    for c in transit:
        assert "unavailable" in c["explanation"].lower()
        assert c["crowding"]["crowding_level"] == "UNKNOWN"


def test_plan_rejects_unknown_mode():
    r = client.post("/plan", json={**PLAN_BODY, "modes": ["FLY"]})
    assert r.status_code == 400


def test_plan_rejects_unknown_scenario():
    r = client.post("/plan", json={**PLAN_BODY, "crowding_scenario": "NOPE"})
    assert r.status_code == 400


def test_plan_custom_weights_change_ranking():
    # Weight only crowding: with a packed bus, transit modes should rank worst.
    body = {
        **PLAN_BODY,
        "crowding_scenario": "VERY_HIGH",
        "weights": {"time": 0, "walk": 0, "crowd": 1, "park": 0, "uncertainty": 0},
    }
    r = client.post("/plan", json=body)
    assert r.status_code == 200
    cands = r.json()["candidates"]
    worst = cands[-1]["mode"]
    assert worst in ("TRANSIT_ONLY", "PARK+TRANSIT")


def test_crowding_endpoint_demo():
    r = client.get("/crowding", params={"scenario": "LOW", "demo": True})
    assert r.status_code == 200
    assert r.json()["source"] == "DEMO"
    assert r.json()["crowding_level"] == "LOW"


def test_crowding_endpoint_live_degrades_honestly():
    # No CV service running in tests -> live must degrade to MOCK (via fallback).
    r = client.get("/crowding", params={"demo": False})
    assert r.status_code == 200
    assert r.json()["source"] in ("MOCK", "UNAVAILABLE")


def test_parking_endpoint_demo_and_live():
    r = client.get("/parking", params={"scenario": "NEARLY_FULL", "demo": True})
    assert r.status_code == 200
    assert r.json()[0]["source"] == "DEMO"
    r2 = client.get("/parking", params={"demo": False})
    assert r2.json()[0]["source"] == "UNAVAILABLE"
