import type pg from 'pg';

export type SslOptions = pg.PoolConfig['ssl'];

/** Hostname suffixes that only exist on a provider's private network. */
const PRIVATE_HOST_SUFFIXES = [
  '.railway.internal',
  '.flycast',
  '.internal',
  '.local',
  '.svc.cluster.local',
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Pulls the hostname out of a Postgres URL.
 *
 * Split on the *last* `@`: a password is allowed to contain one, and reading
 * the host from the first `@` would silently pick up part of the credentials.
 */
function hostOf(url: string): string | null {
  const withoutScheme = url.replace(/^[a-z+]+:\/\//i, '');
  const at = withoutScheme.lastIndexOf('@');
  const authority = at === -1 ? withoutScheme : withoutScheme.slice(at + 1);
  const host = authority.split(/[/?]/)[0]?.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host ? host.toLowerCase() : null;
}

/**
 * Decides whether to open the Postgres connection with TLS.
 *
 * Two failure modes sit on opposite sides of this call, and both are fatal at
 * boot:
 *
 *  - Managed Postgres reached over the public internet (Neon, Supabase, Render
 *    external, RDS) requires TLS, and presents a chain Node does not trust out
 *    of the box — hence `rejectUnauthorized: false`.
 *  - Postgres reached over a provider's *private* network — Railway's
 *    `postgres.railway.internal`, a Compose service named `db`, a Kubernetes
 *    service — usually has TLS switched off entirely, and asking for it fails
 *    with "The server does not support SSL connections".
 *
 * So private and local hosts default to no TLS, everything else defaults to
 * relaxed TLS, and `DATABASE_SSL` overrides the guess either way.
 */
export function resolveSslOptions(databaseUrl: string, override?: string): SslOptions {
  // An explicit override always wins — no heuristic should be able to
  // override an operator who knows their own network.
  if (override === 'false' || override === '0' || override === 'disable') return undefined;
  if (override === 'true' || override === '1' || override === 'require') {
    return { rejectUnauthorized: false };
  }
  if (override === 'strict' || override === 'verify-full') return { rejectUnauthorized: true };

  // The connection string's own sslmode is the next most explicit signal.
  if (/[?&]sslmode=disable/.test(databaseUrl)) return undefined;
  if (/[?&]sslmode=(require|prefer|verify-ca|verify-full)/.test(databaseUrl)) {
    return { rejectUnauthorized: false };
  }

  const host = hostOf(databaseUrl);
  if (!host) return { rejectUnauthorized: false };

  if (LOCAL_HOSTS.has(host)) return undefined;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return undefined;
  // A bare name with no dots is a Compose service or a Kubernetes service.
  if (!host.includes('.')) return undefined;

  return { rejectUnauthorized: false };
}
