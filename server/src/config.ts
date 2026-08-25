import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { resolvePickerConfig, type PickerSettings } from './auth/pickerConfig.js';
import { DEFAULT_MIN_CHUNK_REST_MS } from './jobs/humanize.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Look for a .env in server/ first, then at the repo root, so either layout works.
for (const candidate of [
  path.resolve(here, '../.env'),
  path.resolve(here, '../../.env'),
  path.resolve(here, '../../../.env'),
]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}
dotenv.config(); // also honour variables already present in the environment

/** Every variable the server cannot start without. */
export const REQUIRED_ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CALLBACK_URL',
  'SESSION_SECRET',
  'DATABASE_URL',
] as const;

/**
 * Secrets are read through getters rather than validated at import time.
 * Pure modules (the humanization engine, the request planner, the backoff
 * helpers) import this file for tuning values and must stay importable in a
 * test run with no environment at all. `assertRequiredEnv` restores the
 * fail-fast behaviour at boot, where it belongs.
 */
export function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill it in.',
    );
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

/**
 * Express's `trust proxy` setting. Accepts `false`, `true`, or a hop count.
 *
 * The hop count matters when more than one proxy sits in front of the app —
 * Cloudflare in front of a platform router, for example, is two. Getting it
 * wrong means `req.ip` reports a proxy address rather than the client.
 */
function trustProxySetting(fallback: boolean): boolean | number {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return 1;
  if (raw === 'false' || raw === '0') return false;
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops > 0) return hops;
  throw new Error(`TRUST_PROXY must be true, false, or a positive hop count, got "${raw}"`);
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: num('PORT', 8080),
  clientUrl: (process.env.CLIENT_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  trustProxy: trustProxySetting(nodeEnv === 'production'),

  get sessionSecret(): string {
    return required('SESSION_SECRET');
  },
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },

  google: {
    get clientId(): string {
      return required('GOOGLE_CLIENT_ID');
    },
    get clientSecret(): string {
      return required('GOOGLE_CLIENT_SECRET');
    },
    get callbackUrl(): string {
      return required('GOOGLE_CALLBACK_URL');
    },
    /**
     * The permission the app cannot work without. Google shows sensitive
     * scopes as a checkbox the user has to tick, and there is no way to
     * pre-select it, so sign-in has to cope with it being declined.
     */
    documentsScope: 'https://www.googleapis.com/auth/documents',
    scopes: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/documents',
      /**
       * Per-file access, so the Google Picker can hand the app a document the
       * user chose from their own Drive.
       *
       * Non-sensitive and, in Google's words, recommended — it adds nothing to
       * the verification review, which is exactly why the picker is built on
       * it rather than on a Drive listing call. `drive.readonly` and
       * `drive.metadata.readonly` would let the app render its own list of the
       * user's documents, but both are **restricted** scopes and would drag a
       * third-party CASA security assessment, repeated annually, into the
       * submission.
       *
       * Optional in practice: a user who unticks it can still paste a link, so
       * unlike the documents scope this one never blocks sign-in — see
       * `grantedDocumentsAccess`, which deliberately does not check for it.
       */
      'https://www.googleapis.com/auth/drive.file',
    ],
    /**
     * Whether Google has finished verifying the OAuth app.
     *
     * While this is false, anyone signing in meets Google's "Google hasn't
     * verified this app" interstitial before the consent screen and has to
     * click through Advanced → Go to TurtleType (unsafe). The sign-in page
     * warns them so the wording does not read as a malware warning — which,
     * on a page that then asks for money, is what it looks like.
     *
     * A flag rather than hardcoded copy for the same reason the landing page
     * stopped hardcoding "free while in beta": a notice about a temporary
     * state outlives the state unless something makes it go away. Flip this
     * to true the day verification lands and the notice disappears.
     */
    appVerified: bool('OAUTH_APP_VERIFIED', false),
    /**
     * Override for the Docs API base URL. Unset in production; the integration
     * tests point it at a local fake so the whole write path can run without
     * touching Google.
     */
    docsRootUrl: process.env.GOOGLE_DOCS_ROOT_URL,
    /**
     * Override for the Drive API base URL, used to read a document's revision
     * list. Unset in production; the integration tests point it at a local
     * fake alongside the Docs one.
     */
    driveRootUrl: process.env.GOOGLE_DRIVE_ROOT_URL,
    /**
     * Google Picker settings, served to the browser at runtime.
     *
     * `GOOGLE_PICKER_API_KEY` is a browser API key from the same Cloud project
     * — it is public by design, restricted by HTTP referrer rather than kept
     * secret. Leave it unset and the picker button simply does not appear.
     */
    get picker(): PickerSettings {
      return resolvePickerConfig({
        clientId: process.env.GOOGLE_CLIENT_ID,
        apiKey: process.env.GOOGLE_PICKER_API_KEY,
        appId: process.env.GOOGLE_PICKER_APP_ID,
      });
    },
  },

  jobs: {
    /**
     * How often the accumulated typing buffer is flushed to Google Docs.
     * One flush == one batchUpdate request.
     */
    flushIntervalMs: num('FLUSH_INTERVAL_MS', 800),
    /**
     * Hard ceiling on batchUpdate calls per minute for a single job. The Docs
     * API caps writes at 60/min/document, so this must stay under 60. An
     * 800ms flush interval alone would produce 75/min, so the limiter holds
     * flushes back (the buffer simply grows) to stay inside the quota.
     */
    writesPerMinute: num('DOCS_WRITES_PER_MINUTE', 55),
    maxConcurrentJobs: num('MAX_CONCURRENT_JOBS', 20),
    maxTextLength: num('MAX_TEXT_LENGTH', 200_000),
    /**
     * Shortest gap between writing bursts. Google Docs folds edits that happen
     * close together into a single revision, so a document written with no
     * gaps shows up in version history as one entry — identical to a paste.
     *
     * Defaulted from the planner's own constant rather than repeated as a
     * literal. The two had already drifted apart once: the engine's floor was
     * retuned and this stayed at the old figure, so the retune reached the
     * tests and never reached production, where this value is always passed
     * explicitly. Deriving it means a pacing change lands in one place.
     */
    minChunkRestMs: num('MIN_CHUNK_REST_MS', DEFAULT_MIN_CHUNK_REST_MS),
    /**
     * How much text lands in one burst. Roughly one version-history entry per
     * burst, so smaller values give a more granular history at the cost of a
     * longer minimum runtime.
     */
    minChunkChars: num('BURST_MIN_CHARS', 55),
    maxChunkChars: num('BURST_MAX_CHARS', 150),
    /** Longest a single job may be stretched over. */
    maxJobDurationMs: num('MAX_JOB_DURATION_MS', 24 * 60 * 60 * 1_000),
    /**
     * Whether a job may end a checkpoint gap early once it has *seen* Google
     * Docs record the revision that gap was waiting for.
     *
     * This is where most of a job's wall clock goes. The planner cannot read
     * Docs' checkpoint clock, so it sizes every gap to contain a checkpoint
     * under the worst phase of that clock — correct, and enormously
     * pessimistic when the revision has in fact already landed. Polling the
     * document's revision list turns the assumption into an observation.
     *
     * Off makes every gap run its full planned length, which is what the
     * engine did before revision watching existed. It is a kill switch, not a
     * tuning knob: leaving it on costs a handful of small Drive reads per gap
     * and never shortens a gap that has not been confirmed.
     */
    confirmCheckpoints: bool('CONFIRM_CHECKPOINTS', true),
    /**
     * How often a resting job asks Drive whether the revision has appeared.
     *
     * Per job, never shared — the same rule the write limiter follows. Twelve
     * a minute resolves a gap to within five seconds while staying far inside
     * Drive's quota even at full job concurrency.
     */
    revisionPollsPerMinute: num('REVISION_POLLS_PER_MINUTE', 12),
    /** Gap between revision polls. Sets how much of a confirmed gap is overshoot. */
    revisionPollIntervalMs: num('REVISION_POLL_INTERVAL_MS', 5_000),
  },

  /**
   * Billing.
   *
   * Off by default: with no Stripe keys set `billing.enabled` is false and the
   * paywall lets every job through, which keeps local development and the test
   * suite free of Stripe entirely and lets a self-hosted instance run without
   * a payment processor.
   *
   * That default is inverted in production. Degrading to "free for everyone"
   * is fine on a laptop and unacceptable on the deploy that is supposed to
   * charge, so `launchChecks.ts` refuses to boot a production instance that
   * cannot bill. `ALLOW_FREE_MODE=true` opts back out, deliberately.
   */
  billing: {
    get secretKey(): string {
      return required('STRIPE_SECRET_KEY');
    },
    get webhookSecret(): string {
      return required('STRIPE_WEBHOOK_SECRET');
    },
    /**
     * Pin the Stripe API version rather than inheriting the account default.
     * The account default moves when Stripe ships a new version, which would
     * otherwise change webhook payload shapes under a running deploy.
     */
    apiVersion: '2026-07-29.dahlia',
    /** Billing is off unless both secrets are present. */
    get enabled(): boolean {
      return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
    },
    /**
     * Whether running without billing is a deliberate choice rather than a
     * misconfiguration. Only consulted in production, where the boot check
     * would otherwise have refused to start.
     */
    get freeModeAllowed(): boolean {
      const raw = process.env.ALLOW_FREE_MODE?.trim();
      return raw === 'true' || raw === '1';
    },
    /**
     * How many characters one credit buys.
     *
     * Credits are the unit the user sees, and they track the resource the
     * service is actually short of: a job holds a concurrency slot for a
     * length of time proportional to its character count, so charging per
     * character is charging per job-hour.
     *
     * **One credit is meant to be three hours of typing.** That is the number
     * to reason about; this one is derived from it. The planner writes about
     * 1,830 characters an hour at current pacing — measured across seeds and
     * document sizes, near enough linear from 1,000 characters up — so three
     * hours is 5,490 characters.
     *
     * The definition was five hours until the pacing work landed. Shortening
     * it to three is a deliberate repricing, not a re-derivation: the same
     * money now buys less writing. Whichever number is chosen, the rule this
     * codebase follows is that the hours are primary and this figure follows
     * them — never the other way round, and never adjusted by feel.
     *
     * Measured against the planner's own estimate, which is the figure quoted
     * on the pricing page and the only one knowable when a customer pays. A
     * job whose document exposes its revision history finishes sooner than
     * that — see `confirmCheckpoints` — but how much sooner depends on how
     * quickly Google checkpoints on the day, which is not a thing to price
     * against.
     *
     * Do not adjust this by feel when pacing changes. `credits.test.ts` runs
     * the real planner over a document of exactly this length and fails if it
     * no longer takes about three hours, which is the same discipline
     * `whatYouGet.ts` applies to the pricing page: the figure a customer is
     * charged against has to be one the engine actually produces.
     */
    charsPerCredit: num('CHARS_PER_CREDIT', 5_490),
    /** Credits handed to a new account once, so the revision history can be seen before paying. */
    signupGrantCredits: num('SIGNUP_GRANT_CREDITS', 1),
    /**
     * Longest a single job may be, in credits. Guards against one job eating a
     * whole pack.
     *
     * Kept at `maxTextLength / charsPerCredit`, so the credit ceiling and the
     * character ceiling bite at the same point and a document is refused for
     * one clearly stated reason rather than two. 37 credits is 203,130
     * characters against a 200,000 character text limit.
     */
    maxCreditsPerJob: num('MAX_CREDITS_PER_JOB', 37),
  },

  /**
   * The identity the legal pages and the OAuth consent screen quote.
   *
   * Read at runtime and served to the browser rather than compiled into the
   * bundle, so changing the support address or the operating entity is an
   * environment change on the platform rather than a rebuild and redeploy.
   * Google's OAuth review checks that these agree with the Cloud project's
   * owner and support contact, and re-checks annually.
   */
  legal: {
    get operator(): string {
      return process.env.LEGAL_OPERATOR?.trim() || 'TurtleType';
    },
    /**
     * Public support address, on the operator's own domain. Overridable, but
     * the default is the real one rather than a placeholder — this address
     * goes on the consent screen and both policy pages, and an unset variable
     * should not put a personal inbox in front of reviewers and customers.
     */
    get contactEmail(): string {
      return process.env.SUPPORT_EMAIL?.trim() || 'help@turtlegames.org';
    },
    /** Empty until configured; the terms render a placeholder note instead of a fake. */
    get jurisdiction(): string {
      return process.env.LEGAL_JURISDICTION?.trim() || '';
    },
    get lastUpdated(): string {
      return process.env.LEGAL_LAST_UPDATED?.trim() || '20 August 2026';
    },
  },

  backoff: {
    initialDelayMs: num('BACKOFF_INITIAL_MS', 2_000),
    maxDelayMs: num('BACKOFF_MAX_MS', 32_000),
    maxRetries: num('BACKOFF_MAX_RETRIES', 5),
  },
} as const;

export type Config = typeof config;
