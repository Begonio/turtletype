/**
 * Checks that what Stripe will charge matches what the pricing page promises.
 *
 * The catalog carries its own `amountCents` so the marketing page can render
 * without a Stripe round trip on every request. That is a cache of a number
 * that lives in Stripe, and the failure mode when the two drift is the worst
 * kind: the page advertises $19, Checkout charges $25, and nobody notices
 * until a customer does. Nothing in the request path can catch it, because the
 * request path never compares them.
 *
 * So this does, on demand:
 *
 *   npm run stripe:verify -w server
 *
 * It also answers the question you cannot answer by looking at a price ID,
 * which is whether it belongs to test mode or live mode — the ID does not say,
 * but the API response does, and pairing a live price with a test key (or the
 * reverse) is the most common way this integration fails on first launch.
 */
import { priceIdFor, SKUS, type Sku } from './catalog.js';
import { stripe } from './stripe.js';

type Status = 'ok' | 'warn' | 'fail' | 'skipped';

interface CheckResult {
  sku: Sku;
  status: Status;
  priceId?: string;
  /** True for a live-mode price, false for test mode. */
  livemode?: boolean;
  notes: string[];
}

async function checkSku(sku: Sku): Promise<CheckResult> {
  const priceId = priceIdFor(sku);
  if (!priceId) {
    return {
      sku,
      status: 'skipped',
      notes: [`${sku.priceIdEnv} is not set — this SKU shows as Unavailable on the pricing page`],
    };
  }

  let price;
  try {
    price = await stripe().prices.retrieve(priceId, { expand: ['product'] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      sku,
      status: 'fail',
      priceId,
      notes: [
        `Stripe could not load this price: ${message}`,
        // These look identical from here, so name all three rather than guess.
        '"No such price" means the key and the price are in different modes (test key with a live price, or the reverse).',
        '"Invalid API Key" means the key itself is wrong. Anything about JSON or the connection means the request never reached Stripe.',
        'Also worth checking the id starts with price_ rather than prod_.',
      ],
    };
  }

  const notes: string[] = [];
  let status: Status = 'ok';

  if (price.unit_amount !== sku.amountCents) {
    status = 'fail';
    notes.push(
      `Stripe charges ${fmt(price.unit_amount, price.currency)} but the pricing page advertises ` +
        `${fmt(sku.amountCents, sku.currency)}. Customers would be shown one number and billed another.`,
    );
  }

  if (price.currency !== sku.currency) {
    status = 'fail';
    notes.push(`Stripe currency is ${price.currency}, the catalog says ${sku.currency}.`);
  }

  const wantsRecurring = sku.kind === 'plan';
  const isRecurring = price.type === 'recurring';
  if (wantsRecurring !== isRecurring) {
    status = 'fail';
    notes.push(
      wantsRecurring
        ? 'This SKU is a subscription but its Stripe price is one-off, so Checkout would open in the wrong mode.'
        : 'This SKU is a one-off pack but its Stripe price is recurring, so buyers would be signed up to a subscription.',
    );
  }

  if (wantsRecurring && isRecurring && price.recurring?.interval !== 'month') {
    status = 'fail';
    notes.push(`Plan renews every ${price.recurring?.interval}, not monthly as the page says.`);
  }

  if (!price.active) {
    status = 'fail';
    notes.push('This price is archived in Stripe — Checkout will refuse it.');
  }

  return { sku, status, priceId, livemode: price.livemode, notes };
}

function fmt(cents: number | null, currency: string): string {
  if (cents === null) return 'an unset amount';
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

export async function verifyBilling(): Promise<CheckResult[]> {
  return Promise.all(SKUS.map(checkSku));
}

async function main(): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not set, so there is nothing to check against.');
    console.error('Set it in your environment (or .env) and run this again.');
    process.exit(1);
  }

  console.log(`Checking ${SKUS.length} SKUs against Stripe…\n`);
  const results = await verifyBilling();

  const icon: Record<Status, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', skipped: 'SKIP' };
  for (const result of results) {
    const { sku } = result;
    console.log(
      `[${icon[result.status]}] ${sku.name.padEnd(9)} ${fmt(sku.amountCents, sku.currency).padEnd(10)} ` +
        `${String(sku.credits).padStart(2)} credits  ${result.priceId ?? '(no price id)'}`,
    );
    for (const note of result.notes) console.log(`         ${note}`);
  }

  // Mixing modes is silently broken rather than loudly broken, so it gets its
  // own line rather than being left for the reader to spot across four rows.
  const modes = new Set(
    results.filter((r) => r.livemode !== undefined).map((r) => (r.livemode ? 'live' : 'test')),
  );
  console.log('');
  if (modes.size === 1) {
    const mode = [...modes][0];
    console.log(`All resolved prices are ${mode}-mode. Pair them with your ${mode}-mode secret key.`);
  } else if (modes.size > 1) {
    console.log('MIXED MODES: some prices are live and some are test. Checkout will fail for one set.');
  }

  const failures = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skipped');

  if (skipped.length > 0) {
    console.log(
      `${skipped.length} SKU(s) unconfigured — they render as Unavailable, which is fine if deliberate.`,
    );
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} problem(s) above would affect real customers. Not safe to launch.`);
    process.exit(1);
  }

  console.log('\nStripe agrees with the pricing page. Webhook secret and portal setup are separate — see docs/stripe-setup.md.');
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isDirectRun) {
  main().catch((error) => {
    console.error('Verification failed to run:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
