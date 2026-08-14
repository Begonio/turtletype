/**
 * Humanization engine.
 *
 * Turns a block of text into a flat, in-memory sequence of typing events that
 * a human would plausibly produce: variable per-character delays, pauses at
 * punctuation and paragraph breaks, occasional mid-word hesitation, and typos
 * that get noticed and corrected a beat or four later.
 *
 * This module performs no I/O of any kind. It is pure (given a seed) and
 * cheap, so an entire document is planned up front and the runner simply
 * replays the array with real sleeps.
 */

export type TypeEvent = { type: 'type'; char: string; delay: number };
export type BackspaceEvent = { type: 'backspace'; count: number; delay: number };
export type PauseEvent = { type: 'pause'; duration: number };
export type HumanEvent = TypeEvent | BackspaceEvent | PauseEvent;

export interface HumanizeOptions {
  /** Speed multiplier. 0.25 = quarter speed, 4 = four times as fast. */
  speed?: number;
  /** 0 = metronome, 1 = distractible human (~8% of words get a typo). */
  humanness?: number;
  /** Optional seed for deterministic output (tests). */
  seed?: number;
}

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

/** Base per-character delay before speed scaling, in milliseconds. */
const CHAR_DELAY_MEAN = 100;
const CHAR_DELAY_SD = 22;
const CHAR_DELAY_MIN = 60;
const CHAR_DELAY_MAX = 140;

/** At humanness = 1, roughly this share of eligible words get a typo. */
const MAX_TYPO_RATE = 0.08;

/** Chance of a mid-word "wait, what was I saying" hesitation. */
const HESITATION_CHANCE = 0.05;

/** Words so ingrained they come out as a single burst. */
const FAST_WORDS = new Set(['the', 'and', 'is', 'to', 'a', 'of', 'in']);
const FAST_WORD_FACTOR = 0.7;

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
  const speed = clamp(options.speed ?? 1, SPEED_MIN, SPEED_MAX);
  const humanness = clamp(options.humanness ?? 0.5, 0, 1);
  const rng = new Rng(makeRandom(options.seed));

  const events: HumanEvent[] = [];
  const typoRate = MAX_TYPO_RATE * humanness;

  /** Every delay and pause in the plan passes through here. */
  const scale = (ms: number): number => Math.max(1, Math.round(ms / speed));

  const charDelay = (fast: boolean): number => {
    const base = rng.gaussian(CHAR_DELAY_MEAN, CHAR_DELAY_SD, CHAR_DELAY_MIN, CHAR_DELAY_MAX);
    return scale(fast ? base * FAST_WORD_FACTOR : base);
  };

  const emitChar = (char: string, fast: boolean): void => {
    events.push({ type: 'type', char, delay: charDelay(fast) });
  };

  const emitString = (value: string, fast: boolean): void => {
    for (const char of value) emitChar(char, fast);
  };

  const emitPause = (ms: number): void => {
    events.push({ type: 'pause', duration: scale(ms) });
  };

  const tokens = tokenize(text);

  for (const token of tokens) {
    if (token.isWord) {
      typeWord(token.value);
    } else {
      typePunctuation(token.value);
    }
  }

  return events;

  // -- helpers ------------------------------------------------------------

  function typeWord(word: string): void {
    const fast = FAST_WORDS.has(word.toLowerCase());

    // Hesitation lands before a word or between its letters, never after the
    // last one (that gap belongs to the following punctuation pause).
    const hesitateAt = rng.chance(HESITATION_CHANCE) ? rng.int(0, word.length - 1) : -1;

    const typo = word.length >= 3 && rng.chance(typoRate) ? planTypo(word) : null;

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
    emitString(typo.wrong, true);

    // 3. Carry on obliviously for a few characters.
    const carriedOn = word.slice(typo.at + typo.consumed, typo.at + typo.consumed + typo.noticeAfter);
    emitString(carriedOn, fast);

    // 4. Notice. Hesitate, then rip out everything typed since the mistake.
    const toDelete = typo.wrong.length + carriedOn.length;
    events.push({
      type: 'backspace',
      count: toDelete,
      delay: scale(rng.range(180, 650)),
    });

    // 5. Retype it correctly, a touch more deliberately than before.
    const corrected = word.slice(typo.at, typo.at + typo.consumed + carriedOn.length);
    for (const char of corrected) {
      events.push({
        type: 'type',
        char,
        delay: scale(rng.gaussian(CHAR_DELAY_MEAN * 1.1, CHAR_DELAY_SD, CHAR_DELAY_MIN, CHAR_DELAY_MAX)),
      });
    }

    // 6. The rest of the word.
    emitString(word.slice(typo.at + typo.consumed + carriedOn.length), fast);
  }

  /**
   * Describes a mistake as: at index `at`, `consumed` intended characters came
   * out as the string `wrong`, and it goes unnoticed for `noticeAfter` more
   * characters.
   */
  function planTypo(
    word: string,
  ): { at: number; consumed: number; wrong: string; noticeAfter: number } | null {
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

    // Sometimes the eye catches it immediately, sometimes three or four
    // characters go by first.
    const remaining = word.length - (at + consumed);
    const noticeAfter = rng.chance(0.45)
      ? Math.min(remaining, rng.int(0, 1))
      : Math.min(remaining, rng.int(3, 4));

    return { at, consumed, wrong, noticeAfter };
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
        }
      }
    }
  }
}

/** Net characters the event array will leave in the document. */
export function netCharCount(events: HumanEvent[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type === 'type') total += event.char.length;
    else if (event.type === 'backspace') total -= event.count;
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
