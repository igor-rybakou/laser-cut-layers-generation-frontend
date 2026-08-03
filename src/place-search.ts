// Nominatim search, debounced, cached in localStorage.
//
// Nominatim's usage policy asks for a descriptive User-Agent identifying the
// application. Browsers block scripts from setting the User-Agent header on
// fetch/XHR requests (it is a forbidden header) -- there is no client-side
// workaround. The best available substitute is the Referer header, which the
// browser sends automatically and which does identify the calling app by
// origin. This is a known limitation of a browser-only Nominatim integration,
// not an oversight.

export interface PlaceResult {
  display_name: string;
  lat: string;
  lon: string;
}

const CACHE_KEY = 'workbench.placeSearchCache';
const MAX_CACHE_ENTRIES = 200;

function readCache(): Record<string, PlaceResult[]> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, PlaceResult[]>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // best-effort only
  }
}

let lastRequestAt = 0;
const MIN_INTERVAL_MS = 1000; // Nominatim's usage policy: ~1 request/second

export async function searchPlace(query: string): Promise<PlaceResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const cache = readCache();
  if (cache[q]) return cache[q];

  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: {
      'Accept-Language': 'en',
    },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const results = (await res.json()) as PlaceResult[];

  const entries = Object.entries(cache);
  if (entries.length >= MAX_CACHE_ENTRIES) {
    delete cache[entries[0][0]];
  }
  cache[q] = results;
  writeCache(cache);

  return results;
}
