import { config } from '../config.js';
import { finishJob, markJobRunning, updateJobProgress, updateJobStatus } from '../db/jobs.js';
import type { JobStatus } from '../db/types.js';
import { getAuthorizedClient, ReauthRequiredError } from '../auth/googleClient.js';
import { DocWriter, getAppendIndex, type DocOp } from '../docs/documents.js';
import { sleep } from '../docs/rateLimiter.js';
import { statusOf } from '../docs/backoff.js';
import { emitJobEvent, type WireOp } from './events.js';
import { humanize, type HumanEvent } from './humanize.js';
import { TypingBuffer } from './buffer.js';

export class JobCancelledError extends Error {
  readonly code = 'CANCELLED';
  constructor() {
    super('Job cancelled');
    this.name = 'JobCancelledError';
  }
}

export interface JobSpec {
  jobId: string;
  userId: string;
  docId: string;
  docUrl: string | null;
  text: string;
  /** Wall-clock time the job should take. Extra time becomes rest between bursts. */
  targetDurationMs: number;
  humanness: number;
  /** Fixes the plan's randomness. Used by tests; unset in production. */
  seed?: number;
}

/** How often job progress is written back to Postgres (flushes are far more frequent). */
const DB_PROGRESS_INTERVAL_MS = 2_000;

/**
 * Replays a humanized event sequence against a Google Doc.
 *
 * Two loops run concurrently:
 *   - the replay loop sleeps out each event's delay and appends to an
 *     in-memory buffer. It never touches the network.
 *   - the flush loop drains that buffer every FLUSH_INTERVAL_MS as a single
 *     batchUpdate.
 *
 * Keeping them separate is what makes the rate limit survivable: typing speed
 * is decoupled from request rate entirely, so a job stretched over an hour and
 * one running at its minimum issue requests at the same bounded cadence.
 */
export class JobRunner {
  private readonly controller = new AbortController();
  private readonly buffer = new TypingBuffer();
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private replayFinished = false;
  private failure: unknown = null;
  private cancelled = false;

  private writer: DocWriter | null = null;
  private startIndex = 1;
  private charsWritten = 0;
  private startedAt = 0;
  private lastDbWrite = 0;

  constructor(readonly spec: JobSpec) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    if (this.paused || this.controller.signal.aborted) return;
    this.paused = true;
    void updateJobStatus(this.spec.jobId, 'paused').catch(() => {});
    emitJobEvent(this.spec.jobId, { type: 'status', status: 'paused' });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const resolve of waiters) resolve();
    void updateJobStatus(this.spec.jobId, 'running').catch(() => {});
    emitJobEvent(this.spec.jobId, { type: 'status', status: 'running' });
  }

  cancel(): void {
    if (this.controller.signal.aborted) return;
    this.cancelled = true;
    // Release the replay loop first so it observes the abort immediately
    // rather than sitting in a pause gate.
    this.resume();
    this.controller.abort(new JobCancelledError());
  }

  /** Blocks the replay loop while the job is paused. */
  private async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.controller.signal.aborted) {
      await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    }
  }

  async run(): Promise<void> {
    const { jobId, userId, docId, docUrl, text, targetDurationMs, humanness, seed } = this.spec;
    this.startedAt = Date.now();

    try {
      await markJobRunning(jobId);
      emitJobEvent(jobId, { type: 'status', status: 'running', docUrl });

      const auth = await getAuthorizedClient(userId);
      this.startIndex = await getAppendIndex(auth, docId);
      this.writer = new DocWriter(auth, docId, this.startIndex);

      // The whole document is planned up front: pure, in-memory, no I/O.
      const events = humanize(text, {
        targetDurationMs,
        humanness,
        minChunkRestMs: config.jobs.minChunkRestMs,
        ...(seed === undefined ? {} : { seed }),
      });

      const flushTask = this.flushLoop().catch((error) => {
        this.recordFailure(error);
      });

      try {
        await this.replay(events);
      } finally {
        this.replayFinished = true;
      }

      await flushTask;

      if (this.failure) throw this.failure;

      await this.persistProgress(true);
      await finishJob(jobId, 'done');
      emitJobEvent(jobId, {
        type: 'done',
        status: 'done',
        charsWritten: this.charsWritten,
        totalChars: text.length,
        docUrl,
      });
    } catch (error) {
      await this.handleFailure(error);
    }
  }

  private recordFailure(error: unknown): void {
    if (this.failure) return;
    this.failure = error;
    if (!this.controller.signal.aborted) this.controller.abort(error);
  }

  private isCancellation(error: unknown): boolean {
    return this.cancelled || error instanceof JobCancelledError;
  }

  private async handleFailure(error: unknown): Promise<void> {
    const { jobId, docUrl, text } = this.spec;

    if (this.isCancellation(error)) {
      // Whatever was already "typed" belongs in the document — losing it
      // would leave a half-word the user never sees completed.
      await this.finalFlushBestEffort();
      await this.persistProgress(true);
      await finishJob(jobId, 'cancelled');
      emitJobEvent(jobId, {
        type: 'done',
        status: 'cancelled',
        charsWritten: this.charsWritten,
        totalChars: text.length,
        docUrl,
      });
      return;
    }

    const message = describeError(error);
    const code = error instanceof ReauthRequiredError ? 'REAUTH_REQUIRED' : undefined;
    console.error(`[job ${jobId}] failed:`, error);

    await this.persistProgress(true).catch(() => {});
    await finishJob(jobId, 'failed', message).catch(() => {});
    emitJobEvent(jobId, { type: 'error', status: 'failed', message, code });
  }

  /**
   * Walks the event array in real time. Delays are honoured with actual
   * sleeps, so a 2,000 character document really does take minutes — that is
   * the product.
   */
  private async replay(events: HumanEvent[]): Promise<void> {
    for (const event of events) {
      await this.waitWhilePaused();
      if (this.controller.signal.aborted) throw this.controller.signal.reason;

      if (event.type === 'pause') {
        // Land the burst before a long rest, so the document holds a complete
        // thought for the whole gap. This is what gives version history a
        // separate, human-looking revision per burst instead of one blob.
        if (event.rest) await this.flushOnce();
        await sleep(event.duration, this.controller.signal);
        continue;
      }

      if (event.type === 'backspace') {
        // Commit the mistake to the document *before* deleting it. Within a
        // single flush window the planner would otherwise trim the typo out of
        // the pending insert, and the reader would never see it happen — no
        // typo in the doc, no correction in the history. Flushing here forces
        // the deletion to become a real deleteContentRange against text Google
        // has already stored.
        await this.flushOnce();
      }

      await sleep(event.delay, this.controller.signal);

      this.buffer.push(event);
    }
  }

  /**
   * Drains the buffer on a fixed cadence until the replay is done and nothing
   * is left. Exactly one batchUpdate per iteration.
   */
  private async flushLoop(): Promise<void> {
    while (!this.replayFinished || !this.buffer.isEmpty) {
      // Throws if the job is aborted mid-wait. A cancellation still gets a
      // final drain from handleFailure; anything else is a hard stop.
      await sleep(config.jobs.flushIntervalMs, this.controller.signal);
      await this.flushOnce();
    }
  }

  private async flushOnce(): Promise<void> {
    if (!this.writer || this.buffer.isEmpty) return;

    const ops = this.buffer.drain();

    const result = await this.writer.flush(ops, {
      signal: this.controller.signal,
      onRetry: ({ attempt, delayMs, status }) => {
        emitJobEvent(this.spec.jobId, {
          type: 'retry',
          attempt,
          delayMs,
          ...(status === undefined ? {} : { httpStatus: status }),
        });
      },
    });

    this.charsWritten = Math.max(0, result.cursorIndex - this.startIndex);
    await this.emitProgress(ops);
  }

  /** Best-effort drain used on cancellation, when the main signal is already aborted. */
  private async finalFlushBestEffort(): Promise<void> {
    if (!this.writer || this.buffer.isEmpty) return;
    const ops = this.buffer.drain();
    try {
      const result = await this.writer.flush(ops, { onRetry: () => {} });
      this.charsWritten = Math.max(0, result.cursorIndex - this.startIndex);
      await this.emitProgress(ops);
    } catch (error) {
      console.error(`[job ${this.spec.jobId}] final flush after cancel failed:`, error);
    }
  }

  private async emitProgress(ops: DocOp[]): Promise<void> {
    const totalChars = this.spec.text.length;
    const pct = totalChars === 0 ? 100 : Math.min(100, (this.charsWritten / totalChars) * 100);
    const elapsedMinutes = Math.max((Date.now() - this.startedAt) / 60_000, 1 / 60_000);
    const charsPerMinute = Math.round(this.charsWritten / elapsedMinutes);
    const status: JobStatus = this.paused ? 'paused' : 'running';

    emitJobEvent(this.spec.jobId, {
      type: 'progress',
      status,
      pct: Number(pct.toFixed(2)),
      charsWritten: this.charsWritten,
      totalChars,
      charsPerMinute,
      ops: ops as WireOp[],
    });

    await this.persistProgress(false);
  }

  private async persistProgress(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastDbWrite < DB_PROGRESS_INTERVAL_MS) return;
    this.lastDbWrite = now;
    const totalChars = this.spec.text.length;
    const pct = totalChars === 0 ? 100 : Math.min(100, (this.charsWritten / totalChars) * 100);
    try {
      await updateJobProgress(this.spec.jobId, this.charsWritten, pct);
    } catch (error) {
      // Progress is cosmetic; never let a hiccup here kill a live job.
      console.error(`[job ${this.spec.jobId}] progress update failed:`, error);
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof ReauthRequiredError) return error.message;

  const status = statusOf(error);
  switch (status) {
    case 401:
      return 'Google rejected the credentials for this document. Please sign in again.';
    case 403:
      return 'No permission to edit that document. Make sure the signed-in account has edit access.';
    case 404:
      return 'That document could not be found. It may have been deleted or moved to the trash.';
    case 429:
      return 'Google rate limited this document for longer than we could wait. Try again in a minute.';
    default:
      break;
  }
  if (status !== undefined && status >= 500) {
    return 'Google Docs is having trouble right now. Please try again shortly.';
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : 'Something went wrong while typing.';
}
