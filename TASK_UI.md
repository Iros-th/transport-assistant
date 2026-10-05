# Task: make Transit Assistent a top industrial-grade product (real data + UI/UX)

Read TASK_REALDATA.md (data + scoring + recommendation spec) and README.md. This task supersedes its UI section.
NOTE: an earlier attempt added api/routing_provider.py but NEVER called it. Real data must actually flow to the screen.

## Architecture
All three APIs (Photon, OSRM, Transitous v5) send `Access-Control-Allow-Origin: *`, so call them DIRECTLY from the
browser in frontend/ (keep it framework-free or use a tiny build-free ES-module setup — it is deployed as static files +
api/index.py on Vercel). Keep the Python /api as a fallback for when the browser calls fail. Seeded simulated fill scores
computed client-side (same rules as TASK_REALDATA.md), labelled "Simuleret".

## Design (reference: Linear / Vercel / Bloomberg terminal; restrained instrument panel)
near-black #07080A surfaces + light mode; 1px hairline borders; 6px radius; Inter for UI, JetBrains Mono tabular
numerals for every number; ONE accent #4C8DFF; green/amber/red only for fill levels; 8px grid; 44px touch targets;
150ms transitions; no gradients, no emoji, no generic dashboard cards.
Layout: full-bleed MapLibre GL map (OpenFreeMap tiles https://tiles.openfreemap.org/styles/dark and /liberty for light)
with a draggable bottom sheet on mobile; split view on desktop (results 420px left, map right).
Screens: FRA/TIL inputs with Photon autocomplete (keyboard navigable), swap button, priority segmented control
("Mindst fyldt offentlig transport" / "Sikker parkering"), Nu / Vælg tid. Hero "Anbefalet" card with line chips in line
colours, total minutes big in mono, one-sentence why, fill bar; leg timeline (time | dot/line | step) on expand;
alternatives as compact cards; route polylines on the map coloured by mode, fitted bounds, origin/destination markers.
States: skeleton loaders, empty, API error with retry, offline banner. PWA stays installable (manifest/sw/icons exist).

## Done when
- `python -m pytest -q` green (84+), plus tests for client-side scoring determinism and ranking (node or pytest on JS).
- Served locally, Nørreport St. -> DTU Lyngby shows REAL Transitous lines (e.g. A-tog / letbane) and a real OSRM drive time,
  a recommendation, and the route on the map, no console errors at 375px and 1440px (verify in your browser, screenshots).
- Write CHANGES_UI.md (what changed + screenshot paths). Do not deploy.
