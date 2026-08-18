import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planRequests, type DocOp } from '../docs/documents.js';
import { TypingBuffer } from './buffer.js';
import { countRepairs, humanize, type HumanEvent } from './humanize.js';

/**
 * End-to-end check of the write path with the network taken out:
 *
 *   humanize -> TypingBuffer -> planRequests -> (fake document)
 *
 * The one thing that must never break is that the document ends up holding
 * exactly the text the user pasted, no matter where the flush boundaries land
 * relative to a typo and its correction. A backspace that crosses a boundary
 * becomes a real deleteContentRange against text Google already has, and that
 * is precisely where index arithmetic goes wrong if anything is off by one.
 */

/** Stands in for the document body; index 1 in the API is offset 0 here. */
class FakeDocument {
  constructor(private body: string) {}

  apply(requests: ReturnType<typeof planRequests>['requests']): void {
    for (const request of requests) {
      if (request.insertText) {
        const at = (request.insertText.location?.index ?? 1) - 1;
        assert.ok(at >= 0 && at <= this.body.length, `insert index ${at + 1} out of bounds`);
        this.body = this.body.slice(0, at) + (request.insertText.text ?? '') + this.body.slice(at);
      } else if (request.deleteContentRange) {
        const start = (request.deleteContentRange.range?.startIndex ?? 1) - 1;
        const end = (request.deleteContentRange.range?.endIndex ?? 1) - 1;
        assert.ok(start >= 0 && end <= this.body.length && start < end, `bad delete range ${start}-${end}`);
        this.body = this.body.slice(0, start) + this.body.slice(end);
      }
    }
  }

  get text(): string {
    return this.body;
  }

  get length(): number {
    return this.body.length;
  }
}

interface RunResult {
  finalText: string;
  batchUpdates: number;
  requests: number;
  deleteRequests: number;
  /** The document body after each write, for inspecting intermediate states. */
  snapshots: string[];
}

/**
 * Replays events the way JobRunner does, but with the clock and the network
 * simulated: `windowMs` of event delays accumulate, then one flush.
 */
function runPipeline(
  events: HumanEvent[],
  options: { windowMs: number; existingBody?: string; flushBeforeBackspace?: boolean },
): RunResult {
  const existing = options.existingBody ?? '';
  const doc = new FakeDocument(existing);
  const buffer = new TypingBuffer();

  // Where this job may write, and the line it may never delete past.
  let cursor = existing.length + 1;
  const floor = cursor;

  let batchUpdates = 0;
  let requests = 0;
  let deleteRequests = 0;
  const snapshots: string[] = [];
  let elapsed = 0;
  let windowStart = 0;

  const flush = (): void => {
    const ops: DocOp[] = buffer.drain();
    if (ops.length === 0) return;
    const planned = planRequests(ops, cursor, floor);
    if (planned.requests.length === 0) {
      cursor = planned.endCursor;
      return;
    }
    doc.apply(planned.requests);
    snapshots.push(doc.text);
    cursor = planned.endCursor;
    batchUpdates += 1;
    requests += planned.requests.length;
    deleteRequests += planned.requests.filter((request) => request.deleteContentRange).length;
  };

  /**
   * Mirrors JobRunner.repair: everything pending is written first, then the
   * correction goes out on its own as a targeted edit inside existing text.
   */
  const repair = (offset: number, remove: number, insert: string): void => {
    flush();

    const start = floor + offset;
    const edits = [
      { deleteContentRange: { range: { startIndex: start, endIndex: start + remove } } },
      ...(insert ? [{ insertText: { location: { index: start }, text: insert } }] : []),
    ];

    doc.apply(edits);
    snapshots.push(doc.text);
    cursor += insert.length - remove;
    batchUpdates += 1;
    requests += edits.length;
    deleteRequests += 1;
  };

  for (const event of events) {
    if (event.type === 'repair') {
      elapsed += event.delay;
      repair(event.offset, event.remove, event.insert);
      windowStart = elapsed;
      continue;
    }

    // Mirrors JobRunner: the buffer is flushed before a backspace so the typo
    // is already in the document when the deletion is issued, and before a
    // rest so each burst lands as its own write.
    if (options.flushBeforeBackspace && (event.type === 'backspace' || (event.type === 'pause' && event.rest))) {
      flush();
      windowStart = elapsed;
    }

    elapsed += event.type === 'pause' ? event.duration : event.delay;
    buffer.push(event);

    if (elapsed - windowStart >= options.windowMs) {
      flush();
      windowStart = elapsed;
    }
  }
  flush();

  return { finalText: doc.text, batchUpdates, requests, deleteRequests, snapshots };
}

const TEXT = [
  'The quick brown fox jumps over the lazy dog, and it does so repeatedly.',
  '',
  'Meanwhile, a second paragraph appears! Does it survive the round trip? It should,',
  'because the whole point is that the document ends up identical to the input.',
].join('\n');

describe('write pipeline', () => {
  it('lands the exact text in an empty document, whatever the flush cadence', () => {
    for (const windowMs of [50, 200, 800, 2_000, 10_000]) {
      for (let seed = 0; seed < 25; seed++) {
        const events = humanize(TEXT, { humanness: 1, minChunkRestMs: 1_000, seed });
        const { finalText } = runPipeline(events, { windowMs });
        assert.equal(finalText, TEXT, `window ${windowMs}ms, seed ${seed}`);
      }
    }
  });

  it('appends to an existing document without touching what was already there', () => {
    const existing = 'Existing content that must survive.\n';
    for (let seed = 0; seed < 25; seed++) {
      const events = humanize(TEXT, { humanness: 1, minChunkRestMs: 1_000, seed });
      const { finalText } = runPipeline(events, { windowMs: 800, existingBody: existing });
      assert.equal(finalText, existing + TEXT, `seed ${seed}`);
    }
  });

  it('holds to roughly one batchUpdate per flush window', () => {
    const events = humanize(TEXT, { humanness: 1, minChunkRestMs: 1_000, seed: 4 });
    const totalMs = events.reduce(
      (sum, event) => sum + (event.type === 'pause' ? event.duration : event.delay),
      0,
    );
    const { batchUpdates, requests } = runPipeline(events, { windowMs: 800 });

    const windows = Math.ceil(totalMs / 800);
    assert.ok(batchUpdates <= windows + 1, `${batchUpdates} updates for ~${windows} windows`);
    // Merging keeps each batch tiny: a handful of requests, not one per key.
    assert.ok(requests / batchUpdates < 3, `${requests / batchUpdates} requests per batch`);
  });

  it('stays correct when a window holds far more keystrokes than usual', () => {
    for (let seed = 0; seed < 25; seed++) {
      const events = humanize(TEXT, { humanness: 1, minChunkRestMs: 1_000, seed });
      const { finalText } = runPipeline(events, { windowMs: 10_000 });
      assert.equal(finalText, TEXT, `seed ${seed}`);
    }
  });

  it('leaves a partial but valid prefix when a job is stopped early', () => {
    // Cancelling mid-word must not corrupt the document: what is there should
    // be a prefix of the input, not a mangled fragment.
    const events = humanize(TEXT, { humanness: 1, minChunkRestMs: 1_000, seed: 8 });
    const truncated = events.slice(0, Math.floor(events.length / 2));
    const { finalText } = runPipeline(truncated, { windowMs: 800 });

    assert.ok(finalText.length > 0, 'expected some text to have been written');
    assert.ok(
      TEXT.startsWith(finalText),
      `partial output is not a prefix of the input:\n${JSON.stringify(finalText.slice(-40))}`,
    );
  });
});

/**
 * The behaviour the whole feature rests on: a typo has to actually reach the
 * document before it is corrected. If the mistake and its correction land in
 * the same flush window, the planner folds them together and Google never sees
 * either one — the document gets clean text and the version history shows no
 * sign of a person writing it.
 */
describe('typo visibility in the document', () => {
  it('sends one real deletion per mistake, and ends up exact', () => {
    let totalRepairs = 0;

    for (let seed = 0; seed < 20; seed++) {
      const events = humanize(TEXT, { humanness: 1, minChunkRestMs: 1_000, seed });
      const repairs = countRepairs(events);
      if (repairs === 0) continue;
      totalRepairs += repairs;

      const result = runPipeline(events, { windowMs: 60_000, flushBeforeBackspace: true });

      assert.equal(
        result.deleteRequests,
        repairs,
        `seed ${seed}: ${repairs} mistakes produced ${result.deleteRequests} deletions`,
      );
      assert.equal(result.finalText, TEXT, `seed ${seed} still has to end up correct`);
    }

    assert.ok(totalRepairs > 0, 'expected the sample text to contain mistakes');
  });

  it('leaves the mistake sitting in the document until the correction', () => {
    // The document must genuinely hold wrong text for a while — that is the
    // state Google Docs snapshots into version history.
    let sawMistake = false;

    for (let seed = 0; seed < 20; seed++) {
      const events = humanize(TEXT, { humanness: 1, minChunkRestMs: 1_000, seed });
      if (countRepairs(events) === 0) continue;

      const result = runPipeline(events, { windowMs: 60_000, flushBeforeBackspace: true });
      // A snapshot that is not a prefix of the final text can only be a typo.
      if (result.snapshots.some((snapshot) => !TEXT.startsWith(snapshot))) sawMistake = true;
    }

    assert.ok(sawMistake, 'no intermediate document state ever contained an uncorrected mistake');
  });

  it('still folds a same-window backspace away, which is why repairs exist', () => {
    // The engine no longer emits backspaces, but the planner still merges an
    // insert and an immediate delete — this is the behaviour that made
    // on-the-spot corrections invisible and drove the move to repairs.
    const events: HumanEvent[] = [
      { type: 'type', char: 't', delay: 100 },
      { type: 'type', char: 'e', delay: 100 },
      { type: 'type', char: 'h', delay: 100 },
      { type: 'backspace', count: 2, delay: 200 },
      { type: 'type', char: 'h', delay: 100 },
      { type: 'type', char: 'e', delay: 100 },
    ];

    const result = runPipeline(events, { windowMs: 60_000, flushBeforeBackspace: false });
    assert.equal(result.deleteRequests, 0, 'the correction was folded away, as expected');
    assert.equal(result.finalText, 'the');
  });

  it('writes each burst separately so revisions do not merge', () => {
    const events = humanize(TEXT, { humanness: 0, minChunkRestMs: 60_000, seed: 3 });
    const rests = events.filter((event) => event.type === 'pause' && event.rest).length;
    assert.ok(rests > 0, 'sample text should contain at least one burst seam');

    // A very wide window: without the forced flush at each rest, the whole
    // document would arrive as a single write.
    const result = runPipeline(events, { windowMs: 3_600_000, flushBeforeBackspace: true });
    assert.ok(
      result.batchUpdates >= rests + 1,
      `${rests} rests should produce at least ${rests + 1} writes, got ${result.batchUpdates}`,
    );
    assert.equal(result.finalText, TEXT);
  });
});

describe('TypingBuffer', () => {
  it('coalesces runs and ignores pauses', () => {
    const buffer = new TypingBuffer();
    buffer.push({ type: 'type', char: 'a', delay: 1 });
    buffer.push({ type: 'pause', duration: 500 });
    buffer.push({ type: 'type', char: 'b', delay: 1 });
    buffer.push({ type: 'backspace', count: 1, delay: 1 });
    buffer.push({ type: 'backspace', count: 2, delay: 1 });
    buffer.push({ type: 'type', char: 'c', delay: 1 });

    assert.deepEqual(buffer.drain(), [
      { kind: 'insert', text: 'ab' },
      { kind: 'delete', count: 3 },
      { kind: 'insert', text: 'c' },
    ]);
    assert.equal(buffer.isEmpty, true);
  });
});
