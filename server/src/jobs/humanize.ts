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
export type PauseEvent = { type: 'pause'; duration: number; rest?: true };
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
  /** Shortest gap between bursts. Lowered in tests; 60s in production. */
  minChunkRestMs?: number;
  /** Optional seed for deterministic output (tests). */
  seed?: number;
}

/**
 * Google Docs needs a gap of roughly this long before it treats what follows
 * as a separate revision rather than folding it into the previous one.
 */
export const DEFAULT_MIN_CHUNK_REST_MS = 60_000;

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

/** Words so ingrained they come out as a single burst. */
const FAST_WORDS = new Set(['the', 'and', 'is', 'to', 'a', 'of', 'in']);
const FAST_WORD_FACTOR = 0.7;

/** A burst runs at least this many characters before the writer stops to think. */
const MIN_CHUNK_CHARS = 90;
/** ...and no more than this, even mid-sentence. */
const MAX_CHUNK_CHARS = 260;

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
  const rng = new Rng(makeRandom(options.seed));

  const events: HumanEvent[] = [];
  const typoRate = MAX_TYPO_RATE * humanness;

  /** Characters typed since the last rest, used to size bursts. */
  let charsThisChunk = 0;
  /** Net characters this job has put in the document so far. */
  let writtenLength = 0;
  /**
   * A mistake left in the text, waiting to be noticed.
   *
   * Only one is outstanding at a time. That keeps the offset arithmetic honest
   * — a repair shifts every position after it — and matches how people work:
   * you notice the last thing you got wrong, not four of them at once.
   */
  let pendingTypo: { offset: number; remove: number; insert: string } | null = null;

  const charDelay = (fast: boolean): number => {
    const base = rng.gaussian(CHAR_DELAY_MEAN, CHAR_DELAY_SD, CHAR_DELAY_MIN, CHAR_DELAY_MAX);
    return Math.max(1, Math.round(fast ? base * FAST_WORD_FACTOR : base));
  };

  const emitChar = (char: string, fast: boolean): void => {
    events.push({ type: 'type', char, delay: charDelay(fast) });
    charsThisChunk += 1;
    writtenLength += 1;
  };

  const emitString = (value: string, fast: boolean): void => {
    for (const char of value) emitChar(char, fast);
  };

  const emitPause = (ms: number): void => {
    events.push({ type: 'pause', duration: Math.max(1, Math.round(ms)) });
  };

  /**
   * Stop and think. Only emitted between bursts, and only these pauses grow
   * when the job is stretched over a longer target duration.
   */
  const emitRest = (): void => {
    if (charsThisChunk === 0 && !pendingTypo) return;
    events.push({
      type: 'pause',
      // A little spread so every gap is not identical.
      duration: Math.round(minRest * rng.range(1, 1.6)),
      rest: true,
    });
    charsThisChunk = 0;
    // Coming back to the document is when you reread and spot the mistake.
    // Fixing it here — after the gap, not a second after making it — is the
    // whole point: the typo has been sitting in the document long enough for
    // Docs to have recorded it, so the correction shows up as its own edit.
    repairPendingTypo();
  };

  const repairPendingTypo = (): void => {
    if (!pendingTypo) return;
    const { offset, remove, insert } = pendingTypo;
    events.push({
      type: 'repair',
      offset,
      remove,
      insert,
      // Reading back, spotting it, moving the cursor there.
      delay: Math.round(rng.range(600, 2_200)),
    });
    writtenLength += insert.length - remove;
    pendingTypo = null;
  };

  const tokens = tokenize(text);

  for (const token of tokens) {
    if (token.isWord) {
      // A burst never runs past its ceiling; break at the word boundary.
      if (charsThisChunk >= MAX_CHUNK_CHARS) emitRest();
      typeWord(token.value);
    } else {
      typePunctuation(token.value);
    }
  }

  // A mistake made in the last burst still has to be found. Step away, come
  // back, fix it — which also leaves the job ending on the correction rather
  // than on raw typing.
  if (pendingTypo) emitRest();

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
          if (charsThisChunk >= MIN_CHUNK_CHARS) emitRest();
        } else {
          emitPause(rng.range(400, 900));
        }
        continue;
      }

      emitChar(char, false);

      if (char === ',' || char === ';' || char === ':') {
        emitPause(rng.range(150, 400));
      } else if (char === '.' || char === '!' || char === '?') {
        // Only pause at the end of the sentence, not between "..." dots.
        const next = chunk[i + 1];
        if (next !== '.' && next !== '!' && next !== '?') {
          emitPause(rng.range(400, 1_200));
          // End of a sentence is the natural seam between bursts.
          if (charsThisChunk >= MIN_CHUNK_CHARS) emitRest();
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
