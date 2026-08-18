/**
 * End-to-end job test: real Postgres, real JobRunner, real googleapis client
 * — pointed at a local fake Docs API instead of Google.
 *
 * This is the test that would have caught every interesting bug in this
 * codebase: cursor drift across flush windows, deletes landing on the wrong
 * range, a 429 that never recovers, a cancelled job left marked 'running'.
 *
 * Skipped automatically when DATABASE_URL is not set or Postgres is not
 * reachable, so `npm test` still passes on a laptop with no database.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

// Must be set before anything imports config.js, hence the dynamic imports below.
process.env.BACKOFF_INITIAL_MS = '25';
process.env.BACKOFF_MAX_MS = '200';
process.env.FLUSH_INTERVAL_MS = process.env.FLUSH_INTERVAL_MS ?? '300';
// Bursts still happen, just seconds apart instead of a minute, so the suite
// exercises the rest path without taking minutes of wall clock.
process.env.MIN_CHUNK_REST_MS = process.env.MIN_CHUNK_REST_MS ?? '400';
process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.GOOGLE_CALLBACK_URL ??= 'http://localhost:8080/auth/google/callback';
process.env.SESSION_SECRET ??= 'test-session-secret';

/** In-memory stand-in for a Google Doc, with the same 1-based index rules. */
class FakeDoc {
  body = '';
  batchUpdates = 0;
  requests = 0;
  /** deleteContentRange operations received — i.e. visible typo corrections. */
  deletes = 0;
  /** Every intermediate body, so a test can see the typo before its correction. */
  snapshots: string[] = [];
  /** Number of upcoming batchUpdate calls to answer with a 429. */
  failWith429 = 0;

  reset(): void {
    this.body = '';
    this.batchUpdates = 0;
    this.requests = 0;
    this.deletes = 0;
    this.snapshots = [];
    this.failWith429 = 0;
  }

  get endIndex(): number {
    // Every document body ends with a newline that cannot be written after.
    return this.body.length + 2;
  }

  apply(requests: Array<Record<string, any>>): void {
    for (const request of requests) {
      if (request.insertText) {
        const at = request.insertText.location.index - 1;
        assert.ok(at >= 0 && at <= this.body.length, `insert index ${at + 1} out of range`);
        this.body = this.body.slice(0, at) + request.insertText.text + this.body.slice(at);
      } else if (request.deleteContentRange) {
        const start = request.deleteContentRange.range.startIndex - 1;
        const end = request.deleteContentRange.range.endIndex - 1;
        assert.ok(start >= 0 && end <= this.body.length && start < end, `delete ${start}-${end} out of range`);
        this.body = this.body.slice(0, start) + this.body.slice(end);
        this.deletes += 1;
      }
      this.requests += 1;
    }
    this.batchUpdates += 1;
    this.snapshots.push(this.body);
  }
}

const doc = new FakeDoc();
let server: http.Server;

async function startFakeDocsApi(): Promise<string> {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'GET') {
        send(200, {
          documentId: 'fake-doc',
          body: { content: [{ endIndex: doc.endIndex }] },
        });
        return;
      }

      if (req.method === 'POST' && req.url?.includes(':batchUpdate')) {
        if (doc.failWith429 > 0) {
          doc.failWith429 -= 1;
          send(429, {
            error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' },
          });
          return;
        }
        doc.apply((JSON.parse(raw) as { requests: Array<Record<string, any>> }).requests ?? []);
        send(200, { documentId: 'fake-doc', replies: [] });
        return;
      }

      send(200, { documentId: 'fake-doc' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/`;
}

const databaseUrl = process.env.DATABASE_URL;

describe('job runner integration', { skip: databaseUrl ? false : 'DATABASE_URL is not set' }, () => {
  // Bound late so the env above is already in place.
  let pool: typeof import('../db/pool.js')['pool'];
  let query: typeof import('../db/pool.js')['query'];
  let JobRunner: typeof import('./runner.js')['JobRunner'];
  let getChannel: typeof import('./events.js')['getChannel'];
  let userId: string;
  let reachable = true;

  before(async () => {
    process.env.GOOGLE_DOCS_ROOT_URL = await startFakeDocsApi();

    const poolModule = await import('../db/pool.js');
    pool = poolModule.pool;
    query = poolModule.query;

    try {
      const { migrate } = await import('../db/migrate.js');
      await migrate();
    } catch (error) {
      reachable = false;
      console.warn('[integration] Postgres unreachable, skipping:', (error as Error).message);
      return;
    }

    ({ JobRunner } = await import('./runner.js'));
    ({ getChannel } = await import('./events.js'));

    const { rows } = await query<{ id: string }>(
      `INSERT INTO users (google_id, email, name, access_token, refresh_token, token_expiry)
       VALUES ($1, $2, $3, 'fake-access-token', 'fake-refresh-token', NOW() + INTERVAL '1 hour')
       ON CONFLICT (google_id) DO UPDATE SET
         access_token = 'fake-access-token',
         token_expiry = NOW() + INTERVAL '1 hour'
       RETURNING id`,
      [`integration-test-${process.pid}`, `integration-${process.pid}@example.test`, 'Integration Test'],
    );
    userId = rows[0]!.id;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (userId) await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    if (pool) await pool.end().catch(() => {});
  });

  async function createJobRow(totalChars: number): Promise<string> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO jobs (user_id, doc_id, doc_url, total_chars, status)
       VALUES ($1, 'fake-doc', 'https://docs.google.com/document/d/fake-doc/edit', $2, 'pending')
       RETURNING id`,
      [userId, totalChars],
    );
    return rows[0]!.id;
  }

  async function jobRow(jobId: string) {
    const { rows } = await query<{
      status: string;
      chars_written: number;
      progress_pct: string;
      error_message: string | null;
    }>('SELECT status, chars_written, progress_pct, error_message FROM jobs WHERE id = $1', [jobId]);
    return rows[0]!;
  }

  const TEXT =
    'The quick brown fox jumps over the lazy dog, and it does so repeatedly. Does it survive?';

  it('types the exact text into the document and marks the job done', async (t) => {
    if (!reachable) return t.skip('Postgres unreachable');
    doc.body = '';
    doc.batchUpdates = 0;
    doc.requests = 0;

    const jobId = await createJobRow(TEXT.length);
    const events: string[] = [];
    getChannel(jobId).emit = new Proxy(getChannel(jobId).emit, {
      apply(target, thisArg, args: [{ type: string }]) {
        events.push(args[0].type);
        return Reflect.apply(target, thisArg, args);
      },
    });

    await new JobRunner({
      jobId,
      userId,
      docId: 'fake-doc',
      docUrl: 'https://docs.google.com/document/d/fake-doc/edit',
      text: TEXT,
      targetDurationMs: 0,
      humanness: 1,
    }).run();

    assert.equal(doc.body, TEXT, 'document content must match the input exactly');

    const row = await jobRow(jobId);
    assert.equal(row.status, 'done');
    assert.equal(row.error_message, null);
    assert.equal(row.chars_written, TEXT.length);
    assert.equal(Number(row.progress_pct), 100);

    assert.ok(events.includes('progress'), 'expected progress events on the stream');
    assert.ok(events.includes('done'), 'expected a done event on the stream');

    // The whole point of the buffer: nowhere near one call per character.
    assert.ok(
      doc.batchUpdates < TEXT.length / 4,
      `${doc.batchUpdates} batchUpdates for ${TEXT.length} characters`,
    );
  });

  /**
   * The failure that motivated all of this: a document written in one go shows
   * up in Google Docs' version history as a single revision, indistinguishable
   * from a paste. These two assertions are the fix — the document is built up
   * over many separate writes, and mistakes really do appear in it before
   * being corrected.
   */
  it('builds the document over many writes, with typos visible before correction', async (t) => {
    if (!reachable) return t.skip('Postgres unreachable');
    doc.reset();

    // Long enough to contain several sentence seams, so bursts actually occur.
    const longText = `${TEXT} ${TEXT} ${TEXT} ${TEXT}`;
    const jobId = await createJobRow(longText.length);

    await new JobRunner({
      jobId,
      userId,
      docId: 'fake-doc',
      docUrl: null,
      text: longText,
      targetDurationMs: 0,
      humanness: 1,
      seed: 5,
    }).run();

    assert.equal(doc.body, longText, 'the finished document must still be exact');

    assert.ok(
      doc.batchUpdates > 5,
      `a paste is one write; this produced only ${doc.batchUpdates}`,
    );
    assert.ok(
      doc.deletes > 0,
      'expected at least one correction to reach the document as a deletion',
    );

    // At some point the stored document must have held text that is NOT a
    // prefix of the final text — that is the typo, sitting in the document,
    // exactly as a human would have left it before noticing.
    const hadVisibleMistake = doc.snapshots.some((snapshot) => !longText.startsWith(snapshot));
    assert.ok(hadVisibleMistake, 'no intermediate state contained an uncorrected typo');
  });

  it('appends after existing content without disturbing it', async (t) => {
    if (!reachable) return t.skip('Postgres unreachable');
    const existing = 'Already in the document.\n';
    doc.body = existing;
    doc.batchUpdates = 0;

    const jobId = await createJobRow(TEXT.length);
    await new JobRunner({
      jobId,
      userId,
      docId: 'fake-doc',
      docUrl: null,
      text: TEXT,
      targetDurationMs: 0,
      humanness: 1,
    }).run();

    assert.equal(doc.body, existing + TEXT);
    assert.equal((await jobRow(jobId)).status, 'done');
  });

  it('rides out 429s with backoff and still finishes', async (t) => {
    if (!reachable) return t.skip('Postgres unreachable');
    doc.body = '';
    doc.failWith429 = 3;

    const jobId = await createJobRow(TEXT.length);
    const retries: unknown[] = [];
    const channel = getChannel(jobId);
    const original = channel.emit.bind(channel);
    channel.emit = (event) => {
      if (event.type === 'retry') retries.push(event);
      original(event);
    };

    await new JobRunner({
      jobId,
      userId,
      docId: 'fake-doc',
      docUrl: null,
      text: TEXT,
      targetDurationMs: 0,
      humanness: 1,
    }).run();

    assert.equal(doc.failWith429, 0, 'the fake API should have served all its 429s');
    assert.ok(retries.length >= 3, `expected retry events, got ${retries.length}`);
    assert.equal(doc.body, TEXT, 'text must survive the retries intact');
    assert.equal((await jobRow(jobId)).status, 'done');
  });

  it('stops on cancel, keeps what was typed, and records the outcome', async (t) => {
    if (!reachable) return t.skip('Postgres unreachable');
    doc.body = '';
    const longText = `${TEXT} ${TEXT} ${TEXT}`;
    const jobId = await createJobRow(longText.length);

    const runner = new JobRunner({
      jobId,
      userId,
      docId: 'fake-doc',
      docUrl: null,
      text: longText,
      targetDurationMs: 0,
      humanness: 1,
    });

    const finished = runner.run();
    await new Promise((resolve) => setTimeout(resolve, 900));
    runner.cancel();
    await finished;

    const row = await jobRow(jobId);
    assert.equal(row.status, 'cancelled');
    assert.ok(doc.body.length > 0, 'characters typed before the cancel should be kept');
    assert.ok(doc.body.length < longText.length, 'the job should not have finished');
    assert.ok(
      longText.startsWith(doc.body),
      `partial document is not a prefix of the input: ${JSON.stringify(doc.body.slice(-30))}`,
    );
  });

  it('pauses and resumes without losing position', async (t) => {
    if (!reachable) return t.skip('Postgres unreachable');
    doc.body = '';
    const jobId = await createJobRow(TEXT.length);

    const runner = new JobRunner({
      jobId,
      userId,
      docId: 'fake-doc',
      docUrl: null,
      text: TEXT,
      targetDurationMs: 0,
      humanness: 1,
    });

    const finished = runner.run();
    await new Promise((resolve) => setTimeout(resolve, 500));
    runner.pause();

    // Let the flush that was already buffered at the moment of the pause land,
    // then check that nothing more arrives: a paused job produces nothing at
    // all, which is a far steadier assertion than a character threshold.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const settled = doc.body.length;
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(doc.body.length, settled, 'a paused job should stop producing characters');
    assert.equal((await jobRow(jobId)).status, 'paused');

    runner.resume();
    await finished;

    assert.equal(doc.body, TEXT);
    assert.equal((await jobRow(jobId)).status, 'done');
  });
});
