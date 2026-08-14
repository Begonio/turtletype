export interface UserRow {
  id: string;
  google_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: Date | null;
  stripe_customer_id: string | null;
  subscription_status: string;
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
