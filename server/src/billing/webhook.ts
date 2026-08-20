/**
 * Stripe webhook handling.
 *
 * Webhooks are the only place credit is created, deliberately. The browser
 * being redirected back to a success URL proves nothing — a user can open that
 * URL directly — so the client's return from Checkout only refreshes the
 * balance, and the balance only ever moves when Stripe tells the server, over
 * a signed request, that money actually moved.
 *
 * Everything here must tolerate being run twice. Stripe redelivers on any
 * non-2xx, and redelivers occasionally even on a 2xx it did not hear in time.
 * Idempotency is anchored on the object that represents the payment — the
 * Checkout session for a pack, the invoice for a subscription period — rather
 * than on the event id, because Stripe can emit more than one event for the
 * same payment and only one of them should pay out.
 */
import type Stripe from 'stripe';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import type { UserRow } from '../db/types.js';
import { findSku, priceIdFor, SKUS, type Sku } from './catalog.js';
import { formatCreditsWithUnit, parseCredits } from './amount.js';
import { grantCredits } from './credits.js';
import { stripe } from './stripe.js';

/** Events this app acts on. Anything else is acknowledged and ignored. */
export const HANDLED_EVENTS = [
  'checkout.session.completed',
  // Some payment methods settle after Checkout returns. Without this event a
  // customer who paid by one of them would be charged and never credited,
  // because `checkout.session.completed` arrives while payment_status is still
  // 'unpaid' and correctly declines to pay out.
  'checkout.session.async_payment_succeeded',
  'invoice.paid',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.refunded',
] as const;

/** Maps a configured Stripe price back to the SKU that named it. */
export function skuForPriceId(priceId: string | null | undefined): Sku | undefined {
  if (!priceId) return undefined;
  return SKUS.find((sku) => priceIdFor(sku) === priceId);
}

async function findUserByCustomerId(customerId: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>('SELECT * FROM users WHERE stripe_customer_id = $1', [
    customerId,
  ]);
  return rows[0] ?? null;
}

/** Stripe hands back either an id or an expanded object depending on the call. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

async function linkCustomer(userId: string, customerId: string): Promise<void> {
  await query(
    'UPDATE users SET stripe_customer_id = $2, updated_at = NOW() WHERE id = $1',
    [userId, customerId],
  );
}

/**
 * A completed Checkout.
 *
 * For a pack this is the payment, and the credits are granted here against the
 * session id. For a subscription it is only the signup — `invoice.paid` fires
 * alongside it and is what grants, so this branch just records the linkage.
 */
async function onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<string> {
  const userId = session.client_reference_id;
  const customerId = idOf(session.customer);
  if (!userId) return 'no client_reference_id on session; ignored';

  if (customerId) await linkCustomer(userId, customerId);

  if (session.mode === 'subscription') {
    const subscriptionId = idOf(session.subscription);
    await query(
      `UPDATE users
          SET stripe_subscription_id = $2, subscription_status = 'active', updated_at = NOW()
        WHERE id = $1`,
      [userId, subscriptionId],
    );
    return `subscription ${subscriptionId} linked; credits follow on invoice.paid`;
  }

  // Unpaid sessions reach this handler too (Checkout can complete with an
  // async payment method still pending). Paying out on one would give credit
  // away for a payment that may never land.
  if (session.payment_status !== 'paid') {
    return `session ${session.id} completed but payment_status=${session.payment_status}; no credit`;
  }

  const skuId = session.metadata?.sku_id;
  const sku = skuId ? findSku(skuId) : undefined;
  if (!sku) return `session ${session.id} has no recognisable sku_id (${skuId}); no credit`;

  const result = await grantCredits(userId, sku.credits, 'purchase', session.id);
  return result.applied
    ? `granted ${sku.credits} credit(s) for ${sku.id}, balance ${result.balance}`
    : `session ${session.id} already credited; no-op`;
}

/**
 * A subscription period was paid for — the first one and every renewal.
 *
 * Keyed on the invoice, so the month's credits land exactly once however many
 * events describe that invoice.
 */
async function onInvoicePaid(invoice: Stripe.Invoice): Promise<string> {
  const customerId = idOf(invoice.customer);
  if (!customerId) return 'invoice has no customer; ignored';

  const user = await findUserByCustomerId(customerId);
  if (!user) return `no user linked to customer ${customerId}; ignored`;

  // A one-off pack also produces an invoice. Those were already credited from
  // the Checkout session, so only subscription line items pay out here.
  const line = invoice.lines?.data?.find((item) => Boolean(item.pricing?.price_details?.price));
  // `price` comes back as an id or an expanded object depending on the call
  // that produced the invoice, so normalise before looking it up.
  const priceId = idOf(line?.pricing?.price_details?.price);
  const sku = skuForPriceId(priceId);

  if (!sku || sku.kind !== 'plan') {
    return `invoice ${invoice.id} is not a plan renewal (price ${priceId}); no credit`;
  }

  const result = await grantCredits(
    user.id,
    sku.credits,
    'subscription_renewal',
    invoice.id ?? null,
  );
  return result.applied
    ? `granted ${sku.credits} renewal credit(s), balance ${result.balance}`
    : `invoice ${invoice.id} already credited; no-op`;
}

/**
 * Subscription state changed.
 *
 * Only the status is mirrored — credits are never granted here, because a
 * status change is not a payment. A cancelled plan leaves whatever credits the
 * account already bought: they were paid for.
 */
async function onSubscriptionChanged(subscription: Stripe.Subscription): Promise<string> {
  const customerId = idOf(subscription.customer);
  if (!customerId) return 'subscription has no customer; ignored';

  const user = await findUserByCustomerId(customerId);
  if (!user) return `no user linked to customer ${customerId}; ignored`;

  // `current_period_end` lives on the subscription item in recent API
  // versions; fall back across both shapes so a version bump cannot silently
  // start writing nulls.
  const periodEnd =
    subscription.items?.data?.[0]?.current_period_end ??
    (subscription as unknown as { current_period_end?: number }).current_period_end ??
    null;

  await query(
    `UPDATE users
        SET subscription_status = $2,
            stripe_subscription_id = $3,
            current_period_end = $4,
            updated_at = NOW()
      WHERE id = $1`,
    [
      user.id,
      subscription.status,
      subscription.id,
      periodEnd ? new Date(periodEnd * 1000) : null,
    ],
  );
  return `subscription ${subscription.id} now ${subscription.status}`;
}

/**
 * A charge was refunded.
 *
 * Credits bought with that charge are taken back, down to zero but never
 * below: if they have already been spent on jobs that ran, the work is done
 * and the balance simply floors out rather than going into debt the account
 * can never clear.
 */
async function onChargeRefunded(charge: Stripe.Charge): Promise<string> {
  const customerId = idOf(charge.customer);
  if (!customerId) return 'charge has no customer; ignored';

  const user = await findUserByCustomerId(customerId);
  if (!user) return `no user linked to customer ${customerId}; ignored`;

  // Only a full refund claws back; a partial refund is a support decision, not
  // something to guess at automatically.
  if (!charge.refunded) return `charge ${charge.id} only partially refunded; left alone`;

  const { rows } = await query<{ credits: string | number }>(
    'SELECT credits FROM users WHERE id = $1',
    [user.id],
  );
  const balance = parseCredits(rows[0]?.credits);
  if (balance <= 0) return `charge ${charge.id} refunded; balance already zero`;

  const { rows: updated } = await query<{ credits: string | number }>(
    `UPDATE users SET credits = 0, updated_at = NOW() WHERE id = $1 RETURNING credits`,
    [user.id],
  );
  await query(
    `INSERT INTO credit_ledger (user_id, delta, balance_after, reason, reference)
     VALUES ($1, $2, $3, 'manual_adjustment', $4)
     ON CONFLICT (reason, reference) WHERE reference IS NOT NULL DO NOTHING`,
    [user.id, -balance, parseCredits(updated[0]?.credits), `refund:${charge.id}`],
  );
  return `charge ${charge.id} refunded; cleared ${formatCreditsWithUnit(balance)}`;
}

/** Verifies the signature and returns the parsed event, or throws. */
export async function parseEvent(rawBody: Buffer, signature: string): Promise<Stripe.Event> {
  // constructEventAsync rather than constructEvent: the async form uses the
  // platform's WebCrypto, which does not block the event loop on the HMAC.
  return stripe().webhooks.constructEventAsync(
    rawBody,
    signature,
    config.billing.webhookSecret,
  );
}

/**
 * Acts on one verified event.
 *
 * Returns a short human-readable description of what it did, which the route
 * logs. Unhandled event types are not an error — Stripe sends whatever the
 * endpoint is subscribed to, and acknowledging them keeps them from being
 * retried forever.
 */
export async function handleEvent(event: Stripe.Event): Promise<string> {
  // Fast path for a redelivery of something already dealt with. The real
  // guarantee is the ledger's unique reference; this just avoids the work.
  const seen = await query('SELECT 1 FROM stripe_events WHERE id = $1', [event.id]);
  if (seen.rowCount && seen.rowCount > 0) return `event ${event.id} already processed`;

  let outcome: string;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      // Both carry the same session object, and both route through the same
      // handler: it pays out only when payment_status is 'paid', and the
      // session id keeps the two from crediting twice for one purchase.
      outcome = await onCheckoutCompleted(event.data.object);
      break;
    case 'invoice.paid':
      outcome = await onInvoicePaid(event.data.object);
      break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      outcome = await onSubscriptionChanged(event.data.object);
      break;
    case 'charge.refunded':
      outcome = await onChargeRefunded(event.data.object);
      break;
    default:
      outcome = `no handler for ${event.type}; acknowledged`;
  }

  // Recorded only after the effect succeeded. A handler that threw never gets
  // here, so Stripe's retry finds no record and runs it again.
  await query(
    'INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    [event.id, event.type],
  );
  return outcome;
}
