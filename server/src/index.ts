import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import connectPgSimple from 'connect-pg-simple';
import cors from 'cors';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { assertRequiredEnv, config } from './config.js';
import { configurePassport, passport } from './auth/passport.js';
import { authRouter } from './auth/routes.js';
import { failOrphanedJobs } from './db/jobs.js';
import { migrate } from './db/migrate.js';
import { closePool, pool } from './db/pool.js';
import { disposeAllChannels } from './jobs/events.js';
import { jobQueue } from './jobs/queue.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { jobsRouter } from './routes/jobs.js';
import { meRouter } from './routes/me.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * When the API and the frontend live on different origins in production, the
 * session cookie has to be SameSite=None; Secure or the browser drops it on
 * the OAuth round trip.
 */
function cookiePolicy(): { sameSite: 'lax' | 'none'; secure: boolean } {
  let crossSite = false;
  try {
    crossSite = new URL(config.clientUrl).origin !== new URL(config.google.callbackUrl).origin;
  } catch {
    crossSite = false;
  }
  if (crossSite && config.isProduction) return { sameSite: 'none', secure: true };
  return { sameSite: 'lax', secure: config.isProduction };
}

export function createApp(): express.Express {
  const app = express();
  const PgSession = connectPgSimple(session);
  const cookie = cookiePolicy();

  if (config.trustProxy) {
    // Required behind Railway/Render/nginx so secure cookies are actually set.
    app.set('trust proxy', 1);
  }

  app.use(
    helmet({
      // The SPA is served from the same process in production; the default
      // CSP would block its own bundle.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: config.clientUrl,
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '5mb' }));

  app.use(
    session({
      name: 'humantype.sid',
      store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: cookie.sameSite,
        secure: cookie.secure,
      },
    }),
  );

  configurePassport();
  app.use(passport.initialize());
  app.use(passport.session());

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      activeJobs: jobQueue.activeCount,
      queuedJobs: jobQueue.waitingCount,
    });
  });

  app.use('/auth', authRouter);
  app.use('/api', meRouter);
  app.use('/api', jobsRouter);

  // Single-service deploys: serve the built SPA from the same origin, which
  // also sidesteps third-party cookie restrictions entirely.
  const clientDist = path.resolve(here, '../../client/dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^\/(?!api|auth|health).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

async function main(): Promise<void> {
  // Fail loudly at boot rather than on the first request that needs a secret.
  assertRequiredEnv();

  await migrate();

  // The queue is in-memory, so nothing survived the restart. Say so honestly
  // rather than leaving rows stuck in 'running' forever.
  const orphaned = await failOrphanedJobs();
  if (orphaned > 0) console.log(`[boot] marked ${orphaned} interrupted job(s) as failed`);

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[boot] HumanType API listening on :${config.port} (${config.nodeEnv})`);
    console.log(`[boot] flush interval ${config.jobs.flushIntervalMs}ms, ` +
      `write ceiling ${config.jobs.writesPerMinute}/min/job`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received`);

    server.close();
    await jobQueue.shutdown();
    disposeAllChannels();
    await closePool().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Only boot when executed directly, so tests can import createApp.
if (process.env.NODE_ENV !== 'test') {
  main().catch((error) => {
    console.error('[boot] failed to start:', error);
    process.exit(1);
  });
}
