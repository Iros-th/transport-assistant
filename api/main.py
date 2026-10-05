from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from core.enums import DataSource, Freshness, TransportMode
from core.models import CrowdingObservation, Parking
from core.occupancy import build_crowding_observation
from core.scoring import DEFAULT_WEIGHTS, ScoringWeights, rank_candidates
from simulation.scenarios import (
    CrowdingScenario,
    ParkingScenario,
    list_scenarios,
    simulate_crowding,
    simulate_parking,
)
from api.demo_ui import router as demo_router, _crowding_out, _parking_out
from api.planning import GeoPoint, build_candidates
from api.providers import (
    DetectionResult,
    MockDetectionProvider,
    RealDetectionProvider,
)
from api.routing_provider import RealRoutingProvider
from api.schemas import (
    CandidateOut,
    CrowdingOut,
    ParkingOut,
    PlanRequest,
    PlanResponse,
)

app = FastAPI(
    title="Transportation Assistant API",
    version="1.0.0",
    description="Crowding-aware, explainable multi-modal trip planning. "
    "Occupancy counts only -- no identity or biometrics.",
)

router = APIRouter()

@router.get("/geocode")
async def geocode_places(q: str = Query(min_length=2, max_length=200)) -> dict:
    """Proxy address lookup so browser searches do not depend on upstream CORS."""
    try:
        async with httpx.AsyncClient(timeout=3.5) as client:
            response = await client.get(
                "https://photon.komoot.io/api/",
                params={"q": q, "limit": 5, "lat": 55.68, "lon": 12.57},
            )
            response.raise_for_status()
            data = response.json()
        if not isinstance(data, dict) or not isinstance(data.get("features"), list):
            raise ValueError("Invalid geocoding response")
        return {"features": data["features"]}
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(status_code=503, detail="Address lookup unavailable") from error


_LIVE_PROVIDER = RealDetectionProvider(fallback=MockDetectionProvider())

def _observation_from_detection(result: DetectionResult) -> CrowdingObservation:
    return build_crowding_observation(
        transport_id=result.transport_id,
        route_id=result.route_id,
        passenger_count=result.passenger_count,
        estimated_capacity=result.capacity,
        timestamp=result.timestamp,
        source=result.source,
        confidence=result.confidence,
    )

def _parse_crowding_scenario(name: Optional[str], default: CrowdingScenario) -> CrowdingScenario:
    if name is None:
        return default
    try:
        return CrowdingScenario(name)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"unknown crowding scenario: {name}")

def _parse_parking_scenario(name: Optional[str], default: ParkingScenario) -> ParkingScenario:
    if name is None:
        return default
    try:
        return ParkingScenario(name)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"unknown parking scenario: {name}")

@router.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "transport-assistant", "time": datetime.now(timezone.utc).isoformat()}

@router.get("/scenarios")
def scenarios() -> dict:
    return {
        "crowding": [s.value for s in CrowdingScenario],
        "parking": [s.value for s in ParkingScenario],
        "all": list_scenarios(),
    }

@router.get("/crowding", response_model=CrowdingOut)
def crowding(
    transport_id: str = Query("veh-001"),
    route_id: str = Query("route-42"),
    estimated_capacity: int = Query(60, gt=0),
    demo: bool = Query(True),
    scenario: Optional[str] = Query(None, description="Demo crowding scenario name"),
) -> CrowdingOut:
    if demo:
        sc = _parse_crowding_scenario(scenario, CrowdingScenario.MODERATE)
        obs = simulate_crowding(
            sc,
            transport_id=transport_id,
            route_id=route_id,
            estimated_capacity=estimated_capacity,
        )
    else:
        result = _LIVE_PROVIDER.get_detection(transport_id, route_id, estimated_capacity)
        obs = _observation_from_detection(result)
    return CrowdingOut.from_domain(obs)

@router.get("/parking", response_model=list[ParkingOut])
def parking(
    demo: bool = Query(True),
    scenario: Optional[str] = Query(None, description="Demo parking scenario name"),
) -> list[ParkingOut]:
    if demo:
        sc = _parse_parking_scenario(scenario, ParkingScenario.PARKING_AVAILABLE)
        return [ParkingOut.from_domain(simulate_parking(sc))]
    else:
        placeholder = Parking(
            parking_id="lot-central",
            name="Central Deck",
            lat=40.7128,
            lon=-74.0060,
            available_spaces=None,
            total_spaces=500,
            distance_to_destination_m=350.0,
            walking_minutes=4.5,
            price=None,
            source=DataSource.UNAVAILABLE,
            timestamp=None,
            freshness=Freshness.UNAVAILABLE,
        )
        return [ParkingOut.from_domain(placeholder)]

@router.post("/plan", response_model=PlanResponse)
def plan(req: PlanRequest) -> PlanResponse:

    if req.modes:
        try:
            modes = [TransportMode(m) for m in req.modes]
        except ValueError:
            raise HTTPException(status_code=400, detail=f"unknown mode in {req.modes}")
    else:
        modes = list(TransportMode)

    # Adjust weights based on priority
    weights = DEFAULT_WEIGHTS
    if req.weights is not None:
        weights = ScoringWeights(
            time=req.weights.time,
            walk=req.weights.walk,
            crowd=req.weights.crowd,
            park=req.weights.park,
            uncertainty=req.weights.uncertainty,
        )
    # Override weights based on priority if no custom weights provided
    if req.weights is None:
        if req.priority == "Sikker parkering":
            weights = ScoringWeights(time=0.1, walk=0.05, crowd=0.1, park=0.6, uncertainty=0.15)
        elif req.priority == "Mindst fyldt offentlig transport":
            weights = ScoringWeights(time=0.1, walk=0.05, crowd=0.6, park=0.1, uncertainty=0.15)

    if req.demo:
        sc = _parse_crowding_scenario(req.crowding_scenario, CrowdingScenario.MODERATE)
        crowding_obs = simulate_crowding(sc, estimated_capacity=req.estimated_capacity)
    else:
        # Use real routing provider
        # For non-demo mode, we still need to simulate crowding and parking for the response structure,
        # but we will label them as simulated fill scores and note that routing is real.
        # We'll use the demo simulation for crowding and parking to keep the same response structure.
        sc = _parse_crowding_scenario(req.crowding_scenario, CrowdingScenario.MODERATE)
        crowding_obs = simulate_crowding(sc, estimated_capacity=req.estimated_capacity)
        # We will override the data source of the crowding_obs to indicate that the routing is real but fill scores are simulated?
        # However, the CrowdingObservation is used only for the crowding field in the candidate.
        # We want to show that the routing data is real, but the fill scores are simulated.
        # We'll leave the crowding_obs as is (from simulation) and note in the data_notes that routing is real.

    if req.demo:
        psc = _parse_parking_scenario(req.parking_scenario, ParkingScenario.PARKING_AVAILABLE)
        parking_opt: Optional[Parking] = simulate_parking(psc)
    else:
        # For non-demo mode, we still use simulated parking for the response structure.
        psc = _parse_parking_scenario(req.parking_scenario, ParkingScenario.PARKING_AVAILABLE)
        parking_opt = simulate_parking(psc)

    origin = GeoPoint(req.origin.lat, req.origin.lon, req.origin.name)
    destination = GeoPoint(req.destination.lat, req.destination.lon, req.destination.name)

    candidates = build_candidates(origin, destination, crowding_obs, parking_opt, modes=modes)
    if not candidates:
        raise HTTPException(status_code=400, detail="no candidate journeys for requested modes")

    ranked = rank_candidates(candidates, weights=weights)
    out_candidates = [CandidateOut.from_domain(c) for c in ranked]

    notes: list[str] = []
    notes.append(
        f"Crowding data source: {crowding_obs.source.value}, freshness: {crowding_obs.freshness.value}."
    )
    if crowding_obs.freshness != Freshness.FRESH:
        notes.append(
            "Crowding data is not fresh; transit crowding is treated as uncertain, not current."
        )
    if parking_opt is not None:
        notes.append(
            f"Parking data source: {parking_opt.source.value}, freshness: {parking_opt.freshness.value}."
        )
    else:
        notes.append("No parking data source configured; parking-based options carry maximal parking uncertainty.")
    if req.demo:
        notes.append("Demo mode: crowding and parking are deterministic simulation output, not live.")
    else:
        notes.append("Routes are modelled, not fetched from a live routing API; crowding and parking are simulated.")

    return PlanResponse(
        recommended=out_candidates[0] if out_candidates else None,
        candidates=out_candidates,
        data_notes=notes,
    )

# Same routes at "/" (local uvicorn) and under "/api" (Vercel serves this app
# at /api/*). The demo-shaped endpoints for the web UI live under /demo and
# /api/demo and need no CV service.
app.include_router(router)
app.include_router(demo_router)
app.include_router(router, prefix="/api")
app.include_router(demo_router, prefix="/api")

# Local convenience: `uvicorn api.main:app` also serves the web UI at "/".
# (On Vercel the static frontend is served by the platform; see vercel.json.)
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if _FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIR), html=True), name="frontend")