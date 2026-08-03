import type { ParsedPath, ParsedSheet, Ring } from './types';

const KNOWN_GROUPS = new Set(['cuts', 'engraves_building', 'engraves_road', 'engraves_text']);

// Parses one 'd' attribute into rings. Contract: absolute commands only,
// "M x,y L x,y ... Z" per subpath, one ring per subpath (exterior first,
// holes as additional subpaths within the same path element).
function parsePathD(d: string): Ring[] {
  const rings: Ring[] = [];
  // Split on 'M' (a new subpath), keep the coordinate text following it up
  // to the next M or end of string.
  const subpaths = d.split(/(?=M)/g).map((s) => s.trim()).filter(Boolean);
  for (const sub of subpaths) {
    const body = sub.replace(/^M/, '').replace(/Z\s*$/, '');
    const coordRe = /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g;
    const points: [number, number][] = [];
    let m: RegExpExecArray | null;
    while ((m = coordRe.exec(body)) !== null) {
      points.push([parseFloat(m[1]), parseFloat(m[2])]);
    }
    if (points.length >= 2) rings.push({ points });
  }
  return rings;
}

export function parseSheetSvg(svgText: string, index: number, name: string, filename: string): ParsedSheet {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  const widthAttr = svg.getAttribute('width') || '';
  const sizeMm = parseFloat(widthAttr.replace('mm', '')) || 0;

  const paths: ParsedPath[] = [];
  const groups = Array.from(svg.querySelectorAll(':scope > g'));
  for (const g of groups) {
    const id = g.getAttribute('id') || '';
    if (!KNOWN_GROUPS.has(id)) continue;
    const pathEls = Array.from(g.querySelectorAll(':scope > path'));
    for (const pathEl of pathEls) {
      const d = pathEl.getAttribute('d') || '';
      if (!d) continue;
      const rings = parsePathD(d);
      if (rings.length === 0) continue;
      paths.push({ rings, group: id });
    }
  }

  return { index, name, filename, sizeMm, paths };
}
