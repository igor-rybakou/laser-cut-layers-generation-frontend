import { store } from './store';
import { pruneRetiredPaths } from './paths';
import { DEFAULT_MACHINE_TIME, type MachineTimeSettings } from './machine-time';
import type { SheetColorOverrides } from './materials';
import type {
  GenerateParamsBody,
  HealthResponse,
  JobRecord,
  ParsedSheet,
  SchemaField,
  Snapshot,
} from './types';

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage full/unavailable -- nothing this tool can do about it, and
    // it must not crash the run loop over it.
  }
}

// ---- Schema / params ------------------------------------------------------

export const schemaStore = store<SchemaField[]>([]);

const DEFAULT_PARAMS: GenerateParamsBody = {
  lat: 38.679,
  lng: -9.1569,
  radius: 1500,
  size: 300,
};

// Pruned on the way in as well as on every preset/snapshot load: a params blob
// persisted against an older backend can carry keys the current one refuses
// outright (see pruneRetiredPaths), and the failure mode is a 422 on the whole
// request rather than an ignored field.
export const paramsStore = store<GenerateParamsBody>(
  pruneRetiredPaths(loadJSON('workbench.params', DEFAULT_PARAMS) as Record<string, unknown>) as GenerateParamsBody,
);
paramsStore.subscribe((v) => saveJSON('workbench.params', v), false);

// ---- Backend health --------------------------------------------------------

export type HealthState =
  | { kind: 'checking' }
  | { kind: 'ok'; health: HealthResponse }
  | { kind: 'unreachable'; url: string };

export const healthStore = store<HealthState>({ kind: 'checking' });

// ---- Generation lifecycle --------------------------------------------------

export type GenerationState =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: number; params: GenerateParamsBody }
  | { kind: 'done'; job: JobRecord; fromCache: boolean; wasForced: boolean }
  | { kind: 'timeout'; params: GenerateParamsBody }
  | { kind: 'error'; job: JobRecord };

export const generationStore = store<GenerationState>({ kind: 'idle' });

export const currentJobStore = store<JobRecord | null>(null);
export const parsedSheetsStore = store<ParsedSheet[]>([]);
export const lastJobDurationStore = store<number | null>(null);
export const lastFromCacheStore = store<boolean>(false);

// ---- UI state ---------------------------------------------------------------

export interface UiState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  viewMode: 'flat' | 'stack';
  autoRegen: boolean;
  explode: number;
  backlightOn: boolean;
  backlightIntensity: number;
  materialPalette: 'birch' | 'walnut' | 'dark';
  // Per-sheet colour overrides from the layers editor's swatches, keyed by
  // sheet name. Absent/null = follow materialPalette, so switching palette
  // still moves every sheet the user has not pinned. Two maps because a sheet
  // can show two colours: `land` is a plate that also carries the label.
  sheetColors: SheetColorOverrides; // plate body tone
  engraveColors: SheetColorOverrides; // burn tone
  showCuts: boolean;
  showEngraves: boolean;
  showNarrowNeck: boolean;
  showTinyPiece: boolean;
  showOutOfBounds: boolean;
  selectedSheet: number | null;
  collapsedGroups: Record<string, boolean>;
}

const DEFAULT_UI: UiState = {
  leftCollapsed: false,
  rightCollapsed: false,
  viewMode: 'flat',
  autoRegen: false,
  explode: 0,
  backlightOn: false,
  backlightIntensity: 0.6,
  materialPalette: 'birch',
  sheetColors: {},
  engraveColors: {},
  showCuts: true,
  showEngraves: true,
  showNarrowNeck: true,
  showTinyPiece: true,
  showOutOfBounds: true,
  selectedSheet: null,
  collapsedGroups: {},
};

// The colour maps are merged key-by-key rather than replaced, so a UI blob
// persisted before either existed still yields a usable record. They are
// keyed by sheet name and sparse by design: an older blob's
// `{base: null, land: null, green: null}` needs no migration -- a null entry
// already means "follow the palette".
const PERSISTED_UI = loadJSON<Partial<UiState>>('workbench.ui', {});
export const uiStore = store<UiState>({
  ...DEFAULT_UI,
  ...PERSISTED_UI,
  sheetColors: { ...DEFAULT_UI.sheetColors, ...(PERSISTED_UI.sheetColors ?? {}) },
  engraveColors: { ...DEFAULT_UI.engraveColors, ...(PERSISTED_UI.engraveColors ?? {}) },
});
uiStore.subscribe((v) => saveJSON('workbench.ui', v), false);

// ---- Machine time settings ---------------------------------------------------

export const machineTimeStore = store<MachineTimeSettings>(
  loadJSON('workbench.machineTime', DEFAULT_MACHINE_TIME),
);
machineTimeStore.subscribe((v) => saveJSON('workbench.machineTime', v), false);

// ---- Snapshots -----------------------------------------------------------

export const snapshotsStore = store<Snapshot[]>(loadJSON('workbench.snapshots', []));
snapshotsStore.subscribe((v) => saveJSON('workbench.snapshots', v), false);

export const threeStatsStore = store<{ fps: number; drawCalls: number } | null>(null);

export function addSnapshot(thumbnail: string, params: GenerateParamsBody): void {
  const snap: Snapshot = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    thumbnail,
    params: JSON.parse(JSON.stringify(params)),
  };
  const next = [snap, ...snapshotsStore.get()].slice(0, 8);
  snapshotsStore.set(next);
}
