import pg from 'pg';
import { config } from '../config.js';
import { resolveSslOptions } from './ssl.js';

const { Pool } = pg;

/**
 * Read `NUMERIC` as a JavaScript number rather than a string.
 *
 * node-postgres hands back numerics as strings by default, because Postgres
 * `NUMERIC` has more range and precision than a double and the driver will not
 * silently lose either. That is the right default in general and the wrong one
 * here: every numeric in this schema is a credit balance or a percentage, all
 * of them small and to two decimal places, and all of them exactly
 * representable. Without this, `users.credits` arrives as `"1.50"` and
 * `cost > balance` becomes a string comparison that is wrong without ever
 * throwing — the kind of bug that shows up as a customer being charged rather
 * than as a stack trace.
 *
 * Credit arithmetic still goes through `billing/amount.ts`, which works in
 * whole hundredths, so nothing depends on floating point addition being exact.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

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

/**
 * Runs `fn` inside a transaction on a single dedicated client.
 *
 * Billing needs this: moving credit and recording why it moved have to succeed
 * or fail together, or the ledger stops being the answer to "why does this
 * account have this balance". Any throw rolls back and re-throws.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
