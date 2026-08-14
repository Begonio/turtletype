import type { NextFunction, Request, Response } from 'express';
import { findUserById } from '../db/users.js';
import type { UserRow } from '../db/types.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Populated by isAuthenticated so handlers never re-query the user. */
    currentUser?: UserRow;
  }
}

/**
 * Gate for every /api route. Rejects with 401 rather than redirecting — the
 * frontend is a SPA and decides for itself where to send the user.
 */
export async function isAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.isAuthenticated?.() || !req.user?.id) {
    res.status(401).json({ error: 'Not signed in', code: 'UNAUTHENTICATED' });
    return;
  }

  try {
    const user = await findUserById(req.user.id);
    if (!user) {
      // Session outlived the user record.
      req.logout(() => {
        res.status(401).json({ error: 'Not signed in', code: 'UNAUTHENTICATED' });
      });
      return;
    }
    req.currentUser = user;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Placeholder for the Stripe paywall. Every user is seeded 'active', so this
 * is a no-op today; when billing lands it starts returning 403 and nothing
 * else in the codebase has to change.
 */
export function hasActiveSubscription(req: Request, res: Response, next: NextFunction): void {
  if (req.currentUser && req.currentUser.subscription_status !== 'active') {
    res.status(403).json({
      error: 'An active subscription is required to start a job.',
      code: 'SUBSCRIPTION_REQUIRED',
    });
    return;
  }
  next();
}
