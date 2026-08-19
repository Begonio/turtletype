import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countBursts,
  countRepairs,
  DEFAULT_HUMANNESS,
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
    else if (event.type === 'repair')
      out = out.slice(0, event.offset) + event.insert + out.slice(event.offset + event.remove);
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
      assert.equal(countRepairs(events), 0, `seed ${seed} produced a typo at humanness 0`);
    }
  });

  it('makes mistakes at the default setting', () => {
    const events = humanize(SAMPLE.repeat(4), { seed: 11, ...FAST_REST });
    assert.ok(countRepairs(events) > 0, 'expected at least one mistake at the default setting');
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

/**
 * Google Docs merges edits that happen close together into one revision. A
 * typo corrected a second after it was made is therefore invisible in version
 * history no matter how it is sent. The mistake has to survive a full rest.
 */
describe('mistakes are left in place and fixed later', () => {
  const eventsFor = (seed: number): HumanEvent[] =>
    humanize(ESSAY, { humanness: 1, seed, ...FAST_REST });

  it('always puts a full rest between the mistake and its correction', () => {
    // Every repair must be the first thing that happens after coming back from
    // a break. That gap is what lets Docs record the typo as its own revision
    // before the correction arrives as a second one.
    let totalChecked = 0;

    for (let seed = 0; seed < 40; seed++) {
      const events = eventsFor(seed);

      events.forEach((event, index) => {
        if (event.type !== 'repair') return;
        const previous = events[index - 1];
        assert.ok(
          previous?.type === 'pause' && previous.rest === true,
          `seed ${seed}: correction at ${index} follows ${previous?.type}, not a rest`,
        );
        totalChecked += 1;
      });
    }

    assert.ok(totalChecked > 20, `expected plenty of corrections to check, saw ${totalChecked}`);
  });

  it('leaves the mistake on the page across a Docs checkpoint', () => {
    // Google Docs snapshots roughly every two minutes. A mistake corrected
    // inside one of those windows is never recorded, so the gap between making
    // it and fixing it has to clear that interval with room to spare — this is
    // the single property that decides whether corrections show up in history.
    const DOCS_CHECKPOINT_MS = 120_000;
    let checked = 0;

    for (let seed = 0; seed < 30; seed++) {
      const events = humanize(ESSAY, { seed });

      events.forEach((event, index) => {
        if (event.type !== 'repair') return;
        const rest = events[index - 1];
        assert.ok(rest?.type === 'pause' && rest.rest === true, `seed ${seed}: no rest before fix`);
        assert.ok(
          rest.duration > DOCS_CHECKPOINT_MS,
          `seed ${seed}: mistake sat for only ${(rest.duration / 1000).toFixed(0)}s, ` +
            'which Docs would fold into one revision',
        );
        checked += 1;
      });
    }

    assert.ok(checked > 10, `expected plenty of corrections to check, saw ${checked}`);
  });

  it('waits a beat before reaching back to fix it', () => {
    const events = eventsFor(3).filter(
      (event): event is Extract<HumanEvent, { type: 'repair' }> => event.type === 'repair',
    );
    assert.ok(events.length > 0);
    for (const repair of events) {
      // Rereading, spotting it, moving the cursor — not an instant machine edit.
      assert.ok(repair.delay >= 600, `correction delay ${repair.delay}ms is too abrupt`);
    }
  });

  it('keeps typing to the end of the word after fumbling it', () => {
    // The characters immediately after a mistake must be ordinary typing, not
    // an instant backspace.
    const events = humanize(ESSAY, { humanness: 1, seed: 2, ...FAST_REST });
    assert.equal(
      events.some((event) => event.type === 'backspace'),
      false,
      'the engine should no longer correct anything on the spot',
    );
    assert.ok(countRepairs(events) > 0, 'but it should still be making mistakes');
  });

  it('only ever leaves one mistake outstanding at a time', () => {
    // Two unfixed typos at once would make the second one's offset wrong.
    for (let seed = 0; seed < 40; seed++) {
      const events = humanize(ESSAY, { humanness: 1, seed, ...FAST_REST });
      assert.equal(replay(events), ESSAY, `seed ${seed} corrupted the text`);
    }
  });

  it('repairs target text that is actually there', () => {
    for (let seed = 0; seed < 40; seed++) {
      const events = humanize(ESSAY, { humanness: 1, seed, ...FAST_REST });
      let written = '';
      for (const event of events) {
        if (event.type === 'type') written += event.char;
        else if (event.type === 'repair') {
          assert.ok(
            event.offset >= 0 && event.offset + event.remove <= written.length,
            `seed ${seed}: repair at ${event.offset}+${event.remove} is outside ${written.length} written chars`,
          );
          written =
            written.slice(0, event.offset) + event.insert + written.slice(event.offset + event.remove);
        }
      }
      assert.equal(written, ESSAY);
    }
  });

  it('always fixes a mistake made in the final burst', () => {
    for (let seed = 0; seed < 60; seed++) {
      const events = humanize(SAMPLE, { humanness: 1, seed, ...FAST_REST });
      // Round-tripping proves nothing was left broken at the end.
      assert.equal(replay(events), SAMPLE, `seed ${seed} ended with an unfixed mistake`);
    }
  });

  it('defaults to a fixed human setting with no slider involved', () => {
    assert.ok(DEFAULT_HUMANNESS > 0.5, 'the default should be firmly human');
    const withDefault = humanize(ESSAY, { seed: 15, ...FAST_REST });
    const explicit = humanize(ESSAY, { humanness: DEFAULT_HUMANNESS, seed: 15, ...FAST_REST });
    assert.deepEqual(withDefault, explicit);
    assert.ok(countRepairs(withDefault) > 0, 'the default must actually produce mistakes');
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

  it('produces a realistic floor at the production settings', () => {
    // Sanity-check the number a user will actually be shown, expressed per 100
    // characters so the bound stays meaningful whatever the sample is.
    //
    // Writing with genuine gaps is slow, and that is the point: the rests are
    // what Google Docs records as separate revisions. But a floor of hours per
    // paragraph would mean the tuning had run away, so both ends are pinned.
    const minutes = minimumDurationMs(ESSAY, { seed: 1 }) / 60_000;
    const perHundred = (minutes / ESSAY.length) * 100;
    assert.ok(
      perHundred > 3 && perHundred < 15,
      `${perHundred.toFixed(1)} min per 100 chars (${minutes.toFixed(0)} min total) is out of range`,
    );
  });
});
