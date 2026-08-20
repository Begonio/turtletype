import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { findSku, priceIdFor, publicCatalog } from '../billing/catalog.js';
import { balanceOf, listLedger } from '../billing/credits.js';
import { charsPerWord, referencePoints } from '../billing/whatYouGet.js';
import { stripe } from '../billing/stripe.js';
import { handleEvent, parseEvent } from '../billing/webhook.js';
import { query } from '../db/pool.js';
import { isAuthenticated } from '../middleware/isAuthenticated.js';
import { HttpError } from '../middleware/errorHandler.js';

export const billingRouter = Router();

function wrap(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

/**
 * The price list, and what this account currently has.
 *
 * Deliberately readable without a session so the marketing page can render
 * real prices rather than a hardcoded copy that drifts. The balance half is
 * only filled in when there is a user.
 */
billingRouter.get(
  '/billing/catalog',
  wrap(async (req, res) => {
    const userId = req.user?.id;
    res.json({
      enabled: config.billing.enabled,
      charsPerCredit: config.billing.charsPerCredit,
      maxCreditsPerJob: config.billing.maxCreditsPerJob,
      signupGrantCredits: config.billing.signupGrantCredits,
      skus: publicCatalog(),
      credits: userId ? await balanceOf(userId) : null,
      // Measured by running the real planner, not written into the copy. A
      // customer deciding whether to pay should see how long a job of their
      // size actually takes, and that number moves whenever pacing is tuned.
      reference: referencePoints(),
      charsPerWord: charsPerWord(),
    });
  }),
);

billingRouter.get(
  '/billing/me',
  isAuthenticated,
  wrap(async (req, res) => {
    const user = req.currentUser!;
    res.json({
      credits: user.credits,
      plan: user.plan,
      subscriptionStatus: user.subscription_status,
      currentPeriodEnd: user.current_period_end ? user.current_period_end.toISOString() : null,
      hasBillingAccount: Boolean(user.stripe_customer_id),
      ledger: (await listLedger(user.id, 25)).map((entry) => ({
        delta: entry.delta,
        balanceAfter: entry.balance_after,
        reason: entry.reason,
        createdAt: entry.created_at.toISOString(),
      })),
    });
  }),
);

const checkoutSchema = z.object({
  skuId: z.string().min(1),
});

/**
 * Starts a Checkout session and hands back the URL to send the browser to.
 *
 * The session carries `client_reference_id` so the webhook can find the
 * account without trusting anything the browser says on the way back, and
 * `sku_id` in metadata so the payout amount is decided by the SKU that was
 * actually purchased rather than re-derived from a price lookup.
 */
billingRouter.post(
  '/billing/checkout',
  isAuthenticated,
  wrap(async (req, res) => {
    if (!config.billing.enabled) {
      throw new HttpError(503, 'Billing is not configured on this deployment.', 'BILLING_DISABLED');
    }

    const user = req.currentUser!;
    const { skuId } = checkoutSchema.parse(req.body);
    const sku = findSku(skuId);
    if (!sku) throw new HttpError(400, 'Unknown plan.', 'UNKNOWN_SKU');

    const priceId = priceIdFor(sku);
    if (!priceId) {
      throw new HttpError(
        503,
        `${sku.name} is not available right now.`,
        'SKU_UNAVAILABLE',
      );
    }

    const session = await stripe().checkout.sessions.create({
      mode: sku.kind === 'plan' ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      // Reusing the customer keeps one billing record per account, so the
      // portal shows a real history rather than a fresh customer each time.
      ...(user.stripe_customer_id
        ? { customer: user.stripe_customer_id }
        : { customer_email: user.email }),
      client_reference_id: user.id,
      metadata: { sku_id: sku.id, user_id: user.id },
      // Copied onto the subscription too, so a renewal invoice can be traced
      // back to what was bought without consulting the original session.
      ...(sku.kind === 'plan'
        ? { subscription_data: { metadata: { sku_id: sku.id, user_id: user.id } } }
        : {}),
      success_url: `${config.clientUrl}/app?checkout=success`,
      cancel_url: `${config.clientUrl}/pricing?checkout=cancelled`,
      allow_promotion_codes: true,
    });

    if (!session.url) throw new HttpError(502, 'Stripe did not return a checkout URL.');
    res.json({ url: session.url });
  }),
);

/**
 * Stripe's hosted billing portal — invoices, card changes, cancellation.
 *
 * Cheaper than building any of that, and it keeps card details off this
 * service entirely.
 */
billingRouter.post(
  '/billing/portal',
  isAuthenticated,
  wrap(async (req, res) => {
    if (!config.billing.enabled) {
      throw new HttpError(503, 'Billing is not configured on this deployment.', 'BILLING_DISABLED');
    }
    const user = req.currentUser!;
    if (!user.stripe_customer_id) {
      throw new HttpError(400, 'This account has never been billed.', 'NO_BILLING_ACCOUNT');
    }

    const session = await stripe().billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${config.clientUrl}/app`,
    });
    res.json({ url: session.url });
  }),
);

/**
 * The webhook endpoint.
 *
 * Mounted on its own router so it can be installed *before* `express.json`:
 * signature verification runs against the exact bytes Stripe signed, and a
 * JSON round-trip through `JSON.parse` and back would not reproduce them.
 */
export const stripeWebhookRouter = Router();

stripeWebhookRouter.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req, res) => {
    void (async () => {
      if (!config.billing.enabled) {
        res.status(503).json({ error: 'Billing is not configured.' });
        return;
      }

      const signature = req.header('stripe-signature');
      if (!signature) {
        res.status(400).json({ error: 'Missing stripe-signature header' });
        return;
      }

      let event;
      try {
        event = await parseEvent(req.body as Buffer, signature);
      } catch (error) {
        // A bad signature is either a misconfigured secret or someone poking
        // the endpoint. Never retry-worthy, so answer 400 and say no more.
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[stripe] rejected webhook: ${message}`);
        res.status(400).json({ error: 'Signature verification failed' });
        return;
      }

      try {
        const outcome = await handleEvent(event);
        console.log(`[stripe] ${event.type} (${event.id}): ${outcome}`);
        res.json({ received: true });
      } catch (error) {
        // Answering non-2xx is what makes Stripe retry, which is what we want
        // for a transient database failure. The event stays unrecorded, so the
        // retry reruns it.
        console.error(`[stripe] handler failed for ${event.type} (${event.id}):`, error);
        res.status(500).json({ error: 'Webhook handler failed' });
      }
    })();
  },
);

/**
 * Support endpoint: does the cached balance match the ledger?
 *
 * Restricted to the caller's own account — it answers "why do I have this
 * many credits", not "show me the books".
 */
billingRouter.get(
  '/billing/reconcile',
  isAuthenticated,
  wrap(async (req, res) => {
    const { rows } = await query<{ credits: number; ledger_sum: string | null }>(
      `SELECT u.credits,
              (SELECT SUM(delta) FROM credit_ledger WHERE user_id = u.id) AS ledger_sum
         FROM users u WHERE u.id = $1`,
      [req.currentUser!.id],
    );
    const row = rows[0];
    const balance = row?.credits ?? 0;
    const ledgerSum = Number(row?.ledger_sum ?? 0);
    res.json({ balance, ledgerSum, consistent: balance === ledgerSum });
  }),
);
