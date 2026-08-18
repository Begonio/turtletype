import { Router, type Request, type Response, type NextFunction } from 'express';
import passport from 'passport';
import { config } from '../config.js';

export const authRouter = Router();

/**
 * accessType=offline + prompt=consent is what makes the refresh token show
 * up. Google only issues one on the first grant otherwise, so a user who
 * signed in before a scope change would end up with an access token that dies
 * in an hour and no way to renew it.
 */
authRouter.get('/google', (req, res, next) => {
  passport.authenticate('google', {
    scope: [...config.google.scopes],
    accessType: 'offline',
    prompt: 'consent',
    // Round-trip where the user wanted to land, but only as a same-site path.
    state: typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : undefined,
  })(req, res, next);
});

authRouter.get('/google/callback', (req: Request, res: Response, next: NextFunction) => {
  passport.authenticate('google', (err: unknown, user: Express.User | false) => {
    if (err) {
      console.error('[auth] google callback error:', err);
      res.redirect(`${config.clientUrl}/?error=auth_failed`);
      return;
    }
    if (!user) {
      res.redirect(`${config.clientUrl}/?error=access_denied`);
      return;
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('[auth] session login failed:', loginErr);
        res.redirect(`${config.clientUrl}/?error=session_failed`);
        return;
      }
      const target = typeof req.query.state === 'string' && req.query.state.startsWith('/')
        ? req.query.state
        : '/app';
      res.redirect(`${config.clientUrl}${target}`);
    });
  })(req, res, next);
});

function destroySession(req: Request, res: Response, done: () => void): void {
  req.logout((logoutErr) => {
    if (logoutErr) console.error('[auth] logout error:', logoutErr);
    req.session.destroy((destroyErr) => {
      if (destroyErr) console.error('[auth] session destroy error:', destroyErr);
      res.clearCookie('turtletype.sid');
      done();
    });
  });
}

authRouter.get('/logout', (req, res) => {
  destroySession(req, res, () => res.redirect(`${config.clientUrl}/`));
});

// Same thing for clients that would rather not follow a redirect.
authRouter.post('/logout', (req, res) => {
  destroySession(req, res, () => res.json({ ok: true }));
});
