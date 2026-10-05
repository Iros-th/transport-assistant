# How to demo the Transit Assistant

## The one step (show the class)

Double-click **`frontend/index.html`**.

> **Live kamera-tælling (bonus):** double-click **`frontend/camera.html`** for a standalone in-browser people counter — starts the webcam, runs COCO-SSD locally, counts only `person`, and maps the count to the crowding model (LAV/MODERAT/HØJ/MEGET HØJ). Approximate for dense crowds; the accurate dense-crowd path is the `cv_service/` GPU service (see the page's own note).

It opens in any browser straight from the file system (`file://`) with no
server, no Python, no API, and no GPU. The dashboard loads fully populated with
deterministic, simulated Copenhagen data:

- Ranked route candidates (Bil, Bil + parkering, Parkér og gå, Parkér & rejs,
  Offentlig transport) with travel time, walking, parking spaces, crowding
  level, score, the "Hvorfor denne mulighed" explanation, and the
  time/walking/crowding/parking/uncertainty score breakdown. The best option is
  badged **Anbefalet**.
- Real Copenhagen line names (Metro M1–M4, S-tog linje A/B/C/E/H, Bus 5C/2A/
  350S/1A, Letbane L) on the transit routes and in the real-time panels.
- **Live afgange ved startstop** — a simulated "vehicle N stops away, arrives at
  your start stop in M min" per transit line.
- Real-time crowding per line (passengers/capacity, occupancy, crowding level,
  freshness stamp) and parking availability per lot.
- A persistent **DEMO DATA – ikke live** banner. All figures are simulated; the
  line names are real but positions/crowding are not live data.

The whole UI is in Danish.

### Things to try live in front of the class

- Type any **Fra**/**Til** (e.g. Nørreport St. → DTU Lyngby, or Nørrebrogade 40
  → Ørestad) and press **Find ruter**. The data is seeded by a hash of the
  addresses, so different trips give different but coherent results (ETAs,
  crowding, parking, departures), and the same trip always reproduces the same
  result.
- Flip **Tidspunkt** between *Uden for myldretid* and *Myldretid* to shift
  crowding and parking pressure.
- Toggle **Lys/Mørk** in the header (respects the OS setting by default and
  remembers your choice).

## Optional: run the full stack (live backend)

Only needed if you want the real FastAPI backend instead of the baked-in demo.

```
pip install -r requirements-dev.txt
uvicorn api.main:app --host 0.0.0.0 --port 8000
```

Then serve the frontend and point it at the API:

```
cd frontend
python -m http.server 8080
```

Open `http://localhost:8080` and set the **API-adresse** field to
`http://localhost:8000`. When the API is reachable the frontend uses live
backend data; when it is not reachable (or opened via `file://`) it falls back
to the embedded simulation automatically.

## Optional: the GPU / live computer-vision path

Crowding counts can come from a real CV service instead of the simulation. The
backend's `RealDetectionProvider` calls the CV service over HTTP with
`POST /count` (occupancy counts only — no images or identity cross the
boundary), and degrades to a mock/unavailable state if the service is down.

```
cd cv_service
pip install -r requirements-cv.txt
uvicorn cv_service.app:app --host 0.0.0.0 --port 8800
```

Point the backend at it with `CV_SERVICE_URL=http://localhost:8800` and request
plans with `demo=false`. See `cv_service/docs/CV_INTEGRATION.md` for the GPU
setup and model details.

## Regenerating / tests

- The offline demo data is generated in the browser by
  `frontend/demo-data.js` (a deterministic generator that mirrors the backend's
  planning/scoring constants). `gen_demo.py` at the repo root can dump the
  backend simulation's output as JSON if you want to compare.
- Backend tests: `pytest` from the repo root, and `pytest` inside `cv_service/`.
