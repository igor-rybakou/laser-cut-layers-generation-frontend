import type { SheetManifest } from './types';

export interface MachineTimeSettings {
  cutSpeedMmPerS: number;
  engraveSpeedMmPerS: number;
  lineStepMm: number;
  perPathOverheadS: number;
}

export const DEFAULT_MACHINE_TIME: MachineTimeSettings = {
  cutSpeedMmPerS: 15,
  engraveSpeedMmPerS: 40,
  lineStepMm: 0.1,
  perPathOverheadS: 0.4,
};

export function estimateSheetSeconds(
  sheet: SheetManifest,
  settings: MachineTimeSettings,
): number {
  const cutS = sheet.cut_length_mm / settings.cutSpeedMmPerS;
  const engraveOutlineS = sheet.engrave_outline_mm / settings.engraveSpeedMmPerS;
  const fillLineLengthMm = sheet.engrave_fill_mm2 / Math.max(settings.lineStepMm, 0.001);
  const fillS = fillLineLengthMm / settings.engraveSpeedMmPerS;
  const overheadS = sheet.piece_count * settings.perPathOverheadS;
  return cutS + engraveOutlineS + fillS + overheadS;
}

export function estimateTotalSeconds(sheets: SheetManifest[], settings: MachineTimeSettings): number {
  return sheets.reduce((sum, s) => sum + estimateSheetSeconds(s, settings), 0);
}
