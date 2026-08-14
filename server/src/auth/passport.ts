import passport from 'passport';
import { Strategy as GoogleStrategy, type Profile, type VerifyCallback } from 'passport-google-oauth20';
import { config } from '../config.js';
import { findUserById, upsertUser } from '../db/users.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface User {
      id: string;
    }
  }
}

interface GoogleTokenParams {
  expires_in?: number;
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
