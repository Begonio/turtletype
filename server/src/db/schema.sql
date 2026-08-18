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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  CONSTRAINT jobs_status_check CHECK (
    status IN ('pending', 'running', 'paused', 'done', 'failed', 'cancelled')
  )
);

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
