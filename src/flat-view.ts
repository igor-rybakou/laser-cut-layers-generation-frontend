import { boundaryForSheet } from './geometry';
import { PALETTES, sheetColorCss } from './materials';
import { uiStore } from './state';
import type { DefectMarker, Manifest, ParsedPath, ParsedSheet } from './types';

interface Camera {
  x: number; // pan offset in canvas px
  y: number;
  scale: number; // canvas px per mm
}

const CAMERA_KEY = 'workbench.flatCamera';

function loadCamera(): Camera | null {
  try {
    const raw = localStorage.getItem(CAMERA_KEY);
    return raw ? (JSON.parse(raw) as Camera) : null;
  } catch {
    return null;
  }
}

function saveCamera(c: Camera): void {
  try {
    localStorage.setItem(CAMERA_KEY, JSON.stringify(c));
  } catch {
    /* best effort */
  }
}

function ringPath2D(points: [number, number][]): Path2D {
  const p = new Path2D();
  if (points.length === 0) return p;
  p.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) p.lineTo(points[i][0], points[i][1]);
  p.closePath();
  return p;
}

function pathToPath2D(path: ParsedPath): Path2D {
  const p = new Path2D();
  for (const ring of path.rings) {
    p.addPath(ringPath2D(ring.points));
  }
  return p;
}

export class FlatView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private camera: Camera;
  private sheets: ParsedSheet[] = [];
  private manifest: Manifest | null = null;
  private defects: DefectMarker[] = [];
  private ro: ResizeObserver;
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };

  constructor(private container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'flat-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.camera = loadCamera() ?? { x: 0, y: 0, scale: 1 };

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();

    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => this.onPointerUp());
  }

  canvasEl(): HTMLCanvasElement {
    return this.canvas;
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  fitToBoundary(sizeMm: number): void {
    const rect = this.container.getBoundingClientRect();
    const margin = 40;
    const scale = Math.max(0.01, Math.min((rect.width - margin * 2) / sizeMm, (rect.height - margin * 2) / sizeMm));
    // Sheet-local geometry spans world [0, sizeMm] in both axes (uncentered,
    // matching the raw SVG coordinate space) -- center its midpoint, not the
    // world origin, on screen.
    const half = sizeMm / 2;
    this.camera = { x: rect.width / 2 - scale * half, y: rect.height / 2 - scale * half, scale };
    saveCamera(this.camera);
    this.render();
  }

  setData(sheets: ParsedSheet[], manifest: Manifest | null, defects: DefectMarker[]): void {
    const firstLoad = this.sheets.length === 0 && sheets.length > 0;
    this.sheets = sheets;
    this.manifest = manifest;
    this.defects = defects;
    if (firstLoad && manifest) this.fitToBoundary(manifest.canvas.size_mm);
    this.render();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.001);
    const worldX = (mx - this.camera.x) / this.camera.scale;
    const worldY = (my - this.camera.y) / this.camera.scale;
    this.camera.scale = Math.max(0.02, Math.min(50, this.camera.scale * factor));
    this.camera.x = mx - worldX * this.camera.scale;
    this.camera.y = my - worldY * this.camera.scale;
    saveCamera(this.camera);
    this.render();
  }

  private onPointerDown(e: PointerEvent): void {
    this.dragging = true;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastPointer.x;
    const dy = e.clientY - this.lastPointer.y;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.camera.x += dx;
    this.camera.y += dy;
    this.render();
  }

  private onPointerUp(): void {
    if (this.dragging) saveCamera(this.camera);
    this.dragging = false;
  }

  private worldTransform(): void {
    const { x, y, scale } = this.camera;
    this.ctx.setTransform(
      (window.devicePixelRatio || 1) * scale,
      0,
      0,
      (window.devicePixelRatio || 1) * scale,
      (window.devicePixelRatio || 1) * x,
      (window.devicePixelRatio || 1) * y,
    );
  }

  render(): void {
    const ctx = this.ctx;
    const rect = this.container.getBoundingClientRect();
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#101215';
    ctx.fillRect(0, 0, rect.width, rect.height);

    if (!this.manifest) {
      ctx.fillStyle = '#878d96';
      ctx.font = '14px "Barlow Condensed", sans-serif';
      ctx.fillText('Press Generate to render the first map.', 24, 32);
      return;
    }

    const ui = uiStore.get();
    const palette = PALETTES[ui.materialPalette];
    const { shape, size_mm } = this.manifest.canvas;

    this.worldTransform();

    // Water background: the physical boundary shape, sitting under everything.
    const boundary = boundaryForSheet(shape, size_mm);
    ctx.fillStyle = palette.water;
    ctx.fill(ringPath2D(boundary));

    const land = this.sheets.find((s) => s.name === 'land');
    const green = this.sheets.find((s) => s.name === 'green');
    const base = this.sheets.find((s) => s.name === 'base');

    const selected = ui.selectedSheet;
    const dim = (idx: number) => selected != null && selected !== idx;

    if (land && ui.showCuts) {
      ctx.globalAlpha = dim(land.index) ? 0.25 : 1;
      ctx.fillStyle = sheetColorCss(palette, 'land', ui.sheetColors);
      ctx.strokeStyle = palette.landEdge;
      ctx.lineWidth = 0.3 / this.camera.scale;
      for (const p of land.paths.filter((p) => p.group === 'cuts')) {
        const p2d = pathToPath2D(p);
        ctx.fill(p2d, 'evenodd');
        ctx.stroke(p2d);
      }
      ctx.globalAlpha = 1;
    }

    if (green && ui.showCuts) {
      ctx.globalAlpha = dim(green.index) ? 0.25 : 1;
      ctx.fillStyle = sheetColorCss(palette, 'green', ui.sheetColors);
      for (const p of green.paths.filter((p) => p.group === 'cuts')) {
        ctx.fill(pathToPath2D(p), 'evenodd');
      }
      ctx.globalAlpha = 1;
    }

    if (base && ui.showEngraves) {
      ctx.globalAlpha = dim(base.index) ? 0.25 : 1;
      const buildings = base.paths.filter((p) => p.group === 'engraves_building');
      ctx.fillStyle = palette.engraveBuilding;
      for (const p of buildings) ctx.fill(pathToPath2D(p), 'evenodd');

      ctx.strokeStyle = palette.engraveRoad;
      ctx.lineWidth = Math.max(0.15, 0.5 / this.camera.scale);
      for (const p of base.paths.filter((p) => p.group === 'engraves_road')) {
        ctx.stroke(pathToPath2D(p));
      }

      ctx.strokeStyle = palette.engraveText;
      ctx.lineWidth = Math.max(0.1, 0.3 / this.camera.scale);
      for (const p of base.paths.filter((p) => p.group === 'engraves_text')) {
        ctx.stroke(pathToPath2D(p));
      }
      ctx.globalAlpha = 1;
    }

    // Outer edge of the piece.
    ctx.strokeStyle = '#2f343a';
    ctx.lineWidth = 0.5 / this.camera.scale;
    ctx.stroke(ringPath2D(boundary));

    this.renderDefects(ctx, ui);
  }

  private renderDefects(ctx: CanvasRenderingContext2D, ui: ReturnType<typeof uiStore.get>): void {
    const r = 1.2 / this.camera.scale;
    for (const d of this.defects) {
      if (d.kind === 'narrow_neck' && !ui.showNarrowNeck) continue;
      if (d.kind === 'tiny_piece' && !ui.showTinyPiece) continue;
      if (d.kind === 'out_of_bounds' && !ui.showOutOfBounds) continue;

      const color = d.kind === 'narrow_neck' ? '#ff5c47' : d.kind === 'tiny_piece' ? '#e8a33d' : '#e34fe0';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(0.15, 0.4 / this.camera.scale);
      ctx.beginPath();
      ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
      if (d.kind === 'narrow_neck') ctx.fill();
      else ctx.stroke();

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const screenX = d.x * this.camera.scale + this.camera.x;
      const screenY = d.y * this.camera.scale + this.camera.y;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillStyle = color;
      ctx.fillText(d.label, screenX + 6, screenY - 6);
      ctx.restore();
    }
  }

  dispose(): void {
    this.ro.disconnect();
    this.canvas.remove();
  }
}
