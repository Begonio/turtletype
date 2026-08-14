import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

/**
 * Hosted Postgres (Railway, Render, Supabase, Neon) terminates TLS with a
 * certificate chain Node does not trust out of the box. Enable SSL without
 * chain verification unless the URL explicitly opts out.
 */
function sslOptions(): pg.PoolConfig['ssl'] {
  const url = config.databaseUrl;
  if (/sslmode=disable/.test(url)) return undefined;
  const isLocal = /@(localhost|127\.0\.0\.1|::1)[:/]/.test(url);
  if (isLocal && !/sslmode=require/.test(url)) return undefined;
  return { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: sslOptions(),
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
