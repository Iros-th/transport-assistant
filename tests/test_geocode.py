"""Address lookup uses the backend and degrades cleanly on upstream failure."""
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)


def test_geocode_proxies_query_and_supports_both_prefixes():
    payload = {"features": [{"properties": {"name": "Østerport"}}]}
    response = httpx.Response(200, json=payload, request=httpx.Request("GET", "https://photon.komoot.io/api/"))
    with patch("api.main.httpx.AsyncClient.get", new_callable=AsyncMock, return_value=response) as get:
        for path in ["/geocode", "/api/geocode"]:
            result = client.get(path, params={"q": "Østerport"})
            assert result.status_code == 200
            assert result.json() == payload
        assert get.call_args.kwargs["params"]["q"] == "Østerport"


def test_geocode_returns_unavailable_on_timeout():
    with patch("api.main.httpx.AsyncClient.get", new_callable=AsyncMock, side_effect=httpx.ReadTimeout("timeout")):
        response = client.get("/api/geocode", params={"q": "Østerport"})
    assert response.status_code == 503


def test_geocode_rejects_invalid_upstream_payload():
    response = httpx.Response(200, json={"features": None}, request=httpx.Request("GET", "https://photon.komoot.io/api/"))
    with patch("api.main.httpx.AsyncClient.get", new_callable=AsyncMock, return_value=response):
        assert client.get("/api/geocode", params={"q": "Østerport"}).status_code == 503


def test_geocode_validates_query():
    assert client.get("/api/geocode", params={"q": "a"}).status_code == 422
