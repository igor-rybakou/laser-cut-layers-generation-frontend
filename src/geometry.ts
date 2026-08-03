import type { ParsedPath, ParsedSheet } from './types';

export function ringArea(points: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pathArea(p: ParsedPath): number {
  if (p.rings.length === 0) return 0;
  let a = Math.abs(ringArea(p.rings[0].points));
  for (let i = 1; i < p.rings.length; i++) a -= Math.abs(ringArea(p.rings[i].points));
  return Math.max(0, a);
}

export function pathBounds(p: ParsedPath): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of p.rings) {
    for (const [x, y] of ring.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

export function pointInRing(px: number, py: number, points: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInPath(px: number, py: number, p: ParsedPath): boolean {
  if (p.rings.length === 0) return false;
  if (!pointInRing(px, py, p.rings[0].points)) return false;
  for (let i = 1; i < p.rings.length; i++) {
    if (pointInRing(px, py, p.rings[i].points)) return false;
  }
  return true;
}

// Distance from point to segment.
export function distPointSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Circle boundary for the given canvas size (matches mapgen.layers.make_boundary).
export function circleBoundary(sizeMm: number, segments = 128): [number, number][] {
  const half = sizeMm / 2;
  const pts: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    pts.push([half + half * Math.cos(theta), half + half * Math.sin(theta)]);
  }
  return pts;
}

export function rectBoundary(sizeMm: number): [number, number][] {
  return [
    [0, 0],
    [sizeMm, 0],
    [sizeMm, sizeMm],
    [0, sizeMm],
  ];
}

export function boundaryForSheet(shape: string, sizeMm: number): [number, number][] {
  return shape === 'rectangle' ? rectBoundary(sizeMm) : circleBoundary(sizeMm);
}

export function findSheet(sheets: ParsedSheet[], index: number): ParsedSheet | undefined {
  return sheets.find((s) => s.index === index);
}
