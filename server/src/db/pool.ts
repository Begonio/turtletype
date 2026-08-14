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
