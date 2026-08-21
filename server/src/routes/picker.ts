import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { authorizeUser } from '../auth/googleClient.js';
import { storedGrantCoversDocs } from '../auth/scopes.js';
import { isAuthenticated } from '../middleware/isAuthenticated.js';
import { HttpError } from '../middleware/errorHandler.js';

/**
 * Everything the browser needs to open a Google Picker.
 *
 * The Picker is not decoration. Under `auth/drive.file` the app can only reach
 * documents it created itself and documents the user has handed it, and the
 * Picker is the only thing that can perform that handover — a pasted URL grants
 * nothing. So this endpoint is load-bearing for the "write into a document I
 * already have" flow, which is most of the product.
 *
 * It returns an OAuth access token to the browser, which deserves saying out
 * loud. It is the signed-in user's own token, it carries `drive.file` and
 * nothing wider, and the Picker cannot authenticate the app without it. That
 * is a materially smaller thing to hand out than it was in August 2026, when
 * the same token carried `auth/documents` and would have opened every document
 * the account owned — which is the argument for the migration in miniature.
 */
export const pickerRouter = Router();

/** Async handler wrapper so rejections reach the error middleware. */
function wrap(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

pickerRouter.get(
  '/picker/session',
  isAuthenticated,
  wrap(async (req, res) => {
    const user = req.currentUser!;

    // A token minted under the old `auth/documents` grant cannot drive the
    // Picker, and neither can a row from before the scope column existed.
    // Sending them through consent once is the entire migration for an
    // existing account; the client already knows how to act on this code.
    if (!storedGrantCoversDocs(user.granted_scopes)) {
      throw new HttpError(
        401,
        'Your Google permission predates our move to per-document access. ' +
          'Sign in again to pick a document.',
        'REAUTH_REQUIRED',
      );
    }

    // No API key means the Picker cannot load at all. Say so as a fact about
    // the deployment rather than letting the browser fail opaquely — the
    // create-a-new-document path still works without it.
    if (!config.google.pickerApiKey) {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ configured: false });
      return;
    }

    // A ReauthRequiredError from here is already mapped to a 401 with the
    // REAUTH_REQUIRED code by the error handler, which is what the client acts on.
    const auth = await authorizeUser(user);
    const accessToken = auth.credentials.access_token ?? undefined;

    if (!accessToken) {
      throw new HttpError(401, 'Google access has expired. Please sign in again.', 'REAUTH_REQUIRED');
    }

    // Never cached, anywhere. It is a bearer credential with a one-hour life.
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      configured: true,
      accessToken,
      apiKey: config.google.pickerApiKey,
      /** Empty unless configured; the Picker only needs it for shared drives. */
      appId: config.google.projectNumber,
      scope: config.google.docsAccessScope,
    });
  }),
);
