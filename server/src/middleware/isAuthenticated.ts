import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
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
 * The paywall.
 *
 * It only checks that the account has *some* credit, not that it has enough
 * for this particular job: what a job costs depends on its character count,
 * which is not known until the body has been parsed and sanitised. The exact
 * charge is taken later, atomically, when the job row is created — see
 * `createJobReservingCredits`. This is the cheap early rejection that keeps a
 * user with an empty balance from getting as far as a Google Docs API call.
 *
 * With no Stripe keys configured the whole thing is a no-op, so a local or
 * self-hosted deploy behaves exactly as it did before billing existed — except
 * in production, where being unable to bill is a misconfiguration rather than a
 * choice and the gate closes instead of opening.
 */
export function hasCredits(req: Request, res: Response, next: NextFunction): void {
  if (!config.billing.enabled) {
    // Unreachable in a correctly configured production deploy: `preflight.ts`
    // refuses to boot one that has no Stripe keys and has not opted into free
    // mode. It is here because the alternative failure — a paywalled service
    // quietly handing out unlimited jobs after someone clears a variable — is
    // both silent and expensive, and this is the one line that makes it loud.
    if (config.isProduction && !config.billing.freeModeAllowed) {
      res.status(503).json({
        error: 'Billing is temporarily unavailable, so new jobs cannot be accepted.',
        code: 'BILLING_MISCONFIGURED',
      });
      return;
    }
    next();
    return;
  }
  if (req.currentUser && req.currentUser.credits <= 0) {
    res.status(402).json({
      error: 'You are out of credits.',
      code: 'INSUFFICIENT_CREDITS',
      credits: 0,
    });
    return;
  }
  next();
}
