import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addCredits,
  ceilCreditsFromRatio,
  compareCredits,
  creditsEqual,
  formatCredits,
  formatCreditsWithUnit,
  fromHundredths,
  MIN_CHARGE_CREDITS,
  parseCredits,
  roundCredits,
  subtractCredits,
  toHundredths,
} from './amount.js';

describe('credit arithmetic', () => {
  it('adds without accumulating floating point error', () => {
    // The reason this module exists: 0.1 + 0.2 is 0.30000000000000004 as
    // doubles, and a balance carrying that error stops matching its ledger.
    assert.notEqual(0.1 + 0.2, 0.3);
    assert.equal(addCredits(0.1, 0.2), 0.3);
    assert.equal(subtractCredits(0.3, 0.1), 0.2);
  });

  it('stays exact over a long run of fractional charges', () => {
    // A thousand five-hundredth charges against a ten credit balance. Done as
    // floats this drifts; done in hundredths it lands on zero exactly.
    let balance = 10;
    for (let i = 0; i < 200; i++) balance = subtractCredits(balance, 0.05);
    assert.equal(balance, 0);
    assert.ok(creditsEqual(balance, 0));
  });

  it('agrees with a ledger summed independently', () => {
    // Mirrors what `reconcile` checks: the cached balance is the running total
    // of the deltas, and summing the deltas afterwards has to give the same
    // answer. This is the invariant that fails first if anything here goes
    // back to plain float addition.
    const deltas = [1, -0.07, 5, -0.13, -0.01, 2.5, -0.99, -0.3];
    let running = 0;
    for (const delta of deltas) running = addCredits(running, delta);
    const summed = deltas.reduce((total, delta) => addCredits(total, delta), 0);
    assert.ok(creditsEqual(running, summed), `${running} vs ${summed}`);
    assert.equal(running, 7);
  });

  it('rounds every amount onto the 0.01 grid, idempotently', () => {
    assert.equal(roundCredits(1.004), 1);
    assert.equal(roundCredits(1.006), 1.01);
    assert.equal(roundCredits(roundCredits(1.006)), 1.01);
    assert.equal(toHundredths(1.23), 123);
    assert.equal(fromHundredths(123), 1.23);
    // Pinning the documented caveat rather than pretending it is not there:
    // 1.005 is stored as slightly under 1.005, so it rounds down. Nothing
    // prices with this function — `creditsForChars` ceils — so it does not
    // decide anybody's bill.
    assert.equal(roundCredits(1.005), 1);
  });

  it('ceils a ratio without overcharging on the grid line', () => {
    // 539 characters at 7,700 per credit is exactly 0.07. Dividing before
    // scaling lands a hair above seven hundredths and charges 0.08 — a real
    // overcharge, on a real input, that this function's argument order exists
    // to prevent.
    assert.equal(Math.ceil((539 / 7_700) * 100) / 100, 0.08);
    assert.equal(ceilCreditsFromRatio(539, 7_700), 0.07);

    // Exact multiples stay exact rather than tipping into the next hundredth.
    assert.equal(ceilCreditsFromRatio(2_310, 7_700), 0.3);
    assert.equal(ceilCreditsFromRatio(7_700, 7_700), 1);
    assert.equal(ceilCreditsFromRatio(15_400, 7_700), 2);

    // Genuinely over a grid line, so it does round up.
    assert.equal(ceilCreditsFromRatio(2_311, 7_700), 0.31);
    assert.equal(ceilCreditsFromRatio(540, 7_700), 0.08);
  });

  it('never charges less than the grid, over every length a job can be', () => {
    // Swept rather than sampled: the property that matters is that no
    // character count is ever priced below its true share of a credit, and one
    // unlucky length is exactly how a rounding bug reaches production.
    const per = 7_700;
    for (let chars = 1; chars <= 200_000; chars += 7) {
      const price = ceilCreditsFromRatio(chars, per);
      assert.ok(price >= chars / per, `${chars} chars priced at ${price}, below its share`);
      assert.ok(
        price - chars / per < 0.01,
        `${chars} chars priced at ${price}, more than a hundredth over`,
      );
      assert.equal(toHundredths(price), Math.round(toHundredths(price)), 'off the 0.01 grid');
    }
  });

  it('orders amounts on the grid rather than by float equality', () => {
    assert.equal(compareCredits(0.1, 0.2), -10);
    assert.equal(compareCredits(0.3, 0.1 + 0.2), 0);
    assert.ok(creditsEqual(0.3, 0.1 + 0.2));
  });

  it('reads a balance back out of a database row whatever the driver returns', () => {
    // node-postgres hands back NUMERIC as a string unless a type parser is
    // registered, and a SUM() in a hand-written query can still slip through.
    assert.equal(parseCredits('1.50'), 1.5);
    assert.equal(parseCredits(1.5), 1.5);
    assert.equal(parseCredits(null), 0);
    assert.equal(parseCredits(undefined), 0);
    assert.equal(parseCredits('0.01'), MIN_CHARGE_CREDITS);
  });

  it('refuses an amount that is not a number rather than storing NaN', () => {
    assert.throws(() => parseCredits('not a number'), RangeError);
    assert.throws(() => toHundredths(Number.NaN), RangeError);
    assert.throws(() => toHundredths(Number.POSITIVE_INFINITY), RangeError);
    assert.throws(() => toHundredths(Number.MAX_SAFE_INTEGER), RangeError);
  });

  it('formats an amount the way a person would write it', () => {
    assert.equal(formatCredits(1), '1');
    assert.equal(formatCredits(0), '0');
    assert.equal(formatCredits(40), '40');
    assert.equal(formatCredits(2.5), '2.5');
    assert.equal(formatCredits(0.05), '0.05');
    assert.equal(formatCredits(0.1), '0.1');
    assert.equal(formatCredits(1.2000000000000002), '1.2');
  });

  it('pluralises on exactly one credit', () => {
    assert.equal(formatCreditsWithUnit(1), '1 credit');
    assert.equal(formatCreditsWithUnit(0.05), '0.05 credits');
    assert.equal(formatCreditsWithUnit(2.5), '2.5 credits');
    assert.equal(formatCreditsWithUnit(0), '0 credits');
  });
});
