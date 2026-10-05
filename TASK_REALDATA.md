# Task: real routes + simulated fill scores, perfect mobile UX

Repo: this folder. Python backend (api/, core/), vanilla JS frontend (frontend/), deployed on Vercel
(api/index.py is the function, vercel.json routes, PWA in frontend/). Read README.md and HOW_TO_DEMO.md first.
Run `python -m pytest -q` before and after; it must stay green (81+ tests).

## Goal
User types any FROM address and TO address (Danish UI, Copenhagen default). The app fetches REAL routes, attaches a
fill score to every option, and clearly recommends the optimal route for the user's chosen priority:
"Sikker parkering" (most consistently available parking) or "Mindst fyldt offentlig transport" (least crowded transit).

## Real data — keyless public APIs (all verified working 2026-10-02)
- Geocoding: Photon `https://photon.komoot.io/api/?q=<text>&limit=5&lat=55.68&lon=12.57` (also use it for
  as-you-type address suggestions, debounced 250 ms).
- Driving route: OSRM `https://router.project-osrm.org/route/v1/driving/<lon,lat>;<lon,lat>?overview=full&geometries=geojson`
- Public transport: Transitous/MOTIS `https://api.transitous.org/api/v5/plan?fromPlace=<lat,lon>&toPlace=<lat,lon>&time=<iso>`
  (real Danish timetables: lines, departures, legs, durations; send a descriptive User-Agent).
Call these server-side in the Python function (timeouts 8 s, small in-memory cache, graceful fallback to the existing
deterministic demo data with a visible "offline demo" notice if an API fails).

## Fill scores (simulated — be honest)
- Per transit leg: a 0–100 "fyldningsgrad" from a deterministic seeded generator keyed on (line, stop, hour, weekday) —
  rush hours busier — so the same query gives the same score. Route score = duration-weighted average.
- Per driving option: parking availability 0–100 near the destination, seeded the same way, plus a "consistency"
  (low variance across the hour) used for the "Sikker parkering" priority.
- Label every score "Simuleret" with a tooltip explaining it is an estimate, not live sensor data. Routes/timetables ARE
  real — label them "Rigtige ruter (OpenStreetMap / Transitous)".

## Recommendation
Rank options by the chosen priority (tie-break on total time). Show the winner as a hero card: "Anbefalet: …" with a
one-sentence why ("Linje 150S er 22% fyldt — 31 min, 4 min langsommere end bil men ingen parkeringsrisiko").
Below: compact cards for alternatives with time, transfers, walk, fill bar, parking bar.
Show the chosen route on a map (Leaflet from cdnjs + OSM tiles, polyline per leg coloured by mode).

## Also fix
One click on "Find ruter" currently fires /api/demo/plan and the crowding/parking/departures GETs 2–3 times each.
Make it exactly one request per click (coalesce in-flight requests, no refetch on re-render). Add a test.

## UX bar (this matters most)
Mobile-first 375 px, dark + light, Cortex-like restraint: one accent colour, semantic green/amber/red only for fill
levels, 8 px spacing grid, tabular numerals, skeleton loaders, clear empty/error states, 44 px touch targets,
keyboard friendly, no layout shift, PWA still installable. No generic dashboard look.

## Done when
- `python -m pytest -q` green, with new tests for: score determinism, ranking by both priorities, API-failure fallback,
  single-request-per-click.
- Running locally (`uvicorn api.main:app`) a query Nørreport St. → DTU Lyngby shows real transit lines and a real driving
  time, scores labelled Simuleret, a recommendation, and a map, with no console errors at 375 px and desktop.
- Write a short summary of changes to CHANGES_REALDATA.md. Do not deploy; the boss deploys after review.
