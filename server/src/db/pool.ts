import pg from 'pg';
import { config } from '../config.js';
import { resolveSslOptions } from './ssl.js';

const { Pool } = pg;

export { resolveSslOptions };

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: resolveSslOptions(config.databaseUrl, process.env.DATABASE_SSL),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // An idle client blew up (network hiccup, database restart). The pool
  // discards it and hands out a fresh one; log rather than crash.
  console.error('[db] idle client error:', err.message);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never);
}

export async function closePool(): Promise<void> {
  await pool.end();
}

/**
 * Blocks until Postgres accepts a connection, or the deadline passes.
 *
 * On a platform's very first deploy the app container is frequently ready
 * before the database is, and a single failed connection would otherwise exit
 * the process and fail the deploy's health check for a condition that resolves
 * itself in a few seconds.
 */
export async function waitForDatabase(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError: unknown;

  for (;;) {
    attempt += 1;
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
      if (attempt > 1) console.log(`[boot] database reachable after ${attempt} attempts`);
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) {
        const message = (error as { message?: string })?.message ?? String(error);
        throw new Error(
          `Could not reach Postgres after ${attempt} attempts over ${Math.round(timeoutMs / 1000)}s. ` +
            `Check DATABASE_URL. Last error: ${message}`,
          { cause: lastError },
        );
      }
      const delay = Math.min(5_000, 500 * 2 ** Math.min(attempt, 4));
      console.warn(
        `[boot] database not ready (attempt ${attempt}): ` +
          `${(error as { message?: string })?.message ?? error}. Retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
