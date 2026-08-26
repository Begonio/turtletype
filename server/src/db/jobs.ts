import { formatCreditsWithUnit } from '../billing/amount.js';
import { settleJobCredits } from '../billing/credits.js';
import { notifyJobFinished } from '../notify/jobNotifications.js';
import { query } from './pool.js';
import type { JobRow, JobStatus } from './types.js';

export interface CreateJobInput {
  userId: string;
  docId: string;
  docUrl: string | null;
  totalChars: number;
}

export async function createJob(input: CreateJobInput): Promise<JobRow> {
  const { rows } = await query<JobRow>(
    `INSERT INTO jobs (user_id, doc_id, doc_url, total_chars, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING *`,
    [input.userId, input.docId, input.docUrl, input.totalChars],
  );
  const row = rows[0];
  if (!row) throw new Error('createJob returned no row');
  return row;
}

export async function findJob(jobId: string, userId: string): Promise<JobRow | null> {
  const { rows } = await query<JobRow>('SELECT * FROM jobs WHERE id = $1 AND user_id = $2', [
    jobId,
    userId,
  ]);
  return rows[0] ?? null;
}

export async function listJobs(userId: string, limit = 20): Promise<JobRow[]> {
  const { rows } = await query<JobRow>(
    'SELECT * FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit],
  );
  return rows;
}

export async function markJobRunning(jobId: string): Promise<void> {
  await query(
    `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1`,
    [jobId],
  );
}

export async function updateJobProgress(
  jobId: string,
  charsWritten: number,
  progressPct: number,
): Promise<void> {
  await query('UPDATE jobs SET chars_written = $2, progress_pct = $3 WHERE id = $1', [
    jobId,
    charsWritten,
    progressPct.toFixed(2),
  ]);
}

export async function updateJobStatus(jobId: string, status: JobStatus): Promise<void> {
  await query('UPDATE jobs SET status = $2 WHERE id = $1', [jobId, status]);
}

/**
 * Marks a job finished and settles what it was charged.
 *
 * The refund lives here rather than in the runner because every terminal
 * transition — the happy path, the failure path, the cancel path, and the
 * queue's last-resort catch — goes through this function. Anywhere else and
 * one of them would eventually forget. `settleJobCredits` is idempotent, so
 * two of those paths firing for the same job still pays back once.
 */
export async function finishJob(
  jobId: string,
  status: Extract<JobStatus, 'done' | 'failed' | 'cancelled'>,
  errorMessage?: string | null,
): Promise<void> {
  await query(
    `UPDATE jobs
        SET status = $2, error_message = $3, completed_at = NOW()
      WHERE id = $1`,
    [jobId, status, errorMessage ?? null],
  );

  try {
    const refunded = await settleJobCredits(jobId, status);
    if (refunded > 0) {
      console.log(
        `[billing] refunded ${formatCreditsWithUnit(refunded)} for ${status} job ${jobId}`,
      );
    }
  } catch (error) {
    // A job's outcome is already recorded; failing to refund must not turn
    // that into an unhandled rejection. Loud, because it is money.
    console.error(`[billing] could not settle credits for job ${jobId}:`, error);
  }

  // Tell the user it ended. Here for the same reason the refund is here: this
  // is the one function every terminal transition goes through, so anywhere
  // else would eventually miss one. After the settle, so a failure email can
  // truthfully say the credits are already back.
  //
  // Not awaited. The runner emits the SSE `done` event the moment this
  // resolves, and a mail provider having a slow minute is not a reason to hold
  // a browser's progress panel open. `notifyJobFinished` swallows its own
  // errors; the catch here is the belt to that pair of braces.
  void notifyJobFinished(jobId).catch((error) => {
    console.error(`[notify] job ${jobId} notification failed:`, error);
  });
}

/**
 * The job queue is in-memory, so a process restart orphans anything that was
 * mid-flight. Called once at boot so the UI never shows a job that will never
 * make progress again.
 */
export async function failOrphanedJobs(): Promise<number> {
  const { rows } = await query<{ id: string }>(
    `UPDATE jobs
        SET status = 'failed',
            error_message = 'Server restarted while this job was running',
            completed_at = NOW()
      WHERE status IN ('pending', 'running', 'paused')
      RETURNING id`,
  );

  // These were charged for and then killed by a restart that was not the
  // customer's doing, so they get their credits back like any other failure.
  for (const row of rows) {
    try {
      await settleJobCredits(row.id, 'failed');
    } catch (error) {
      console.error(`[billing] could not refund orphaned job ${row.id}:`, error);
    }
    // Worth an email precisely because nobody was watching: this is a job that
    // died between the tab being closed and now, and the only other evidence
    // of it is a row in a table the user cannot see. The rows here bypass
    // `finishJob` (one UPDATE for the whole sweep rather than one per job), so
    // the send has to be asked for explicitly.
    void notifyJobFinished(row.id).catch((error) => {
      console.error(`[notify] orphaned job ${row.id} notification failed:`, error);
    });
  }
  return rows.length;
}
