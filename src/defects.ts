import { distPointSegment, pathArea, pathBounds } from './geometry';
import type { DefectMarker, Manifest, ParsedPath, ParsedSheet, RemovedBanner } from './types';

const MAX_VERTICES_FOR_NECK_SCAN = 1500;
const NECK_ADJACENCY_SKIP = 2; // skip this many neighbours on either side of a vertex's own edges

// The neck threshold rule itself, mirroring mapgen/config.py's
// resolve_min_feature_width_mm. Exported so the stack editor can preview the
// same number off the pending params instead of re-deriving the rule.
export function deriveMinFeatureWidthMm(explicit: unknown, thicknessMm: number): number {
  if (typeof explicit === 'number') return explicit;
  return Math.max(2.0, thicknessMm * 0.85);
}

function effectiveMinFeatureWidthMm(manifest: Manifest, thicknessMm: number): number {
  const mf = (
    manifest.params?.config as Record<string, unknown> | undefined
  )?.['manufacturability'] as Record<string, unknown> | undefined;
  return deriveMinFeatureWidthMm(mf?.['min_feature_width_mm'], thicknessMm);
}

function minPieceAreaMm2(manifest: Manifest): number {
  const mf = (
    manifest.params?.config as Record<string, unknown> | undefined
  )?.['manufacturability'] as Record<string, unknown> | undefined;
  const v = mf?.['min_piece_area_mm2'];
  return typeof v === 'number' ? v : 25.0;
}

interface Edge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ringIdx: number;
  vertIdx: number; // index of vertex `a` within its ring
}

function collectEdges(p: ParsedPath): Edge[] {
  const edges: Edge[] = [];
  p.rings.forEach((ring, ringIdx) => {
    const pts = ring.points;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      edges.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], ringIdx, vertIdx: i });
    }
  });
  return edges;
}

function narrowNecksForSheet(sheet: ParsedSheet, thresholdMm: number): DefectMarker[] {
  const cutsPaths = sheet.paths.filter((p) => p.group === 'cuts');
  const candidates: { x: number; y: number; width: number }[] = [];

  for (const piece of cutsPaths) {
    const totalVerts = piece.rings.reduce((n, r) => n + r.points.length, 0);
    if (totalVerts === 0 || totalVerts > MAX_VERTICES_FOR_NECK_SCAN) continue;

    const edges = collectEdges(piece);

    piece.rings.forEach((ring, ringIdx) => {
      const pts = ring.points;
      const n = pts.length;
      for (let vi = 0; vi < n; vi++) {
        const [px, py] = pts[vi];
        let best = Infinity;
        for (const e of edges) {
          if (e.ringIdx === ringIdx) {
            const forward = (e.vertIdx - vi + n) % n;
            const backward = (vi - e.vertIdx + n) % n;
            if (Math.min(forward, backward) <= NECK_ADJACENCY_SKIP) continue;
          }
          const d = distPointSegment(px, py, e.ax, e.ay, e.bx, e.by);
          if (d < best) best = d;
        }
        const width = best * 2; // vertex-to-opposite-edge distance approximates the half-width of the neck
        if (width < thresholdMm) candidates.push({ x: px, y: py, width });
      }
    });
  }

  candidates.sort((a, b) => a.width - b.width);
  return candidates.slice(0, 20).map((c) => ({
    kind: 'narrow_neck' as const,
    sheetIndex: sheet.index,
    x: c.x,
    y: c.y,
    label: `${c.width.toFixed(2)} mm`,
  }));
}

function tinyPiecesForSheet(sheet: ParsedSheet, minAreaMm2: number): DefectMarker[] {
  const cutsPaths = sheet.paths.filter((p) => p.group === 'cuts');
  const out: DefectMarker[] = [];
  for (const piece of cutsPaths) {
    const area = pathArea(piece);
    if (area > 0 && area < minAreaMm2) {
      const [minX, minY, maxX, maxY] = pathBounds(piece);
      out.push({
        kind: 'tiny_piece',
        sheetIndex: sheet.index,
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        label: `${area.toFixed(1)} mm²`,
      });
    }
  }
  return out;
}

function outOfBoundsForSheet(sheet: ParsedSheet, shape: string, sizeMm: number): DefectMarker[] {
  const out: DefectMarker[] = [];
  const eps = 0.05;
  const half = sizeMm / 2;
  const isOutside = (x: number, y: number): boolean => {
    if (shape === 'rectangle') {
      return x < -eps || y < -eps || x > sizeMm + eps || y > sizeMm + eps;
    }
    const dx = x - half;
    const dy = y - half;
    return Math.hypot(dx, dy) > half + eps;
  };

  for (const p of sheet.paths) {
    let worst: { x: number; y: number; dist: number } | null = null;
    for (const ring of p.rings) {
      for (const [x, y] of ring.points) {
        if (!isOutside(x, y)) continue;
        const dist = shape === 'rectangle'
          ? Math.max(-x, -y, x - sizeMm, y - sizeMm)
          : Math.hypot(x - half, y - half) - half;
        if (!worst || dist > worst.dist) worst = { x, y, dist };
      }
    }
    if (worst) {
      out.push({
        kind: 'out_of_bounds',
        sheetIndex: sheet.index,
        x: worst.x,
        y: worst.y,
        label: `${worst.dist.toFixed(1)} mm outside`,
      });
    }
  }
  return out;
}

export function computeDefects(manifest: Manifest, sheets: ParsedSheet[]): DefectMarker[] {
  const out: DefectMarker[] = [];
  for (const sheet of sheets) {
    const sm = manifest.sheets.find((s) => s.index === sheet.index);
    const thickness = sm?.thickness_mm ?? 3;
    out.push(...narrowNecksForSheet(sheet, effectiveMinFeatureWidthMm(manifest, thickness)));
    out.push(...tinyPiecesForSheet(sheet, minPieceAreaMm2(manifest)));
    out.push(...outOfBoundsForSheet(sheet, manifest.canvas.shape, manifest.canvas.size_mm));
  }
  return out;
}

export function computeRemovedBanners(manifest: Manifest): RemovedBanner[] {
  return manifest.sheets
    .filter((s) => s.removed.pieces > 0 || s.removed.area_mm2 > 0)
    .map((s) => ({
      sheetIndex: s.index,
      sheetName: `${s.index.toString().padStart(2, '0')}_${s.name}`,
      pieces: s.removed.pieces,
      area_mm2: s.removed.area_mm2,
    }));
}
