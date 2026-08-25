/**
 * Watching a document's revision list, so the engine can stop *assuming* when
 * Google Docs has checkpointed and start *seeing* it.
 *
 * The problem this solves is the single biggest line item in a job's runtime.
 * Docs decides on its own when to close a revision, and that decision is not
 * visible from inside a pure planner, so every gap the planner emits has to be
 * long enough to contain a checkpoint under the worst possible phase of a
 * clock it cannot read — a little over two minutes, every time, once per
 * revision. On a job with ninety revisions that is three hours of waiting for
 * an event that has, in all likelihood, already happened.
 *
 * Drive exposes the revision list for a file. Poll it across a gap and a new
 * entry appearing is direct evidence that the boundary has been drawn: every
 * edit made after that point necessarily lands in a later revision, which is
 * the entire property the long wait was buying. So the runner waits a floor
 * for the sake of realism, watches, and carries on the moment the revision
 * shows up.
 *
 * What this deliberately does *not* do is guess. If the revision list is
 * unreachable — most importantly on the paste-a-link path, where the app holds
 * `documents` but has never been granted `drive.file` for that particular
 * document — the watcher disables itself and every gap runs its full planned
 * length. Degraded is the old behaviour, exactly; there is no state in which a
 * gap is cut short on anything other than an observed revision.
 */
import { google, type drive_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';
import { statusOf } from './backoff.js';
import { RateLimiter, sleep } from './rateLimiter.js';

/**
 * An opaque snapshot of "how many revisions this document had, and which was
 * last". Compared for inequality and nothing else — the format is not part of
 * the contract.
 */
export type RevisionMark = string;

/**
 * Statuses that mean this document will never answer, however long we wait:
 * the app was not granted per-file access to it, it is gone, or the grant has
 * lapsed. Anything else is treated as a blip worth one more try.
 */
const PERMANENT_STATUSES = new Set([401, 403, 404]);

/** Transient failures tolerated in a row before the watcher gives up for good. */
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Revisions per page. Drive allows up to 1000, and a page token lets each poll
 * resume from the tail rather than walking the whole history again, so this is
 * about the size of the first request rather than the steady-state cost.
 */
const PAGE_SIZE = 200;

function driveClient(auth: OAuth2Client): drive_v3.Drive {
  const rootUrl = config.google.driveRootUrl;
  return google.drive({ version: 'v3', auth, ...(rootUrl ? { rootUrl } : {}) } as drive_v3.Options);
}

export interface RevisionWatcherOptions {
  /** Poll budget for this job. Per job, never shared — same rule as the write limiter. */
  pollsPerMinute?: number;
}

export class RevisionWatcher {
  private readonly drive: drive_v3.Drive;
  private readonly limiter: RateLimiter;

  private disabled = false;
  private disabledReason: string | null = null;
  private consecutiveErrors = 0;

  /**
   * Where the last poll left off. Drive returns revisions oldest first, so the
   * tail is the expensive end to reach; keeping the token that fetched the
   * final page turns every poll after the first into a single small request.
   */
  private resumeToken: string | undefined;
  private countBeforeResume = 0;

  private confirmations = 0;

  constructor(
    auth: OAuth2Client,
    private readonly fileId: string,
    options: RevisionWatcherOptions = {},
  ) {
    this.drive = driveClient(auth);
    this.limiter = new RateLimiter(options.pollsPerMinute ?? config.jobs.revisionPollsPerMinute);
  }

  /** False once the document has proved it will not answer. */
  get usable(): boolean {
    return !this.disabled;
  }

  /** How many gaps have been ended on observed evidence rather than on the clock. */
  get confirmedCount(): number {
    return this.confirmations;
  }

  get offReason(): string | null {
    return this.disabledReason;
  }

  private disable(reason: string): void {
    if (this.disabled) return;
    this.disabled = true;
    this.disabledReason = reason;
  }

  /**
   * Current state of the revision list, or null if it cannot be read.
   *
   * A null is never treated as "no change" by callers — it means the watcher
   * has nothing to say, and the gap runs its full planned length.
   */
  async observe(signal?: AbortSignal): Promise<RevisionMark | null> {
    if (this.disabled) return null;

    try {
      await this.limiter.acquire(signal);
      let token = this.resumeToken;
      let before = this.countBeforeResume;

      for (;;) {
        const response = await this.drive.revisions.list(
          {
            fileId: this.fileId,
            pageSize: PAGE_SIZE,
            fields: 'nextPageToken,revisions(id)',
            ...(token ? { pageToken: token } : {}),
          },
          // No client-side retrying. A poll is a question asked inside a gap
          // that is being timed, and the library's default is to sit on a 5xx
          // for seconds before answering — which spends the very gap it was
          // meant to shorten. A failed poll should come straight back as "no
          // opinion"; the next one is a few seconds away regardless.
          { retry: false },
        );

        const revisions = response.data.revisions ?? [];
        const next = response.data.nextPageToken;
        if (next) {
          before += revisions.length;
          token = next;
          // Walking forward costs another request; pay for it out of the same
          // per-job budget rather than bursting past the limiter.
          await this.limiter.acquire(signal);
          continue;
        }

        this.resumeToken = token;
        this.countBeforeResume = before;
        this.consecutiveErrors = 0;
        const last = revisions[revisions.length - 1]?.id ?? '';
        return `${before + revisions.length}:${last}`;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const status = statusOf(error);
      if (status !== undefined && PERMANENT_STATUSES.has(status)) {
        this.disable(`revision history is not readable for this document (HTTP ${status})`);
        return null;
      }
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        this.disable(`revision history could not be read after ${MAX_CONSECUTIVE_ERRORS} attempts`);
      }
      return null;
    }
  }

  /**
   * Waits up to `budgetMs` for the revision list to move past `baseline`.
   *
   * Returns the time actually spent waiting, or null if the budget ran out
   * without a new revision appearing — in which case the caller has already
   * waited the full planned gap and should simply carry on.
   *
   * `onSlept` is handed each sleep as it is taken rather than the total at the
   * end, so a caller tracking a countdown stays accurate while this runs.
   */
  async waitForChange(
    baseline: RevisionMark,
    budgetMs: number,
    pollIntervalMs: number,
    signal: AbortSignal,
    onSlept: (ms: number) => Promise<void> | void,
  ): Promise<number | null> {
    let waited = 0;

    while (waited < budgetMs) {
      const step = Math.min(pollIntervalMs, budgetMs - waited);
      await sleep(step, signal);
      waited += step;
      await onSlept(step);

      if (!this.usable) return null;
      const now = await this.observe(signal);
      if (now !== null && now !== baseline) {
        this.confirmations += 1;
        return waited;
      }
    }

    return null;
  }
}
