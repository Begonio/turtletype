import { parseCredits } from '../billing/amount.js';

export interface UserRow {
  id: string;
  google_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: Date | null;
  /**
   * Space-delimited scopes Google reported at the last sign-in. NULL on rows
   * created before the column existed, i.e. before the `drive.file` migration.
   */
  granted_scopes: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string;
  /**
   * Credits available to spend. Cached sum of credit_ledger.delta.
   *
   * A `NUMERIC(12, 2)` in Postgres, and a number here because `db/pool.ts`
   * registers a type parser for numerics — without it node-postgres hands back
   * a string and this type would be a lie.
   */
  credits: number;
  plan: string | null;
  current_period_end: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type JobStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface JobRow {
  id: string;
  user_id: string;
  doc_id: string;
  doc_url: string | null;
  status: JobStatus;
  progress_pct: string | number;
  total_chars: number;
  chars_written: number;
  error_message: string | null;
  credits_spent: number;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

/** Shape returned to the browser — never includes OAuth tokens. */
export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  subscriptionStatus: string;
  /** Credits available to spend, so the composer can price a job before submitting it. */
  credits: number;
  plan: string | null;
  createdAt: string;
}

export interface PublicJob {
  id: string;
  docId: string;
  docUrl: string | null;
  status: JobStatus;
  progressPct: number;
  totalChars: number;
  charsWritten: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    subscriptionStatus: row.subscription_status,
    // Snapped to the 0.01 grid on the way out, so the browser never has to
    // render a balance carrying a stray fifteenth decimal place.
    credits: parseCredits(row.credits),
    plan: row.plan,
    createdAt: row.created_at.toISOString(),
  };
}

export function toPublicJob(row: JobRow): PublicJob {
  return {
    id: row.id,
    docId: row.doc_id,
    docUrl: row.doc_url,
    status: row.status,
    progressPct: Number(row.progress_pct),
    totalChars: row.total_chars,
    charsWritten: row.chars_written,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}
