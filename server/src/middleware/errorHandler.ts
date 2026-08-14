import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ReauthRequiredError } from '../auth/googleClient.js';
import { statusOf } from '../docs/backoff.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: 'Invalid request',
      code: 'VALIDATION_FAILED',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }

  if (error instanceof ReauthRequiredError) {
    res.status(401).json({ error: error.message, code: error.code });
    return;
  }

  // Errors that bubbled up from a Google Docs call. Passing a bare 500 here
  // hides the one thing the user can act on.
  const googleStatus = statusOf(error);
  if (googleStatus === 401) {
    res.status(401).json({
      error: 'Google rejected the credentials for this account. Please sign in again.',
      code: 'REAUTH_REQUIRED',
    });
    return;
  }
  if (googleStatus === 403 || googleStatus === 404) {
    res.status(googleStatus).json({
      error:
        googleStatus === 403
          ? 'No permission to edit that document. Make sure the signed-in account has edit access.'
          : 'That document could not be found. Check the link and try again.',
      code: 'DOC_ACCESS',
    });
    return;
  }
  if (googleStatus === 429) {
    res.status(429).json({
      error: 'Google is rate limiting this account right now. Please try again in a minute.',
      code: 'RATE_LIMITED',
    });
    return;
  }

  console.error('[error]', error);
  res.status(500).json({ error: 'Internal server error' });
}
