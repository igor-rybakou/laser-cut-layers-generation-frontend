import type {
  GenerateParamsBody,
  GenerateResponse,
  HealthResponse,
  JobRecord,
  PresetMap,
  SchemaField,
} from './types';

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`API ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<HealthResponse>('/api/health'),
  schema: () => req<SchemaField[]>('/api/schema'),

  generate: (params: GenerateParamsBody, force: boolean) =>
    req<GenerateResponse>(`/api/generate${force ? '?force=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  getJob: (jobId: string) => req<JobRecord>(`/api/jobs/${jobId}`),
  listJobs: () => req<JobRecord[]>('/api/jobs'),

  fileUrl: (jobId: string, filename: string) => `/api/jobs/${jobId}/files/${filename}`,
  archiveUrl: (jobId: string) => `/api/jobs/${jobId}/archive`,

  listPresets: () => req<PresetMap>('/api/presets'),
  putPreset: (name: string, params: GenerateParamsBody) =>
    req(`/api/presets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
  deletePreset: (name: string) =>
    req(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''));
  return res.text();
}
