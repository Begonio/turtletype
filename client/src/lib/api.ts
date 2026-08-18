/**
 * Thin fetch wrapper. Every call carries the session cookie; in development
 * Vite proxies /api and /auth to the API so the browser stays on one origin.
 */
const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => ({}) as Record<string, unknown>);

  if (!response.ok) {
    const body = payload as { error?: string; code?: string };
    throw new ApiError(response.status, body.error ?? `Request failed (${response.status})`, body.code);
  }
  return payload as T;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  subscriptionStatus: string;
  createdAt: string;
}

export type JobStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface CreateJobResponse {
  jobId: string;
  docId: string;
  docUrl: string;
  totalChars: number;
  started: boolean;
  queuePosition: number;
  estimatedMs: number;
  minDurationMs: number;
  /** Separate writing sessions — roughly how many revisions the doc will show. */
  bursts: number;
  /** Mistakes the plan will make and later go back to fix. */
  typos: number;
}

export interface EstimateResponse {
  minDurationMs: number;
  bursts: number;
  typos: number;
  totalChars: number;
  maxDurationMs: number;
}

export interface JobSnapshot {
  id: string;
  docId: string;
  docUrl: string | null;
  status: JobStatus;
  progressPct: number;
  totalChars: number;
  charsWritten: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export const api = {
  me: () => request<{ user: CurrentUser }>('/api/me'),

  createJob: (input: { text: string; durationMs?: number; docId?: string }) =>
    request<CreateJobResponse>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** How long this text would take at minimum, and how many bursts that is. */
  estimate: (input: { text: string }, signal?: AbortSignal) =>
    request<EstimateResponse>('/api/estimate', {
      method: 'POST',
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    }),

  getJob: (jobId: string) =>
    request<{ job: JobSnapshot; live: boolean; paused: boolean }>(`/api/jobs/${jobId}`),

  pauseJob: (jobId: string) => request<{ ok: true }>(`/api/jobs/${jobId}/pause`, { method: 'POST' }),

  resumeJob: (jobId: string) => request<{ ok: true }>(`/api/jobs/${jobId}/resume`, { method: 'POST' }),

  cancelJob: (jobId: string) => request<{ ok: true }>(`/api/jobs/${jobId}`, { method: 'DELETE' }),

  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
};

export const streamUrl = (jobId: string): string => `${BASE}/api/jobs/${jobId}/stream`;
export const loginUrl = (next = '/app'): string =>
  `${BASE}/auth/google?next=${encodeURIComponent(next)}`;
