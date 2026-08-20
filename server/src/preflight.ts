import { assertRequiredEnv, REQUIRED_ENV } from './config.js';
import { launchReport, legalReport } from './launchChecks.js';

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

  // Second gate: a production deploy that cannot take payment is not a
  // degraded deploy, it is the product being given away. See launchChecks.ts.
  const isProduction = process.env.NODE_ENV === 'production';
  const { errors, warnings } = launchReport(process.env, { isProduction });

  for (const problem of warnings) {
    console.warn(`[boot] WARNING ${problem.subject}: ${problem.detail}`);
  }

  // Legal identity is a warning even in production: an unfinished terms page
  // is bad, and a service that will not start is worse. `npm run launch:check`
  // treats the same list as errors — run it before submitting to Google.
  if (isProduction) {
    for (const problem of legalReport(process.env)) {
      console.warn(`[boot] WARNING ${problem.subject}: ${problem.detail}`);
    }
  }

  if (errors.length > 0) {
    console.error('[boot] FAILED TO START: this production deploy cannot charge for jobs.');
    for (const problem of errors) {
      console.error(`[boot]   ${problem.subject}: ${problem.detail}`);
    }
    console.error(
      '[boot] Set the variables above, or set ALLOW_FREE_MODE=true to run this deploy for free ' +
        'on purpose. See docs/stripe-setup.md.',
    );
    process.exit(1);
  }
}
