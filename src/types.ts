// Mirrors workbench/schema.py's descriptor shape exactly (GET /api/schema).
export interface SchemaField {
  name: string;
  path: string; // dotted location in the POST /api/generate body
  // 'enum_list' is a multi-select over `enum` whose value is an array
  // (currently only include_layers.roads). `min` is the minimum number of
  // entries the backend will accept, not a numeric bound.
  type: 'number' | 'integer' | 'string' | 'boolean' | 'enum' | 'enum_list';
  default: unknown;
  min?: number | null;
  max?: number | null;
  unit?: string | null;
  group: string;
  description: string;
  enum?: string[];
}

// Mirrors workbench/jobs.py FileEntry / JobRecord.
export interface FileEntry {
  name: string;
  size: number;
  url: string;
}

export interface SheetManifest {
  index: number;
  name: string;
  filename: string;
  thickness_mm: number;
  piece_count: number;
  smallest_piece_mm2: number;
  narrowest_neck_mm: number;
  cut_length_mm: number;
  engrave_outline_mm: number;
  engrave_fill_mm2: number;
  bbox: [number, number, number, number];
  flags: string[];
  removed: { pieces: number; area_mm2: number };
  // Optional: older generator builds omit both. `operation` is 'cut' for a
  // real plywood sheet and 'engrave' for a pass that is burned onto the top
  // sheet rather than cut out of its own (the road passes) -- its `cuts`
  // group is only the boundary circle, used as a registration outline.
  operation?: 'cut' | 'engrave';
  stack_index?: number;
}

export interface Manifest {
  version: string;
  generated_at: string;
  params: Record<string, unknown>;
  canvas: { size_mm: number; shape: string };
  source: { lat: number; lng: number; radius_m: number; place_name: string };
  sheets: SheetManifest[];
}

export type JobStatus = 'ok' | 'error' | 'timeout';

export interface JobRecord {
  job_id: string;
  status: JobStatus;
  params: Record<string, unknown>;
  created_at: string;
  duration_s: number;
  manifest: Manifest | null;
  files: FileEntry[];
  stdout: string;
  stderr: string;
  returncode: number | null;
}

export interface GenerateResponse {
  job_id: string;
  cached: boolean;
}

export interface HealthResponse {
  status: string;
  generator_path: { path: string; exists: boolean };
  interpreter: { path: string; resolved_from: string };
  help_check: { ok: boolean; returncode: number };
  data_dir: string;
  timeout_s: number;
  max_jobs: number;
  jobs_count: number;
}

// Sugar for the three unrelated config keys that decide which optional
// sheets a run emits (workbench/params.py's LayerSelection).
//
// `green` and `buildings` are *aliases* of config.layers.include_green_layer
// and config.buildings.enabled, and sending an alias together with its config
// key is a 422 -- the backend refuses to pick a winner. This app therefore
// only ever writes the config keys for those two, and uses this object for
// `roads` alone, which has no config-level equivalent.
export interface LayerSelection {
  green?: boolean;
  buildings?: boolean;
  roads?: string[]; // never empty: the generator refuses zero road sheets
}

// The nested request body for POST /api/generate, built from the flat
// schema field paths. Matches workbench/params.py's GenerateParams 1:1.
export interface GenerateParamsBody {
  lat?: number;
  lng?: number;
  radius?: number;
  size?: number;
  place_name?: string | null;
  land_polygons?: string | null;
  include_layers?: LayerSelection;
  config?: Record<string, unknown>;
}

export interface PresetMap {
  [name: string]: GenerateParamsBody;
}

// ---- Parsed geometry (from sheet SVGs) ------------------------------------

export interface Ring {
  points: [number, number][]; // mm, SVG space (Y down)
}

export interface ParsedPath {
  rings: Ring[]; // ring[0] = exterior, rest = holes
  group: string; // 'cuts' | 'engraves_building' | 'engraves_road' | 'engraves_text'
}

export interface ParsedSheet {
  index: number;
  name: string;
  filename: string;
  sizeMm: number;
  paths: ParsedPath[];
}

// ---- Defect markers ---------------------------------------------------

export interface DefectMarker {
  kind: 'narrow_neck' | 'tiny_piece' | 'out_of_bounds';
  sheetIndex: number;
  x: number;
  y: number;
  label: string;
}

export interface RemovedBanner {
  sheetIndex: number;
  sheetName: string;
  pieces: number;
  area_mm2: number;
}

// ---- Snapshots ----------------------------------------------------------

export interface Snapshot {
  id: string;
  createdAt: string;
  thumbnail: string; // data URL
  params: GenerateParamsBody;
}
