// Get/set a value in a plain nested object tree by dotted path, e.g.
// "config.material.thickness_mm.0" -- every segment is treated as a plain
// object key (never an array index), matching the JSON shapes the backend
// actually accepts (dict[str, float] for thickness_mm, keyed by "0"/"1"/"2").

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export function deepClone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

// Paths the backend used to accept and now rejects outright. Its request models
// are `extra="forbid"`, so a stale key is a 422 for the whole request, not an
// ignored field -- and these blobs outlive a backend upgrade in localStorage
// (persisted params, snapshots) and in the preset store.
//
// config.layers.road_widths_mm moved to config.roads.sheets.<name>.class_widths_mm
// per road sheet. It is dropped rather than migrated: the old flat map has no
// sheet to belong to, and guessing one would silently re-width roads.
const RETIRED_PATHS = ['config.layers.road_widths_mm'];

export function pruneRetiredPaths<T extends Record<string, unknown>>(body: T): T {
  for (const path of RETIRED_PATHS) {
    const parts = path.split('.');
    let cur: Record<string, unknown> | undefined = body;
    const chain: Record<string, unknown>[] = [];
    for (let i = 0; i < parts.length - 1 && cur; i++) {
      chain.push(cur);
      const next: unknown = cur[parts[i]];
      cur =
        next && typeof next === 'object' && !Array.isArray(next)
          ? (next as Record<string, unknown>)
          : undefined;
    }
    if (!cur || !(parts[parts.length - 1] in cur)) continue;
    delete cur[parts[parts.length - 1]];
    // Drop the containers the key leaves behind, so `config: {layers: {}}`
    // does not travel to the backend as a meaningless empty block.
    for (let i = chain.length - 1; i >= 0; i--) {
      const key = parts[i];
      const child = chain[i][key] as Record<string, unknown> | undefined;
      if (child && typeof child === 'object' && Object.keys(child).length === 0) {
        delete chain[i][key];
      }
    }
  }
  return body;
}
