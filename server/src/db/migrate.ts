import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Arbitrary but fixed: any two migrations must pick the same number to queue on. */
const MIGRATION_LOCK_ID = 8_270_113;

/**
 * Applies schema.sql. Every statement in it is idempotent, so this doubles as
 * both the initial migration and a safe no-op on every subsequent boot.
 */
export async function migrate(): Promise<void> {
  // When compiled, schema.sql sits next to the JS in dist/db/; in dev it sits
  // next to the TS source. Both resolve to `here`, but fall back to src/ for
  // the case where the .sql was not copied into dist.
  const candidates = [
    path.join(here, 'schema.sql'),
    path.resolve(here, '../../src/db/schema.sql'),
  ];

  let sql: string | undefined;
  for (const candidate of candidates) {
    try {
      sql = await readFile(candidate, 'utf8');
      break;
    } catch {
      // try the next location
    }
  }
  if (!sql) throw new Error(`Could not locate schema.sql (looked in: ${candidates.join(', ')})`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise concurrent migrations. Two containers booting at once — which
    // a rolling deploy does by definition — would otherwise run the DDL
    // against each other. The lock is transaction-scoped, so it releases on
    // COMMIT or ROLLBACK without any cleanup path to forget.
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isDirectRun) {
  migrate()
    .then(() => {
      console.log('[migrate] schema applied');
      return closePool();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed:', err);
      process.exit(1);
    });
}
