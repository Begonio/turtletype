-- TurtleType schema. Safe to run repeatedly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id           TEXT NOT NULL UNIQUE,
  email               TEXT NOT NULL,
  name                TEXT,
  avatar_url          TEXT,
  access_token        TEXT,
  refresh_token       TEXT,
  token_expiry        TIMESTAMPTZ,
  -- Reserved for Stripe. Everyone is 'active' until billing is wired up, so
  -- the eventual paywall is a single middleware check on POST /api/jobs.
  stripe_customer_id  TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'active',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);

-- Billing columns. Added separately from CREATE TABLE so an existing deploy
-- picks them up: the table above is only created when absent, so a column
-- added to it would never reach a database that already has a users table.
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;

-- A negative balance would mean a job ran that nobody paid for. Postgres
-- enforces it so no amount of concurrent webhook and job traffic can produce
-- one; the reserve path relies on this as its last line of defence.
--
-- Added conditionally rather than dropped-and-recreated. The drop/add version
-- was not a no-op on re-run: it took an ACCESS EXCLUSIVE lock on users and
-- re-validated every row on every single boot, and a migration doing that
-- while another connection held a row lock on users deadlocked outright.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_credits_non_negative'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_credits_non_negative CHECK (credits >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_idx
  ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Every movement of credit, ever. The balance on users is a cache of this
-- table's sum; the ledger is what makes a disputed charge answerable and what
-- makes grants idempotent.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  delta         INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  -- What caused it: a Stripe event id, a job id, an invoice id. Combined with
  -- `reason` this is what stops a redelivered webhook granting twice or a
  -- retried failure refunding twice.
  reference     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credit_ledger_reason_check CHECK (
    reason IN (
      'signup_grant', 'purchase', 'subscription_renewal',
      'job_reserve', 'job_refund', 'manual_adjustment'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_reason_reference_idx
  ON credit_ledger (reason, reference) WHERE reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_ledger_user_created_idx
  ON credit_ledger (user_id, created_at DESC);

-- Stripe redelivers webhooks on any non-2xx and occasionally on a 2xx it did
-- not hear in time, so every handler has to be safe to run twice. Recording
-- the event id first, inside the same transaction as its effect, makes that
-- structural rather than a property each handler has to remember.
CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  doc_id        TEXT NOT NULL,
  doc_url       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  progress_pct  NUMERIC(5, 2) NOT NULL DEFAULT 0,
  total_chars   INTEGER NOT NULL DEFAULT 0,
  chars_written INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  -- Credits taken when the job was accepted. Kept on the row so a refund pays
  -- back exactly what was charged, even if pricing changed in between.
  credits_spent INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  CONSTRAINT jobs_status_check CHECK (
    status IN ('pending', 'running', 'paused', 'done', 'failed', 'cancelled')
  )
);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS credits_spent INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS jobs_user_created_idx ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);

-- Session store for connect-pg-simple. Created here so the app never needs
-- CREATE TABLE privileges at runtime.
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR NOT NULL COLLATE "default",
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);
