# UI Changes Round 2

- **Map Rendering**:
  - Implemented OpenFreeMap dynamic styles for light/dark mode parity (`/styles/liberty` and `/styles/dark`).
  - Added origin and destination markers using `maplibregl.Marker`.
  - Polylines now draw correctly with precision fixes in `api.js` (tests added).
  - Implemented a draggable bottom sheet with peek, half, and full snap points, ensuring the map remains visible behind the panel.
- **Mode Chips**: 
  - Updated API parsing to extract `routeShortName` and `routeColor` directly from Transitous.
  - Replaced English mode names with Transitous short names (e.g. A, 150S, etc.) with correct route colours. Danish fallback words added.
- **Hero Card**: 
  - Added a one-sentence descriptive reason summarizing the route fill score, duration, and transfers.
  - Implemented a tap-to-expand leg timeline detailing time, dot/line segments, and steps (including walking).
- **Time Picker ('Vælg tid')**:
  - Segmented control layout wrap fixed.
  - Time picker input made visually hidden so it doesn't break flex layout, while opening a native time picker (`showPicker()`) when clicked.
- **Accessibility & Controls**:
  - Replaced priority and time radio buttons with native `<button>` elements utilizing `aria-pressed`.
  - Added `role="listbox"` and `role="option"` to autocomplete suggestions.
  - Added arrow-key navigation (up/down/enter/escape) to the suggestions dropdown.
- **First-load Experience**:
  - Prefilled the search inputs with "Nørreport St." and "DTU Lyngby" on `DOMContentLoaded`.
  - Automatically triggers the first search so users see results and the map trace immediately on load.

## Screenshots
- `screenshots/mobile_light.png`
- `screenshots/mobile_dark_timeline_expanded.png`
- `screenshots/desktop_split_view.png`
