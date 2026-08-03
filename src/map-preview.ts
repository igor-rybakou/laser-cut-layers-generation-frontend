// Slippy-map preview for picking the generation center, with the real
// generated footprint drawn on top.
//
// Hand-rolled (no Leaflet) for the same reason svg-parser.ts is hand-rolled:
// the contract is narrow and fully known. Web Mercator raster tiles, an
// in-memory tile cache, pan/zoom, and three overlay shapes.
//
// PROJECTION NOTE: the generator projects in UTM (mapgen/project.py), these
// tiles are Web Mercator. The two agree on scale only locally. At the radii
// this tool works at (~0.5-5 km) the divergence is far below one screen pixel,
// so the overlay is trustworthy -- but it is an approximation, not the same
// projection, and it would stop being trustworthy at tens of km.
//
// TILE POLICY NOTE: openstreetmap.org's tile servers require attribution
// (rendered below the canvas) and discourage bulk automated use. Like
// place-search.ts, this cannot send a descriptive User-Agent -- browsers
// forbid setting that header -- so Referer is again the only identification.
// Tiles are cached in memory and only fetched for the visible viewport.

import { el } from './controls';
import { updateParams } from './generate';
import { getPath } from './paths';
import { paramsStore } from './state';

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 19;
const EARTH_CIRCUMFERENCE_M = 40075016.686;
const MAX_CACHED_TILES = 400;
const ZOOM_KEY = 'workbench.mapZoom';

// ---- Web Mercator ---------------------------------------------------------
// Zoom is continuous in all four of these; only tile *selection* rounds it.

function lngToWorldX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

function latToWorldY(lat: number, zoom: number): number {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return y * TILE_SIZE * 2 ** zoom;
}

function worldXToLng(x: number, zoom: number): number {
  return (x / (TILE_SIZE * 2 ** zoom)) * 360 - 180;
}

function worldYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * 2 ** zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function metersPerPixel(lat: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** zoom);
}

// ---- Tile cache -----------------------------------------------------------

type TileState = { img: HTMLImageElement; loaded: boolean; failed: boolean };

const tiles = new Map<string, TileState>();

function getTile(z: number, x: number, y: number, onLoad: () => void): TileState {
  const key = `${z}/${x}/${y}`;
  const hit = tiles.get(key);
  if (hit) return hit;

  // No crossOrigin: nothing reads this canvas back as pixels, and requesting
  // CORS would turn a missing header into a tile that never loads at all.
  const img = new Image();
  const state: TileState = { img, loaded: false, failed: false };
  img.addEventListener('load', () => {
    state.loaded = true;
    onLoad();
  });
  img.addEventListener('error', () => {
    state.failed = true;
  });
  img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

  if (tiles.size >= MAX_CACHED_TILES) {
    // Map preserves insertion order, so the first key is the oldest fetch.
    const oldest = tiles.keys().next().value;
    if (oldest !== undefined) tiles.delete(oldest);
  }
  tiles.set(key, state);
  return state;
}

// ---- Params access --------------------------------------------------------

interface Footprint {
  lat: number;
  lng: number;
  radiusM: number;
  sizeMm: number;
  shape: 'circle' | 'rectangle';
}

function readFootprint(): Footprint {
  const p = paramsStore.get();
  const shape = getPath(p, 'config.layers.boundary_shape');
  return {
    lat: typeof p.lat === 'number' ? p.lat : 0,
    lng: typeof p.lng === 'number' ? p.lng : 0,
    radiusM: typeof p.radius === 'number' && p.radius > 0 ? p.radius : 1500,
    sizeMm: typeof p.size === 'number' && p.size > 0 ? p.size : 300,
    shape: shape === 'rectangle' ? 'rectangle' : 'circle',
  };
}

// ---- View -----------------------------------------------------------------

export class MapPreview {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readout: HTMLElement;
  private ro: ResizeObserver;

  private zoom: number;
  // The rendered center. Normally identical to params lat/lng; it only leads
  // them mid-drag, so the map can move smoothly without writing a param (and
  // triggering the 1.5s auto-regenerate) on every pointermove.
  private center: { lat: number; lng: number };

  private dragging = false;
  private moved = false;
  private lastPointer = { x: 0, y: 0 };
  private raf = 0;

  constructor(private container: HTMLElement) {
    const fp = readFootprint();
    this.center = { lat: fp.lat, lng: fp.lng };
    this.zoom = this.loadZoom(fp);

    this.canvas = el('canvas', 'map-canvas') as HTMLCanvasElement;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.readout = el('div', 'map-readout');
    container.appendChild(this.readout);

    // Observe the canvas, not the container: the canvas is CSS-sized, so
    // writing its backing-store width/height here can never feed back into the
    // observed box the way resizing the container would.
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);

    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', () => this.onPointerCancel());

    paramsStore.subscribe(() => {
      if (this.dragging) return;
      const next = readFootprint();
      if (next.lat !== this.center.lat || next.lng !== this.center.lng) {
        this.center = { lat: next.lat, lng: next.lng };
      }
      this.requestRender();
    }, false);

    this.resize();
  }

  private loadZoom(fp: Footprint): number {
    const raw = Number(localStorage.getItem(ZOOM_KEY));
    if (Number.isFinite(raw) && raw >= MIN_ZOOM && raw <= MAX_ZOOM) return raw;
    return this.zoomThatFits(fp, 300, 200);
  }

  private saveZoom(): void {
    try {
      localStorage.setItem(ZOOM_KEY, String(this.zoom));
    } catch {
      /* best effort */
    }
  }

  // Zoom at which the 2*radius footprint square fills ~80% of the shorter side.
  private zoomThatFits(fp: Footprint, w: number, h: number): number {
    const target = Math.min(w, h) * 0.8;
    const wanted = (2 * fp.radiusM) / target; // meters per pixel we need
    const atZoom0 = (EARTH_CIRCUMFERENCE_M * Math.cos((fp.lat * Math.PI) / 180)) / TILE_SIZE;
    const z = Math.log2(atZoom0 / wanted);
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  }

  fit(): void {
    const fp = readFootprint();
    this.center = { lat: fp.lat, lng: fp.lng };
    this.zoom = this.zoomThatFits(
      fp,
      this.canvas.clientWidth || 300,
      this.canvas.clientHeight || 200,
    );
    this.saveZoom();
    this.requestRender();
  }

  zoomBy(delta: number): void {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom + delta));
    this.saveZoom();
    this.requestRender();
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.requestRender();
  }

  private requestRender(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  // ---- Interaction --------------------------------------------------------

  private screenToLatLng(px: number, py: number, w: number, h: number): { lat: number; lng: number } {
    const cx = lngToWorldX(this.center.lng, this.zoom);
    const cy = latToWorldY(this.center.lat, this.zoom);
    return {
      lng: worldXToLng(cx + (px - w / 2), this.zoom),
      lat: worldYToLat(cy + (py - h / 2), this.zoom),
    };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const under = this.screenToLatLng(px, py, rect.width, rect.height);

    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom - e.deltaY * 0.002));

    // Keep the point under the cursor pinned across the zoom change.
    const ux = lngToWorldX(under.lng, this.zoom);
    const uy = latToWorldY(under.lat, this.zoom);
    this.center = {
      lng: worldXToLng(ux - (px - rect.width / 2), this.zoom),
      lat: worldYToLat(uy - (py - rect.height / 2), this.zoom),
    };
    this.saveZoom();
    this.requestRender();
  }

  private onPointerDown(e: PointerEvent): void {
    this.dragging = true;
    this.moved = false;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastPointer.x;
    const dy = e.clientY - this.lastPointer.y;
    if (dx !== 0 || dy !== 0) this.moved = true;
    this.lastPointer = { x: e.clientX, y: e.clientY };

    const cx = lngToWorldX(this.center.lng, this.zoom) - dx;
    const cy = latToWorldY(this.center.lat, this.zoom) - dy;
    this.center = { lng: worldXToLng(cx, this.zoom), lat: worldYToLat(cy, this.zoom) };
    this.requestRender();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.moved) {
      // A drag re-centers. A click without movement does not -- misclicking a
      // map that regenerates on a 1.5s debounce is an expensive accident.
      this.commitCenter();
    }
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  private onPointerCancel(): void {
    this.dragging = false;
    const fp = readFootprint();
    this.center = { lat: fp.lat, lng: fp.lng };
    this.requestRender();
  }

  private commitCenter(): void {
    const lat = Number(this.center.lat.toFixed(6));
    const lng = Number(this.center.lng.toFixed(6));
    this.center = { lat, lng };
    updateParams((draft) => {
      draft.lat = lat;
      draft.lng = lng;
    });
  }

  // ---- Render -------------------------------------------------------------

  render(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#101215';
    ctx.fillRect(0, 0, w, h);

    this.drawTiles(ctx, w, h);
    this.drawFootprint(ctx, w, h);
    this.drawReadout();
  }

  private drawTiles(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const tz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(this.zoom)));
    const scale = 2 ** (this.zoom - tz);
    const tilePx = TILE_SIZE * scale;
    const n = 2 ** tz;

    const cx = lngToWorldX(this.center.lng, tz) * scale;
    const cy = latToWorldY(this.center.lat, tz) * scale;
    const originX = w / 2 - cx;
    const originY = h / 2 - cy;

    const x0 = Math.floor(-originX / tilePx);
    const x1 = Math.floor((w - originX) / tilePx);
    const y0 = Math.floor(-originY / tilePx);
    const y1 = Math.floor((h - originY) / tilePx);

    ctx.imageSmoothingEnabled = true;
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = x0; tx <= x1; tx++) {
        const wrapped = ((tx % n) + n) % n;
        const state = getTile(tz, wrapped, ty, () => this.requestRender());
        const sx = originX + tx * tilePx;
        const sy = originY + ty * tilePx;
        if (state.loaded) {
          // +1px covers the seam fractional scaling leaves between tiles.
          ctx.drawImage(state.img, sx, sy, tilePx + 1, tilePx + 1);
        } else if (!state.failed) {
          ctx.fillStyle = '#1a1d21';
          ctx.fillRect(sx, sy, tilePx, tilePx);
        }
      }
    }
  }

  private drawFootprint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const fp = readFootprint();
    const mpp = metersPerPixel(this.center.lat, this.zoom);
    if (!Number.isFinite(mpp) || mpp <= 0) return;

    const radiusPx = fp.radiusM / mpp;
    // The canvas is a real-world square of side 2*radius (mapgen/project.py's
    // Projector docstring) -- that square is both the OSM fetch extent and the
    // full sheet. The cut boundary is inscribed in it, or is it.
    const halfPx = radiusPx;

    // The footprint is always drawn at the viewport center: the crosshair is
    // the thing being aimed, and the map slides under it during a drag, so
    // what you see framed on release is exactly what gets generated.
    const cx = w / 2;
    const cy = h / 2;

    // Everything outside the fetch square is dimmed rather than outlined only:
    // the discarded area is the thing that surprises people.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.rect(cx - halfPx, cy - halfPx, halfPx * 2, halfPx * 2);
    ctx.fillStyle = 'rgba(16, 18, 21, 0.55)';
    ctx.fill('evenodd');
    ctx.restore();

    // Fetch / canvas extent.
    ctx.strokeStyle = '#878d96';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(cx - halfPx, cy - halfPx, halfPx * 2, halfPx * 2);
    ctx.setLineDash([]);

    // The actual outer cut.
    ctx.strokeStyle = '#e8a33d';
    ctx.lineWidth = 1.5;
    if (fp.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(cx - halfPx, cy - halfPx, halfPx * 2, halfPx * 2);
    }

    // Center crosshair.
    ctx.strokeStyle = '#e8a33d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.stroke();
  }

  private drawReadout(): void {
    const fp = readFootprint();
    const mPerMm = (2 * fp.radiusM) / fp.sizeMm;
    // Coordinates come from the rendered center so they track a drag live;
    // everything else is params, which a drag does not touch until release.
    this.readout.textContent =
      `${this.center.lat.toFixed(4)}, ${this.center.lng.toFixed(4)} · ` +
      `${(2 * fp.radiusM).toFixed(0)} m across · 1 mm = ${mPerMm.toFixed(1)} m`;
    this.readout.title =
      'Canvas is a real-world square of side 2 × radius; the cut boundary is ' +
      'inscribed in it. Scale is size_mm / (2 × radius).';
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.remove();
  }
}

export function mountMapPreview(parent: HTMLElement): MapPreview {
  const wrap = el('div', 'map-preview');
  parent.appendChild(wrap);

  const stage = el('div', 'map-stage');
  wrap.appendChild(stage);

  const map = new MapPreview(stage);

  const hud = el('div', 'map-hud');
  const mkBtn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', 'map-btn', label) as HTMLButtonElement;
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };
  hud.appendChild(mkBtn('−', 'zoom out', () => map.zoomBy(-1)));
  hud.appendChild(mkBtn('+', 'zoom in', () => map.zoomBy(1)));
  hud.appendChild(mkBtn('fit', 'recenter on lat/lng and frame the footprint', () => map.fit()));
  stage.appendChild(hud);

  const attr = el('div', 'map-attr');
  const link = el('a', undefined, '© OpenStreetMap contributors') as HTMLAnchorElement;
  link.href = 'https://www.openstreetmap.org/copyright';
  link.target = '_blank';
  link.rel = 'noreferrer';
  attr.appendChild(link);
  wrap.appendChild(attr);

  return map;
}
