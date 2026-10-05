# UI Changes

- Rewrote `frontend/index.html` to introduce a full-bleed MapLibre GL map layout using OpenFreeMap tiles.
- Added input fields for `FRA` and `TIL` with custom styling and a swap button.
- Added a segmented control for priority ("Mindst fyldt transport" and "Sikker parkering").
- Added time selector ("Nu" / "Vælg tid").
- Added Skeleton loaders for a smoother experience during fetch.
- Rewrote `frontend/styles.css` adhering strictly to the design constraints: dark mode default, `#07080A` surfaces, Inter and JetBrains Mono fonts, 1px borders, 6px radius, one accent color, proper touch targets.
- Merged routing logic into `frontend/api.js` to call Photon, OSRM, and Transitous v5 APIs directly.
- Implemented client-side seeded random generation for simulated fill and parking scores to ensure determinism for the same query.
- Rewrote `frontend/app.js` to handle MapLibre instance, debounce input handling, rank routes, and render UI dynamically.
- Implemented node-based test for checking deterministic scoring and ranking in `tests/test_frontend.js`.

Screenshots:
- `desktop.png` (1440px viewport)
- `mobile.png` (375px viewport)
