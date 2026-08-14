/**
 * Per-job token bucket.
 *
 * The Google Docs API caps writes at 60 requests/minute/document, and that is
 * a hard cap — going over earns a 429 no matter how well-behaved the retry
 * logic is. An 800ms flush interval on its own produces 75 calls/minute, so
 * every flush passes through this limiter first. When the bucket is empty the
 * flush simply waits; the typing buffer keeps accumulating in the meantime and
 * the next batchUpdate carries the extra characters. Nothing is dropped.
 *
 * One instance per job. State is never shared between jobs or users, so a
 * heavy user can never eat another user's quota.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(private readonly permitsPerMinute: number) {
    if (permitsPerMinute <= 0) throw new Error('permitsPerMinute must be > 0');
    // A small burst allowance smooths over scheduler jitter without ever
    // exceeding the sustained rate.
    this.capacity = Math.max(1, Math.min(5, Math.floor(permitsPerMinute / 10)));
    this.tokens = this.capacity;
    this.refillPerMs = permitsPerMinute / 60_000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /** Milliseconds until a permit is available (0 if one is available now). */
  delayUntilAvailable(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  /**
   * Waits for a permit and consumes it. Rejects with the abort reason if the
   * signal fires while waiting.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const wait = this.delayUntilAvailable();
      if (wait === 0) {
        this.tokens -= 1;
        return;
      }
      await sleep(wait, signal);
    }
  }
}

/** Abort-aware sleep. Rejects with the abort reason instead of resolving. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return signal?.aborted ? Promise.reject(signal.reason ?? new Error('aborted')) : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
