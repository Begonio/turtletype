import { query } from './pool.js';
import type { UserRow } from './types.js';

export interface UpsertUserInput {
  googleId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: Date | null;
}

/**
 * Creates the user on first sign-in, refreshes their profile afterwards.
 *
 * Google only returns a refresh_token on the first consent (or when
 * `prompt=consent` is forced), so COALESCE keeps the stored one whenever the
 * new grant does not carry one.
 */
export async function upsertUser(input: UpsertUserInput): Promise<UserRow> {
  const { rows } = await query<UserRow>(
    `INSERT INTO users (google_id, email, name, avatar_url, access_token, refresh_token, token_expiry)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (google_id) DO UPDATE SET
       email         = EXCLUDED.email,
       name          = EXCLUDED.name,
       avatar_url    = EXCLUDED.avatar_url,
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, users.refresh_token),
       token_expiry  = EXCLUDED.token_expiry,
       updated_at    = NOW()
     RETURNING *`,
    [
      input.googleId,
      input.email,
      input.name,
      input.avatarUrl,
      input.accessToken,
      input.refreshToken,
      input.tokenExpiry,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('upsertUser returned no row');
  return row;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function updateUserTokens(
  userId: string,
  tokens: { accessToken: string | null; refreshToken?: string | null; tokenExpiry: Date | null },
): Promise<void> {
  await query(
    `UPDATE users
        SET access_token  = $2,
            refresh_token = COALESCE($3, refresh_token),
            token_expiry  = $4,
            updated_at    = NOW()
      WHERE id = $1`,
    [userId, tokens.accessToken, tokens.refreshToken ?? null, tokens.tokenExpiry],
  );
}

/** Called when Google rejects the refresh token (revoked access, expired grant). */
export async function clearUserTokens(userId: string): Promise<void> {
  await query(
    `UPDATE users
        SET access_token = NULL, refresh_token = NULL, token_expiry = NULL, updated_at = NOW()
      WHERE id = $1`,
    [userId],
  );
}
