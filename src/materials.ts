// Material palettes for the viewport. This is the one part of the UI allowed
// saturation/hue variety -- everything else stays neutral so these colors
// read truthfully (see brief's VISUAL DESIGN section).

export interface Palette {
  water: string;
  land: string;
  landEdge: string;
  green: string;
  greenEdge: string;
  base: string; // sheet material tone, used for the 3D base sheet body
  engraveBuilding: string;
  engraveRoad: string;
  engraveText: string;
}

export type EngraveKind = 'building' | 'road' | 'text';

// Colour overrides picked in the layers editor, keyed by *sheet name* -- the
// manifest's own identifier for a sheet. Keyed by name rather than by a fixed
// role union so a sheet the generator adds later (a third road sheet, say)
// gets its own entry with no code change here. `null` or a missing key means
// "follow whatever the active palette says", so switching palette still moves
// every sheet the user has not pinned.
//
// Two separate maps because a sheet can contribute two visible colours: `land`
// is a plate (body tone) that also carries the label (burn tone).
export type SheetColorOverrides = Record<string, string | null>;

export const PALETTES: Record<'birch' | 'walnut' | 'dark', Palette> = {
  birch: {
    water: '#1e3a4c',
    land: '#d9c79c',
    landEdge: '#00000022',
    green: '#9aab7a',
    greenEdge: '#00000022',
    base: '#e3d3a8',
    engraveBuilding: '#8a6f3f',
    engraveRoad: '#6b5230',
    engraveText: '#4a3a22',
  },
  walnut: {
    water: '#152736',
    land: '#8a6042',
    landEdge: '#00000033',
    green: '#6f8a55',
    greenEdge: '#00000033',
    base: '#7a5238',
    engraveBuilding: '#3f2a1a',
    engraveRoad: '#2e1f13',
    engraveText: '#20150d',
  },
  dark: {
    water: '#0c1a24',
    land: '#4a4136',
    landEdge: '#00000044',
    green: '#48533c',
    greenEdge: '#00000044',
    base: '#3a332a',
    engraveBuilding: '#18140f',
    engraveRoad: '#100d0a',
    engraveText: '#0a0806',
  },
};

// Palette tones a plate sheet can take. A sheet name with no tone of its own
// falls back to the base tone -- it is plywood either way, and inventing a
// fourth hue for it would break the palette (see the design-token rule).
const PLATE_TONE: Record<string, 'base' | 'land' | 'green'> = {
  base: 'base',
  land: 'land',
  green: 'green',
};

function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}

// The palette's own body tone for a sheet, ignoring any override.
export function paletteSheetColor(palette: Palette, sheetName: string): string {
  return palette[PLATE_TONE[sheetName] ?? 'base'];
}

// The palette's own burn tone for an engrave kind, ignoring any override.
export function paletteEngraveColor(palette: Palette, kind: EngraveKind): string {
  if (kind === 'building') return palette.engraveBuilding;
  if (kind === 'road') return palette.engraveRoad;
  return palette.engraveText;
}

// The edge line drawn around a filled plate. Not overridable: it is a hairline
// separator, not a material tone.
export function plateEdgeColor(palette: Palette, sheetName: string): string {
  return sheetName === 'green' ? palette.greenEdge : palette.landEdge;
}

// Body tone per sheet: the user's override if they pinned one in the layers
// editor, otherwise the palette's. Both views resolve through here so a swatch
// change shows identically in flat and 3D.
export function sheetColorCss(
  palette: Palette,
  sheetName: string,
  overrides?: SheetColorOverrides | null,
): string {
  const override = overrides?.[sheetName];
  return isHex(override) ? override : paletteSheetColor(palette, sheetName);
}

export function sheetColorHex(
  palette: Palette,
  sheetName: string,
  overrides?: SheetColorOverrides | null,
): number {
  return parseInt(sheetColorCss(palette, sheetName, overrides).replace('#', ''), 16);
}

// Burn tone for one sheet's engraving. A sheet-level override wins over the
// per-kind palette tone for everything that sheet engraves -- pinning "roads ·
// narrow" to a colour means that whole sheet, not just its road group.
export function engraveColorCss(
  palette: Palette,
  kind: EngraveKind,
  sheetName?: string,
  overrides?: SheetColorOverrides | null,
): string {
  const override = sheetName ? overrides?.[sheetName] : undefined;
  return isHex(override) ? override : paletteEngraveColor(palette, kind);
}

export function engraveColorHex(
  palette: Palette,
  kind: EngraveKind,
  sheetName?: string,
  overrides?: SheetColorOverrides | null,
): number {
  return parseInt(engraveColorCss(palette, kind, sheetName, overrides).replace('#', ''), 16);
}
