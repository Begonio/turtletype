import { google, type docs_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';
import { withBackoff, statusOf } from './backoff.js';
import { RateLimiter } from './rateLimiter.js';

/** A single buffered operation, in the order the typist performed it. */
export type DocOp =
  | { kind: 'insert'; text: string }
  | { kind: 'delete'; count: number };

export interface FlushResult {
  /** Requests actually sent in the batchUpdate. */
  requestCount: number;
  /** Document index the cursor sits at afterwards. */
  cursorIndex: number;
}

export interface RetryNotice {
  attempt: number;
  delayMs: number;
  status: number | undefined;
}

function docsClient(auth: OAuth2Client): docs_v1.Docs {
  const rootUrl = config.google.docsRootUrl;
  return google.docs({ version: 'v1', auth, ...(rootUrl ? { rootUrl } : {}) } as docs_v1.Options);
}

export function docUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

/**
 * Pulls a document ID out of anything a user might paste: a full edit URL, a
 * /d/e/ published URL, an open?id= link, or the bare ID itself.
 */
export function parseDocId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const patterns = [
    /\/document\/d\/([a-zA-Z0-9_-]{10,})/,
    /[?&]id=([a-zA-Z0-9_-]{10,})/,
    /^([a-zA-Z0-9_-]{20,})$/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Google Docs rejects most control characters. Normalise line endings and drop
 * anything else that is not a tab or newline before it reaches the engine.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export async function createDocument(auth: OAuth2Client, title: string): Promise<{ documentId: string; url: string }> {
  const docs = docsClient(auth);
  const response = await withBackoff(() => docs.documents.create({ requestBody: { title } }));
  const documentId = response.data.documentId;
  if (!documentId) throw new Error('Google did not return a document ID');
  return { documentId, url: docUrl(documentId) };
}

/**
 * Index just past the last character of the body — where new content should
 * be appended. The body always ends with a newline that cannot be deleted or
 * written after, hence the -1.
 */
export async function getAppendIndex(auth: OAuth2Client, documentId: string): Promise<number> {
  const docs = docsClient(auth);
  const response = await withBackoff(() => docs.documents.get({ documentId }));
  const content = response.data.body?.content ?? [];
  let end = 1;
  for (const element of content) {
    if (typeof element.endIndex === 'number') end = Math.max(end, element.endIndex);
  }
  return Math.max(1, end - 1);
}

/**
 * Translates a window's worth of buffered ops into Docs API requests.
 *
 * Requests inside one batchUpdate apply in order, each seeing the document as
 * the previous request left it, so this walks a local cursor the same way.
 * Two reductions happen here:
 *
 *  - adjacent inserts merge into a single insertText;
 *  - a backspace over characters still sitting in an unsent insert trims that
 *    insert instead of emitting a deleteContentRange. No observer can see an
 *    intermediate state inside a single batch, so the visible result is
 *    identical and it costs one request fewer.
 *
 * A backspace that reaches across a flush boundary — the common case for a
 * typo caught a beat later — does become a real deleteContentRange against
 * text Google already has, which is exactly the typo-then-correction the
 * reader is meant to see.
 *
 * `floor` is the index the job started at: deletes never chew into content
 * that was in the document beforehand.
 */
export function planRequests(
  ops: DocOp[],
  startCursor: number,
  floor: number,
): { requests: docs_v1.Schema$Request[]; endCursor: number } {
  const requests: docs_v1.Schema$Request[] = [];
  let cursor = startCursor;

  for (const op of ops) {
    if (op.kind === 'insert') {
      if (!op.text) continue;
      const previous = requests[requests.length - 1];
      if (previous?.insertText?.text !== undefined && previous.insertText.location?.index !== undefined) {
        previous.insertText.text += op.text;
      } else {
        requests.push({ insertText: { location: { index: cursor }, text: op.text } });
      }
      cursor += op.text.length;
      continue;
    }

    const start = Math.max(floor, cursor - op.count);
    if (start >= cursor) continue;

    const previous = requests[requests.length - 1];
    if (previous?.insertText?.text) {
      const insertText = previous.insertText.text;
      const trim = Math.min(insertText.length, cursor - start);
      previous.insertText.text = insertText.slice(0, insertText.length - trim);
      cursor -= trim;
      if (!previous.insertText.text) requests.pop();

      const remaining = op.count - trim;
      if (remaining > 0) {
        const rangeStart = Math.max(floor, cursor - remaining);
        if (rangeStart < cursor) {
          requests.push({ deleteContentRange: { range: { startIndex: rangeStart, endIndex: cursor } } });
          cursor = rangeStart;
        }
      }
      continue;
    }

    requests.push({ deleteContentRange: { range: { startIndex: start, endIndex: cursor } } });
    cursor = start;
  }

  return { requests, endCursor: cursor };
}

/**
 * Owns the write side of a single job: cursor bookkeeping, its own rate
 * limiter, and one batchUpdate per flush.
 *
 * Every character that reaches Google goes through `flush`. The caller
 * accumulates ops in memory for the flush window; this class never sends more
 * than one request per window, and the limiter can stretch a window further
 * if the per-minute quota demands it.
 */
export class DocWriter {
  private readonly docs: docs_v1.Docs;
  private readonly limiter: RateLimiter;
  private cursor: number;
  /**
   * Lowest index this job is allowed to delete back to — the append index it
   * started from. A runaway backspace count can never chew into content the
   * document already had.
   */
  private readonly floor: number;
  /** Serialises flushes so index arithmetic always sees a settled document. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    auth: OAuth2Client,
    readonly documentId: string,
    startIndex: number,
    permitsPerMinute = config.jobs.writesPerMinute,
  ) {
    this.docs = docsClient(auth);
    this.cursor = Math.max(1, startIndex);
    this.floor = this.cursor;
    this.limiter = new RateLimiter(permitsPerMinute);
  }

  get cursorIndex(): number {
    return this.cursor;
  }

  /**
   * Sends one batchUpdate for the whole window. Waits on the rate limiter
   * first, and retries 429/5xx with exponential backoff + jitter.
   *
   * Calls are serialised: index arithmetic is only valid against a document
   * state nothing else is mutating, so two overlapping flushes would compute
   * their ranges from the same stale cursor and scramble the document. The
   * chain runs the next flush whether or not the previous one succeeded.
   */
  flush(
    ops: DocOp[],
    options: { signal?: AbortSignal; onRetry?: (notice: RetryNotice) => void } = {},
  ): Promise<FlushResult> {
    const task = this.chain.then(
      () => this.doFlush(ops, options),
      () => this.doFlush(ops, options),
    );
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async doFlush(
    ops: DocOp[],
    options: { signal?: AbortSignal; onRetry?: (notice: RetryNotice) => void } = {},
  ): Promise<FlushResult> {
    const { requests, endCursor } = planRequests(ops, this.cursor, this.floor);
    if (requests.length === 0) {
      this.cursor = endCursor;
      return { requestCount: 0, cursorIndex: this.cursor };
    }

    await this.send(requests, options);

    this.cursor = endCursor;
    return { requestCount: requests.length, cursorIndex: this.cursor };
  }

  /** One rate-limited, backoff-wrapped batchUpdate. */
  private async send(
    requests: docs_v1.Schema$Request[],
    options: { signal?: AbortSignal; onRetry?: (notice: RetryNotice) => void },
  ): Promise<void> {
    await this.limiter.acquire(options.signal);

    await withBackoff(
      () =>
        this.docs.documents.batchUpdate({
          documentId: this.documentId,
          requestBody: { requests },
        }),
      {
        signal: options.signal,
        onRetry: ({ attempt, delayMs, error }) =>
          options.onRetry?.({ attempt, delayMs, status: statusOf(error) }),
      },
    );
  }

  /**
   * Corrects a mistake left behind earlier in the text.
   *
   * `offset` counts from where this job started writing, so the absolute
   * range is `floor + offset`. Sent as its own batchUpdate — a targeted edit
   * in the middle of the text cannot be interleaved with appends, whose
   * indices it would shift, and giving it its own request is also what makes
   * it land in version history as a distinct correction.
   *
   * The caller must have drained the buffer first, or pending appends would be
   * planned against a stale cursor.
   */
  async repair(
    offset: number,
    remove: number,
    insert: string,
    options: { signal?: AbortSignal; onRetry?: (notice: RetryNotice) => void } = {},
  ): Promise<FlushResult> {
    const start = this.floor + offset;
    const end = start + remove;

    // Refuse to touch anything outside what this job has written.
    if (remove <= 0 || start < this.floor || end > this.cursor) {
      throw new Error(
        `repair(${offset}, ${remove}) targets ${start}-${end}, outside the job's range ${this.floor}-${this.cursor}`,
      );
    }

    const requests: docs_v1.Schema$Request[] = [
      { deleteContentRange: { range: { startIndex: start, endIndex: end } } },
    ];
    if (insert) {
      requests.push({ insertText: { location: { index: start }, text: insert } });
    }

    const task = this.chain.then(
      () => this.send(requests, options),
      () => this.send(requests, options),
    );
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );

    await task;
    // Everything after the repair point shifted by the length difference.
    this.cursor += insert.length - remove;
    return { requestCount: requests.length, cursorIndex: this.cursor };
  }

  /**
   * Re-reads the document to recover the true append index. Used after a
   * failure where the local cursor may have drifted from reality.
   */
  async resyncCursor(auth: OAuth2Client): Promise<number> {
    this.cursor = await getAppendIndex(auth, this.documentId);
    return this.cursor;
  }
}
