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
