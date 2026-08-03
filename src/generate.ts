import { api, fetchText, ApiError } from './api';
import { parseSheetSvg } from './svg-parser';
import {
  currentJobStore,
  generationStore,
  healthStore,
  lastFromCacheStore,
  lastJobDurationStore,
  paramsStore,
  parsedSheetsStore,
} from './state';
import type { GenerateParamsBody, JobRecord, ParsedSheet } from './types';

export async function checkHealth(): Promise<void> {
  healthStore.set({ kind: 'checking' });
  try {
    const health = await api.health();
    healthStore.set({ kind: 'ok', health });
  } catch {
    healthStore.set({ kind: 'unreachable', url: '/api/health' });
  }
}

async function loadSheets(job: JobRecord): Promise<ParsedSheet[]> {
  if (!job.manifest) return [];
  const sheets: ParsedSheet[] = [];
  for (const sm of job.manifest.sheets) {
    const file = job.files.find((f) => f.name === sm.filename);
    if (!file) continue;
    try {
      const text = await fetchText(api.fileUrl(job.job_id, sm.filename));
      sheets.push(parseSheetSvg(text, sm.index, sm.name, sm.filename));
    } catch {
      // A missing/unreadable sheet file must not blank out the sheets that
      // did load -- skip it and let the report/defect panels show what they
      // can from the manifest alone.
    }
  }
  return sheets;
}

let requestSeq = 0;

export async function runGenerate(force: boolean): Promise<void> {
  const params = paramsStore.get();
  if (params.lat == null || params.lng == null || params.radius == null || params.size == null) {
    generationStore.set({
      kind: 'error',
      job: {
        job_id: '',
        status: 'error',
        params: {},
        created_at: new Date().toISOString(),
        duration_s: 0,
        manifest: null,
        files: [],
        stdout: '',
        stderr: 'lat, lng, radius and size are all required before generating.',
        returncode: null,
      },
    });
    return;
  }

  const mySeq = ++requestSeq;
  generationStore.set({ kind: 'running', startedAt: Date.now(), params });

  try {
    const genRes = await api.generate(params, force);
    if (mySeq !== requestSeq) return; // superseded by a newer request
    const job = await api.getJob(genRes.job_id);
    if (mySeq !== requestSeq) return;

    currentJobStore.set(job);
    lastJobDurationStore.set(job.duration_s);
    lastFromCacheStore.set(genRes.cached);

    if (job.status === 'timeout') {
      generationStore.set({ kind: 'timeout', params });
      return;
    }
    if (job.status === 'error') {
      generationStore.set({ kind: 'error', job });
      return;
    }

    const sheets = await loadSheets(job);
    if (mySeq !== requestSeq) return;
    parsedSheetsStore.set(sheets);
    generationStore.set({ kind: 'done', job, fromCache: genRes.cached, wasForced: force });
  } catch (err) {
    if (mySeq !== requestSeq) return;
    const msg = err instanceof ApiError ? err.message : String(err);
    generationStore.set({
      kind: 'error',
      job: {
        job_id: '',
        status: 'error',
        params: params as Record<string, unknown>,
        created_at: new Date().toISOString(),
        duration_s: 0,
        manifest: null,
        files: [],
        stdout: '',
        stderr: msg,
        returncode: null,
      },
    });
  }
}

export function updateParams(mutator: (draft: GenerateParamsBody) => void): void {
  const next = JSON.parse(JSON.stringify(paramsStore.get())) as GenerateParamsBody;
  mutator(next);
  paramsStore.set(next);
}
