# Transport Assistant - Python Backend

Crowding-aware, explainable multi-modal trip planning. Given an origin,
a destination and preferences, it ranks candidate journeys (drive, park,
transit, and combinations), scores each one transparently, and returns a
plain-language explanation of why each scored as it did. Crowding comes from a
passenger-counting computer-vision service (or deterministic demo data), and
every data point is labelled with its source and freshness so the assistant
never presents stale or missing data as current.

This is the Python backend only. The web frontend and the CV service are
separate components (owned by other parts of the project) and are not included
here. The HTTP contract this backend expects from the CV service is documented
at the end of this file.

## What it is

- `core/` - pure domain logic: occupancy math, crowding levels, freshness,
  and the transparent route-scoring model. No I/O, fully unit-tested.
- `simulation/` - deterministic, seeded demo data (same seed -> same output)
  covering crowding bands and data-failure scenarios.
- `api/` - a FastAPI application, request/response schemas, and the detection
  provider interface (mock, demo, and a real HTTP-backed provider with
  graceful degradation).
- `tests/` - pytest suite covering math, thresholds, scoring, normalization,
  data-quality handling, determinism, provider fallback, and the API.

## Install

```bash
cd transport-assistant
python -m venv .venv && source .venv/bin/activate   # optional
pip install -r requirements-dev.txt
```

Python 3.10+ is required (tested on 3.10.12).

## Run the API

```bash
# from the transport-assistant/ directory
uvicorn api.main:app --host 0.0.0.0 --port 8000
```

Interactive docs are then at `http://localhost:8000/docs`.

Endpoints:

| Method | Path         | Purpose                                             |
|--------|--------------|-----------------------------------------------------|
| GET    | `/health`    | Liveness probe.                                     |
| GET    | `/scenarios` | List available demo scenarios.                      |
| GET    | `/crowding`  | One crowding observation (demo or live provider).   |
| GET    | `/parking`   | Parking options (demo or configured source).        |
| POST   | `/plan`      | Ranked, scored, explained candidate journeys.       |

Example plan request (demo mode):

```bash
curl -s -X POST http://localhost:8000/plan \
  -H 'content-type: application/json' \
  -d '{
        "origin": {"lat": 40.70, "lon": -74.01, "name": "Home"},
        "destination": {"lat": 40.75, "lon": -73.99, "name": "Office"},
        "demo": true,
        "crowding_scenario": "HIGH",
        "parking_scenario": "NEARLY_FULL"
      }'
```

The response contains `recommended`, a `candidates` list sorted best-first,
each with a `components` breakdown and an `explanation`, plus `data_notes`
describing the source and freshness of the underlying data.

## Run in demo mode

Demo mode is the default (`"demo": true` on `/plan`, `demo=true` on the GET
endpoints). It uses the deterministic simulation layer, so results are stable
across refreshes and process restarts, and every value is labelled `DEMO`.
No CV service is needed. Available scenarios:

- Crowding: `LOW`, `MODERATE`, `HIGH`, `VERY_HIGH`, `STALE_DATA`,
  `MISSING_DATA`, `SENSOR_FAILURE`.
- Parking: `PARKING_AVAILABLE`, `NEARLY_FULL`.

## Run the tests

```bash
# from the transport-assistant/ directory
python -m pytest tests/ -q
```

The suite is self-contained (it stubs the CV service with an in-memory HTTP
transport) and requires no network access or running server.

## Configuration

All tunables are explicit, documented dataclasses with sensible defaults; none
are magic numbers buried in the code.

### Crowding thresholds (`core/occupancy.py`, `CrowdingThresholds`)

Upper bounds (exclusive) on the 0..1 crowding score:

| Level      | Condition             | Default |
|------------|-----------------------|---------|
| LOW        | `score < low_max`     | < 0.50  |
| MODERATE   | `score < moderate_max`| < 0.75  |
| HIGH       | `score < high_max`    | < 0.90  |
| VERY_HIGH  | otherwise             | >= 0.90 |

Boundaries are exact: a score of 0.50 is MODERATE, 0.75 is HIGH, 0.90 is
VERY_HIGH.

### Freshness thresholds (`core/freshness.py`, `FreshnessThresholds`)

Age of the reading, in seconds:

| Freshness   | Condition                                   | Default        |
|-------------|---------------------------------------------|----------------|
| FRESH       | `age <= fresh_max_seconds`                  | <= 60 s        |
| STALE       | `fresh_max < age <= stale_max_seconds`      | 60-120 s       |
| UNAVAILABLE | no reading, future timestamp, or `age > stale_max` | > 120 s |

Stale and unavailable data are surfaced explicitly and raise the uncertainty
component of the score; they are never silently treated as current.

### Scoring weights (`core/scoring.py`, `ScoringWeights`)

The total is a weighted average of five components, each normalized to 0..1
where **higher means worse**:

```
total = (W_TIME*time + W_WALK*walk + W_CROWD*crowd
         + W_PARK*park + W_UNCERT*uncertainty) / sum(weights)
```

| Weight        | Meaning                          | Default |
|---------------|----------------------------------|---------|
| `time`        | travel time (min-max normalized) | 0.40    |
| `walk`        | walking effort                   | 0.15    |
| `crowd`       | transit crowding                 | 0.25    |
| `park`        | parking friction                 | 0.10    |
| `uncertainty` | stale/missing data, low confidence | 0.10  |

Dividing by the sum of weights keeps the total on the same 0..1 scale as the
components, so **lower score = better journey** and no single component can
dominate merely because of the units it is measured in. Weights can be
overridden per request via the `weights` field on `/plan`.

The walking penalty (`WalkingPenaltyConfig`) is normalized-linear and capped:
`penalty(m) = clamp(m / max_penalty_minutes, 0, 1)` with a default cap of 20
minutes. It is monotonically non-decreasing, so more walking is never scored
better than less.

## Live vs. mock data

The backend never invents live availability. Every crowding and parking payload
carries an explicit `source` and `freshness`:

- `LIVE` - a real count actually returned by the CV service.
- `DEMO` - deterministic simulation output (demo mode).
- `MOCK` - deterministic stand-in from `MockDetectionProvider` (e.g. the
  fallback used when a live request cannot reach the CV service).
- `UNAVAILABLE` - no data could be obtained; numeric fields are `null`, never
  a fabricated number.

The `RealDetectionProvider` calls the CV service over HTTP. On any transport
error, timeout, non-200 status, malformed body, or an explicit null count, it
degrades to its configured fallback (by default a `MockDetectionProvider`,
labelled `MOCK`) or, with no fallback, to `UNAVAILABLE`. A result is labelled
`LIVE` only when a real count came back.

Set the CV service location with the `CV_SERVICE_URL` environment variable
(default `http://localhost:8800`):

```bash
export CV_SERVICE_URL=http://cv-service.internal:8800
uvicorn api.main:app --port 8000
# then call /plan or /crowding with "demo": false
```

## Privacy by design

The assistant works with occupancy counts only. There is no face recognition,
no identity, and no biometric storage anywhere in this backend. This is
enforced at the interface, not just by policy:

- The `DetectionProvider.get_detection` contract accepts only
  `(transport_id, route_id, estimated_capacity)` - it has no parameter for an
  image, a video frame, or any per-person data.
- The `DetectionResult` it returns carries only an aggregate count, a capacity,
  a confidence and a timestamp - no faces, embeddings, track ids, or personal
  attributes.
- Camera frames processed by a real CV service are transient and stay inside
  that service; only the aggregate count crosses this HTTP boundary.

## CV service HTTP contract (the shared boundary)

`RealDetectionProvider` in `api/providers.py` calls the CV service's `POST
/count` endpoint. This is the exact contract across the boundary; the CV
service (a separate component) implements the server side and this backend the
client side.

**Request**

```
POST {CV_SERVICE_URL}/count
Content-Type: application/json

{
  "signal": "people",              // "people" for passenger counts (or "cars" for parking)
  "capacity": 60,                  // integer >= 1, echoed back untouched (optional)
  "image_path": "/frames/veh.jpg"  // server-visible frame path (optional; supplied only if
                                   //   the deployment configures CV_IMAGE_PATH)
}
```

This backend passes a signal and a capacity only. It never sends image bytes;
`image_path` is a reference the CV service resolves on its own side, included
solely when the deployment provides one. The CV service must never return image
data, crops, bounding boxes, embeddings, or identities.

**Success response** (`200 OK`)

```
{
  "count": 42,                                 // integer >= 0; primary count for the signal
  "class_counts": {"person": 42, "car": 0},    // per-class integer breakdown
  "confidence": 0.88,                          // float 0..1
  "model": "…",                                // estimator that produced the count
  "source": "LIVE",                            // "LIVE" (real inference) or "MOCK"
  "signal": "people",                          // echo of the requested signal
  "capacity": 60,                              // echo of the supplied capacity (or null)
  "timestamp": "2026-09-29T12:00:00+00:00",    // ISO-8601 UTC when the count was produced
  "latency_ms": 5.0                            // inference wall-time
}
```

This backend consumes `count`, `confidence`, `source`, `capacity` and
`timestamp`; the other fields are informational. The `source` value maps
straight onto `core.enums.DataSource` (`LIVE` -> LIVE, `MOCK` -> MOCK), so a
count the CV service produced in mock mode is never relabelled as live. A count
of `null`, a non-200 status, a malformed body, or an unreachable service all
cause graceful degradation (to `MOCK` via the fallback provider, or
`UNAVAILABLE`) with no fabricated number. The default request timeout is 2.5 s.

A `GET /health` endpoint on the CV service is recommended but not required by
this backend.

## Public demo on Vercel (installable PWA)

`vercel.json` serves `frontend/` statically and runs the FastAPI app
(`api/index.py`) as a Python serverless function under `/api/*`
(`/api/demo/plan|crowding|parking|departures|meta`). Demo mode needs no CV
service and no secrets; every value is labelled DEMO/SIMULATED. If `/api` is
unreachable the page falls back to its in-browser generator. The site is an
installable PWA (manifest, service worker, icons from `gen_icons.py`).

Deploy (after you have run `vercel login` yourself): `npx vercel --prod`

Local equivalent: `python -m uvicorn api.main:app --port 8000` then open
http://localhost:8000/ (serves the UI and `/api`). Dev deps:
`pip install -r requirements-dev.txt`.
