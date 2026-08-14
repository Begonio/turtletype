import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDocId, planRequests, sanitizeText, type DocOp } from './documents.js';
import { RateLimiter } from './rateLimiter.js';
import { isRetryable, statusOf } from './backoff.js';

/** Applies planned requests to a fake document body to check index arithmetic. */
function applyToDocument(body: string, requests: ReturnType<typeof planRequests>['requests']): string {
  // Document indices are 1-based, so index 1 == body[0].
  let text = body;
  for (const request of requests) {
    if (request.insertText) {
      const at = (request.insertText.location?.index ?? 1) - 1;
      text = text.slice(0, at) + (request.insertText.text ?? '') + text.slice(at);
    } else if (request.deleteContentRange) {
      const start = (request.deleteContentRange.range?.startIndex ?? 1) - 1;
      const end = (request.deleteContentRange.range?.endIndex ?? 1) - 1;
      text = text.slice(0, start) + text.slice(end);
    }
  }
  return text;
}

describe('planRequests', () => {
  it('merges consecutive inserts into one request', () => {
    const ops: DocOp[] = [
      { kind: 'insert', text: 'he' },
      { kind: 'insert', text: 'llo' },
    ];
    const { requests, endCursor } = planRequests(ops, 1, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.insertText?.text, 'hello');
    assert.equal(requests[0]?.insertText?.location?.index, 1);
    assert.equal(endCursor, 6);
  });

  it('trims a backspace out of an insert that has not been sent yet', () => {
    const ops: DocOp[] = [
      { kind: 'insert', text: 'teh' },
      { kind: 'delete', count: 2 },
      { kind: 'insert', text: 'he' },
    ];
    const { requests, endCursor } = planRequests(ops, 1, 1);
    assert.equal(requests.length, 1, 'no deleteContentRange is needed inside one window');
    assert.equal(requests[0]?.insertText?.text, 'the');
    assert.equal(endCursor, 4);
    assert.equal(applyToDocument('', requests), 'the');
  });

  it('emits a deleteContentRange when the backspace crosses a flush boundary', () => {
    // Window 1 already sent "teh"; window 2 opens with the correction.
    const ops: DocOp[] = [
      { kind: 'delete', count: 2 },
      { kind: 'insert', text: 'he' },
    ];
    const { requests, endCursor } = planRequests(ops, 4, 1);

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]?.deleteContentRange?.range, { startIndex: 2, endIndex: 4 });
    assert.equal(requests[1]?.insertText?.location?.index, 2);
    assert.equal(requests[1]?.insertText?.text, 'he');
    assert.equal(endCursor, 4);
    assert.equal(applyToDocument('teh', requests), 'the');
  });

  it('never deletes below the index the job started at', () => {
    const ops: DocOp[] = [{ kind: 'delete', count: 50 }];
    const { requests, endCursor } = planRequests(ops, 20, 12);
    assert.deepEqual(requests[0]?.deleteContentRange?.range, { startIndex: 12, endIndex: 20 });
    assert.equal(endCursor, 12);
  });

  it('drops a delete that would target nothing', () => {
    const { requests, endCursor } = planRequests([{ kind: 'delete', count: 5 }], 12, 12);
    assert.equal(requests.length, 0);
    assert.equal(endCursor, 12);
  });

  it('keeps indices correct across a mixed window', () => {
    const ops: DocOp[] = [
      { kind: 'insert', text: 'abc' },
      { kind: 'delete', count: 5 }, // eats 'abc' plus two pre-existing chars
      { kind: 'insert', text: 'XY' },
    ];
    // Document already holds "12345678"; job started at index 1.
    const { requests, endCursor } = planRequests(ops, 9, 1);
    assert.equal(applyToDocument('12345678', requests), '123456XY');
    assert.equal(endCursor, 9);
  });
});

describe('parseDocId', () => {
  it('accepts the shapes users actually paste', () => {
    const id = '1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R9s0T';
    assert.equal(parseDocId(`https://docs.google.com/document/d/${id}/edit#heading=h.x`), id);
    assert.equal(parseDocId(`https://docs.google.com/document/d/${id}`), id);
    assert.equal(parseDocId(`https://drive.google.com/open?id=${id}`), id);
    assert.equal(parseDocId(`  ${id}  `), id);
  });

  it('rejects things that are not documents', () => {
    assert.equal(parseDocId(''), null);
    assert.equal(parseDocId('not a link'), null);
    assert.equal(parseDocId('https://example.com/'), null);
  });
});

describe('sanitizeText', () => {
  it('normalises line endings and strips control characters', () => {
    assert.equal(sanitizeText('a\r\nb\rc'), 'a\nb\nc');
    assert.equal(sanitizeText('a\u0000b\u0007c'), 'abc');
    assert.equal(sanitizeText('keep\ttabs\nand newlines'), 'keep\ttabs\nand newlines');
  });
});

describe('RateLimiter', () => {
  it('hands out an initial burst then throttles to the configured rate', () => {
    const limiter = new RateLimiter(60); // one per second
    let granted = 0;
    while (limiter.delayUntilAvailable() === 0 && granted < 100) {
      // Consume by acquiring synchronously through the public API.
      void limiter.acquire();
      granted++;
    }
    assert.ok(granted >= 1 && granted <= 6, `unexpected burst size ${granted}`);
    assert.ok(limiter.delayUntilAvailable() > 0, 'limiter should be empty after the burst');
    assert.ok(limiter.delayUntilAvailable() <= 1000, 'a 60/min limiter refills within a second');
  });

  it('rejects a waiting acquire when the job is aborted', async () => {
    const limiter = new RateLimiter(1); // effectively one per minute
    await limiter.acquire();
    const controller = new AbortController();
    const pending = limiter.acquire(controller.signal);
    controller.abort(new Error('cancelled'));
    await assert.rejects(pending, /cancelled/);
  });
});

describe('backoff classification', () => {
  it('retries quota and server faults, not client mistakes', () => {
    assert.equal(isRetryable({ code: 429 }), true);
    assert.equal(isRetryable({ response: { status: 503 } }), true);
    assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
    assert.equal(isRetryable({ code: 404 }), false);
    assert.equal(isRetryable({ response: { status: 403 } }), false);
  });

  it('reads the status out of the shapes googleapis throws', () => {
    assert.equal(statusOf({ code: 429 }), 429);
    assert.equal(statusOf({ status: '500' }), 500);
    assert.equal(statusOf({ response: { status: 401 } }), 401);
    assert.equal(statusOf(new Error('boom')), undefined);
  });
});
