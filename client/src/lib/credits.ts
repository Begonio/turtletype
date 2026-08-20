/**
 * Rendering credit amounts.
 *
 * Credits are priced to a hundredth, so a balance is `0.05` or `2.5` at least
 * as often as it is a whole number, and `toString()` on a float is not a safe
 * way to show a price — a balance that arrives as `1.2000000000000002` after a
 * round trip should read as `1.2`.
 *
 * These mirror `formatCredits` and `formatCreditsWithUnit` in
 * `server/src/billing/amount.ts`. The duplication is deliberate: the two
 * workspaces share no code, and copying twenty lines of formatting is a better
 * trade than a shared package for it. Only the display rules live here — every
 * amount the browser shows was computed by the server, and none of it is
 * arithmetic the client is entitled to redo.
 */

/** Snaps to the 0.01 grid the server prices on. */
export function roundCredits(credits: number): number {
  return Math.round(credits * 100) / 100;
}

/**
 * `1`, `2.5`, `0.05` — trailing zeros dropped, because `0.50` implies a
 * precision the price does not have.
 */
export function formatCredits(credits: number): string {
  const rounded = roundCredits(credits);
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/0$/, '');
}

/** The amount with its noun, pluralised on exactly one. */
export function formatCreditsWithUnit(credits: number): string {
  const rounded = roundCredits(credits);
  return `${formatCredits(rounded)} ${rounded === 1 ? 'credit' : 'credits'}`;
}

/** The noun on its own, for callers laying the number out themselves. */
export function creditNoun(credits: number): string {
  return roundCredits(credits) === 1 ? 'credit' : 'credits';
}
