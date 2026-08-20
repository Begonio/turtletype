import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { launchReport, legalReport } from './launchChecks.js';

/** A production environment with everything a paying deploy needs. */
const PAYING: NodeJS.ProcessEnv = {
  STRIPE_SECRET_KEY: 'sk_live_abc',
  STRIPE_WEBHOOK_SECRET: 'whsec_abc',
  STRIPE_PRICE_PACK_STARTER: 'price_1',
  STRIPE_PRICE_PACK_STANDARD: 'price_2',
  STRIPE_PRICE_PACK_BULK: 'price_3',
  STRIPE_PRICE_PLAN_MONTHLY: 'price_4',
};

const prod = (env: NodeJS.ProcessEnv) => launchReport(env, { isProduction: true });
const subjects = (problems: { subject: string }[]) => problems.map((p) => p.subject);

describe('launchReport', () => {
  it('passes a fully configured production deploy with nothing to say', () => {
    const { errors, warnings } = prod(PAYING);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  it('enforces nothing outside production', () => {
    // The test suite and every laptop run with no Stripe account at all.
    const { errors, warnings } = launchReport({}, { isProduction: false });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  it('refuses to boot a production deploy with no Stripe keys', () => {
    // This is the whole point: without the keys billing is off and every job
    // is free, which on this deploy means the product is being given away.
    const { errors } = prod({});
    assert.deepEqual(subjects(errors), ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
  });

  it('refuses a deploy that can charge but has no webhook secret', () => {
    // Webhooks are the only place credit is created, so a payment taken
    // without one is money in and nothing out.
    const { errors } = prod({ ...PAYING, STRIPE_WEBHOOK_SECRET: undefined });
    assert.deepEqual(subjects(errors), ['STRIPE_WEBHOOK_SECRET']);
  });

  it('refuses a paywall with nothing behind it', () => {
    // Keys but no price IDs paywalls every user against a pricing page whose
    // buttons are all disabled — neither earning nor working.
    const { errors } = prod({
      STRIPE_SECRET_KEY: 'sk_live_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc',
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.detail, /no way\s+through/);
  });

  it('accepts one pack alone, but says which are missing', () => {
    const { errors, warnings } = prod({
      STRIPE_SECRET_KEY: 'sk_live_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc',
      STRIPE_PRICE_PACK_STARTER: 'price_1',
    });
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 2); // the two unpriced packs, and the plan
  });

  it('does not repeat the price complaint when the keys are missing anyway', () => {
    // Otherwise a bare environment reports five problems that are one problem.
    const { errors } = prod({});
    assert.equal(errors.length, 2);
  });

  it('warns rather than fails on a test key in production', () => {
    // Checkout succeeds and no money moves — wrong, but not a reason to
    // refuse to serve a deploy that is otherwise complete.
    const { errors, warnings } = prod({ ...PAYING, STRIPE_SECRET_KEY: 'sk_test_abc' });
    assert.deepEqual(errors, []);
    assert.deepEqual(subjects(warnings), ['STRIPE_SECRET_KEY']);
  });

  it('lets free mode through, loudly', () => {
    const { errors, warnings } = prod({ ALLOW_FREE_MODE: 'true' });
    assert.deepEqual(errors, []);
    assert.deepEqual(subjects(warnings), ['ALLOW_FREE_MODE']);
  });

  it('needs free mode spelled out, not merely present', () => {
    // An empty or accidental value must not switch the paywall off.
    for (const value of ['', 'false', '0', 'yes', 'TRUE']) {
      const { errors } = prod({ ALLOW_FREE_MODE: value });
      assert.ok(errors.length > 0, `ALLOW_FREE_MODE=${JSON.stringify(value)} disabled the paywall`);
    }
  });

  it('treats a whitespace-only variable as unset', () => {
    // Platform variable editors make this easy to produce by accident.
    const { errors } = prod({ ...PAYING, STRIPE_SECRET_KEY: '   ' });
    assert.deepEqual(subjects(errors), ['STRIPE_SECRET_KEY']);
  });
});

describe('legalReport', () => {
  it('is satisfied by the two variables that have no honest default', () => {
    assert.deepEqual(
      legalReport({
        LEGAL_OPERATOR: 'A Person',
        LEGAL_JURISDICTION: 'England and Wales',
      }),
      [],
    );
  });

  it('names each missing piece the legal pages and consent screen quote', () => {
    assert.deepEqual(subjects(legalReport({})), ['LEGAL_OPERATOR', 'LEGAL_JURISDICTION']);
  });

  it('does not require SUPPORT_EMAIL, which ships with a real default', () => {
    // config.legal.contactEmail falls back to help@turtlegames.org — a real
    // address on the operator's domain, not a placeholder. Demanding the
    // variable be set anyway would block a launch over nothing.
    assert.ok(!subjects(legalReport({})).includes('SUPPORT_EMAIL'));
  });
});
