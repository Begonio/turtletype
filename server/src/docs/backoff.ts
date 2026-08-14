import { config } from '../config.js';
import { sleep } from './rateLimiter.js';

export interface RetryOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/** Digs the HTTP status out of a googleapis / fetch style error. */
export function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const raw = candidate.response?.status ?? candidate.status ?? candidate.code;
  const parsed = typeof raw === 'string' ? Number(raw) : raw;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Retryable: quota (429), transient server faults (500/502/503/504) and
 * connection-level failures. Everything else — 400 bad request, 401 expired
 * credentials, 403 missing scope, 404 deleted doc — is permanent and is
 * surfaced immediately rather than burning 5 retries on a certain failure.
 */
export function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;
  if (status !== undefined) return false;

  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' &&
    ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(code)
  );
}

/**
 * Exponential backoff with full jitter: 2s, 4s, 8s, 16s, 32s (capped), each
 * randomised across [0, delay). Jitter matters here — without it, several
 * concurrent jobs that hit the same quota wall would retry in lockstep and
 * hit it again together.
 */
export async function withBackoff<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const initial = options.initialDelayMs ?? config.backoff.initialDelayMs;
  const max = options.maxDelayMs ?? config.backoff.maxDelayMs;
  const maxRetries = options.maxRetries ?? config.backoff.maxRetries;

  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!isRetryable(error) || attempt >= maxRetries) throw error;

      const ceiling = Math.min(max, initial * 2 ** attempt);
      // Full jitter, but never so small that it is effectively an immediate
      // retry against a quota that resets on a one-minute window.
      const delayMs = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));

      attempt += 1;
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, options.signal);
    }
  }
}
