/**
 * Humanization engine.
 *
 * Turns a block of text into a flat, in-memory sequence of typing events that
 * a human would plausibly produce: variable per-character delays, pauses at
 * punctuation and paragraph breaks, occasional mid-word hesitation, typos that
 * get noticed and corrected a beat or four later, and — critically — long
 * rests between bursts of writing.
 *
 * Those rests are what make Google Docs' version history look human. Docs
 * groups edits into revisions by how close together in time they happen, not
 * by how many API calls arrive. A document typed start-to-finish inside a
 * minute collapses into a single revision that reads exactly like a paste, no
 * matter how many requests produced it. Real writing happens in bursts
 * separated by thinking, so this engine writes a sentence or two, then stops
 * for a while, which is what produces a believable revision trail.
 *
 * This module performs no I/O of any kind. It is pure (given a seed) and
 * cheap, so an entire document is planned up front and the runner simply
 * replays the array with real sleeps.
 */

export type TypeEvent = { type: 'type'; char: string; delay: number };
export type BackspaceEvent = { type: 'backspace'; count: number; delay: number };
/** `rest: true` marks a between-burst gap — the pauses that absorb extra time. */
export type PauseEvent = {
  type: 'pause';
  duration: number;
  rest?: true;
  /**
   * Marks a pause whose entire job is to sit still long enough for Docs to
   * close a revision, and says how far it may be cut short if the runner can
   * *see* that it already has.
   *
   * `duration` is what this pause costs when nobody is watching: the blind,
   * conservative wait derived from `DOCS_CHECKPOINT_MS`. Almost all of it is
   * margin for an assumption — Docs' checkpoint clock is not observable from
   * inside the plan, so the plan has to assume the worst phase of it.
   *
   * A runner that can poll the document's revision list does not have to
   * assume. It waits `minMs` (the floor that keeps the gap looking like a
   * human stopping to think), then watches for the revision to appear and
   * carries on the moment it does. `duration` stays the ceiling, so a runner
   * that cannot see revisions — or one whose document does not expose them —
   * behaves exactly as before.
   *
   * The planner still costs the plan at `duration`, because estimates and the
   * countdown are shown before any of this is known. Finishing early is a
   * pleasant surprise; promising early and not delivering is not.
   */
  checkpoint?: { minMs: number };
};
/**
 * Going back to fix a typo that was left behind several words ago — the
 * equivalent of clicking into the middle of a line and correcting it.
 *
 * `offset` counts from the start of this job's own text, in the document's
 * state at the moment the repair happens.
 */
export type RepairEvent = {
  type: 'repair';
  offset: number;
  remove: number;
  insert: string;
  delay: number;
};
export type HumanEvent = TypeEvent | BackspaceEvent | PauseEvent | RepairEvent;

export interface HumanizeOptions {
  /** 0 = metronome, 1 = distractible human (~8% of words get a typo). */
  humanness?: number;
  /**
   * How long the whole job should take, in milliseconds. Extra time beyond the
   * natural minimum is spent resting between bursts, never on slowing the
   * keystrokes themselves — a person writing an essay over two hours still
   * types at normal speed, they just stop and think a lot.
   *
   * Values below the natural minimum are ignored; the engine will not type
   * faster than a person can.
   */
  targetDurationMs?: number;
  /** Shortest gap between bursts. Lowered in tests; 2.5 min in production. */
  minChunkRestMs?: number;
  /** How much text one burst covers before the writer stops to think. */
  minChunkChars?: number;
  maxChunkChars?: number;
  /** Optional seed for deterministic output (tests). */
  seed?: number;
}

/**
 * Docs' own checkpoint cadence, as this engine models it. Every timing
 * guarantee below is expressed as a margin over this number rather than as a
 * magic constant, so retuning the model means changing one line.
 */
export const DOCS_CHECKPOINT_MS = 120_000;

/**
 * How far every checkpoint-buying gap clears `DOCS_CHECKPOINT_MS`.
 *
 * A gap strictly longer than the checkpoint interval contains a checkpoint
 * whatever the phase of Docs' clock, so the margin is not buying correctness —
 * correctness is had at 1.0. It is buying tolerance for the interval being
 * "roughly" two minutes rather than exactly.
 *
 * It used to be 1.25 on the rest and 1.6 on the correction gap, drawn on top
 * of a jitter multiplier of up to 1.45, which stacked to a mean rest of 182s
 * against a 120s interval — better than half the wait was margin on margin.
 * The cost of that is not abstract: every gap in the plan is one revision's
 * worth of wall clock, so 50s of surplus margin per gap was the single largest
 * line item in a job's runtime and it bought nothing a reader could see.
 */
export const CHECKPOINT_MARGIN = 1.1;

/**
 * Google Docs checkpoints a document into version history roughly every two
 * minutes while it is being edited. Anything shorter than that interval is
 * invisible: a burst and the rest after it land in the same bucket, and a
 * mistake made and fixed inside one bucket is never recorded at all.
 *
 * So the floor sits above Docs' cadence rather than under it. Raise
 * `MIN_CHUNK_REST_MS` further for an even more spread-out history.
 */
export const DEFAULT_MIN_CHUNK_REST_MS = Math.round(DOCS_CHECKPOINT_MS * CHECKPOINT_MARGIN);

/**
 * How much jitter a rest carries on top of its floor.
 *
 * Enough that the gaps are visibly not identical, and no more: every
 * millisecond here is spent once per revision across the whole job.
 */
const REST_JITTER = { min: 1, max: 1.18 };

/**
 * The shortest a checkpoint gap may be cut to when the runner can confirm the
 * revision actually landed.
 *
 * Confirmation replaces the assumption the margin exists to survive, so what
 * is left to justify is only the realism of the gap itself: a writer who
 * stops, thinks and starts again does not do it in four seconds. Twenty-five
 * seconds is a believable "reread the last sentence" pause, and it is the
 * floor the runner is never allowed to go below however fast Docs answers.
 *
 * Scaled with `minChunkRestMs` like every other think pause, so tests that
 * shrink the rest do not sit through it.
 */
const CHECKPOINT_FLOOR_MS = 25_000;

/**
 * How long a mistake must sit in the document before it is corrected.
 *
 * Measured from the keystroke that made it to the edit that fixes it — not
 * from the start of the rest. That distinction is the whole point: a typo made
 * mid-burst has already been on the page for the rest of that burst, and
 * previously that time was thrown away and the following rest inflated to
 * nearly six minutes to re-buy a guarantee the plan had mostly paid for
 * already.
 *
 * The margin over the checkpoint interval covers the phase of Docs' clock,
 * which is unknowable from inside a pure planner: a checkpoint could fire a
 * moment before the mistake is typed, so the gap has to reach into a second
 * interval. It is a fifth over the standard gap margin rather than the half
 * again it used to be, because the old figure was compounding with a rest
 * jitter that has since been trimmed — the two together were buying the same
 * guarantee twice.
 *
 * A runner that confirms revisions supersedes this arithmetic entirely: the
 * gap carrying the correction is cut short only once a new revision has been
 * *observed* since the mistake was typed, which is the property this constant
 * is trying to make likely.
 */
const CORRECTION_GAP_MS = Math.round(DOCS_CHECKPOINT_MS * CHECKPOINT_MARGIN * 1.2);

/**
 * How many rests a mistake waits through before being noticed. Waiting two
 * puts a whole burst of unrelated writing between the mistake and its fix, so
 * the correction lands as a standalone edit in a later revision rather than at
 * the head of the very next one — which is what rereading actually looks like,
 * and costs nothing, because that rest was going to happen anyway.
 */
const CORRECTION_DEFERRAL_CHANCE = 0.45;

/** Per-character delay, in milliseconds. Never scaled — humans type at human speed. */
const CHAR_DELAY_MEAN = 100;
const CHAR_DELAY_SD = 22;
const CHAR_DELAY_MIN = 60;
const CHAR_DELAY_MAX = 140;

/** At humanness = 1, roughly this share of eligible words get a typo. */
const MAX_TYPO_RATE = 0.08;

/**
 * The one setting the app ships with. There is no slider: "a bit human" is
 * not a useful product, and the whole point is that the result reads as a
 * person every time.
 */
export const DEFAULT_HUMANNESS = 0.85;

/** Chance of a mid-word "wait, what was I saying" hesitation. */
const HESITATION_CHANCE = 0.05;

/**
 * Not every burst is written the same way, and the difference is the single
 * biggest lever on how long a job takes.
 *
 * A *flow* burst is a sentence the writer already had in their head: it goes
 * down in twenty seconds and Docs captures it as one tidy revision. A
 * *laboured* burst is one being worked out on the page, with real gaps at
 * clause and sentence boundaries, and it deliberately runs past the checkpoint
 * interval so a snapshot lands in the middle of it — a revision ending
 * mid-clause, which no paste ever produces.
 *
 * The engine used to think a little in *every* burst, which spent the time
 * everywhere and bought the mid-sentence snapshot almost nowhere: the median
 * burst landed at ~94s, just *under* the checkpoint interval, so Docs captured
 * it whole anyway and the thinking was invisible. Splitting bursts into two
 * modes spends the same idea where it actually registers — the share of bursts
 * that run past a checkpoint is unchanged at ~32%, but they now clear it
 * decisively instead of hovering at the boundary, and the other two thirds
 * cost twenty seconds instead of ninety.
 */
const LABOURED_BURST_CHANCE = 0.32;

/**
 * The stall that makes a laboured burst count: one long stop, mid-writing,
 * while the next phrase gets worked out.
 *
 * Every laboured burst gets exactly one, and it is drawn long enough that the
 * burst clears the checkpoint interval on its own. Scattering the same time
 * across many small pauses looked reasonable but was not reliable — on prose
 * with short sentences a burst ends before enough of them accumulate, and the
 * burst is snapshotted whole after all. Committing to one stall makes the
 * mid-sentence revision a property of the plan rather than a lucky draw, which
 * is also what lets the engine afford far fewer laboured bursts.
 *
 * Placed at a word boundary partway through the burst, so the snapshot lands
 * mid-clause rather than at a tidy seam.
 *
 * The range sits a little under the standard gap margin at the bottom because
 * a stall is not the whole gap — the typing either side of it is part of the
 * same quiet stretch as far as Docs is concerned, and a burst's own span is
 * what has to clear the interval, not the stall in isolation.
 */
const STALL_MS = {
  min: Math.round(DOCS_CHECKPOINT_MS * CHECKPOINT_MARGIN * 0.92),
  max: Math.round(DOCS_CHECKPOINT_MS * CHECKPOINT_MARGIN * 1.25),
};
const STALL_CHANCE_PER_WORD = 0.4;

/**
 * The lighter thinking around the stall, so a laboured burst is not one long
 * freeze surrounded by metronome typing. Laboured bursts only.
 */
const SENTENCE_THINK_CHANCE = 0.7;
const SENTENCE_THINK_MS = { min: 8_000, max: 35_000 };
const CLAUSE_THINK_CHANCE = 0.3;
const CLAUSE_THINK_MS = { min: 3_000, max: 14_000 };
const WORD_THINK_CHANCE = 0.22;
const WORD_THINK_MS = { min: 5_000, max: 30_000 };

/**
 * A flow burst still is not a metronome — the writer pauses at a comma, just
 * not for long enough to matter to Docs.
 */
const FLOW_CLAUSE_THINK_CHANCE = 0.25;
const FLOW_CLAUSE_THINK_MS = { min: 800, max: 3_000 };

/** Words so ingrained they come out as a single burst. */
const FAST_WORDS = new Set(['the', 'and', 'is', 'to', 'a', 'of', 'in']);
const FAST_WORD_FACTOR = 0.7;

/**
 * A burst runs at least this many characters before the writer stops to think,
 * and no more than the ceiling even mid-sentence.
 *
 * Small bursts are the lever on how many entries the version history ends up
 * with: one revision per burst, roughly. Large ones make each revision arrive
 * as a wall of text, which is what reads as a paste.
 */
const DEFAULT_MIN_CHUNK_CHARS = 55;
const DEFAULT_MAX_CHUNK_CHARS = 150;

/**
 * QWERTY physical neighbours. Used for wrong-key typos: a finger that lands
 * one key off produces a specific, recognisable class of error.
 */
const QWERTY_ADJACENCY: Record<string, string> = {
  q: 'wa12',
  w: 'qeasd23',
  e: 'wrsdf34',
  r: 'etdfg45',
  t: 'ryfgh56',
  y: 'tughj67',
  u: 'yihjk78',
  i: 'uojkl89',
  o: 'ipkl90',
  p: 'ol;0-',
  a: 'qwszx',
  s: 'qweadzxc',
  d: 'wersfxcv',
  f: 'ertdgcvb',
  g: 'rtyfhvbn',
  h: 'tyugjbnm',
  j: 'yuihknm,',
  k: 'uiojlm,.',
  l: 'iopk;,./',
  z: 'asx',
  x: 'zasdc',
  c: 'xsdfv',
  v: 'cdfgb',
  b: 'vfghn',
  n: 'bghjm',
  m: 'nhjk,',
  '1': '2qw',
  '2': '13qwe',
  '3': '24wer',
  '4': '35ert',
  '5': '46rty',
  '6': '57tyu',
  '7': '68yui',
  '8': '79uio',
  '9': '80iop',
  '0': '9op-',
  ',': 'mkl.',
  '.': ',l;/',
  ';': "lp'/",
  "'": ';[',
  '/': ".;'",
  '-': '0p=',
};

/** Mulberry32 — small, fast, seedable PRNG. */
function makeRandom(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(private readonly next: () => number) {}

  float(): number {
    return this.next();
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('pick() called with an empty list');
    return item;
  }

  /** Box–Muller gaussian, clamped so a tail never produces a silly delay. */
  gaussian(mean: number, sd: number, min: number, max: number): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return clamp(mean + normal * sd, min, max);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type TypoKind = 'substitute' | 'transpose' | 'double';

interface Token {
  value: string;
  isWord: boolean;
}

/**
 * Splits text into word / non-word runs. Apostrophes stay inside words so
 * "don't" is treated as one unit rather than three.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      tokens.push({ value: text.slice(cursor, match.index), isWord: false });
    }
    tokens.push({ value: match[0], isWord: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    tokens.push({ value: text.slice(cursor), isWord: false });
  }
  return tokens;
}

function adjacentKey(char: string, rng: Rng): string | null {
  const lower = char.toLowerCase();
  const neighbours = QWERTY_ADJACENCY[lower];
  if (!neighbours) return null;
  const replacement = rng.pick([...neighbours]);
  // Preserve the shape of the original keystroke.
  return char === lower ? replacement : replacement.toUpperCase();
}

export function humanize(text: string, options: HumanizeOptions = {}): HumanEvent[] {
  const humanness = clamp(options.humanness ?? DEFAULT_HUMANNESS, 0, 1);
  const minRest = Math.max(0, options.minChunkRestMs ?? DEFAULT_MIN_CHUNK_REST_MS);
  /**
   * Think pauses are sized relative to the rest interval, so lowering
   * `minChunkRestMs` shrinks them too. Tests set a tiny rest and would
   * otherwise still sleep through minutes of real "thinking".
   */
  const thinkScale = minRest / DEFAULT_MIN_CHUNK_REST_MS;
  const think = (range: { min: number; max: number }): number =>
    rng.range(range.min, range.max) * thinkScale;
  /**
   * How short a confirmed checkpoint gap may be cut. Scaled with the rest for
   * the same reason think pauses are: a test that sets a one-second rest must
   * not then sit through a twenty-five second floor.
   */
  const checkpointFloor = Math.max(1, Math.round(CHECKPOINT_FLOOR_MS * thinkScale));
  /**
   * The correction gap, scaled with the rest like every other pause here.
   *
   * It used to be applied as an absolute, which meant `minChunkRestMs` was not
   * actually a working test seam: a suite that set a 400ms rest to keep itself
   * quick still sat through a 158-second top-up on any rest that happened to
   * be carrying a typo. In production `thinkScale` is 1 and this is exactly
   * `CORRECTION_GAP_MS`, so nothing about a real job changes.
   */
  const correctionGapMs = CORRECTION_GAP_MS * thinkScale;

  const minChunkChars = Math.max(1, options.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS);
  const maxChunkChars = Math.max(minChunkChars, options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS);
  const rng = new Rng(makeRandom(options.seed));

  const events: HumanEvent[] = [];
  const typoRate = MAX_TYPO_RATE * humanness;

  /** Characters typed since the last rest, used to size bursts. */
  let charsThisChunk = 0;
  /** Net characters this job has put in the document so far. */
  let writtenLength = 0;
  /**
   * Running wall-clock position in the plan, so timing guarantees can be
   * checked against what the plan actually does rather than assumed. Kept as a
   * plain counter rather than read from a clock — this module stays pure.
   */
  let elapsedMs = 0;
  /**
   * Whether the burst being written is being worked out on the page or simply
   * transcribed from the writer's head. See LABOURED_BURST_CHANCE.
   */
  let labouredBurst = rng.chance(LABOURED_BURST_CHANCE);
  /** Whether this laboured burst still owes its one long stall. */
  let stallOwed = labouredBurst;
  /**
   * A mistake left in the text, waiting to be noticed.
   *
   * Only one is outstanding at a time. That keeps the offset arithmetic honest
   * — a repair shifts every position after it — and matches how people work:
   * you notice the last thing you got wrong, not four of them at once.
   *
   * `madeAtMs` is when the wrong keystroke landed and `restsToWait` how many
   * more breaks pass before it gets spotted; together they let the rest that
   * carries the fix be sized to the gap that is actually still owed.
   */
  let pendingTypo: {
    offset: number;
    remove: number;
    insert: string;
    madeAtMs: number;
    restsToWait: number;
  } | null = null;

  const charDelay = (fast: boolean): number => {
    const base = rng.gaussian(CHAR_DELAY_MEAN, CHAR_DELAY_SD, CHAR_DELAY_MIN, CHAR_DELAY_MAX);
    return Math.max(1, Math.round(fast ? base * FAST_WORD_FACTOR : base));
  };

  const emitChar = (char: string, fast: boolean): void => {
    const delay = charDelay(fast);
    events.push({ type: 'type', char, delay });
    elapsedMs += delay;
    charsThisChunk += 1;
    writtenLength += 1;
  };

  const emitString = (value: string, fast: boolean): void => {
    for (const char of value) emitChar(char, fast);
  };

  const emitPause = (ms: number): void => {
    const duration = Math.max(1, Math.round(ms));
    events.push({ type: 'pause', duration });
    elapsedMs += duration;
  };

  /**
   * A pause that exists to let Docs close a revision, rather than to look like
   * thinking. Same shape as any other pause, but tagged so a runner that can
   * watch the document's revision list knows it may stop waiting early.
   */
  const emitCheckpointPause = (ms: number): void => {
    const duration = Math.max(1, Math.round(ms));
    events.push({ type: 'pause', duration, checkpoint: { minMs: Math.min(checkpointFloor, duration) } });
    elapsedMs += duration;
  };

  /**
   * Stop and think. Only emitted between bursts, and only these pauses grow
   * when the job is stretched over a longer target duration.
   *
   * `force` is used once, at the end of the text, where an outstanding mistake
   * has to be fixed whether or not it has waited its full number of breaks.
   */
  const emitRest = (force = false): void => {
    if (charsThisChunk === 0 && !pendingTypo) return;

    let duration = Math.round(minRest * rng.range(REST_JITTER.min, REST_JITTER.max));

    // Is this the break where the mistake gets spotted?
    const fixingNow = pendingTypo !== null && (force || pendingTypo.restsToWait <= 1);

    if (pendingTypo && fixingNow) {
      // The mistake has to have been on the page across a Docs checkpoint, and
      // the time since it was typed already counts towards that: the rest of
      // the burst, and any earlier breaks it waited through. Only top the rest
      // up by whatever gap is still owed, instead of inflating every rest that
      // happens to be carrying one.
      const alreadyWaited = elapsedMs - pendingTypo.madeAtMs;
      const shortfall = correctionGapMs - (alreadyWaited + duration);
      if (shortfall > 0) duration += Math.round(shortfall);
    }

    events.push({ type: 'pause', duration, rest: true, checkpoint: { minMs: checkpointFloor } });
    elapsedMs += duration;
    charsThisChunk = 0;
    // The next stretch of writing may go down easily or may have to be worked
    // out; that is decided here, once per burst.
    labouredBurst = rng.chance(LABOURED_BURST_CHANCE);
    stallOwed = labouredBurst;

    // Coming back to the document is when you reread and spot the mistake.
    // Fixing it here — after the gap, not a second after making it — is the
    // whole point: the typo has been sitting in the document long enough for
    // Docs to have recorded it, so the correction shows up as its own edit.
    if (pendingTypo) {
      if (fixingNow) repairPendingTypo();
      else pendingTypo.restsToWait -= 1;
    }
  };

  const repairPendingTypo = (): void => {
    if (!pendingTypo) return;
    const { offset, remove, insert } = pendingTypo;
    // Reading back, spotting it, moving the cursor there.
    const delay = Math.round(rng.range(600, 2_200));
    events.push({ type: 'repair', offset, remove, insert, delay });
    elapsedMs += delay;
    writtenLength += insert.length - remove;
    pendingTypo = null;
  };

  const tokens = tokenize(text);

  for (const token of tokens) {
    if (token.isWord) {
      // A burst never runs past its ceiling; break at the word boundary.
      if (charsThisChunk >= maxChunkChars) emitRest();
      typeWord(token.value);
    } else {
      typePunctuation(token.value);
    }
  }

  // A mistake made in the last burst still has to be found. Step away, come
  // back, fix it — which also leaves the job ending on the correction rather
  // than on raw typing. There is no more text to write, so it is fixed at this
  // break whatever its deferral said.
  if (pendingTypo) emitRest(true);

  // Any pause at the very end just delays the job reporting itself finished;
  // there is nothing left to type after it.
  while (events.length > 0 && (events[events.length - 1] as HumanEvent).type === 'pause') {
    events.pop();
  }

  applyTargetDuration(events, options.targetDurationMs, rng);

  return events;

  // -- helpers ------------------------------------------------------------

  function typeWord(word: string): void {
    const fast = FAST_WORDS.has(word.toLowerCase());

    // The one long stall this burst owes. It fires at a random word boundary
    // once a few characters are down, but is forced before the burst can reach
    // the length at which it is allowed to end — otherwise a burst on
    // short-sentence prose could finish still owing it, and be snapshotted
    // whole.
    if (stallOwed && charsThisChunk >= 8) {
      const lastChance = charsThisChunk >= minChunkChars * 0.8;
      if (lastChance || rng.chance(STALL_CHANCE_PER_WORD)) {
        emitCheckpointPause(think(STALL_MS));
        stallOwed = false;
      }
    }

    // Stopping mid-sentence to work out the next phrase. Only in a burst that
    // is being composed rather than transcribed — see LABOURED_BURST_CHANCE.
    if (labouredBurst && charsThisChunk > 0 && rng.chance(WORD_THINK_CHANCE)) {
      emitPause(think(WORD_THINK_MS));
    }

    // Hesitation lands before a word or between its letters, never after the
    // last one (that gap belongs to the following punctuation pause).
    const hesitateAt = rng.chance(HESITATION_CHANCE) ? rng.int(0, word.length - 1) : -1;

    // Only one mistake is ever outstanding, so a repair always lands before
    // the next one is made.
    const typo =
      !pendingTypo && word.length >= 4 && rng.chance(typoRate) ? planTypo(word) : null;

    if (!typo) {
      for (let i = 0; i < word.length; i++) {
        if (i === hesitateAt) emitPause(rng.range(300, 800));
        emitChar(word[i] as string, fast);
      }
      return;
    }

    // 1. Everything before the mistake.
    for (let i = 0; i < typo.at; i++) {
      if (i === hesitateAt) emitPause(rng.range(300, 800));
      emitChar(word[i] as string, fast);
    }

    // 2. The mistake itself. Fingers are already moving, so it comes out fast.
    const offset = writtenLength;
    emitString(typo.wrong, true);

    // 3. A brief stumble — enough to feel the keys go wrong, not enough to
    //    stop. The correction comes much later.
    emitPause(rng.range(250, 900));

    // 4. Carry on and finish the word, and the sentence after it, none the
    //    wiser. The mistake stays in the document until the next rest.
    pendingTypo = {
      offset,
      remove: typo.wrong.length,
      insert: word.slice(typo.at, typo.at + typo.consumed),
      // The clock starts at the wrong keystroke, not at the next break: the
      // remainder of this burst is time the mistake is already on the page.
      madeAtMs: elapsedMs,
      // Usually spotted at the next break; often not until the one after,
      // which puts a whole burst of unrelated writing in between.
      restsToWait: rng.chance(CORRECTION_DEFERRAL_CHANCE) ? 2 : 1,
    };

    emitString(word.slice(typo.at + typo.consumed), fast);
  }

  /**
   * Describes a mistake as: at index `at`, `consumed` intended characters came
   * out as the string `wrong`, and it goes unnoticed for `noticeAfter` more
   * characters.
   */
  function planTypo(word: string): { at: number; consumed: number; wrong: string } | null {
    // Never fumble the very first keystroke — mistakes cluster mid-word.
    const at = rng.int(1, word.length - 1);
    const kinds: TypoKind[] = ['substitute', 'double'];
    if (at + 1 < word.length && word[at] !== word[at + 1]) kinds.push('transpose', 'transpose');

    const kind = rng.pick(kinds);
    const char = word[at] as string;

    let consumed: number;
    let wrong: string;

    switch (kind) {
      case 'transpose': {
        // "the" -> "teh": the next letter beats this one to the page.
        consumed = 2;
        wrong = (word[at + 1] as string) + char;
        break;
      }
      case 'double': {
        // A key that bounces, or a finger that lingers.
        consumed = 1;
        wrong = char + char;
        break;
      }
      case 'substitute':
      default: {
        const neighbour = adjacentKey(char, rng);
        if (!neighbour) return null;
        consumed = 1;
        wrong = neighbour;
        break;
      }
    }

    return { at, consumed, wrong };
  }

  function typePunctuation(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i] as string;

      // Collapse a run of newlines into one keystroke sequence plus a single
      // "gathering my thoughts" pause, sized by whether it is a line break or
      // a paragraph break.
      if (char === '\n') {
        let run = 0;
        while (chunk[i + run] === '\n') run++;
        for (let n = 0; n < run; n++) emitChar('\n', false);
        i += run - 1;
        if (run >= 2) {
          emitPause(rng.range(1_500, 5_000));
          // A paragraph break is the most natural place to walk away.
          if (charsThisChunk >= minChunkChars) emitRest();
        } else {
          emitPause(rng.range(400, 900));
        }
        continue;
      }

      emitChar(char, false);

      if (char === ',' || char === ';' || char === ':') {
        emitPause(rng.range(150, 400));
        // Occasionally the clause is where the thought runs out for a moment.
        // In a flow burst that is a beat, not a break — long enough to read as
        // human, too short for Docs to snapshot inside it.
        const chance = labouredBurst ? CLAUSE_THINK_CHANCE : FLOW_CLAUSE_THINK_CHANCE;
        if (rng.chance(chance)) {
          emitPause(think(labouredBurst ? CLAUSE_THINK_MS : FLOW_CLAUSE_THINK_MS));
        }
      } else if (char === '.' || char === '!' || char === '?') {
        // Only pause at the end of the sentence, not between "..." dots.
        const next = chunk[i + 1];
        if (next !== '.' && next !== '!' && next !== '?') {
          emitPause(rng.range(400, 1_200));
          // End of a sentence is the natural seam between bursts.
          if (charsThisChunk >= minChunkChars) {
            emitRest();
          } else if (labouredBurst && rng.chance(SENTENCE_THINK_CHANCE)) {
            // Not long enough to walk away, but long enough that the document
            // is sitting untouched while the next sentence is worked out.
            emitPause(think(SENTENCE_THINK_MS));
          }
        }
      }
    }
  }
}

/**
 * Stretches a plan to fill `targetMs` by growing the between-burst rests.
 *
 * Keystroke timing is deliberately untouched: a person writing over an
 * afternoon still types at ordinary speed, so slowing the keys themselves
 * would read as obviously synthetic. The extra time is spread unevenly across
 * the rests so the gaps do not all come out identical.
 *
 * A stretched plan also loses its `checkpoint` markers entirely: a job running
 * at its natural minimum should finish as soon as the revisions it needs have
 * actually landed, but a job the user asked to spread over three hours should
 * take three hours.
 */
function applyTargetDuration(events: HumanEvent[], targetMs: number | undefined, rng: Rng): void {
  if (!targetMs || !Number.isFinite(targetMs)) return;

  const natural = estimateDurationMs(events);
  const extra = targetMs - natural;
  if (extra <= 0) return;

  const restIndexes: number[] = [];
  events.forEach((event, index) => {
    if (event.type === 'pause' && event.rest) restIndexes.push(index);
  });
  // Nothing to stretch: the text is too short to have a natural seam.
  if (restIndexes.length === 0) return;

  // Once a job is being stretched, its duration is a promise rather than a
  // by-product, and that applies to every gap in it — not just the rests that
  // get grown. A mid-burst stall cut short on a confirmed revision would still
  // land the job ahead of the time the user asked for.
  for (const event of events) {
    if (event.type === 'pause') delete event.checkpoint;
  }

  const weights = restIndexes.map(() => 0.5 + rng.float());
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  restIndexes.forEach((index, position) => {
    const event = events[index] as PauseEvent;
    event.duration += Math.round((extra * (weights[position] as number)) / totalWeight);
  });
}

/** Net characters the event array will leave in the document. */
export function netCharCount(events: HumanEvent[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type === 'type') total += event.char.length;
    else if (event.type === 'backspace') total -= event.count;
    else if (event.type === 'repair') total += event.insert.length - event.remove;
  }
  return total;
}

/** Wall-clock duration of the plan, in milliseconds. */
export function estimateDurationMs(events: HumanEvent[]): number {
  let total = 0;
  for (const event of events) {
    total += event.type === 'pause' ? event.duration : event.delay;
  }
  return total;
}

/** How many mistakes the plan leaves in the document and later goes back to fix. */
export function countRepairs(events: HumanEvent[]): number {
  return events.filter((event) => event.type === 'repair').length;
}

/**
 * How many separate revisions Docs should end up recording.
 *
 * Not the same as the burst count, and the difference matters when judging
 * granularity: a laboured burst stalls for longer than the checkpoint interval
 * partway through, so it is snapshotted twice — once mid-sentence and once at
 * the seam. Counting bursts undercounts the history by whatever share of them
 * are laboured, which flatters any change that trades bursts for stalls.
 *
 * Every gap that clears the checkpoint interval is one boundary; the writing
 * before the first is the first revision.
 */
export function countRevisions(events: HumanEvent[]): number {
  let boundaries = 0;
  for (const event of events) {
    if (event.type === 'pause' && event.duration > DOCS_CHECKPOINT_MS) boundaries += 1;
  }
  return boundaries + 1;
}

/** Number of writing bursts, i.e. how many separate revisions to expect. */
export function countBursts(events: HumanEvent[]): number {
  let rests = 0;
  for (const event of events) if (event.type === 'pause' && event.rest) rests += 1;
  return rests + 1;
}

/**
 * The shortest believable duration for a piece of text: natural typing speed
 * plus the minimum rest between every burst. Jobs cannot be scheduled faster
 * than this, because faster is what makes a document look pasted.
 */
export function minimumDurationMs(
  text: string,
  options: Pick<HumanizeOptions, 'humanness' | 'minChunkRestMs' | 'seed'> = {},
): number {
  return estimateDurationMs(humanize(text, { ...options, targetDurationMs: undefined }));
}
