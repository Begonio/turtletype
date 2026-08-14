import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';
import { clearUserTokens, findUserById, updateUserTokens } from '../db/users.js';
import type { UserRow } from '../db/types.js';

/** Refresh this far ahead of real expiry so a long batchUpdate never straddles it. */
const REFRESH_SKEW_MS = 120_000;

export class ReauthRequiredError extends Error {
  readonly code = 'REAUTH_REQUIRED';
  constructor(message = 'Google access has expired. Please sign in again.') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

export function createOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.callbackUrl,
  );
}

/**
 * Builds an OAuth client for a user, refreshing the access token first if it
 * is expired or about to be. Refreshed credentials are written straight back
 * to the users row, so the next request (or the next process) starts from the
 * fresh token instead of refreshing again.
 */
export async function getAuthorizedClient(userId: string): Promise<OAuth2Client> {
  const user = await findUserById(userId);
  if (!user) throw new ReauthRequiredError('User no longer exists');
  return authorizeUser(user);
}

export async function authorizeUser(user: UserRow): Promise<OAuth2Client> {
  if (!user.access_token && !user.refresh_token) {
    throw new ReauthRequiredError();
  }

  const client = createOAuthClient();
  client.setCredentials({
    access_token: user.access_token ?? undefined,
    refresh_token: user.refresh_token ?? undefined,
    expiry_date: user.token_expiry ? user.token_expiry.getTime() : undefined,
  });

  // Fires whenever the library rotates credentials, including refreshes it
  // performs on its own during a request.
  client.on('tokens', (tokens) => {
    void updateUserTokens(user.id, {
      accessToken: tokens.access_token ?? user.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    }).catch((err) => console.error('[auth] failed to persist refreshed tokens:', err));
  });

  const expiresAt = user.token_expiry?.getTime() ?? 0;
  const needsRefresh = !user.access_token || expiresAt - Date.now() < REFRESH_SKEW_MS;

  if (needsRefresh) {
    if (!user.refresh_token) throw new ReauthRequiredError();
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await updateUserTokens(user.id, {
        accessToken: credentials.access_token ?? null,
        refreshToken: credentials.refresh_token ?? null,
        tokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      });
    } catch (error) {
      // invalid_grant means the user revoked access or the grant expired.
      // The stored refresh token is dead — drop it and make them re-consent.
      const message = String((error as { message?: string })?.message ?? error);
      if (/invalid_grant|invalid_request|unauthorized/i.test(message)) {
        await clearUserTokens(user.id);
        throw new ReauthRequiredError();
      }
      throw error;
    }
  }

  return client;
}
