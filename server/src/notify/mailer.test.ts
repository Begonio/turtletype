/**
 * The mail transport, pointed at a local HTTP server instead of a provider.
 *
 * Same trick the Docs and Drive clients get in `integration.test.ts`: the base
 * URL is an environment variable precisely so the whole send path — headers,
 * body shape, error handling — can run without an account anywhere.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.GOOGLE_CALLBACK_URL ??= 'http://localhost:8080/auth/google/callback';
process.env.SESSION_SECRET ??= 'test-session-secret';

interface Received {
  method: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Record<string, unknown>;
}

const received: Received[] = [];
/** What the fake provider answers with next. */
let reply: { status: number; body: string } = { status: 200, body: '{"id":"mail_1"}' };
/** When true the server accepts the connection and never responds. */
let hang = false;

let server: http.Server;
let mailer: typeof import('./mailer.js');

const EMAIL = {
  to: 'someone@example.com',
  subject: 'Your document is finished',
  text: 'plain',
  html: '<p>rich</p>',
};

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      });
      if (hang) return; // deliberately never answers
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  process.env.MAIL_API_URL = `http://127.0.0.1:${port}/emails`;
  process.env.MAIL_API_KEY = 're_test_key';
  process.env.MAIL_FROM = 'TurtleType <notifications@example.org>';
  // Short, so the timeout case does not hold the suite open for ten seconds.
  process.env.MAIL_TIMEOUT_MS = '300';

  mailer = await import('./mailer.js');
});

after(async () => {
  hang = false;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  reply = { status: 200, body: '{"id":"mail_1"}' };
  hang = false;
  process.env.MAIL_API_KEY = 're_test_key';
  process.env.MAIL_FROM = 'TurtleType <notifications@example.org>';
});

describe('sendEmail', () => {
  it('posts the message as JSON with the key as a bearer token', async () => {
    assert.equal(await mailer.sendEmail(EMAIL), true);
    assert.equal(received.length, 1);

    const request = received[0]!;
    assert.equal(request.method, 'POST');
    assert.equal(request.authorization, 'Bearer re_test_key');
    assert.match(request.contentType ?? '', /application\/json/);
    assert.deepEqual(request.body.to, ['someone@example.com']);
    assert.equal(request.body.from, 'TurtleType <notifications@example.org>');
    assert.equal(request.body.subject, EMAIL.subject);
    assert.equal(request.body.text, 'plain');
    assert.equal(request.body.html, '<p>rich</p>');
  });

  it('sends both a plain-text and an HTML body', async () => {
    // A text/plain alternative is what keeps this out of a spam folder and
    // readable in a client that blocks HTML.
    await mailer.sendEmail(EMAIL);
    assert.ok(received[0]!.body.text);
    assert.ok(received[0]!.body.html);
  });

  it('points replies at the published support address', async () => {
    // An automated notice someone cannot reply to is a dead end, and the
    // address on the consent screen and the legal pages is the one they will
    // look for.
    await mailer.sendEmail(EMAIL);
    assert.equal(received[0]!.body.reply_to, 'help@turtlegames.org');
  });

  it('honours an operator-chosen reply address over the default', async () => {
    process.env.MAIL_REPLY_TO = 'support@example.org';
    try {
      await mailer.sendEmail(EMAIL);
      assert.equal(received[0]!.body.reply_to, 'support@example.org');
    } finally {
      delete process.env.MAIL_REPLY_TO;
    }
  });

  it('sends nothing at all when no provider is configured', async () => {
    // A laptop, the test suite and a self-hosted instance all run this way,
    // and every one of them must behave exactly as it did before
    // notifications existed.
    delete process.env.MAIL_API_KEY;
    assert.equal(mailer.emailEnabled(), false);
    assert.equal(await mailer.sendEmail(EMAIL), false);
    assert.equal(received.length, 0);
  });

  it('needs a From address as well as a key', async () => {
    delete process.env.MAIL_FROM;
    assert.equal(mailer.emailEnabled(), false);
    assert.equal(await mailer.sendEmail(EMAIL), false);
    assert.equal(received.length, 0);
  });

  it('reports a rejected send rather than throwing', async () => {
    // A bad key and an unverified sending domain are the two realistic
    // failures, and both arrive as a 4xx. The job that triggered this has
    // already finished successfully — an exception here would turn a delivered
    // document into an unhandled rejection.
    reply = { status: 422, body: '{"message":"domain is not verified"}' };
    assert.equal(await mailer.sendEmail(EMAIL), false);
  });

  it('gives up on a provider that never answers', async () => {
    hang = true;
    assert.equal(await mailer.sendEmail(EMAIL), false);
  });

  it('reports an unreachable provider rather than throwing', async () => {
    process.env.MAIL_API_URL = 'http://127.0.0.1:1/emails';
    try {
      assert.equal(await mailer.sendEmail(EMAIL), false);
    } finally {
      const { port } = server.address() as AddressInfo;
      process.env.MAIL_API_URL = `http://127.0.0.1:${port}/emails`;
    }
  });
});
