import passport from 'passport';
import { Strategy as GoogleStrategy, type Profile, type VerifyCallback } from 'passport-google-oauth20';
import { config } from '../config.js';
import { DOCS_SCOPE_DECLINED, grantedDocumentsAccess, type GoogleTokenParams } from './scopes.js';
import { findUserById, upsertUser } from '../db/users.js';
import { grantCredits } from '../billing/credits.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface User {
      id: string;
    }
  }
}

export function configurePassport(): void {
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.google.clientId,
        clientSecret: config.google.clientSecret,
        callbackURL: config.google.callbackUrl,
        scope: [...config.google.scopes],
      },
      async (
        accessToken: string,
        refreshToken: string | undefined,
        params: GoogleTokenParams,
        profile: Profile,
        done: VerifyCallback,
      ) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) {
            done(null, false, { message: 'Google did not return an email address' });
            return;
          }

          if (!grantedDocumentsAccess(params)) {
            // Refuse the sign-in rather than creating an account that cannot
            // do the one thing the app exists for.
            done(null, false, { message: DOCS_SCOPE_DECLINED });
            return;
          }

          const expiresIn = typeof params?.expires_in === 'number' ? params.expires_in : 3600;
          const user = await upsertUser({
            googleId: profile.id,
            email,
            name: profile.displayName ?? null,
            avatarUrl: profile.photos?.[0]?.value ?? null,
            accessToken,
            refreshToken: refreshToken ?? null,
            tokenExpiry: new Date(Date.now() + expiresIn * 1000),
          });

          // One-time welcome credit, so the revision history can be seen
          // working before anyone is asked to pay. Keyed on the user id, so
          // signing in again for the tenth time does not grant again.
          if (config.billing.enabled && config.billing.signupGrantCredits > 0) {
            try {
              await grantCredits(
                user.id,
                config.billing.signupGrantCredits,
                'signup_grant',
                user.id,
              );
            } catch (error) {
              // A failed grant must not block sign-in; the account simply
              // starts empty and the user can buy credits.
              console.error(`[billing] signup grant failed for ${user.id}:`, error);
            }
          }

          done(null, { id: user.id });
        } catch (error) {
          done(error as Error);
        }
      },
    ),
  );

  // Only the user id lives in the session cookie; everything else is read
  // fresh from Postgres, so a revoked account stops working immediately.
  passport.serializeUser((user: Express.User, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await findUserById(id);
      done(null, user ? { id: user.id } : false);
    } catch (error) {
      done(error as Error);
    }
  });
}

export { passport };
