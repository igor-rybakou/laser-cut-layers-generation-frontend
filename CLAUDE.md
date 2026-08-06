# laser-cut-layers-generation-frontend

Local dev workbench frontend for tuning a laser-cut layered-map generator. An
instrument for finding manufacturability defects (hidden engraving, silently
discarded geometry, sub-1mm necks that snap in plywood) fast — not a product.
No onboarding, no marketing surface, no empty-state illustrations.

## Related repos (siblings on disk)

- **Backend** (FastAPI, drives the CLI as a subprocess, caches by param hash):
  `../laser-cut-layers-generation-api`
  - `workbench/main.py` — all routes (`/api/generate`, `/api/jobs`,
    `/api/schema`, `/api/health`, `/api/presets`)
  - `workbench/schema.py` — hand-maintained descriptor list behind
    `GET /api/schema` (defaults refreshed live from the generator's
    `config.example.yaml`)
  - `workbench/params.py` — `GenerateParams` pydantic model = exact shape of
    the `POST /api/generate` body
  - Run it: `python run.py` (reads `.env`, default port 8010)
- **Generator** (the actual map/SVG producer, not imported — driven as a
  subprocess by the backend): `../laser-cut-layers-generation`
  - `mapgen/manifest.py` / `mapgen/metrics.py` — manifest.json schema and the
    geometry metrics that fill it
  - `mapgen/svg.py` — SVG sheet contract (group ids, path format)
  - `mapgen/layers.py` — the 3-sheet strategy (base/land/green) and
    manufacturability filtering
  - `preview.py` — a throwaway compositor script in that repo; its draw order
    is the only place the *physical* sheet stacking order is recorded (see
    below) — worth re-reading if the stack order ever seems wrong
  - `tests/test_output_contract.py` — pins the CLI's stdout/manifest/SVG
    contract; read this before trusting anything about output shape that
    isn't nailed down elsewhere

Both repos are read-only from here — this app only talks to the backend over
HTTP (`/api/*`, proxied to `http://localhost:8010` in dev).

## Stack

Vite + TypeScript, no framework (no React/Vue/SSR). Three.js for the 3D view.
No CSS framework — plain CSS with custom properties. No state library — see
`src/store.ts` (~30 lines: value holder + subscribers).

```
npm install
npm run dev        # Vite dev server, proxies /api -> localhost:8010
npm run typecheck  # tsc --noEmit
npm run build      # tsc --noEmit && vite build
```

**`npm run build` writes directly into `../laser-cut-layers-generation-api/web/dist`**
(see `vite.config.ts` — `outDir` is an absolute sibling-repo path, not local
`dist/`). The backend mounts that directory as static files at `/` on
startup (`workbench/main.py`'s `lifespan`), but only if the directory already
exists *when the backend process starts* — **restart the backend after the
first build** or after any build that changes which top-level asset files
exist, otherwise it keeps serving 404s at `/`.

## Backend contract — things that bit us once, don't re-derive them

- **`POST /api/generate` is synchronous.** It blocks on a subprocess for the
  full run (~6–13s warm, up to `timeout_s` = 120s default) and returns
  `{job_id, cached}` only after the generator exits. There is no
  progress/streaming endpoint — the "elapsed seconds" display in
  `left-panel.ts` is a client-side timer started at fetch time, not real
  progress.
- **Sheet SVG filenames are `layer_<index>_<name>.svg`** (`layer_0_base.svg`,
  `layer_1_land.svg`, `layer_2_green.svg`), *not* the `{index:02d}_{name}.svg`
  pattern that `test_output_contract.py` documents as an intended-but-not-yet
  built contract. Always read the actual filename off
  `manifest.sheets[].filename` / `job.files[]` — never construct it.
- **There is no `--layers N` flag, and no single "layers" switch.** Which
  sheets a run emits is spread over three unrelated config keys, which
  `include_layers` exists to gather:
  `green` → `config.layers.include_green_layer`, `buildings` →
  `config.buildings.enabled`, `roads` → a filter over `config.roads.sheets`.
  Three things to know before touching it:
  - **base (0) and land (1) are never selectable** — base is the plate the
    stack is glued to and land carries the label. `green` and `buildings` are
    additionally dropped by the *generator* when the site has no park / no
    building geometry, so a checked box is an upper bound, not a promise.
  - **Sending an alias and its config key in one request is a 422**, not a
    precedence rule — the backend refuses rather than silently discarding one
    of the two values. `left-panel.ts` therefore *only ever writes the config
    keys* for green/buildings and uses `include_layers` for `roads` alone
    (which has no config-level equivalent); `setLayerFlag` also strips a stale
    alias that an old preset may carry. `schema.py` deliberately does not
    advertise the aliases for the same reason.
  - **`include_layers.roads` cannot be empty** (the generator refuses an empty
    `roads.sheets` block, so there is no way to ask for zero road sheets).
    The last checked road sheet locks in the UI instead of composing a request
    that can only come back 422.
- **`config.buildings.enabled` is not a rendering flag.** With it false the OSM
  building query — the largest and slowest request in a run — is never issued
  at all. `render: "fill"` burns each block solid (most contrast, by far the
  longest pass); `"outline"` traces the edges like the roads.
- **`manifest.sheets[]` splits by `operation`, and `index` is not dense.**
  `operation: "cut"` is a plate whose `cuts` are the material that remains
  (base 0, land 1, green 2). `operation: "engrave"` is a sheet whose `cuts`
  are *only its outer frame* and whose detail is burned on the surface
  (buildings 3, road sheets 4+, one per `config.roads.sheets` entry). Index 3
  is reserved whether or not buildings are on, so enabling them never
  renumbers the road sheets — but a road sheet's index *is* positional over
  the selected sheets, so dropping `wide` moves `narrow` to index 4 and
  `config.material.thickness_mm.4` with it. Consequences:
  - **All engraving lives outside `base`.** Roads, buildings and the label
    were all moved off it. `base` with `engrave_outline_mm: 0` is the normal
    case. Never read engraving off `base` alone — `flat-view.ts` did, and
    roads silently vanished from the flat compositor.
  - **Never fill an engrave sheet's `cuts`.** It is a full disc
    (`cut_length_mm` 942.47 = π·300) with nothing cut through it, so filling
    it buries the whole composite. Both views skip the body and keep the
    sheet's thickness and stack slot, which is exactly what preview.py does by
    filling only `land` and `green`. That boundary *is* a real cut, though —
    `machine-time.ts` is right to count it.
- **Physical stack order is `manifest.sheets[].stack_index`, and nothing
  else** — not the filename, not `index`, not a role list in this repo.
  `mapgen/layers.py` says so outright ("Anything that composites sheets —
  preview.py, the workbench — must read this, not the filename") and
  `preview.py` sorts by it. **base is the BOTTOM** backing plate: 0 base,
  1 land (label), 2 green, 3 buildings, 4+ roads on top. Everything was moved
  off base precisely because the land plate above it is ~100% of the disc on
  an inland site, so anything burned into the base is under solid material and
  invisible. This repo previously hardcoded the opposite order
  (`ROLE_ORDER = land, green, base`) — it is gone; both views sort by
  `stack_index`.
- **Manifest has no `out_of_bounds` flag and no per-sheet resolved
  `min_feature_width_mm`.** Both are computed client-side in `defects.ts`:
  out-of-bounds directly from parsed geometry vs. the canvas boundary; the
  effective neck threshold from `manifest.params.config.manufacturability
  .min_feature_width_mm` when set, else `max(2.0, thickness_mm * 0.85)`
  (mirrors `mapgen/config.py`'s `resolve_min_feature_width_mm`).
- **`manifest.sheets[].removed`** is always present (not just when something
  was removed) — `{pieces: 0, area_mm2: 0.0}` when nothing was. The
  "removed by filter" banner condition in `defects.ts` is
  `pieces > 0 || area_mm2 > 0`, since a sheet can lose area with zero whole
  pieces removed (a neck trim that doesn't eliminate a piece).
- **SVG contract** (pinned by `test_output_contract.py`, don't assume
  anything looser): absolute path commands only, one `<path>` per polygon
  piece with holes as additional subpaths in the same `d`, top-level group
  ids restricted to `cuts` / `engraves_building` / `engraves_road` /
  `engraves_text`, 1 SVG unit = 1 mm, Y-down.
- **`config.layers.road_widths_mm` is gone and is now *rejected*, not
  ignored.** Road widths moved to `config.roads.sheets.<name>.class_widths_mm`
  (plus `width_mm`, `class_widths_m`, `width_m`, `operation`), and every
  request model is `extra="forbid"`, so one stale key 422s the whole request.
  Those keys outlive a backend upgrade in `localStorage` and in the preset
  store, which is what `paths.ts::pruneRetiredPaths` exists for — it runs on
  the persisted params blob at startup and on every preset/snapshot load. Add
  to `RETIRED_PATHS` whenever the backend retires a key.
- **`engraves_road` is closed area polygons, not centrelines.** Every `d`
  ends in `Z`; a road path is the *buffered* ribbon (widths from
  `config.roads.sheets[].class_widths_mm`, 0.35–2.2mm) and the city blocks it
  encloses come back as holes — one real job had a single `<path>` with 34
  subpaths, i.e. one connected road network + 33 blocks. So the
  exterior-first/holes-after reading of `ParsedPath.rings` holds here, and
  both views fill with `evenodd` rather than stroking a polyline.
  `flat-view.ts` still strokes a 1px hairline over the fill, because a 1.1mm
  ribbon is a third of a pixel when 300mm is zoomed to fit.

## Architecture notes

- **State**: `src/state.ts` holds every top-level store (`paramsStore`,
  `schemaStore`, `uiStore`, `generationStore`, etc.), each persisted to
  `localStorage` individually where the brief calls for it. Don't add a
  second source of truth for the same data — read from these stores, don't
  cache derived values in module-level variables that can drift.
- **Params body**: `paths.ts`'s `getPath`/`setPath` read/write the nested
  request body by the dotted `path` string straight from the schema
  descriptor (e.g. `"config.material.thickness_mm.0"`). This is *the*
  mechanism that keeps the left panel from ever hardcoding a field list —
  every control in `left-panel.ts` is built generically off
  `GET /api/schema`, including fields that don't exist yet in this file's
  knowledge (new schema fields "just appear").
- **Geometry pipeline**: sheet SVGs are fetched once per completed job
  (`generate.ts::loadSheets`), parsed once (`svg-parser.ts` →
  `ParsedSheet[]`), and that single parse feeds both `flat-view.ts` (2D
  canvas compositor) and `three-view.ts` (3D). Don't re-parse per view.
- **3D view performance**: one merged `THREE.Mesh` per sheet per material
  class (body / engrave), built via `BufferGeometryUtils.mergeGeometries`,
  disposed and rebuilt on data change — never per-frame, never per-path.
  Defect markers are billboarded `THREE.Sprite`s, not flat geometry.
- **Flat view coordinate gotcha**: `flat-view.ts` draws sheet geometry
  *uncentered* (world space is `[0, size_mm]`, matching the raw SVG
  coordinate space directly) — unlike `three-view.ts`, which explicitly
  centers on `[-half, half]` per the 3D brief's instruction. If you're
  fitting/framing the flat camera, center on the shape's midpoint
  (`size_mm / 2`), not world origin — `FlatView.fitToBoundary` got this
  wrong once already (centered on `(0,0)` instead of `(half, half)`,
  producing a tiny cropped circle in one corner); the fix is in a comment
  right above where it's computed now.
- **The map preview's footprint is derived, not guessed.** `mapgen/project.py`'s
  `Projector` defines the canvas as a real-world square of side `2 * radius_m`
  centered on lat/lng, with `mm_per_m = size_mm / (2 * radius_m)`; a circle
  boundary is exactly inscribed in it. `map-preview.ts` draws that square (the
  OSM fetch extent *and* the sheet extent) plus the resolved cut boundary, so
  the overlay stays truthful only as long as that docstring does. Tiles are Web
  Mercator while the generator projects in UTM — sub-pixel divergence at these
  radii, not at tens of km.
- **Defect detection** (`defects.ts`) is a deliberately approximate,
  client-side pass — vertex-vs-non-adjacent-edge distance for narrow necks
  (capped at ~1500 vertices/piece, worst 20 markers/sheet), not an
  exhaustive geometric analysis. It exists to make defects *visible fast*,
  not to replace the generator's own manufacturability filter.

## File map

```
src/
  main.ts            bootstrap: layout, mounts every panel, health+schema fetch
  state.ts            every store + localStorage persistence
  store.ts             minimal pub/sub value holder (the "state library")
  api.ts               fetch wrapper for /api/*
  generate.ts          POST /api/generate orchestration, sheet loading
  types.ts             mirrors of every backend response/request shape
  paths.ts             dotted-path get/set for the nested params body
  controls.ts          generic form controls (number/text/bool/enum)
  left-panel.ts         schema-driven param panel, generate header, layers editor
  place-search.ts       Nominatim search (debounced, localStorage-cached)
  map-preview.ts        OSM tile map for picking the center + footprint overlay
  presets.ts             preset gallery (backend CRUD + client-side thumbnails)
  svg-parser.ts          sheet SVG -> ParsedSheet (contract-aware, no SVG lib)
  geometry.ts             polygon math (area, point-in-poly, boundary shapes)
  defects.ts               narrow-neck/tiny-piece/out-of-bounds/removed-banner
  materials.ts              birch/walnut/dark-stain palettes
  flat-view.ts              2D canvas compositor (pan/zoom persisted)
  three-view.ts             3D stack (Three.js, explode, backlight, markers)
  viewport.ts                mode toggle + toolbar wiring flat/3D together
  right-panel.ts              manufacturability table, machine-time, downloads
  machine-time.ts               cut/engrave time estimate math
  status-strip.ts                health/duration/cache/fps/snapshot filmstrip
  debounce.ts                     generic debounce util
  style.css                        design tokens, all UI chrome styling
```

## Design tokens (exact, do not add a fifth hue to UI chrome)

```
--bg #17191c  --panel #1e2125  --panel-hi #262a2f  --line #2f343a
--ink #e6e4df --muted #878d96
--signal #e8a33d (active controls / primary action)
--alert  #ff5c47 (defect markers only)
--led    #6fd8e8 (backlight simulation only)
```

Magenta (`out_of_bounds` markers) lives *only* inside viewport content
(canvas/3D scene) — never as UI chrome color, only as a small swatch/legend
accent on the toggle that controls it. `Barlow Condensed` for labels/controls,
`JetBrains Mono` for every number/measurement/table cell.

## Known limitations (not bugs, just constraints worth remembering)

- Nominatim's usage policy wants a custom `User-Agent`; browsers block
  scripts from setting that header on `fetch`. No client-side fix exists —
  `place-search.ts` relies on the automatic `Referer` header instead. The same
  limitation applies to `map-preview.ts`'s tile requests to
  `tile.openstreetmap.org`, which is why it caches tiles in memory, fetches
  only the visible viewport, and renders the required attribution link.
- `npm audit` reports a moderate/high advisory in Vite 5's bundled esbuild —
  dev-server-only (a CORS-adjacent issue affecting `vite dev`), doesn't touch
  the production build. Not upgraded to Vite 8 (breaking major) for this.
- The 3D engrave mesh is one merged mesh per sheet regardless of
  building/road/text kind (all tinted the same darker material tone) — kinds
  are still visually distinguishable by shape (fill vs. thin outline
  extrusion), just not by separate hue, to keep draw calls low. The tone is
  picked per sheet from whichever kind dominates it (`dominantEngraveKind`),
  which is exact in practice — each sheet is single-kind.
- **Viewport colours are overridable per sheet, keyed by sheet name.**
  `uiStore` holds two sparse maps — `sheetColors` (plate body tone) and
  `engraveColors` (burn tone) — keyed by `manifest.sheets[].name`, not by a
  fixed role union, so a sheet the generator adds later gets its own entry
  with no code change. A missing key or `null` means "follow the palette",
  which is what keeps a palette switch moving every unpinned sheet. A sheet
  can appear in both maps: `land` is a plate that also carries the label.
  An `engraveColors` entry overrides that sheet's burn tone whatever the
  engrave kind — pinning a sheet means the whole sheet.
  Everything resolves through `materials.ts` (`sheetColorCss` /
  `engraveColorCss` and their `*Hex` twins) so flat and 3D cannot disagree.
  Live-ness is not special-cased: `<input type=color>` fires `input`
  continuously, `viewport.ts` already re-renders the flat canvas and calls
  `three.refreshUi()` on every `uiStore` write, and `applyUiState` retints
  the 3D materials in place rather than re-extruding.
  Water is *not* in either map — it is not a sheet, it is what shows through
  the cutouts, so it stays on `palette.water`.

## Out of scope (per the original brief, don't add unless asked)

Authentication, user accounts, routing, a service worker, a real test suite
(smoke-test level only), Docker, CI, deployment config.
