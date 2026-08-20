/**
 * What the product costs, in one place.
 *
 * Credits, not documents or months, are the unit. The service's scarce
 * resource is concurrency-hours: a job holds a slot in the queue for a
 * duration proportional to its character count, so a character-denominated
 * credit is the only unit that tracks what a customer actually consumes.
 * Charging per document would mean a 400 character note and a 40,000
 * character dissertation cost the same while differing sixtyfold in what they
 * occupy.
 *
 * One credit is five hours of typing — see `config.billing.charsPerCredit` for
 * where that number comes from and `credits.test.ts` for the test that stops
 * it drifting away from what the planner actually does. Charges are priced to
 * the hundredth of a credit, so the rounding is worth a few characters rather
 * than a few thousand.
 *
 * This module is pure: no Stripe client, no database, no environment reads
 * beyond the price IDs the deploy supplies. The client renders its pricing
 * page from `publicCatalog()`, so the numbers a customer sees and the numbers
 * that get charged cannot drift apart.
 */

import { ceilCreditsFromRatio, MIN_CHARGE_CREDITS, roundCredits } from './amount.js';

export type SkuKind = 'pack' | 'plan';

export interface Sku {
  /** Stable identifier used in URLs and the ledger. Never reuse one. */
  id: string;
  kind: SkuKind;
  name: string;
  /** Price in the smallest currency unit, for display only — Stripe is the source of truth. */
  amountCents: number;
  currency: string;
  /** Credits granted per purchase, or per billing period for a plan. */
  credits: number;
  blurb: string;
  highlight?: boolean;
  /** Environment variable holding this SKU's Stripe price ID. */
  priceIdEnv: string;
}

/**
 * Pricing rationale, so the next person to touch these numbers knows what
 * they are trading against:
 *
 * - Stripe takes 2.9% + $0.30. On a $3 charge that is 13%; on a $9 charge it
 *   is 6.2%. That is the floor on the smallest pack — going below roughly $9
 *   gives a meaningful slice of revenue to payment processing for no gain.
 * - Usage is deadline-driven and episodic. Packs that never expire suit that
 *   better than a subscription the customer resents; the plan exists for the
 *   minority who come back every week.
 * - Per-credit price falls with volume because the marginal cash cost of a
 *   credit is close to zero. The real constraint is peak concurrency, and the
 *   job queue enforces that directly rather than through price.
 */
export const SKUS: readonly Sku[] = [
  {
    id: 'pack_starter',
    kind: 'pack',
    name: 'Starter',
    amountCents: 900,
    currency: 'usd',
    credits: 5,
    blurb: 'Five documents at typical essay length. Credits never expire.',
    priceIdEnv: 'STRIPE_PRICE_PACK_STARTER',
  },
  {
    id: 'pack_standard',
    kind: 'pack',
    name: 'Standard',
    amountCents: 1900,
    currency: 'usd',
    credits: 15,
    blurb: 'A semester of coursework, at a third off the starter rate.',
    highlight: true,
    priceIdEnv: 'STRIPE_PRICE_PACK_STANDARD',
  },
  {
    id: 'pack_bulk',
    kind: 'pack',
    name: 'Bulk',
    amountCents: 3900,
    currency: 'usd',
    credits: 40,
    blurb: 'The cheapest per credit. For long documents or heavy terms.',
    priceIdEnv: 'STRIPE_PRICE_PACK_BULK',
  },
  {
    id: 'plan_monthly',
    kind: 'plan',
    name: 'Monthly',
    amountCents: 1200,
    currency: 'usd',
    credits: 12,
    blurb: 'Twelve credits every month, added to your balance. Cancel anytime.',
    priceIdEnv: 'STRIPE_PRICE_PLAN_MONTHLY',
  },
];

export function findSku(id: string): Sku | undefined {
  return SKUS.find((sku) => sku.id === id);
}

/** The Stripe price ID this deploy has configured for a SKU, if any. */
export function priceIdFor(sku: Sku): string | undefined {
  const value = process.env[sku.priceIdEnv];
  return value && value.trim() ? value.trim() : undefined;
}

/**
 * How many credits a job of this length costs.
 *
 * Priced to the hundredth of a credit, so what a customer pays tracks what
 * they actually use. Rounding to whole credits meant a 400 character note and
 * a 7,000 character essay cost the same, and the note is roughly seventeen
 * times less work — a difference big enough that short jobs were quietly
 * subsidising long ones and nobody could see it in the price.
 *
 * Rounded up, and never zero: even a one-line document occupies a queue slot
 * and writes a real revision history, so it is never free once the signup
 * grant is spent. `MIN_CHARGE_CREDITS` is one hundredth of a credit, which at
 * the default rate is about eighty characters.
 */
export function creditsForChars(chars: number, charsPerCredit: number): number {
  if (chars <= 0) return 0;
  return Math.max(MIN_CHARGE_CREDITS, ceilCreditsFromRatio(chars, charsPerCredit));
}

/**
 * The inverse: how much writing a balance buys. Rounded *down*, because this
 * answers "what can I do with this", and a figure a customer cannot quite
 * afford is worse than one that undersells by a few characters.
 */
export function charsForCredits(credits: number, charsPerCredit: number): number {
  if (credits <= 0) return 0;
  return Math.floor(roundCredits(credits) * charsPerCredit);
}

export interface PublicSku extends Omit<Sku, 'priceIdEnv'> {
  /** False when the deploy has not configured a Stripe price for this SKU. */
  available: boolean;
  /** Cents per credit, precomputed so the UI does not re-derive it. */
  centsPerCredit: number;
}

/**
 * The catalog as the browser sees it. Omits the environment variable names and
 * marks anything the deploy has not wired to a Stripe price as unavailable, so
 * a half-configured deploy shows a disabled button rather than a checkout that
 * 500s.
 */
export function publicCatalog(): PublicSku[] {
  return SKUS.map(({ priceIdEnv, ...rest }) => ({
    ...rest,
    available: Boolean(process.env[priceIdEnv]?.trim()),
    centsPerCredit: Math.round(rest.amountCents / rest.credits),
  }));
}
