import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countBursts,
  estimateDurationMs,
  humanize,
  minimumDurationMs,
  netCharCount,
  type HumanEvent,
} from './humanize.js';

/**
 * Replays an event array the way the runner does, but into a string. If this
 * does not reproduce the input exactly, the document would end up wrong.
 */
function replay(events: HumanEvent[]): string {
  let out = '';
  for (const event of events) {
    if (event.type === 'type') out += event.char;
    else if (event.type === 'backspace') out = out.slice(0, Math.max(0, out.length - event.count));
  }
  return out;
}

const SAMPLE = [
  'The quick brown fox jumps over the lazy dog, and it does so repeatedly.',
  '',
  'Meanwhile, a second paragraph appears! Does it survive? It should.',
  'Short line.',
].join('\n');

/** A few paragraphs, long enough to contain several natural burst seams. */
const ESSAY = Array.from(
  { length: 6 },
  (_, i) =>
    `Paragraph ${i + 1} makes a point about something, and then develops it a little further. ` +
    'It runs on for a couple of sentences so that the engine has somewhere natural to stop. ' +
    'That is the whole idea behind writing in bursts rather than one continuous stream.',
).join('\n\n');

/** Tests use a short rest so the suite does not take minutes of wall clock. */
const FAST_REST = { minChunkRestMs: 1_000 };

describe('humanize', () => {
  it('always reproduces the input text exactly, typos and all', () => {
    for (let seed = 0; seed < 200; seed++) {
      const events = humanize(SAMPLE, { humanness: 1, seed, ...FAST_REST });
      assert.equal(replay(events), SAMPLE, `seed ${seed} did not round-trip`);
    }
  });

  it('round-trips across the whole humanness range and any target duration', () => {
    for (const targetDurationMs of [undefined, 60_000, 3_600_000]) {
      for (const humanness of [0, 0.25, 0.5, 0.75, 1]) {
        const events = humanize(ESSAY, { humanness, targetDurationMs, seed: 7, ...FAST_REST });
        assert.equal(replay(events), ESSAY, `duration ${targetDurationMs} / humanness ${humanness}`);
      }
    }
  });

  it('handles awkward input without losing characters', () => {
    const inputs = ['', 'a', 'ab', '\n\n\n', '   ', 'a,b.c!d?e', "don't — it's fine", '...ellipsis...'];
    for (const input of inputs) {
      const events = humanize(input, { humanness: 1, seed: 3, ...FAST_REST });
      assert.equal(replay(events), input, `input ${JSON.stringify(input)}`);
    }
  });

  it('makes no mistakes at humanness 0', () => {
    for (let seed = 0; seed < 50; seed++) {
      const events = humanize(SAMPLE, { humanness: 0, seed, ...FAST_REST });
      assert.equal(
        events.some((event) => event.type === 'backspace'),
        false,
        `seed ${seed} produced a typo at humanness 0`,
      );
    }
  });

  it('makes mistakes at humanness 1', () => {
    const events = humanize(SAMPLE.repeat(4), { humanness: 1, seed: 11, ...FAST_REST });
    const corrections = events.filter((event) => event.type === 'backspace').length;
    assert.ok(corrections > 0, 'expected at least one correction at humanness 1');
  });

  it('keeps per-character delays in the 60–140ms band, whatever the target duration', () => {
    // Stretching a job must never slow the keystrokes themselves: a person
    // writing over an afternoon still types at ordinary speed.
    for (const targetDurationMs of [undefined, 600_000, 8 * 3_600_000]) {
      const events = humanize(ESSAY, { humanness: 0, targetDurationMs, seed: 5, ...FAST_REST });
      const delays = events.filter((event) => event.type === 'type').map((event) => event.delay);
      assert.ok(delays.length > 0);
      for (const delay of delays) {
        // Fast words scale down by 0.7, so the floor is 60 * 0.7 rounded.
        assert.ok(delay >= 41 && delay <= 140, `delay ${delay} out of range at ${targetDurationMs}`);
      }
    }
  });

  it('types common short words faster than unfamiliar ones', () => {
    const meanDelay = (text: string): number => {
      const delays = humanize(text, { humanness: 0, seed: 9, ...FAST_REST })
        .filter((event): event is Extract<HumanEvent, { type: 'type' }> => event.type === 'type')
        .map((event) => event.delay);
      return delays.reduce((sum, value) => sum + value, 0) / delays.length;
    };

    const common = meanDelay('the and is to a of in the and is to a of in');
    const unusual = meanDelay('vex crwth glyph zephyr quorum kudzu fjord bwana');
    assert.ok(common < unusual, `common ${common} should beat unusual ${unusual}`);
  });

  it('pauses after sentence endings and paragraph breaks', () => {
    const events = humanize('Hi. Bye.\n\nNext', { humanness: 0, seed: 1, ...FAST_REST });
    const pauses = events
      .filter((event): event is Extract<HumanEvent, { type: 'pause' }> => event.type === 'pause')
      .map((event) => event.duration);

    assert.ok(pauses.some((d) => d >= 400 && d <= 1200), 'expected a sentence-ending pause');
    assert.ok(pauses.some((d) => d >= 1500 && d <= 5000), 'expected a paragraph pause');
  });

  it('reports the net character count it will leave behind', () => {
    const events = humanize(SAMPLE, { humanness: 1, seed: 21, ...FAST_REST });
    assert.equal(netCharCount(events), SAMPLE.length);
  });

  it('is deterministic for a given seed', () => {
    const options = { humanness: 0.8, seed: 1234, targetDurationMs: 900_000, ...FAST_REST };
    assert.deepEqual(humanize(SAMPLE, options), humanize(SAMPLE, options));
  });
});

describe('bursts and rests', () => {
  it('breaks a long text into several bursts', () => {
    // Each rest is a gap long enough for Google Docs to record a separate
    // revision. One burst would mean one revision, i.e. it looks pasted.
    const events = humanize(ESSAY, { humanness: 0.5, seed: 2, ...FAST_REST });
    assert.ok(countBursts(events) >= 5, `expected several bursts, got ${countBursts(events)}`);
  });

  it('never rests at the very end, where it would only delay completion', () => {
    const events = humanize(ESSAY, { humanness: 0.5, seed: 4, ...FAST_REST });
    const last = events[events.length - 1];
    assert.notEqual(last?.type, 'pause');
  });

  it('gives short text no artificial rest', () => {
    const events = humanize('Just one short line.', { humanness: 0, seed: 6, ...FAST_REST });
    assert.equal(countBursts(events), 1);
  });

  it('spaces rests by at least the configured minimum', () => {
    const minChunkRestMs = 60_000;
    const events = humanize(ESSAY, { humanness: 0.5, seed: 8, minChunkRestMs });
    const rests = events.filter(
      (event): event is Extract<HumanEvent, { type: 'pause' }> => event.type === 'pause' && !!event.rest,
    );
    assert.ok(rests.length > 0);
    for (const rest of rests) {
      assert.ok(rest.duration >= minChunkRestMs, `rest of ${rest.duration}ms is under the floor`);
    }
  });
});

describe('duration targeting', () => {
  it('stretches a job to roughly the requested duration', () => {
    for (const target of [30 * 60_000, 2 * 3_600_000]) {
      const events = humanize(ESSAY, { humanness: 0.5, targetDurationMs: target, seed: 3, ...FAST_REST });
      const actual = estimateDurationMs(events);
      const drift = Math.abs(actual - target) / target;
      assert.ok(drift < 0.02, `asked for ${target}ms, planned ${actual}ms`);
    }
  });

  it('absorbs the extra time into rests, not keystrokes', () => {
    const base = humanize(ESSAY, { humanness: 0, seed: 3, ...FAST_REST });
    const stretched = humanize(ESSAY, {
      humanness: 0,
      targetDurationMs: 4 * 3_600_000,
      seed: 3,
      ...FAST_REST,
    });

    const typingTime = (events: HumanEvent[]): number =>
      events.reduce((sum, e) => sum + (e.type === 'pause' ? 0 : e.delay), 0);

    assert.equal(typingTime(base), typingTime(stretched), 'typing time must not change');
    assert.ok(estimateDurationMs(stretched) > estimateDurationMs(base) * 10);
  });

  it('refuses to run faster than the natural minimum', () => {
    const minimum = minimumDurationMs(ESSAY, { humanness: 0.5, seed: 12, ...FAST_REST });
    // Ask for a tenth of the floor; the plan should ignore it.
    const events = humanize(ESSAY, {
      humanness: 0.5,
      targetDurationMs: Math.round(minimum / 10),
      seed: 12,
      ...FAST_REST,
    });
    assert.equal(estimateDurationMs(events), minimum);
  });

  it('reports a minimum that scales with how much text there is', () => {
    const short = minimumDurationMs('One sentence only.', { seed: 1, ...FAST_REST });
    const long = minimumDurationMs(ESSAY, { seed: 1, ...FAST_REST });
    assert.ok(long > short * 5, `short ${short}ms vs long ${long}ms`);
  });

  it('produces a realistic floor at the production rest interval', () => {
    // Sanity-check the number a user will actually be shown.
    const minutes = minimumDurationMs(ESSAY, { humanness: 0.5, seed: 1 }) / 60_000;
    assert.ok(minutes > 5 && minutes < 60, `${minutes.toFixed(1)} minutes is not a sane floor`);
  });
});
