"""Demo path + the API contract the web frontend (frontend/app.js) consumes."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.index import app as vercel_app  # the exact object Vercel serves

client = TestClient(vercel_app)
ROOT = Path(__file__).resolve().parent.parent
BODY = {"origin": "Nørreport St.", "destination": "DTU Lyngby"}

CANDIDATE_KEYS = {
    "recommended", "mode", "line", "score", "eta_minutes", "walking_minutes",
    "parking", "crowding", "explanation", "warnings", "score_components", "data_sources",
}
COMPONENT_KEYS = {"time", "walking", "crowding", "parking", "uncertainty"}


@pytest.fixture(autouse=True)
def _no_cv(monkeypatch):
    monkeypatch.delenv("CV_SERVICE_URL", raising=False)


@pytest.mark.parametrize("prefix", ["/api", ""])
def test_plan_contract(prefix):
    r = client.post(f"{prefix}/demo/plan", json=BODY)
    assert r.status_code == 200
    d = r.json()
    assert d["demo_mode"] is True and "DEMO" in d["label"] and d["as_of"]
    cands = d["candidates"]
    assert len(cands) == 5
    for c in cands:
        assert CANDIDATE_KEYS <= set(c)
        assert set(c["score_components"]) == COMPONENT_KEYS
        assert c["explanation"]
    assert [c["recommended"] for c in cands] == [True] + [False] * 4
    scores = [c["score"] for c in cands]
    assert scores == sorted(scores)  # best (lowest) first
    transit = [c for c in cands if c["crowding"]]
    assert transit and all(c["crowding"]["source"] == "DEMO" for c in transit)


def test_deterministic_and_trip_dependent():
    a = client.post("/api/demo/plan", json=BODY).json()
    assert a == client.post("/api/demo/plan", json=BODY).json()
    b = client.post("/api/demo/plan", json={**BODY, "destination": "Ørestad"}).json()
    assert a != b
    rush = client.post("/api/demo/plan", json={**BODY, "time_of_day": "RUSH"}).json()
    assert a["candidates"] != rush["candidates"]


def test_nothing_is_labelled_live():
    for path in ("crowding", "parking", "departures"):
        rows = client.get(f"/api/demo/{path}").json()
        assert rows
        for row in rows:
            assert row["source"] == "DEMO"
            assert row["freshness"] in ("SIMULATED", "STALE")
    assert "LIVE" not in json.dumps(client.post("/api/demo/plan", json=BODY).json())


def test_one_feed_is_deliberately_stale():
    rows = client.get("/api/demo/crowding").json()
    assert [r["freshness"] for r in rows].count("STALE") == 1
    assert all(isinstance(r["age_seconds"], (int, float)) for r in rows)


def test_prefs_affect_output():
    p = client.post("/api/demo/plan", json={**BODY, "prefs": {"parking": "none"}}).json()
    assert {c["mode_code"] for c in p["candidates"]} == {"DRIVE", "TRANSIT_ONLY"}
    strict = client.post("/api/demo/plan", json={
        **BODY, "prefs": {"walking_tolerance": 0, "crowding_tolerance": "low"}}).json()
    assert all(c["warnings"] for c in strict["candidates"])


@pytest.mark.parametrize("body", [
    {"origin": "A", "destination": "a"},
    {**BODY, "time_of_day": "MIDNIGHT"},
    {**BODY, "prefs": {"crowding_tolerance": "nope"}},
])
def test_bad_requests_are_400(body):
    assert client.post("/api/demo/plan", json=body).status_code == 400


def test_empty_origin_is_422():
    assert client.post("/api/demo/plan", json={"origin": "", "destination": "x"}).status_code == 422


def test_legacy_endpoints_also_under_api_prefix():
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/crowding", params={"scenario": "LOW"}).json()["source"] == "DEMO"


def test_vercel_config_and_runtime_requirements():
    cfg = json.loads((ROOT / "vercel.json").read_text())
    srcs = {b["src"]: b["use"] for b in cfg["builds"]}
    assert srcs["api/index.py"] == "@vercel/python"
    assert any(r["src"] == "/api/(.*)" and r["dest"] == "/api/index.py" for r in cfg["routes"])
    assert (ROOT / "frontend" / "index.html").exists()
    reqs = (ROOT / "requirements.txt").read_text()
    assert "fastapi" in reqs and "pytest" not in reqs


def test_pwa_manifest_icons_and_shell():
    from PIL import Image  # noqa: F401  (skipped if Pillow absent)
    fe = ROOT / "frontend"
    m = json.loads((fe / "manifest.webmanifest").read_text(encoding="utf-8"))
    assert m["display"] == "standalone" and m["start_url"] and m["scope"]
    assert m["name"] and m["short_name"] and m["theme_color"] and m["background_color"]
    purposes = {(i["sizes"], i["purpose"]) for i in m["icons"]}
    assert {("192x192", "any"), ("512x512", "any"), ("192x192", "maskable"), ("512x512", "maskable")} <= purposes
    for i in m["icons"]:
        w, h = Image.open(fe / i["src"]).size
        assert f"{w}x{h}" == i["sizes"]
    assert Image.open(fe / "icons" / "apple-touch-icon.png").size == (180, 180)
    html = (fe / "index.html").read_text(encoding="utf-8")
    for needle in ("rel=\"manifest\"", "apple-touch-icon", "apple-mobile-web-app-capable", "theme-color"):
        assert needle in html
    sw = (fe / "sw.js").read_text(encoding="utf-8")
    import re
    shell = re.search(r"SHELL_FILES = \[(.*?)\]", sw, re.S).group(1)
    for f in re.findall(r'"([^"]+)"', shell):
        if f != "./":
            assert (fe / f).exists(), f
