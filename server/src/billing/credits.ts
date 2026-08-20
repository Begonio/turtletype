/**
 * Credit accounting.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. **Money moves and the reason it moved are written together.** Every
 *    change to `users.credits` happens in the same transaction as the
 *    `credit_ledger` row explaining it. The balance is a cache; the ledger is
 *    the truth, and `reconcile` proves they agree.
 *
 * 2. **Every operation is idempotent given a reference.** Stripe redelivers
 *    webhooks, the job runner can reach its failure path more than once, and a
 *    user can double-click. Idempotency is enforced by a unique index on
 *    (reason, reference) in Postgres rather than by a check-then-act in
 *    JavaScript, so two concurrent callers cannot both pass the check.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.js';
import type { JobRow } from '../db/types.js';

export type LedgerReason =
  | 'signup_grant'
  | 'purchase'
  | 'subscription_renewal'
  | 'job_reserve'
  | 'job_refund'
  | 'manual_adjustment';

export interface LedgerEntry {
  id: string;
  user_id: string;
  delta: number;
  balance_after: number;
  reason: LedgerReason;
  reference: string | null;
  created_at: Date;
}

/** Thrown when a job costs more than the account has. Carries what the UI needs to say so. */
export class InsufficientCreditsError extends Error {
  readonly code = 'INSUFFICIENT_CREDITS';
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(`This job needs ${required} credit(s); the account has ${available}.`);
    this.name = 'InsufficientCreditsError';
  }
}

interface ApplyResult {
  /** False when this exact (reason, reference) had already been applied. */
  applied: boolean;
  balance: number;
}

/**
 * Takes the row lock that serialises everything else in this file.
 *
 * **This must be the first statement in any transaction that also writes a row
 * referencing the user.** Inserting into `jobs` acquires a KEY SHARE lock on
 * the referenced `users` row for the foreign key; asking for FOR UPDATE
 * afterwards is a lock upgrade, and two concurrent transactions each holding
 * KEY SHARE and each waiting to upgrade deadlock immediately — two simultaneous
 * job submissions by one account were enough to trigger it. Taking the stronger
 * lock up front means the FK's weaker lock is already covered and the
 * transactions simply queue.
 */
async function lockUserCredits(client: PoolClient, userId: string): Promise<number> {
  const locked = await client.query<{ credits: number }>(
    'SELECT credits FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );
  const current = locked.rows[0]?.credits;
  if (current === undefined) throw new Error(`No such user: ${userId}`);
  return current;
}

/**
 * Moves credit and records why, given a balance already read under the lock
 * `lockUserCredits` took. Postgres rejects a duplicate (reason, reference)
 * itself, which is what makes a redelivered webhook a no-op rather than a
 * second grant.
 */
async function applyDeltaLocked(
  client: PoolClient,
  userId: string,
  current: number,
  delta: number,
  reason: LedgerReason,
  reference: string | null,
): Promise<ApplyResult> {
  const next = current + delta;
  if (next < 0) throw new InsufficientCreditsError(-delta, current);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO credit_ledger (user_id, delta, balance_after, reason, reference)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (reason, reference) WHERE reference IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, delta, next, reason, reference],
  );

  // Nothing inserted means this exact movement is already in the ledger. The
  // balance already reflects it, so leave it alone.
  if (inserted.rowCount === 0) return { applied: false, balance: current };

  await client.query('UPDATE users SET credits = $2, updated_at = NOW() WHERE id = $1', [
    userId,
    next,
  ]);
  return { applied: true, balance: next };
}

/** Lock, then move. The common case, for callers that touch nothing else. */
async function applyDelta(
  client: PoolClient,
  userId: string,
  delta: number,
  reason: LedgerReason,
  reference: string | null,
): Promise<ApplyResult> {
  const current = await lockUserCredits(client, userId);
  return applyDeltaLocked(client, userId, current, delta, reason, reference);
}

/**
 * Adds credit. `reference` makes it idempotent — pass the Stripe event id for
 * anything webhook-driven, so a redelivery cannot pay out twice.
 */
export async function grantCredits(
  userId: string,
  amount: number,
  reason: LedgerReason,
  reference: string | null,
): Promise<ApplyResult> {
  if (amount <= 0) throw new Error(`grantCredits needs a positive amount, got ${amount}`);
  return withTransaction((client) => applyDelta(client, userId, amount, reason, reference));
}

/**
 * Takes credit for a job and creates the job row, together.
 *
 * These cannot be two steps. Deducting first and failing to insert the job
 * charges for nothing; inserting first and failing to deduct gives the work
 * away. One transaction means the account is either charged for a job that
 * exists or is not charged at all.
 */
export async function createJobReservingCredits(input: {
  userId: string;
  docId: string;
  docUrl: string | null;
  totalChars: number;
  credits: number;
}): Promise<{ job: JobRow; balance: number }> {
  return withTransaction(async (client) => {
    // Lock first — see `lockUserCredits`. The INSERT below takes a foreign-key
    // lock on this same row, and doing it the other way round deadlocks two
    // concurrent submissions against each other.
    const current = await lockUserCredits(client, input.userId);

    // Refuse before writing anything. The rollback would undo the job row
    // anyway, but failing here keeps the wasted work to a single SELECT.
    if (input.credits > current) {
      throw new InsufficientCreditsError(input.credits, current);
    }

    const { rows } = await client.query<JobRow>(
      `INSERT INTO jobs (user_id, doc_id, doc_url, total_chars, credits_spent, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [input.userId, input.docId, input.docUrl, input.totalChars, input.credits],
    );
    const job = rows[0];
    if (!job) throw new Error('createJobReservingCredits returned no job row');

    // A free job (billing is disabled) still gets a row, just no ledger entry.
    if (input.credits === 0) return { job, balance: current };

    const result = await applyDeltaLocked(
      client,
      input.userId,
      current,
      -input.credits,
      'job_reserve',
      job.id,
    );
    return { job, balance: result.balance };
  });
}

/**
 * Gives back what a job was charged.
 *
 * Keyed on the job id, so the runner's failure path calling this twice — which
 * it can, between `handleFailure` and the queue's last-resort catch — pays back
 * once. Returns the number of credits actually returned, which is zero for a
 * job that was free or has already been refunded.
 */
export async function refundJobCredits(jobId: string): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ user_id: string; credits_spent: number }>(
      'SELECT user_id, credits_spent FROM jobs WHERE id = $1',
      [jobId],
    );
    const job = rows[0];
    if (!job || job.credits_spent <= 0) return 0;

    const result = await applyDelta(client, job.user_id, job.credits_spent, 'job_refund', jobId);
    return result.applied ? job.credits_spent : 0;
  });
}

/**
 * Decides whether a finished job's credits go back, and returns them if so.
 *
 * Called from `finishJob`, so every terminal transition passes through it and
 * no failure path can forget. The policy:
 *
 * - **failed** — always refunded. The job did not do what was paid for, and
 *   whose fault that is (an expired Google token, a revoked document, this
 *   service restarting) is not something to bill a customer for adjudicating.
 * - **cancelled** — refunded only if the document is essentially untouched.
 *   Stopping after a few characters is a change of mind; stopping at 80% means
 *   the revision history that was paid for is largely already there.
 * - **done** — never refunded.
 */
const CANCEL_REFUND_THRESHOLD = 0.1;

export async function settleJobCredits(
  jobId: string,
  status: 'done' | 'failed' | 'cancelled',
): Promise<number> {
  if (status === 'done') return 0;

  if (status === 'cancelled') {
    const { rows } = await query<{ total_chars: number; chars_written: number }>(
      'SELECT total_chars, chars_written FROM jobs WHERE id = $1',
      [jobId],
    );
    const job = rows[0];
    if (!job) return 0;
    const written = job.total_chars > 0 ? job.chars_written / job.total_chars : 0;
    if (written > CANCEL_REFUND_THRESHOLD) return 0;
  }

  return refundJobCredits(jobId);
}

export async function balanceOf(userId: string, client?: PoolClient): Promise<number> {
  const run = client
    ? client.query<{ credits: number }>('SELECT credits FROM users WHERE id = $1', [userId])
    : query<{ credits: number }>('SELECT credits FROM users WHERE id = $1', [userId]);
  const { rows } = await run;
  return rows[0]?.credits ?? 0;
}

export async function listLedger(userId: string, limit = 50): Promise<LedgerEntry[]> {
  const { rows } = await query<LedgerEntry>(
    `SELECT * FROM credit_ledger
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * Checks the cached balance against the ledger it summarises.
 *
 * Nothing calls this on the request path; it exists so a support question
 * ("why does this account say four credits?") has an answer that does not
 * depend on trusting the cache, and so a bug that desynchronises the two is
 * findable rather than silent.
 */
export async function reconcile(userId: string): Promise<{
  balance: number;
  ledgerSum: number;
  consistent: boolean;
}> {
  const { rows } = await query<{ credits: number; ledger_sum: string | null }>(
    `SELECT u.credits,
            (SELECT SUM(delta) FROM credit_ledger WHERE user_id = u.id) AS ledger_sum
       FROM users u
      WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new Error(`No such user: ${userId}`);
  const balance = row.credits;
  const ledgerSum = Number(row.ledger_sum ?? 0);
  return { balance, ledgerSum, consistent: balance === ledgerSum };
}
