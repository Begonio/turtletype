/**
 * What a production deploy must have configured before it is allowed to serve.
 *
 * Billing is deliberately fail-open everywhere else in this codebase: with no
 * Stripe keys `config.billing.enabled` is false, the paywall waves every job
 * through, and a self-hosted instance behaves as if billing never existed.
 * That is the right default for a laptop and the wrong one for the deploy that
 * is meant to charge people — there, a missing key is not "free for everyone",
 * it is the product being given away silently, and nothing in a log line makes
 * that visible until the invoice does not arrive.
 *
 * So production inverts the default: unless the operator has explicitly asked
 * for free mode, a deploy that cannot bill refuses to boot. `ALLOW_FREE_MODE`
 * is the escape hatch, and it has to be typed on purpose.
 *
 * This module is pure — it reads an env object handed to it, never
 * `process.env` directly, and never touches the database — so the rules can be
 * tested without a live environment.
 */

export interface LaunchProblem {
  /** Environment variable at fault, or a short label when it is not one. */
  subject: string;
  /** What is wrong and what to do about it. */
  detail: string;
}

export interface LaunchReport {
  /** Refuse to boot. Without these the deploy cannot do what it promises. */
  errors: LaunchProblem[];
  /** Boot, but say so loudly. Wrong-looking rather than broken. */
  warnings: LaunchProblem[];
}

export interface LaunchCheckOptions {
  isProduction: boolean;
}

/** Price ID variables that let a customer actually hand over money. */
const PACK_PRICE_ENV = [
  'STRIPE_PRICE_PACK_STARTER',
  'STRIPE_PRICE_PACK_STANDARD',
  'STRIPE_PRICE_PACK_BULK',
] as const;

const PLAN_PRICE_ENV = 'STRIPE_PRICE_PLAN_MONTHLY';

/** Trimmed value, or undefined when unset or whitespace. */
function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function isTrue(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = value(env, name);
  return raw === 'true' || raw === '1';
}

/**
 * Everything a paying production deploy needs.
 *
 * The interesting rule is the price-ID one. A deploy with Stripe keys but no
 * price configured passes every other check and then paywalls every user
 * against a pricing page whose buttons are all disabled — the worst of both
 * states, since it neither earns nor works. One purchasable pack is the real
 * minimum for "payments are required".
 */
export function launchReport(
  env: NodeJS.ProcessEnv,
  { isProduction }: LaunchCheckOptions,
): LaunchReport {
  const errors: LaunchProblem[] = [];
  const warnings: LaunchProblem[] = [];

  const freeMode = isTrue(env, 'ALLOW_FREE_MODE');
  const secretKey = value(env, 'STRIPE_SECRET_KEY');
  const webhookSecret = value(env, 'STRIPE_WEBHOOK_SECRET');

  // Outside production nothing here is enforced: the test suite and local
  // development run with no Stripe account at all, by design.
  if (!isProduction) return { errors, warnings };

  if (freeMode) {
    warnings.push({
      subject: 'ALLOW_FREE_MODE',
      detail:
        'Free mode is ON in production: every job runs without charge and no ledger rows are ' +
        'written. Unset this variable to require payment.',
    });
    return { errors, warnings };
  }

  if (!secretKey) {
    errors.push({
      subject: 'STRIPE_SECRET_KEY',
      detail:
        'Required in production. Without it billing is off and every job is free. ' +
        'Set it from Stripe → Developers → API keys, or set ALLOW_FREE_MODE=true if that is what you want.',
    });
  }

  if (!webhookSecret) {
    errors.push({
      subject: 'STRIPE_WEBHOOK_SECRET',
      detail:
        'Required in production. Webhooks are the only place credit is created, so without the ' +
        'signing secret a completed payment never becomes credits. It comes from the endpoint ' +
        'you create under Stripe → Developers → Webhooks (not from `stripe listen`).',
    });
  }

  // Only worth checking once the keys that switch billing on are present —
  // otherwise this just repeats the message above three more times.
  if (secretKey && webhookSecret) {
    const purchasable = PACK_PRICE_ENV.filter((name) => value(env, name));
    if (purchasable.length === 0) {
      errors.push({
        subject: PACK_PRICE_ENV.join(' / '),
        detail:
          'No purchasable pack is configured, so every user would hit the paywall with no way ' +
          'through — the pricing page renders each unpriced SKU as a disabled button. Configure ' +
          'at least one pack price ID from Stripe → Product catalog.',
      });
    } else if (purchasable.length < PACK_PRICE_ENV.length) {
      const missing = PACK_PRICE_ENV.filter((name) => !value(env, name));
      warnings.push({
        subject: missing.join(', '),
        detail: 'These packs show on the pricing page as unavailable. Intentional?',
      });
    }

    if (!value(env, PLAN_PRICE_ENV)) {
      warnings.push({
        subject: PLAN_PRICE_ENV,
        detail: 'The monthly plan shows as unavailable. Packs alone are a valid catalog.',
      });
    }
  }

  if (secretKey?.startsWith('sk_test_')) {
    warnings.push({
      subject: 'STRIPE_SECRET_KEY',
      detail:
        'This is a test-mode key in a production deploy: checkout will succeed and no money will ' +
        'move. Swap it for the live key (sk_live_…) and re-issue the webhook secret with it.',
    });
  }

  return { errors, warnings };
}

/**
 * The legal identity the privacy policy, terms and OAuth consent screen all
 * quote. Separate from the billing rules above because the failure mode is
 * different: a missing jurisdiction is an embarrassment on a page, not a
 * service that cannot charge, and taking a running deploy down over it would
 * be a worse outcome than shipping it. So these are warnings at boot and
 * errors under `npm run launch:check`, which is the gate to run before
 * submitting to Google.
 */
export function legalReport(env: NodeJS.ProcessEnv): LaunchProblem[] {
  const problems: LaunchProblem[] = [];

  // SUPPORT_EMAIL is deliberately absent from this list. It ships with a real
  // default (help@turtlegames.org) rather than a placeholder, so an unset
  // variable is correct rather than unfinished — unlike the two below, where
  // no honest default exists. Override it if the address ever changes.

  if (!value(env, 'LEGAL_OPERATOR')) {
    problems.push({
      subject: 'LEGAL_OPERATOR',
      detail:
        'The legal entity or individual operating the service, as it should read on /privacy ' +
        'and /terms. Google OAuth verification checks that this matches the Cloud project owner. ' +
        'It falls back to the product name, which is not an operator — a customer disputing a ' +
        'charge needs to know who they contracted with.',
    });
  }

  if (!value(env, 'LEGAL_JURISDICTION')) {
    problems.push({
      subject: 'LEGAL_JURISDICTION',
      detail:
        'The governing law for the terms, e.g. "England and Wales" or "California, USA". ' +
        'The terms name it in the disputes section and read as unfinished without it.',
    });
  }

  return problems;
}
