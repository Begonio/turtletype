import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { authorizeUser } from '../auth/googleClient.js';
import { createJob, findJob, listJobs } from '../db/jobs.js';
import { toPublicJob } from '../db/types.js';
import {
  createDocument,
  docUrl as buildDocUrl,
  getAppendIndex,
  parseDocId,
  sanitizeText,
} from '../docs/documents.js';
import { getChannel, peekChannel } from '../jobs/events.js';
import { jobQueue } from '../jobs/queue.js';
import { estimateDurationMs, humanize, SPEED_MAX, SPEED_MIN } from '../jobs/humanize.js';
import { hasActiveSubscription, isAuthenticated } from '../middleware/isAuthenticated.js';
import { HttpError } from '../middleware/errorHandler.js';

export const jobsRouter = Router();

jobsRouter.use(isAuthenticated);

const createJobSchema = z.object({
  text: z.string().min(1, 'Text is required'),
  speed: z.coerce.number().min(SPEED_MIN).max(SPEED_MAX).default(1),
  humanness: z.coerce.number().min(0).max(1).default(0.5),
  // Accepts a full Google Docs URL or a bare document ID.
  docId: z.string().trim().min(1).optional(),
});

/** Async handler wrapper so rejections reach the error middleware. */
function wrap(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

function documentTitle(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  if (!firstLine) {
    return `HumanType — ${new Date().toLocaleDateString('en-US')}`;
  }
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

jobsRouter.post(
  '/jobs',
  hasActiveSubscription,
  wrap(async (req, res) => {
    const user = req.currentUser!;
    const body = createJobSchema.parse(req.body);

    const text = sanitizeText(body.text);
    if (!text.trim()) {
      throw new HttpError(400, 'Text is empty after removing unsupported characters.');
    }
    if (text.length > config.jobs.maxTextLength) {
      throw new HttpError(
        400,
        `Text is ${text.length.toLocaleString()} characters; the limit is ${config.jobs.maxTextLength.toLocaleString()}.`,
        'TEXT_TOO_LONG',
      );
    }

    const auth = await authorizeUser(user);

    let docId: string;
    let docUrl: string;

    if (body.docId) {
      const parsed = parseDocId(body.docId);
      if (!parsed) {
        throw new HttpError(400, 'That does not look like a Google Docs link or document ID.', 'BAD_DOC_ID');
      }
      // Reading the document up front verifies both that it exists and that
      // this account can reach it, so the job never starts just to fail.
      await getAppendIndex(auth, parsed);
      docId = parsed;
      docUrl = buildDocUrl(parsed);
    } else {
      const created = await createDocument(auth, documentTitle(text));
      docId = created.documentId;
      docUrl = created.url;
    }

    const job = await createJob({
      userId: user.id,
      docId,
      docUrl,
      totalChars: text.length,
    });

    const { started, queuePosition } = jobQueue.enqueue({
      jobId: job.id,
      userId: user.id,
      docId,
      docUrl,
      text,
      speed: body.speed,
      humanness: body.humanness,
    });

    // Cheap enough to plan twice, and it lets the UI show an honest ETA
    // before a single character is written.
    const estimatedMs = estimateDurationMs(
      humanize(text, { speed: body.speed, humanness: body.humanness }),
    );

    res.status(201).json({
      jobId: job.id,
      docId,
      docUrl,
      totalChars: text.length,
      started,
      queuePosition,
      estimatedMs,
    });
  }),
);

jobsRouter.get(
  '/jobs',
  wrap(async (req, res) => {
    const jobs = await listJobs(req.currentUser!.id);
    res.json({ jobs: jobs.map(toPublicJob) });
  }),
);

jobsRouter.get(
  '/jobs/:id',
  wrap(async (req, res) => {
    const job = await findJob(req.params.id as string, req.currentUser!.id);
    if (!job) throw new HttpError(404, 'Job not found');
    const runner = jobQueue.get(job.id);
    res.json({
      job: toPublicJob(job),
      live: Boolean(runner),
      paused: runner?.isPaused ?? false,
    });
  }),
);

/**
 * Server-sent events for a single job.
 *
 * The stream is safe to reconnect to: every event carries an id, and the
 * channel replays anything the browser missed when it sends Last-Event-ID.
 */
jobsRouter.get(
  '/jobs/:id/stream',
  wrap(async (req, res) => {
    const job = await findJob(req.params.id as string, req.currentUser!.id);
    if (!job) throw new HttpError(404, 'Job not found');

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Tell nginx and friends not to buffer the stream.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const rawLastId = req.header('Last-Event-ID');
    const lastEventId = rawLastId && /^\d+$/.test(rawLastId) ? Number(rawLastId) : null;

    const existing = peekChannel(job.id);
    const channel = getChannel(job.id);
    const unsubscribe = channel.subscribe(res, lastEventId);

    // A job that already finished (or finished before this process booted)
    // has no live channel to emit anything, so replay its outcome once.
    const terminalStatuses = new Set(['done', 'failed', 'cancelled']);
    if (!existing && terminalStatuses.has(job.status)) {
      const payload =
        job.status === 'failed'
          ? {
              type: 'error' as const,
              status: 'failed' as const,
              message: job.error_message ?? 'Job failed',
            }
          : {
              type: 'done' as const,
              status: job.status,
              charsWritten: job.chars_written,
              totalChars: job.total_chars,
              docUrl: job.doc_url,
            };
      channel.emit(payload);
    }

    // Immediately hand the client a snapshot so a late subscriber's progress
    // bar is not stuck at zero until the next flush.
    if (!terminalStatuses.has(job.status)) {
      res.write(
        `event: snapshot\ndata: ${JSON.stringify({
          type: 'snapshot',
          status: job.status,
          pct: Number(job.progress_pct),
          charsWritten: job.chars_written,
          totalChars: job.total_chars,
          docUrl: job.doc_url,
        })}\n\n`,
      );
    }

    req.on('close', () => {
      unsubscribe();
      res.end();
    });
  }),
);

jobsRouter.post(
  '/jobs/:id/pause',
  wrap(async (req, res) => {
    const job = await findJob(req.params.id as string, req.currentUser!.id);
    if (!job) throw new HttpError(404, 'Job not found');
    if (!jobQueue.pause(job.id)) {
      throw new HttpError(409, 'That job is not running.', 'NOT_RUNNING');
    }
    res.json({ ok: true, status: 'paused' });
  }),
);

jobsRouter.post(
  '/jobs/:id/resume',
  wrap(async (req, res) => {
    const job = await findJob(req.params.id as string, req.currentUser!.id);
    if (!job) throw new HttpError(404, 'Job not found');
    if (!jobQueue.resume(job.id)) {
      throw new HttpError(409, 'That job is not running.', 'NOT_RUNNING');
    }
    res.json({ ok: true, status: 'running' });
  }),
);

jobsRouter.delete(
  '/jobs/:id',
  wrap(async (req, res) => {
    const job = await findJob(req.params.id as string, req.currentUser!.id);
    if (!job) throw new HttpError(404, 'Job not found');

    const cancelled = await jobQueue.cancel(job.id);
    if (!cancelled) {
      // Already finished, or lost to a restart. Report the stored outcome
      // instead of pretending a cancel happened.
      res.json({ ok: true, status: job.status, note: 'Job was not running.' });
      return;
    }
    res.json({ ok: true, status: 'cancelled' });
  }),
);
