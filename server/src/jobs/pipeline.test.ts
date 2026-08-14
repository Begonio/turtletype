import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planRequests, type DocOp } from '../docs/documents.js';
import { TypingBuffer } from './buffer.js';
import { humanize, type HumanEvent } from './humanize.js';

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
}

/**
 * Replays events the way JobRunner does, but with the clock and the network
 * simulated: `windowMs` of event delays accumulate, then one flush.
 */
function runPipeline(
  events: HumanEvent[],
  options: { windowMs: number; existingBody?: string },
): RunResult {
  const existing = options.existingBody ?? '';
  const doc = new FakeDocument(existing);
  const buffer = new TypingBuffer();

  // Where this job may write, and the line it may never delete past.
  let cursor = existing.length + 1;
  const floor = cursor;

  let batchUpdates = 0;
  let requests = 0;
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
    cursor = planned.endCursor;
    batchUpdates += 1;
    requests += planned.requests.length;
  };

  for (const event of events) {
    elapsed += event.type === 'pause' ? event.duration : event.delay;
    buffer.push(event);
    if (elapsed - windowStart >= options.windowMs) {
      flush();
      windowStart = elapsed;
    }
  }
  flush();

  return { finalText: doc.text, batchUpdates, requests };
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
        const events = humanize(TEXT, { speed: 1, humanness: 1, seed });
        const { finalText } = runPipeline(events, { windowMs });
        assert.equal(finalText, TEXT, `window ${windowMs}ms, seed ${seed}`);
      }
    }
  });

  it('appends to an existing document without touching what was already there', () => {
    const existing = 'Existing content that must survive.\n';
    for (let seed = 0; seed < 25; seed++) {
      const events = humanize(TEXT, { speed: 1, humanness: 1, seed });
      const { finalText } = runPipeline(events, { windowMs: 800, existingBody: existing });
      assert.equal(finalText, existing + TEXT, `seed ${seed}`);
    }
  });

  it('holds to roughly one batchUpdate per flush window', () => {
    const events = humanize(TEXT, { speed: 1, humanness: 1, seed: 4 });
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

  it('stays correct at turbo speed, where a window holds far more keystrokes', () => {
    for (let seed = 0; seed < 25; seed++) {
      const events = humanize(TEXT, { speed: 4, humanness: 1, seed });
      const { finalText } = runPipeline(events, { windowMs: 800 });
      assert.equal(finalText, TEXT, `seed ${seed}`);
    }
  });

  it('leaves a partial but valid prefix when a job is stopped early', () => {
    // Cancelling mid-word must not corrupt the document: what is there should
    // be a prefix of the input, not a mangled fragment.
    const events = humanize(TEXT, { speed: 1, humanness: 1, seed: 8 });
    const truncated = events.slice(0, Math.floor(events.length / 2));
    const { finalText } = runPipeline(truncated, { windowMs: 800 });

    assert.ok(finalText.length > 0, 'expected some text to have been written');
    assert.ok(
      TEXT.startsWith(finalText),
      `partial output is not a prefix of the input:\n${JSON.stringify(finalText.slice(-40))}`,
    );
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
