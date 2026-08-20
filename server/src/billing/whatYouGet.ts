/**
 * The numbers the pricing page quotes, measured from the real planner.
 *
 * The alternative — writing "about six hours" into the marketing copy — was
 * wrong within a week the last time pacing changed, and pacing changed by 26%
 * in the commit before this one. Anything a customer is shown before they pay
 * is computed here by running `humanize` itself, so the page cannot claim
 * something the engine does not do.
 *
 * Computed once, lazily, and cached. `humanize` is pure and cheap, but this
 * plans roughly 80,000 characters across several seeds, which is not work to
 * repeat on every request for a public page.
 */
import { config } from '../config.js';
import { countBursts, countRepairs, estimateDurationMs, humanize } from '../jobs/humanize.js';
import { creditsForChars } from './catalog.js';

/**
 * Ordinary prose, because the planner's output genuinely depends on sentence
 * and paragraph structure — it breaks bursts at sentence ends and rests at
 * paragraph breaks. A sample of lorem ipsum or of one repeated word would
 * produce numbers no real document would match.
 */
const REFERENCE_PROSE = `The question of whether a document was written or pasted turns out to be answerable, and the answer lives in the revision history rather than in the text itself. A person composing an essay leaves a trail: sentences that appear half-finished, words that get fixed a few minutes after they were typed, long gaps where nothing happened at all. A paste leaves one entry. That difference is structural, and it is what this project exists to reproduce faithfully.

`;

/** Document sizes a customer might recognise themselves in. */
const REFERENCE_SIZES = [1_000, 3_000, 5_000, 10_000, 20_000] as const;

/** Seeds averaged over, so one unlucky plan does not set the published figure. */
const SEEDS = [1, 2, 3, 4, 5, 6, 7] as const;

export interface ReferencePoint {
  chars: number;
  words: number;
  credits: number;
  /** Median planned duration across seeds, at the job's natural minimum pace. */
  durationMs: number;
  /** Separate writing sittings, which is roughly the number of revisions Docs records. */
  revisions: number;
  /** Mistakes made and corrected later, each of which is its own edit in history. */
  corrections: number;
}

function sampleOf(chars: number): string {
  let text = '';
  while (text.length < chars) text += REFERENCE_PROSE;
  return text.slice(0, chars);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

let cached: ReferencePoint[] | null = null;

export function referencePoints(): ReferencePoint[] {
  if (cached) return cached;

  cached = REFERENCE_SIZES.map((chars) => {
    const text = sampleOf(chars);
    const plans = SEEDS.map((seed) =>
      humanize(text, {
        minChunkRestMs: config.jobs.minChunkRestMs,
        minChunkChars: config.jobs.minChunkChars,
        maxChunkChars: config.jobs.maxChunkChars,
        seed,
      }),
    );

    return {
      chars,
      words: text.trim().split(/\s+/).length,
      credits: creditsForChars(chars, config.billing.charsPerCredit),
      durationMs: median(plans.map(estimateDurationMs)),
      revisions: median(plans.map(countBursts)),
      corrections: median(plans.map(countRepairs)),
    };
  });

  return cached;
}

/**
 * Characters per word in the reference prose, so the client can turn a
 * character allowance into a word count without inventing a divisor. Around
 * 5.9 for English prose including spaces and punctuation.
 */
export function charsPerWord(): number {
  const sample = REFERENCE_PROSE;
  return sample.length / sample.trim().split(/\s+/).length;
}

/** Test seam: drops the cache so a test can vary the config it is computed from. */
export function resetReferencePoints(): void {
  cached = null;
}
