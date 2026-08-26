/**
 * The dispatcher, against a real Postgres and a fake mail provider.
 *
 * The property worth this much setup is exactly-once. Several code paths mark
 * a job finished and more than one can fire for the same job — the runner's
 * failure path and the queue's last-resort catch both call `finishJob`, and a
 * restart mid-flight adds the boot sweep on top. Credits survive that because
 * refunds are idempotent; an email is not, and the only thing standing between
 * a user and a duplicate is one `notified_at IS NULL` predicate. That is not a
 * property a unit test with a stubbed database can honestly check.
 *
 * Skipped when DATABASE_URL is unset, like every other database-backed suite
 * here, so `npm test` still passes on a laptop with no Postgres.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.GOOGLE_CALLBACK_URL ??= 'http://localhost:8080/auth/google/callback';
process.env.SESSION_SECRET ??= 'test-session-secret';

interface SentMail {
  to: string[];
  subject: string;
  text: string;
}

const sent: SentMail[] = [];
let mailServer: http.Server;

const databaseUrl = process.env.DATABASE_URL;

describe(
  'job finish notifications',
  { skip: databaseUrl ? false : 'DATABASE_URL is not set' },
  () => {
    let pool: (typeof import('../db/pool.js'))['pool'];
    let query: (typeof import('../db/pool.js'))['query'];
    let notify: typeof import('./jobNotifications.js');
    let jobsDb: typeof import('../db/jobs.js');

    let userId: string;

    before(async () => {
      mailServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          sent.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as SentMail);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"id":"mail_1"}');
        });
      });
      await new Promise<void>((resolve) => mailServer.listen(0, '127.0.0.1', resolve));
      const { port } = mailServer.address() as AddressInfo;
      process.env.MAIL_API_URL = `http://127.0.0.1:${port}/emails`;
      process.env.MAIL_API_KEY = 're_test_key';
      process.env.MAIL_FROM = 'TurtleType <notifications@example.org>';

      const poolModule = await import('../db/pool.js');
      pool = poolModule.pool;
      query = poolModule.query;
      notify = await import('./jobNotifications.js');
      jobsDb = await import('../db/jobs.js');
      const { migrate } = await import('../db/migrate.js');
      await migrate();
    });

    after(async () => {
      if (pool) await pool.end().catch(() => {});
      await new Promise<void>((resolve) => mailServer.close(() => resolve()));
    });

    beforeEach(async () => {
      sent.length = 0;
      // A fresh account per test: preferences are per-user and a leftover one
      // would make a later assertion pass for the wrong reason.
      const suffix = Math.random().toString(36).slice(2);
      const { rows } = await query<{ id: string }>(
        `INSERT INTO users (google_id, email, name)
         VALUES ($1, $2, 'Ada Lovelace') RETURNING id`,
        [`notify-${suffix}`, `notify-${suffix}@example.com`],
      );
      userId = rows[0]!.id;
    });

    /** A job row already in a terminal state, as `finishJob` would have left it. */
    const makeJob = async (
      status: 'done' | 'failed' | 'cancelled',
      overrides: { errorMessage?: string; charsWritten?: number; creditsSpent?: number } = {},
    ): Promise<string> => {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO jobs (user_id, doc_id, doc_url, status, total_chars, chars_written,
                           error_message, credits_spent, completed_at)
         VALUES ($1, 'doc-test', 'https://docs.google.com/document/d/doc-test/edit',
                 $2, 2431, $3, $4, $5, NOW())
         RETURNING id`,
        [
          userId,
          status,
          overrides.charsWritten ?? 2431,
          overrides.errorMessage ?? null,
          overrides.creditsSpent ?? 0,
        ],
      );
      return rows[0]!.id;
    };

    /** Waits for the fake provider to have received `count` messages. */
    const waitForMail = async (count: number, timeoutMs = 2_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (sent.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    const prefs = async (patch: Record<string, boolean>): Promise<void> => {
      const [column, value] = Object.entries(patch)[0]!;
      await query(`UPDATE users SET ${column} = $2 WHERE id = $1`, [userId, value]);
    };

    it('emails the account holder when a job finishes', async () => {
      const jobId = await makeJob('done');
      await notify.notifyJobFinished(jobId);

      assert.equal(sent.length, 1);
      const { rows } = await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
        userId,
      ]);
      assert.deepEqual(sent[0]!.to, [rows[0]!.email]);
      assert.match(sent[0]!.subject, /finished/);
    });

    it('sends exactly once however many paths announce the same job', async () => {
      // The real shape of this: JobRunner.handleFailure calls finishJob, and
      // the queue's catch-all calls it again a moment later.
      const jobId = await makeJob('failed', { errorMessage: 'Google said no' });
      await notify.notifyJobFinished(jobId);
      await notify.notifyJobFinished(jobId);
      await notify.notifyJobFinished(jobId);

      assert.equal(sent.length, 1);
    });

    it('sends once even when two paths announce it at the same moment', async () => {
      // Sequential calls would pass on a check-then-act too. Concurrent ones
      // are what the conditional UPDATE is actually for.
      const jobId = await makeJob('done');
      await Promise.all([
        notify.notifyJobFinished(jobId),
        notify.notifyJobFinished(jobId),
        notify.notifyJobFinished(jobId),
      ]);

      assert.equal(sent.length, 1);
    });

    it('stamps the job so the claim is visible in the database', async () => {
      const jobId = await makeJob('done');
      await notify.notifyJobFinished(jobId);

      const { rows } = await query<{ notified_at: Date | null }>(
        'SELECT notified_at FROM jobs WHERE id = $1',
        [jobId],
      );
      assert.ok(rows[0]!.notified_at instanceof Date);
    });

    it('says nothing about a job the user stopped themselves', async () => {
      const jobId = await makeJob('cancelled', { charsWritten: 400 });
      await notify.notifyJobFinished(jobId);
      assert.equal(sent.length, 0);
    });

    it('honours a user who does not want to hear about successes', async () => {
      await prefs({ notify_email_done: false });
      const jobId = await makeJob('done');
      await notify.notifyJobFinished(jobId);
      assert.equal(sent.length, 0);
    });

    it('still emails that user when a job fails', async () => {
      // The two switches are independent, which is the whole reason there are
      // four of them rather than one.
      await prefs({ notify_email_done: false });
      const jobId = await makeJob('failed', { errorMessage: 'Boom', charsWritten: 12 });
      await notify.notifyJobFinished(jobId);
      assert.equal(sent.length, 1);
      assert.match(sent[0]!.text, /Boom/);
    });

    it('does not send for a job that is still running', async () => {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO jobs (user_id, doc_id, status, total_chars)
         VALUES ($1, 'doc-test', 'running', 2431) RETURNING id`,
        [userId],
      );
      await notify.notifyJobFinished(rows[0]!.id);
      assert.equal(sent.length, 0);
    });

    it('shrugs off a job id that does not exist', async () => {
      await notify.notifyJobFinished('00000000-0000-0000-0000-000000000000');
      assert.equal(sent.length, 0);
    });

    it('goes out through finishJob, which every terminal path uses', async () => {
      // The wiring, not the dispatcher: if this ever stops being called from
      // there, a job can finish without anyone hearing about it.
      const { rows } = await query<{ id: string }>(
        `INSERT INTO jobs (user_id, doc_id, status, total_chars, chars_written)
         VALUES ($1, 'doc-test', 'running', 2431, 2431) RETURNING id`,
        [userId],
      );
      await jobsDb.finishJob(rows[0]!.id, 'done');

      // finishJob dispatches without awaiting, so the SSE 'done' event is not
      // held up behind a mail provider.
      await waitForMail(1);
      assert.equal(sent.length, 1);
    });

    it('does not email a cancellation routed through finishJob either', async () => {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO jobs (user_id, doc_id, status, total_chars, chars_written)
         VALUES ($1, 'doc-test', 'running', 2431, 100) RETURNING id`,
        [userId],
      );
      await jobsDb.finishJob(rows[0]!.id, 'cancelled');

      await waitForMail(1, 300);
      assert.equal(sent.length, 0);
    });
  },
);
