/**
 * The revision watcher, against a fake Drive.
 *
 * What is being pinned here is not "does it read a list" but the safety rule
 * the speedup rests on: a gap is only ever cut short on an *observed* new
 * revision. Every way of not knowing — no per-file grant, a document that
 * exposes nothing, Drive being briefly unavailable — has to come back as "no
 * opinion", never as a false confirmation, because a false confirmation is a
 * revision boundary that was never drawn and a job that quietly stops looking
 * written.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.GOOGLE_CALLBACK_URL ??= 'http://localhost:8080/auth/google/callback';
process.env.SESSION_SECRET ??= 'test-session-secret';

/** A stand-in for one document's Drive revision list. */
class FakeRevisions {
  revisions: string[] = ['r1'];
  /** Requests served, so a test can prove polling stays cheap. */
  requests = 0;
  /** Page tokens handed out, so a test can prove paging is resumed not rewalked. */
  pageSize = 200;
  /** Upcoming requests to answer with this status instead of a list. */
  failWith: number | null = null;
  failCount = 0;

  reset(): void {
    this.revisions = ['r1'];
    this.requests = 0;
    this.pageSize = 200;
    this.failWith = null;
    this.failCount = 0;
  }

  add(id: string): void {
    this.revisions.push(id);
  }
}

const drive = new FakeRevisions();
let server: http.Server;

async function startFakeDrive(): Promise<string> {
  server = http.createServer((req, res) => {
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    drive.requests += 1;

    if (drive.failCount > 0 && drive.failWith !== null) {
      drive.failCount -= 1;
      const code = drive.failWith;
      send(code, { error: { code, message: 'fake failure', status: 'FAILED' } });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://fake');
    const offset = Number(url.searchParams.get('pageToken') ?? '0');
    const size = Math.min(Number(url.searchParams.get('pageSize') ?? drive.pageSize), drive.pageSize);
    const page = drive.revisions.slice(offset, offset + size);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < drive.revisions.length;

    send(200, {
      revisions: page.map((id) => ({ id })),
      ...(hasMore ? { nextPageToken: String(nextOffset) } : {}),
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/`;
}

describe('revision watcher', () => {
  let RevisionWatcher: typeof import('./revisions.js')['RevisionWatcher'];
  let auth: import('google-auth-library').OAuth2Client;

  before(async () => {
    process.env.GOOGLE_DRIVE_ROOT_URL = await startFakeDrive();
    ({ RevisionWatcher } = await import('./revisions.js'));
    const { google } = await import('googleapis');
    auth = new google.auth.OAuth2('id', 'secret', 'http://localhost/cb');
    auth.setCredentials({ access_token: 'fake-access-token' });
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const watcher = (): InstanceType<typeof RevisionWatcher> =>
    new RevisionWatcher(auth, 'fake-doc', { pollsPerMinute: 6_000 });

  it('reports the same mark while nothing changes', async () => {
    drive.reset();
    const w = watcher();
    const first = await w.observe();
    assert.ok(first);
    assert.equal(await w.observe(), first);
  });

  it('reports a different mark once a new revision lands', async () => {
    drive.reset();
    const w = watcher();
    const before = await w.observe();
    drive.add('r2');
    const after = await w.observe();
    assert.notEqual(after, before);
  });

  it('ends a wait as soon as the revision appears, and says how long it took', async () => {
    drive.reset();
    const w = watcher();
    const baseline = await w.observe();
    assert.ok(baseline);

    const slept: number[] = [];
    setTimeout(() => drive.add('r2'), 40);
    const waited = await w.waitForChange(baseline, 5_000, 20, AbortSignal.timeout(4_000), (ms) =>
      void slept.push(ms),
    );

    assert.ok(waited !== null, 'the watcher never saw the new revision');
    assert.ok(waited < 1_000, `waited ${waited}ms for a revision that landed after 40ms`);
    // Every sleep is reported as it is taken, so a caller's countdown stays
    // truthful while the poll loop is running rather than jumping at the end.
    assert.equal(
      slept.reduce((sum, ms) => sum + ms, 0),
      waited,
    );
    assert.equal(w.confirmedCount, 1);
  });

  it('gives up at the budget rather than reporting a revision that never came', async () => {
    drive.reset();
    const w = watcher();
    const baseline = await w.observe();
    assert.ok(baseline);

    const waited = await w.waitForChange(baseline, 120, 20, AbortSignal.timeout(4_000), () => {});
    assert.equal(waited, null, 'a gap must run its full length when nothing was observed');
    assert.equal(w.confirmedCount, 0);
  });

  it('switches itself off for a document whose revisions it may not read', async () => {
    // The paste-a-link path: the app holds `documents` for the file but was
    // never granted `drive.file` for it, so Drive answers 403 forever. Asking
    // again every five seconds for the rest of a four-hour job would be a
    // waste; worse, treating the failure as "no change" and then as "changed"
    // when a later call succeeds differently would be a false confirmation.
    drive.reset();
    drive.failWith = 403;
    drive.failCount = 1;

    const w = watcher();
    assert.equal(await w.observe(), null);
    assert.equal(w.usable, false);
    assert.match(w.offReason ?? '', /403/);

    const requestsBefore = drive.requests;
    assert.equal(await w.observe(), null);
    assert.equal(drive.requests, requestsBefore, 'a disabled watcher must stop making requests');
  });

  it('rides out a blip but gives up on a sustained outage', async () => {
    drive.reset();
    drive.failWith = 500;
    drive.failCount = 1;

    const w = watcher();
    assert.equal(await w.observe(), null, 'a failed poll has no opinion');
    assert.equal(w.usable, true, 'one 500 is not a reason to stop watching');
    assert.ok(await w.observe(), 'the next poll should succeed again');

    drive.failCount = 3;
    for (let i = 0; i < 3; i++) await w.observe();
    assert.equal(w.usable, false, 'three failures in a row means Drive is not answering');
  });

  it('walks a long history once, then polls only the tail', async () => {
    drive.reset();
    drive.pageSize = 10;
    drive.revisions = Array.from({ length: 95 }, (_, i) => `r${i + 1}`);

    const w = watcher();
    await w.observe();
    const walked = drive.requests;
    assert.ok(walked >= 10, `expected a full walk of the history, made ${walked} requests`);

    // Steady state has to be cheap, or a long job spends its savings on polls.
    drive.requests = 0;
    const mark = await w.observe();
    assert.equal(drive.requests, 1, 'a poll after the first should read one page');

    drive.add('r96');
    assert.notEqual(await w.observe(), mark, 'a new revision on the tail page must still register');
  });

  it('counts revisions, not just the last id, so a pruned history still reads as changed', async () => {
    // Drive merges and prunes revisions on its own. A mark built only from the
    // last id would be blind to a change that replaced the tail without
    // appending, which would strand a job waiting out full gaps for no reason.
    drive.reset();
    const w = watcher();
    const before = await w.observe();
    drive.revisions = ['r1', 'r2'];
    assert.notEqual(await w.observe(), before);
  });
});
