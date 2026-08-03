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
- **There is no `--layers N` flag.** Sheet count is implied by data
  (park geometry present?) and `config.layers.include_green_layer`, capped at
  3 sheets total (base/land/green). `left-panel.ts`'s stack editor exposes
  this honestly as a 2/3-sheet toggle, not a 2–5 selector.
- **Physical stack order ≠ sheet `index` order.** `index` is base=0, land=1,
  green=2, but the *physical* assembly (confirmed by reading the generator's
  own `preview.py`, which composites base's engraving on top of green on top
  of land) is: land at the bottom (nearest an under-mounted LED strip), green
  in the middle, base on top (it carries all the engraving, so it has to be
  the uncovered sheet to be visible at all). `three-view.ts`'s `ROLE_ORDER`
  encodes this. Get this wrong and the exploded 3D view stacks base *under*
  the land plate, which makes no physical sense — nothing above it could ever
  reveal the engraving.
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
  left-panel.ts         schema-driven param panel, generate header, stack editor
  place-search.ts       Nominatim search (debounced, localStorage-cached)
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
  `place-search.ts` relies on the automatic `Referer` header instead.
- `npm audit` reports a moderate/high advisory in Vite 5's bundled esbuild —
  dev-server-only (a CORS-adjacent issue affecting `vite dev`), doesn't touch
  the production build. Not upgraded to Vite 8 (breaking major) for this.
- The 3D engrave mesh is one merged mesh per sheet regardless of
  building/road/text kind (all tinted the same darker material tone) — kinds
  are still visually distinguishable by shape (fill vs. thin outline
  extrusion), just not by separate hue, to keep draw calls low.

## Out of scope (per the original brief, don't add unless asked)

Authentication, user accounts, routing, a service worker, a real test suite
(smoke-test level only), Docker, CI, deployment config.
