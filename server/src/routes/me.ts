import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { isAuthenticated } from '../middleware/isAuthenticated.js';
import { HttpError } from '../middleware/errorHandler.js';
import { updateNotificationPrefs } from '../db/users.js';
import { toPublicUser } from '../db/types.js';

export const meRouter = Router();

meRouter.get('/me', isAuthenticated, (req, res) => {
  // isAuthenticated guarantees currentUser; the 401 path never reaches here.
  res.json({ user: toPublicUser(req.currentUser!) });
});

/**
 * Every field optional, so the app can send one switch rather than all four.
 * `.strict()` because a misspelled key silently doing nothing is exactly the
 * kind of bug a settings screen hides well.
 */
const notificationPrefsSchema = z
  .object({
    emailOnDone: z.boolean().optional(),
    emailOnFailure: z.boolean().optional(),
    browserOnDone: z.boolean().optional(),
    browserOnFailure: z.boolean().optional(),
  })
  .strict();

meRouter.patch(
  '/me/notifications',
  isAuthenticated,
  (req: Request, res: Response, next: NextFunction): void => {
    const patch = notificationPrefsSchema.parse(req.body);

    if (Object.keys(patch).length === 0) {
      throw new HttpError(400, 'No notification settings were given.', 'NOTHING_TO_UPDATE');
    }

    updateNotificationPrefs(req.currentUser!.id, patch)
      .then((row) => {
        // The session outliving the user row is already handled by
        // isAuthenticated; this is the vanishingly narrow race where it is
        // deleted between the two queries.
        if (!row) throw new HttpError(404, 'Account not found.');
        res.json({ user: toPublicUser(row) });
      })
      .catch(next);
  },
);
