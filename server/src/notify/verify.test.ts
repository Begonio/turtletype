/**
 * The rules `npm run mail:verify -w server` applies.
 *
 * Worth testing because of what this check is for. Every failure it names is
 * one that is *invisible at runtime*: `mailer.ts` never throws, so a wrong key
 * and an unverified sending domain both present as a job that finishes and
 * nobody hearing about it, hours later, with the tab already closed. A rule
 * that only fires in that situation is a rule nobody notices is broken.
 *
 * Pure, so this needs no provider and no database — same reason
 * `launchChecks.test.ts` needs neither.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.GOOGLE_CALLBACK_URL ??= 'http://localhost:8080/auth/google/callback';
process.env.SESSION_SECRET ??= 'test-session-secret';

const { checkMailConfig, parseAddress } = await import('./verify.js');

/** A deploy that can send: real-looking domain, https endpoint, live app URL. */
const CONFIGURED: NodeJS.ProcessEnv = {
  MAIL_API_KEY: 're_test_abc',
  MAIL_FROM: 'TurtleType <notifications@turtlegames.org>',
  SUPPORT_EMAIL: 'help@turtlegames.org',
  CLIENT_URL: 'https://type.turtlegames.org',
};

const statusOf = (env: NodeJS.ProcessEnv, subject: string) =>
  checkMailConfig(env).checks.find((check) => check.subject === subject)?.status;

const failures = (env: NodeJS.ProcessEnv) =>
  checkMailConfig(env)
    .checks.filter((check) => check.status === 'fail')
    .map((check) => check.subject);

describe('parseAddress', () => {
  it('accepts both shapes a provider accepts', () => {
    assert.equal(parseAddress('notifications@turtlegames.org'), 'notifications@turtlegames.org');
    assert.equal(
      parseAddress('TurtleType <notifications@turtlegames.org>'),
      'notifications@turtlegames.org',
    );
  });

  it('rejects what would be rejected at send time', () => {
    for (const junk of ['', 'turtlegames.org', 'notifications@localhost', 'a b@c.org', '<@>']) {
      assert.equal(parseAddress(junk), null, `expected ${JSON.stringify(junk)} to be rejected`);
    }
  });
});

describe('checkMailConfig', () => {
  it('passes a configured deploy with no failures', () => {
    const report = checkMailConfig(CONFIGURED);
    assert.equal(report.enabled, true);
    assert.equal(report.fromDomain, 'turtlegames.org');
    assert.deepEqual(
      report.checks.filter((check) => check.status !== 'ok'),
      [],
    );
  });

  it('reports email as off, not broken, when neither variable is set', () => {
    // The legitimate state on a laptop and a self-hosted box. It is still a
    // failure of *this* command, which was asked to verify sending.
    const report = checkMailConfig({});
    assert.equal(report.enabled, false);
    assert.deepEqual(failures({}), ['MAIL_API_KEY', 'MAIL_FROM']);
  });

  it('is off when only one half is set', () => {
    assert.equal(checkMailConfig({ MAIL_API_KEY: 're_x' }).enabled, false);
    assert.equal(checkMailConfig({ MAIL_FROM: 'a@turtlegames.org' }).enabled, false);
  });

  it('rejects the sender domain from .env.example', () => {
    // The most likely way to be configured-looking and undeliverable: nobody
    // has verified example.org, and the provider says so at send time only.
    const env = { ...CONFIGURED, MAIL_FROM: 'TurtleType <notifications@example.org>' };
    assert.deepEqual(failures(env), ['MAIL_FROM']);
  });

  it('rejects a sender that is not an address', () => {
    assert.deepEqual(failures({ ...CONFIGURED, MAIL_FROM: 'TurtleType' }), ['MAIL_FROM']);
  });

  it('names the domain that has to be verified', () => {
    const report = checkMailConfig(CONFIGURED);
    const from = report.checks.find((check) => check.subject === 'MAIL_FROM');
    assert.match(from?.detail ?? '', /turtlegames\.org/);
  });

  it('notes a bare sender with no display name', () => {
    assert.equal(
      statusOf({ ...CONFIGURED, MAIL_FROM: 'notifications@turtlegames.org' }, 'MAIL_FROM'),
      'warn',
    );
  });

  it('warns when the endpoint is the local fake the tests use', () => {
    const env = { ...CONFIGURED, MAIL_API_URL: 'http://127.0.0.1:5051/emails' };
    assert.equal(statusOf(env, 'MAIL_API_URL'), 'warn');
    assert.deepEqual(failures(env), []);
  });

  it('refuses to send an API key over plain http', () => {
    const env = { ...CONFIGURED, MAIL_API_URL: 'http://mail.example.net/emails' };
    assert.deepEqual(failures(env), ['MAIL_API_URL']);
  });

  it('refuses an endpoint that is not a URL', () => {
    assert.deepEqual(failures({ ...CONFIGURED, MAIL_API_URL: 'resend' }), ['MAIL_API_URL']);
  });

  it('notices a Resend endpoint paired with a key that is not one', () => {
    assert.equal(statusOf({ ...CONFIGURED, MAIL_API_KEY: 'whsec_abc' }, 'MAIL_API_KEY'), 'warn');
  });

  it('leaves the key alone when a different provider is configured', () => {
    // The re_ prefix is Resend's, so it says nothing about anyone else's key.
    const env = { ...CONFIGURED, MAIL_API_KEY: 'xkeysib-abc', MAIL_API_URL: 'https://mail.turtlegames.org/emails' };
    assert.equal(statusOf(env, 'MAIL_API_KEY'), 'ok');
  });

  it('rejects a reply-to that is not an address', () => {
    assert.deepEqual(failures({ ...CONFIGURED, MAIL_REPLY_TO: 'support' }), ['MAIL_REPLY_TO']);
  });

  it('accepts SUPPORT_EMAIL as the reply address', () => {
    const report = checkMailConfig(CONFIGURED);
    const reply = report.checks.find((check) => check.subject === 'MAIL_REPLY_TO');
    assert.equal(reply?.status, 'ok');
    assert.match(reply?.detail ?? '', /help@turtlegames\.org/);
  });

  it('warns when replies would go to the built-in default', () => {
    const { SUPPORT_EMAIL: _omitted, ...env } = CONFIGURED;
    assert.equal(statusOf(env, 'MAIL_REPLY_TO'), 'warn');
  });

  it('warns when the unsubscribe link would be missing or unreachable', () => {
    // render.ts drops a link it cannot make absolute, so an unset CLIENT_URL
    // means a notification with no way to switch it off.
    const { CLIENT_URL: _omitted, ...env } = CONFIGURED;
    assert.equal(statusOf(env, 'CLIENT_URL'), 'warn');
    assert.equal(statusOf({ ...CONFIGURED, CLIENT_URL: 'http://localhost:5173' }, 'CLIENT_URL'), 'warn');
  });

  it('checks the send timeout only when it is set', () => {
    assert.equal(statusOf(CONFIGURED, 'MAIL_TIMEOUT_MS'), undefined);
    assert.deepEqual(failures({ ...CONFIGURED, MAIL_TIMEOUT_MS: 'soon' }), ['MAIL_TIMEOUT_MS']);
    assert.equal(statusOf({ ...CONFIGURED, MAIL_TIMEOUT_MS: '250' }, 'MAIL_TIMEOUT_MS'), 'warn');
    assert.equal(statusOf({ ...CONFIGURED, MAIL_TIMEOUT_MS: '10000' }, 'MAIL_TIMEOUT_MS'), 'ok');
  });

  it('reads the environment it is given and not process.env', () => {
    // Same discipline as launchChecks.ts: the rules have to be checkable
    // without an environment, or they only get checked on a deploy.
    process.env.MAIL_API_KEY = 're_from_process_env';
    process.env.MAIL_FROM = 'TurtleType <notifications@turtlegames.org>';
    try {
      assert.equal(checkMailConfig({}).enabled, false);
    } finally {
      delete process.env.MAIL_API_KEY;
      delete process.env.MAIL_FROM;
    }
  });
});
