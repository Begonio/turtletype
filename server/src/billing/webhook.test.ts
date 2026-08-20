import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type Stripe from 'stripe';

/**
 * Webhook handling, against a real database.
 *
 * The failure this suite exists to prevent is paying out twice for one
 * payment. Stripe retries any non-2xx, retries some 2xxs it did not hear in
 * time, and emits more than one event type for the same underlying payment —
 * so "it worked when I clicked buy once" is not evidence of anything.
 */
const databaseUrl = process.env.DATABASE_URL;

describe(
  'stripe webhook handlers',
  { skip: databaseUrl ? false : 'DATABASE_URL is not set' },
  () => {
    let pool: (typeof import('../db/pool.js'))['pool'];
    let query: (typeof import('../db/pool.js'))['query'];
    let handleEvent: (typeof import('./webhook.js'))['handleEvent'];
    let balanceOf: (typeof import('./credits.js'))['balanceOf'];

    let userId: string;
    let customerId: string;
    let unique: string;

    before(async () => {
      // The plan SKU has to resolve to a price for the renewal path to be
      // reachable, and these are read at call time rather than at import.
      process.env.STRIPE_PRICE_PLAN_MONTHLY = 'price_plan_monthly_test';
      process.env.STRIPE_PRICE_PACK_STANDARD = 'price_pack_standard_test';

      const poolModule = await import('../db/pool.js');
      pool = poolModule.pool;
      query = poolModule.query;
      handleEvent = (await import('./webhook.js')).handleEvent;
      balanceOf = (await import('./credits.js')).balanceOf;
      const { migrate } = await import('../db/migrate.js');
      await migrate();
    });

    after(async () => {
      if (pool) await pool.end().catch(() => {});
    });

    beforeEach(async () => {
      unique = Math.random().toString(36).slice(2);
      customerId = `cus_${unique}`;
      const { rows } = await query<{ id: string }>(
        `INSERT INTO users (google_id, email, credits, stripe_customer_id)
         VALUES ($1, $2, 0, $3) RETURNING id`,
        [`hook-${unique}`, `hook-${unique}@example.com`, customerId],
      );
      userId = rows[0]!.id;
    });

    /** Minimal event envelope — only the fields the handlers actually read. */
    const event = (type: string, object: unknown, id = `evt_${unique}_${Math.random()}`): Stripe.Event =>
      ({ id, type, data: { object } }) as unknown as Stripe.Event;

    const checkoutSession = (overrides: Record<string, unknown> = {}): unknown => ({
      id: `cs_${unique}`,
      mode: 'payment',
      payment_status: 'paid',
      customer: customerId,
      client_reference_id: userId,
      metadata: { sku_id: 'pack_standard', user_id: userId },
      ...overrides,
    });

    it('credits a paid pack purchase', async () => {
      await handleEvent(event('checkout.session.completed', checkoutSession()));
      assert.equal(await balanceOf(userId), 15);
    });

    it('does not credit twice when Stripe redelivers the same event', async () => {
      const one = event('checkout.session.completed', checkoutSession(), `evt_dup_${unique}`);
      await handleEvent(one);
      await handleEvent(one);
      await handleEvent(one);
      assert.equal(await balanceOf(userId), 15);
    });

    it('does not credit twice for two different events describing one payment', async () => {
      // The subtle case: Stripe emits `checkout.session.completed` and later
      // `checkout.session.async_payment_succeeded` for the same session. Event
      // id deduplication alone would let both through, which is why the
      // idempotency key is the session, not the event.
      await handleEvent(
        event('checkout.session.completed', checkoutSession(), `evt_a_${unique}`),
      );
      await handleEvent(
        event('checkout.session.completed', checkoutSession(), `evt_b_${unique}`),
      );
      assert.equal(await balanceOf(userId), 15);
    });

    it('gives nothing away for a session whose payment has not landed', async () => {
      await handleEvent(
        event('checkout.session.completed', checkoutSession({ payment_status: 'unpaid' })),
      );
      assert.equal(await balanceOf(userId), 0);
    });

    it('ignores a session with no account attached to it', async () => {
      await handleEvent(
        event('checkout.session.completed', checkoutSession({ client_reference_id: null })),
      );
      assert.equal(await balanceOf(userId), 0);
    });

    it('ignores a session naming a SKU this build does not have', async () => {
      // A price deleted in the Stripe dashboard, or a rolled-back deploy.
      // Granting a guessed amount would be worse than granting nothing.
      await handleEvent(
        event('checkout.session.completed', checkoutSession({ metadata: { sku_id: 'pack_ghost' } })),
      );
      assert.equal(await balanceOf(userId), 0);
    });

    const invoice = (id: string, priceId: string): unknown => ({
      id,
      customer: customerId,
      lines: { data: [{ pricing: { price_details: { price: priceId } } }] },
    });

    it('credits a subscription period once per invoice', async () => {
      const first = invoice(`in_${unique}_1`, 'price_plan_monthly_test');
      await handleEvent(event('invoice.paid', first, `evt_inv_a_${unique}`));
      await handleEvent(event('invoice.paid', first, `evt_inv_b_${unique}`));
      assert.equal(await balanceOf(userId), 12);

      // Next month is a different invoice, and does credit again.
      await handleEvent(
        event('invoice.paid', invoice(`in_${unique}_2`, 'price_plan_monthly_test'), `evt_inv_c_${unique}`),
      );
      assert.equal(await balanceOf(userId), 24);
    });

    it('does not double-credit a pack through its invoice', async () => {
      // A one-off purchase produces both a Checkout session and an invoice.
      // The session credits it; the invoice must not credit it again.
      await handleEvent(event('checkout.session.completed', checkoutSession()));
      await handleEvent(
        event('invoice.paid', invoice(`in_${unique}_pack`, 'price_pack_standard_test')),
      );
      assert.equal(await balanceOf(userId), 15);
    });

    it('ignores an invoice for a customer this service does not know', async () => {
      await handleEvent(
        event('invoice.paid', {
          id: `in_${unique}_orphan`,
          customer: 'cus_someone_else',
          lines: { data: [{ pricing: { price_details: { price: 'price_plan_monthly_test' } } }] },
        }),
      );
      assert.equal(await balanceOf(userId), 0);
    });

    it('mirrors subscription status without granting anything', async () => {
      await handleEvent(
        event('customer.subscription.updated', {
          id: `sub_${unique}`,
          customer: customerId,
          status: 'past_due',
          items: { data: [{ current_period_end: 1893456000 }] },
        }),
      );

      const { rows } = await query<{ subscription_status: string; credits: number }>(
        'SELECT subscription_status, credits FROM users WHERE id = $1',
        [userId],
      );
      assert.equal(rows[0]?.subscription_status, 'past_due');
      assert.equal(rows[0]?.credits, 0, 'a status change is not a payment');
    });

    it('leaves bought credits alone when a plan is cancelled', async () => {
      await handleEvent(event('checkout.session.completed', checkoutSession()));
      await handleEvent(
        event('customer.subscription.deleted', {
          id: `sub_${unique}`,
          customer: customerId,
          status: 'canceled',
          items: { data: [] },
        }),
      );
      assert.equal(await balanceOf(userId), 15, 'cancelling a plan must not confiscate paid credits');
    });

    it('claws back the balance on a full refund', async () => {
      await handleEvent(event('checkout.session.completed', checkoutSession()));
      await handleEvent(
        event('charge.refunded', { id: `ch_${unique}`, customer: customerId, refunded: true }),
      );
      assert.equal(await balanceOf(userId), 0);
    });

    it('leaves a partial refund to a human', async () => {
      await handleEvent(event('checkout.session.completed', checkoutSession()));
      await handleEvent(
        event('charge.refunded', { id: `ch_${unique}_p`, customer: customerId, refunded: false }),
      );
      assert.equal(await balanceOf(userId), 15);
    });

    it('acknowledges an event type it has no handler for', async () => {
      const outcome = await handleEvent(
        event('payment_intent.created', { id: `pi_${unique}` }),
      );
      assert.match(outcome, /no handler/);
    });
  },
);
