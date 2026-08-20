/**
 * Credit arithmetic, at one hundredth of a credit.
 *
 * Credits used to be whole numbers, which meant a 400 character note and a
 * 9,000 character essay both cost one credit — a 22x difference in what they
 * occupy, charged identically. Pricing to two decimal places makes the charge
 * track the work: the smallest unit is 0.01 credits, which is a little under
 * eighty characters.
 *
 * Two decimal places and binary floating point do not get along. `0.1 + 0.2`
 * is famously not `0.3`, and a balance that accumulates that error stops
 * matching the ledger it is supposed to summarise — which is the one property
 * `reconcile` exists to prove. So nothing here adds credits as floats. Every
 * operation converts to whole hundredths, does integer arithmetic, and
 * converts back. A balance is always exactly representable as `n / 100`.
 *
 * Pure, like `humanize.ts` and `launchChecks.ts`: no I/O, no environment, so
 * the money arithmetic is testable on its own.
 */

/** Hundredths of a credit in one credit. The granularity of every charge. */
export const CREDIT_SCALE = 100;

/**
 * The smallest chargeable amount, and therefore the price of the shortest
 * possible job. A job is never free once the signup grant is spent: even a
 * one-line document holds a queue slot and writes a real revision history.
 */
export const MIN_CHARGE_CREDITS = 1 / CREDIT_SCALE;

/**
 * Credits as whole hundredths — the integer domain all arithmetic happens in.
 *
 * Rounds to nearest, so a value that has already been through this function is
 * unchanged by passing through it again. Anything at or beyond the safe
 * integer range is a bug upstream rather than a balance, and is rejected here
 * rather than silently losing precision.
 */
export function toHundredths(credits: number): number {
  if (!Number.isFinite(credits)) {
    throw new RangeError(`Credit amount is not a finite number: ${credits}`);
  }
  const scaled = Math.round(credits * CREDIT_SCALE);
  if (!Number.isSafeInteger(scaled)) {
    throw new RangeError(`Credit amount is out of range: ${credits}`);
  }
  return scaled;
}

/** The inverse: whole hundredths back to a credit amount with two decimals. */
export function fromHundredths(hundredths: number): number {
  return hundredths / CREDIT_SCALE;
}

/**
 * Snaps a credit amount to the 0.01 grid.
 *
 * Every amount that reaches the database or the browser passes through this,
 * so a balance can never carry a third decimal place that later rounds into a
 * mismatch between the cache and the ledger.
 *
 * Rounds to nearest, and an amount sitting exactly halfway can go either way —
 * `1.005` is stored as slightly less than 1.005 and rounds to `1.00`. That is
 * not worth defending against: nothing here prices with `roundCredits`
 * (`creditsForChars` ceils, deliberately), so the only values it ever sees are
 * already on the grid or a few bits off it.
 */
export function roundCredits(credits: number): number {
  return fromHundredths(toHundredths(credits));
}

/**
 * Rounds *up* to the 0.01 grid. Used for pricing, where the fraction of a
 * hundredth a document spills over into is the customer's to pay for, and
 * absorbing it instead would price the shortest jobs at nothing.
 *
 * Takes the numerator and denominator separately rather than a ratio, because
 * dividing first and scaling afterwards overcharges. 539 characters at 7,700
 * per credit is exactly 0.07 credits, but the double nearest 539/7,700 is a
 * hair above seven hundredths, so `Math.ceil((539 / 7700) * 100)` is 8 and the
 * customer pays 0.08. Multiplying first keeps the arithmetic on integers —
 * `Math.ceil(53900 / 7700)` is 7 — and the quotient is exact. Sweeping every
 * length a job can be, 142 character counts under 200,000 are overcharged by
 * the other order; none are by this one.
 */
export function ceilCreditsFromRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new RangeError(`Denominator must be positive: ${denominator}`);
  return fromHundredths(Math.ceil((numerator * CREDIT_SCALE) / denominator));
}

/** Adds two credit amounts without accumulating floating point error. */
export function addCredits(a: number, b: number): number {
  return fromHundredths(toHundredths(a) + toHundredths(b));
}

/** Subtracts, exactly. `subtractCredits(0.3, 0.1)` is 0.2, not 0.19999999999999998. */
export function subtractCredits(a: number, b: number): number {
  return fromHundredths(toHundredths(a) - toHundredths(b));
}

/**
 * Compares two amounts on the 0.01 grid. Returns a negative number, zero, or a
 * positive number in the manner of a sort comparator.
 *
 * Use this rather than `===` wherever a decision hangs on equality — two
 * amounts that should be identical can differ in the fifteenth decimal place
 * after a round trip through Postgres and back.
 */
export function compareCredits(a: number, b: number): number {
  return toHundredths(a) - toHundredths(b);
}

/** True when the two amounts are the same to the hundredth. */
export function creditsEqual(a: number, b: number): boolean {
  return compareCredits(a, b) === 0;
}

/**
 * Reads a credit amount out of a database row.
 *
 * Postgres `NUMERIC` reaches node-postgres as a string unless a type parser is
 * registered — `db/pool.ts` registers one, but a `SUM()` in a hand-written
 * query, a column this file does not know about, or a test double can still
 * hand back a string. Coercing here rather than trusting the driver means a
 * balance is a number everywhere above the database layer, which is what the
 * `credits: number` on `UserRow` claims.
 */
export function parseCredits(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) throw new RangeError(`Not a credit amount: ${String(raw)}`);
  return roundCredits(value);
}

/**
 * A credit amount as a person should read it: `1`, `2.5`, `0.05`.
 *
 * Trailing zeros are dropped because `0.50 credits` reads like a precision the
 * price does not have, and a whole number of credits should look like one.
 */
export function formatCredits(credits: number): string {
  const rounded = roundCredits(credits);
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/0$/, '');
}

/** `formatCredits` with the noun attached, pluralised on exactly one. */
export function formatCreditsWithUnit(credits: number): string {
  const rounded = roundCredits(credits);
  return `${formatCredits(rounded)} ${rounded === 1 ? 'credit' : 'credits'}`;
}
