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
}

/**
 * The job queue is in-memory, so a process restart orphans anything that was
 * mid-flight. Called once at boot so the UI never shows a job that will never
 * make progress again.
 */
export async function failOrphanedJobs(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE jobs
        SET status = 'failed',
            error_message = 'Server restarted while this job was running',
            completed_at = NOW()
      WHERE status IN ('pending', 'running', 'paused')`,
  );
  return rowCount ?? 0;
}
