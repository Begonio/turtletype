/**
 * The Stripe client, constructed lazily.
 *
 * Lazily because `config.ts` keeps secrets behind getters so pure modules stay
 * importable without an environment, and constructing this at module load
 * would undo that: importing anything under `billing/` would demand a live
 * STRIPE_SECRET_KEY, including in the test run.
 */
import Stripe from 'stripe';
import { config } from '../config.js';

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!client) {
    client = new Stripe(config.billing.secretKey, {
      // Pinned rather than inherited from the account. Stripe rolls the
      // account default forward when it ships a new version, which would
      // change webhook payload shapes under a deploy that never redeployed.
      apiVersion: config.billing.apiVersion as Stripe.LatestApiVersion,
      appInfo: { name: 'TurtleType', url: 'https://type.turtlegames.org' },
      // Stripe's own retries, on top of which the caller sees one clean error.
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }
  return client;
}

/** Test seam: drops the memoised client so a test can swap the environment. */
export function resetStripeClient(): void {
  client = null;
}
