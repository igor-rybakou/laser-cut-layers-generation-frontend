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

export type SheetRole = 'base' | 'land' | 'green';

// Per-role tint overrides picked in the stack editor. `null` = follow whatever
// the active palette says, so switching palette still moves untouched roles.
export type SheetColorOverrides = Record<SheetRole, string | null>;

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

// The palette's own tone for a role, ignoring any user override.
export function paletteSheetColor(palette: Palette, role: SheetRole): string {
  const map: Record<SheetRole, string> = {
    base: palette.base,
    land: palette.land,
    green: palette.green,
  };
  return map[role];
}

// Material tone per sheet role: the user's override if they picked one in the
// stack editor, otherwise the palette's. Both views resolve through here so a
// swatch change shows identically in flat and 3D.
export function sheetColorCss(
  palette: Palette,
  role: SheetRole,
  overrides?: SheetColorOverrides | null,
): string {
  const override = overrides?.[role];
  if (typeof override === 'string' && /^#[0-9a-f]{6}$/i.test(override)) return override;
  return paletteSheetColor(palette, role);
}

export function sheetColorHex(
  palette: Palette,
  role: SheetRole,
  overrides?: SheetColorOverrides | null,
): number {
  return parseInt(sheetColorCss(palette, role, overrides).replace('#', ''), 16);
}

export function engraveColorHex(palette: Palette, kind: 'building' | 'road' | 'text'): number {
  const map: Record<string, string> = {
    building: palette.engraveBuilding,
    road: palette.engraveRoad,
    text: palette.engraveText,
  };
  return parseInt(map[kind].replace('#', ''), 16);
}
