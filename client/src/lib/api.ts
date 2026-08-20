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
  /** Credits available to spend. Always 0 on a deploy with billing switched off. */
  credits: number;
  plan: string | null;
  createdAt: string;
}

export interface PricedSku {
  id: string;
  kind: 'pack' | 'plan';
  name: string;
  amountCents: number;
  currency: string;
  credits: number;
  blurb: string;
  highlight?: boolean;
  /** False when this deploy has no Stripe price wired to the SKU. */
  available: boolean;
  centsPerCredit: number;
}

export interface CatalogResponse {
  /** False on a self-hosted or local deploy: everything is free and the paywall is off. */
  enabled: boolean;
  charsPerCredit: number;
  maxCreditsPerJob: number;
  skus: PricedSku[];
  credits: number | null;
}

export interface BillingSummary {
  credits: number;
  plan: string | null;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  hasBillingAccount: boolean;
  ledger: Array<{
    delta: number;
    balanceAfter: number;
    reason: string;
    createdAt: string;
  }>;
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
  /** Credits this job cost. Zero when billing is off. */
  creditsSpent: number;
  creditsRemaining: number;
}

export interface EstimateResponse {
  minDurationMs: number;
  bursts: number;
  typos: number;
  totalChars: number;
  maxDurationMs: number;
  /** What this text would cost to write, so the price is visible before submitting. */
  credits: number;
  creditsAvailable: number;
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

  catalog: () => request<CatalogResponse>('/api/billing/catalog'),

  billingSummary: () => request<BillingSummary>('/api/billing/me'),

  /**
   * Starts a Stripe Checkout session. Returns the URL to send the browser to —
   * the redirect is left to the caller so the button can show a pending state
   * until the navigation actually happens.
   */
  checkout: (skuId: string) =>
    request<{ url: string }>('/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ skuId }),
    }),

  /** Stripe's hosted portal: invoices, cards, cancellation. */
  billingPortal: () => request<{ url: string }>('/api/billing/portal', { method: 'POST' }),
};

export const streamUrl = (jobId: string): string => `${BASE}/api/jobs/${jobId}/stream`;
export const loginUrl = (next = '/app'): string =>
  `${BASE}/auth/google?next=${encodeURIComponent(next)}`;
