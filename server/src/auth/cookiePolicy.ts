export interface CookiePolicy {
  sameSite: 'lax' | 'none';
  secure: boolean;
}

/**
 * Decides the session cookie's SameSite/Secure flags.
 *
 * This is the setting that silently breaks sign-in on a real domain, so it is
 * a pure function with tests rather than a branch buried in server setup.
 *
 * - Same origin for app and API (the single-service deploy at
 *   type.turtlegames.org): `SameSite=Lax`, which survives the redirect back
 *   from Google and keeps the cookie away from third-party contexts.
 * - Split origins in production: the cookie has to travel cross-site, so it
 *   must be `SameSite=None; Secure` — browsers drop `None` without `Secure`.
 * - Development over plain http: never mark it `Secure`, or the browser
 *   discards it and nobody can log in locally.
 */
export function resolveCookiePolicy(
  clientUrl: string,
  callbackUrl: string,
  isProduction: boolean,
): CookiePolicy {
  let crossSite = false;
  try {
    crossSite = new URL(clientUrl).origin !== new URL(callbackUrl).origin;
  } catch {
    // A malformed URL is not worth crashing over; assume the safer same-site
    // default and let the operator notice via a failed login.
    crossSite = false;
  }

  if (crossSite && isProduction) return { sameSite: 'none', secure: true };
  return { sameSite: 'lax', secure: isProduction };
}
