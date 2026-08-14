import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

// Look for a .env in server/ first, then at the repo root, so either layout works.
for (const candidate of [
  path.resolve(here, '../.env'),
  path.resolve(here, '../../.env'),
  path.resolve(here, '../../../.env'),
]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}
dotenv.config(); // also honour variables already present in the environment

/** Every variable the server cannot start without. */
export const REQUIRED_ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CALLBACK_URL',
  'SESSION_SECRET',
  'DATABASE_URL',
] as const;

/**
 * Secrets are read through getters rather than validated at import time.
 * Pure modules (the humanization engine, the request planner, the backoff
 * helpers) import this file for tuning values and must stay importable in a
 * test run with no environment at all. `assertRequiredEnv` restores the
 * fail-fast behaviour at boot, where it belongs.
 */
export function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill it in.',
    );
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: num('PORT', 8080),
  clientUrl: (process.env.CLIENT_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  trustProxy: bool('TRUST_PROXY', nodeEnv === 'production'),

  get sessionSecret(): string {
    return required('SESSION_SECRET');
  },
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },

  google: {
    get clientId(): string {
      return required('GOOGLE_CLIENT_ID');
    },
    get clientSecret(): string {
      return required('GOOGLE_CLIENT_SECRET');
    },
    get callbackUrl(): string {
      return required('GOOGLE_CALLBACK_URL');
    },
    scopes: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/documents',
    ],
    /**
     * Override for the Docs API base URL. Unset in production; the integration
     * tests point it at a local fake so the whole write path can run without
     * touching Google.
     */
    docsRootUrl: process.env.GOOGLE_DOCS_ROOT_URL,
  },

  jobs: {
    /**
     * How often the accumulated typing buffer is flushed to Google Docs.
     * One flush == one batchUpdate request.
     */
    flushIntervalMs: num('FLUSH_INTERVAL_MS', 800),
    /**
     * Hard ceiling on batchUpdate calls per minute for a single job. The Docs
     * API caps writes at 60/min/document, so this must stay under 60. An
     * 800ms flush interval alone would produce 75/min, so the limiter holds
     * flushes back (the buffer simply grows) to stay inside the quota.
     */
    writesPerMinute: num('DOCS_WRITES_PER_MINUTE', 55),
    maxConcurrentJobs: num('MAX_CONCURRENT_JOBS', 20),
    maxTextLength: num('MAX_TEXT_LENGTH', 200_000),
  },

  backoff: {
    initialDelayMs: num('BACKOFF_INITIAL_MS', 2_000),
    maxDelayMs: num('BACKOFF_MAX_MS', 32_000),
    maxRetries: num('BACKOFF_MAX_RETRIES', 5),
  },
} as const;

export type Config = typeof config;
