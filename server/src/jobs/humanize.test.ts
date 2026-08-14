import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  estimateDurationMs,
  humanize,
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

describe('humanize', () => {
  it('always reproduces the input text exactly, typos and all', () => {
    for (let seed = 0; seed < 200; seed++) {
      const events = humanize(SAMPLE, { speed: 1, humanness: 1, seed });
      assert.equal(replay(events), SAMPLE, `seed ${seed} did not round-trip`);
    }
  });

  it('round-trips across the whole speed and humanness range', () => {
    for (const speed of [0.25, 1, 2, 4]) {
      for (const humanness of [0, 0.25, 0.5, 0.75, 1]) {
        const events = humanize(SAMPLE, { speed, humanness, seed: 7 });
        assert.equal(replay(events), SAMPLE, `speed ${speed} / humanness ${humanness}`);
      }
    }
  });

  it('handles awkward input without losing characters', () => {
    const inputs = ['', 'a', 'ab', '\n\n\n', '   ', 'a,b.c!d?e', "don't — it's fine", '...ellipsis...'];
    for (const input of inputs) {
      const events = humanize(input, { humanness: 1, seed: 3 });
      assert.equal(replay(events), input, `input ${JSON.stringify(input)}`);
    }
  });

  it('makes no mistakes at humanness 0', () => {
    for (let seed = 0; seed < 50; seed++) {
      const events = humanize(SAMPLE, { humanness: 0, seed });
      assert.equal(
        events.some((event) => event.type === 'backspace'),
        false,
        `seed ${seed} produced a typo at humanness 0`,
      );
    }
  });

  it('makes mistakes at humanness 1', () => {
    const events = humanize(SAMPLE.repeat(4), { humanness: 1, seed: 11 });
    const corrections = events.filter((event) => event.type === 'backspace').length;
    assert.ok(corrections > 0, 'expected at least one correction at humanness 1');
  });

  it('keeps per-character delays inside the 60–140ms band before scaling', () => {
    const events = humanize('abcdefghij klmnopqrst', { speed: 1, humanness: 0, seed: 5 });
    const delays = events.filter((event) => event.type === 'type').map((event) => event.delay);
    assert.ok(delays.length > 0);
    for (const delay of delays) {
      // Fast words scale down by 0.7, so the floor is 60 * 0.7 rounded.
      assert.ok(delay >= 41 && delay <= 140, `delay out of range: ${delay}`);
    }
  });

  it('scales the whole plan by the speed multiplier', () => {
    const slow = estimateDurationMs(humanize(SAMPLE, { speed: 0.5, humanness: 0, seed: 42 }));
    const normal = estimateDurationMs(humanize(SAMPLE, { speed: 1, humanness: 0, seed: 42 }));
    const turbo = estimateDurationMs(humanize(SAMPLE, { speed: 4, humanness: 0, seed: 42 }));

    assert.ok(slow > normal, 'half speed should take longer than normal');
    assert.ok(turbo < normal, 'turbo should take less time than normal');
    // 4x should land near a quarter of the normal duration (rounding aside).
    assert.ok(turbo < normal / 3, `turbo ${turbo} vs normal ${normal}`);
  });

  it('types common short words faster than unfamiliar ones', () => {
    const meanDelay = (text: string): number => {
      const delays = humanize(text, { speed: 1, humanness: 0, seed: 9 })
        .filter((event): event is Extract<HumanEvent, { type: 'type' }> => event.type === 'type')
        .map((event) => event.delay);
      return delays.reduce((sum, value) => sum + value, 0) / delays.length;
    };

    const common = meanDelay('the and is to a of in the and is to a of in');
    const unusual = meanDelay('vex crwth glyph zephyr quorum kudzu fjord bwana');
    assert.ok(common < unusual, `common ${common} should beat unusual ${unusual}`);
  });

  it('pauses after sentence endings and paragraph breaks', () => {
    const events = humanize('Hi. Bye.\n\nNext', { speed: 1, humanness: 0, seed: 1 });
    const pauses = events
      .filter((event): event is Extract<HumanEvent, { type: 'pause' }> => event.type === 'pause')
      .map((event) => event.duration);

    assert.ok(pauses.some((d) => d >= 400 && d <= 1200), 'expected a sentence-ending pause');
    assert.ok(pauses.some((d) => d >= 1500 && d <= 5000), 'expected a paragraph pause');
  });

  it('reports the net character count it will leave behind', () => {
    const events = humanize(SAMPLE, { humanness: 1, seed: 21 });
    assert.equal(netCharCount(events), SAMPLE.length);
  });

  it('is deterministic for a given seed', () => {
    const a = humanize(SAMPLE, { humanness: 0.8, seed: 1234 });
    const b = humanize(SAMPLE, { humanness: 0.8, seed: 1234 });
    assert.deepEqual(a, b);
  });

  it('clamps out-of-range speed and humanness instead of misbehaving', () => {
    const events = humanize('hello world', { speed: 999, humanness: 42, seed: 2 });
    assert.equal(replay(events), 'hello world');
    for (const event of events) {
      const value = event.type === 'pause' ? event.duration : event.delay;
      assert.ok(value >= 1, 'every delay must be at least 1ms');
    }
  });
});
