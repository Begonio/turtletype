import { assertRequiredEnv, REQUIRED_ENV } from './config.js';

/**
 * Environment check that runs before anything else is constructed.
 *
 * `db/pool.ts` reads DATABASE_URL while its module body evaluates, so a
 * missing variable would otherwise surface as a raw stack trace from deep
 * inside module loading, naming only the first variable it happened to touch.
 * ESM evaluates imports in declaration order, so importing this module first
 * from the entry point turns that into one readable message listing every
 * variable that is actually missing.
 */
if (process.env.NODE_ENV !== 'test') {
  try {
    assertRequiredEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[boot] FAILED TO START: ${message}`);
    console.error(`[boot] Required variables: ${REQUIRED_ENV.join(', ')}`);
    console.error(
      '[boot] On Railway or Render these are set under the service\'s Variables tab. ' +
        'DATABASE_URL comes from the Postgres service — reference it rather than pasting it.',
    );
    process.exit(1);
  }
}
