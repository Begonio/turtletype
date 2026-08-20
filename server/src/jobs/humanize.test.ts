import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countBursts,
  countRepairs,
  DEFAULT_HUMANNESS,
  DOCS_CHECKPOINT_MS,
  estimateDurationMs,
  humanize,
  minimumDurationMs,
  netCharCount,
  type HumanEvent,
} from './humanize.js';

/**
 * How long each mistake sat in the document before being corrected, measured
 * the way Docs sees it: from the keystroke that produced the wrong character
 * to the edit that replaces it.
 *
 * The engine buys that gap out of whatever time has already passed — the rest
 * of the burst, and any breaks the mistake waited through — so checking only
 * the rest immediately before the fix would both understate the real gap and
 * miss a regression that shortened the burst instead.
 */
function correctionGapsMs(events: HumanEvent[]): number[] {
  const timeAtPosition = new Map<number, number>();
  const gaps: number[] = [];
  let written = 0;
  let clock = 0;

  for (const event of events) {
    if (event.type === 'type') {
      clock += event.delay;
      written += 1;
      timeAtPosition.set(written, clock);
    } else if (event.type === 'pause') {
      clock += event.duration;
    } else if (event.type === 'repair') {
      clock += event.delay;
      // The last wrong character sits at offset + remove.
      const typedAt = timeAtPosition.get(event.offset + event.remove);
      assert.ok(typedAt !== undefined, 'repair targets text that was never typed');
      gaps.push(clock - typedAt);
      written += event.insert.length - event.remove;
    }
  }
  return gaps;
}

/** Wall-clock length of each burst, i.e. the writing between two rests. */
function burstSpansMs(events: HumanEvent[]): number[] {
  const spans: number[] = [];
  let current = 0;
  for (const event of events) {
    if (event.type === 'pause' && event.rest) {
      spans.push(current);
      current = 0;
    } else {
      current += event.type === 'pause' ? event.duration : event.delay;
    }
  }
  spans.push(current);
  return spans;
}

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

/**
 * The properties that decide what version history looks like, pinned
 * separately from the pacing that produces them.
 *
 * Speeding a job up is only legitimate if these stay put: the time saved has
 * to come out of waiting that bought nothing, never out of the gaps and
 * granularity that make the history read as written.
 */
describe('version-history structure', () => {
  const LONG = ESSAY.repeat(4);

  it('leaves every mistake on the page well past a Docs checkpoint', () => {
    // Measured from the wrong keystroke to the fix, across many plans. This is
    // the guarantee that puts the mistake in one revision and its correction
    // in a later one; if it ever fails, corrections vanish from history.
    const gaps: number[] = [];
    for (let seed = 0; seed < 30; seed++) {
      gaps.push(...correctionGapsMs(humanize(LONG, { seed })));
    }

    assert.ok(gaps.length > 40, `expected plenty of corrections to check, saw ${gaps.length}`);
    const shortest = Math.min(...gaps);
    assert.ok(
      shortest > DOCS_CHECKPOINT_MS * 1.5,
      `a mistake sat for only ${(shortest / 1000).toFixed(0)}s, too close to the ` +
        `${DOCS_CHECKPOINT_MS / 1000}s checkpoint interval to be recorded reliably`,
    );
  });

  it('often defers a correction past a whole burst of other writing', () => {
    // A fix at the head of the very next revision is fine; a fix that arrives
    // a revision later, with unrelated writing in between, is what rereading
    // actually looks like. Both should occur.
    let deferred = 0;
    let total = 0;

    for (let seed = 0; seed < 30; seed++) {
      const events = humanize(LONG, { seed });
      let restsSinceTypo: number | null = null;

      for (const event of events) {
        if (event.type === 'pause' && event.rest && restsSinceTypo !== null) restsSinceTypo += 1;
        else if (event.type === 'repair') {
          total += 1;
          if ((restsSinceTypo ?? 0) > 1) deferred += 1;
          restsSinceTypo = null;
        } else if (event.type === 'type' && restsSinceTypo === null) {
          // A mistake is only ever pending between the wrong keystroke and its
          // repair, so the first typed char after a repair starts the count.
          restsSinceTypo = 0;
        }
      }
    }

    assert.ok(total > 40, `expected plenty of corrections, saw ${total}`);
    assert.ok(deferred > 0, 'no correction was ever deferred past a burst');
  });

  it('writes some bursts fast and works others out on the page', () => {
    // Two modes, both load-bearing. Bursts that run past the checkpoint are
    // the only source of revisions that end mid-sentence; compact bursts are
    // what keeps a job from taking all day. A plan that is all one or all the
    // other has lost something real.
    const spans: number[] = [];
    for (let seed = 0; seed < 30; seed++) {
      spans.push(...burstSpansMs(humanize(LONG, { seed })));
    }
    assert.ok(spans.length > 100, `expected plenty of bursts, saw ${spans.length}`);

    const laboured = spans.filter((span) => span > DOCS_CHECKPOINT_MS).length / spans.length;
    assert.ok(
      laboured > 0.2 && laboured < 0.55,
      `${(laboured * 100).toFixed(0)}% of bursts run past a checkpoint; ` +
        'too few loses mid-sentence revisions, too many is just slow',
    );

    const flow = spans.filter((span) => span < 60_000).length / spans.length;
    assert.ok(flow > 0.35, `only ${(flow * 100).toFixed(0)}% of bursts are written in flow`);
  });

  it('keeps revisions small enough that none reads as a paste', () => {
    // One burst is roughly one revision. Characters per burst is therefore how
    // much new text each history entry shows at once, and it is the number a
    // reader would notice first.
    const text = ESSAY.repeat(6);
    for (let seed = 0; seed < 10; seed++) {
      const perBurst = text.length / countBursts(humanize(text, { seed }));
      assert.ok(perBurst < 200, `seed ${seed}: ${perBurst.toFixed(0)} chars per revision is a wall of text`);
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

  it('produces a realistic floor at the production settings', () => {
    // Sanity-check the number a user will actually be shown, expressed per 100
    // characters so the bound stays meaningful whatever the sample is.
    //
    // Writing with genuine gaps is slow, and that is the point: the rests are
    // what Google Docs records as separate revisions. But a floor of hours per
    // paragraph would mean the tuning had run away, so both ends are pinned.
    const minutes = minimumDurationMs(ESSAY, { seed: 1 }) / 60_000;
    const perHundred = (minutes / ESSAY.length) * 100;
    // The upper bound also guards the pacing work: the engine used to sit at
    // ~6.5 min per 100 characters, and most of that was waiting that bought
    // nothing in version history. Regressing past 8 means it crept back.
    assert.ok(
      perHundred > 3 && perHundred < 8,
      `${perHundred.toFixed(1)} min per 100 chars (${minutes.toFixed(0)} min total) is out of range`,
    );
  });
});
