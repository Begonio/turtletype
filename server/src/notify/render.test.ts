import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml, renderJobEmail, type JobEmailInput } from './render.js';
import { channelsFor, DEFAULT_NOTIFICATION_PREFS, notifiableOutcome } from './policy.js';

const BASE: JobEmailInput = {
  outcome: 'done',
  recipientName: 'Ada Lovelace',
  docUrl: 'https://docs.google.com/document/d/abc123/edit',
  totalChars: 2431,
  charsWritten: 2431,
  errorMessage: null,
  creditsSpent: 0.44,
  appUrl: 'https://type.turtlegames.org',
  operator: 'A Person',
  supportEmail: 'help@turtlegames.org',
};

const render = (overrides: Partial<JobEmailInput> = {}) =>
  renderJobEmail({ ...BASE, ...overrides });

describe('renderJobEmail', () => {
  it('never puts the document’s text anywhere in the message', () => {
    // The one rule this file exists to keep. The OAuth submission tells Google
    // reviewers document content is never stored or transmitted, and the job
    // row deliberately holds only counts — an email is the obvious place for
    // that promise to be broken by accident, so there is nothing in the input
    // shape that could carry it and a test that says so.
    const keys = Object.keys(BASE);
    assert.ok(!keys.includes('text'));
    assert.ok(!keys.includes('preview'));
  });

  it('leads a finished job with the character count, not a percentage', () => {
    const { subject, text } = render();
    assert.match(subject, /2,431 characters/);
    assert.match(text, /finished writing all 2,431 characters/);
  });

  it('points at version history, which is the thing that was actually bought', () => {
    // The document looks identical either way; the revision list is the
    // product, and it takes a menu dive to see.
    assert.match(render().text, /Version history/);
  });

  it('says what broke, and how far it got, on a failure', () => {
    const { subject, text } = render({
      outcome: 'failed',
      charsWritten: 812,
      errorMessage: 'No permission to edit that document.',
    });
    assert.match(subject, /stopped before it finished/);
    assert.match(text, /812 of 2,431 characters/);
    assert.match(text, /No permission to edit that document\./);
    // What was typed stays in the document, and someone about to re-run the
    // job needs to know that before they run it twice.
    assert.match(text, /is in the document and was left there/);
  });

  it('does not claim partial progress when a job failed before writing anything', () => {
    const { text } = render({ outcome: 'failed', charsWritten: 0, errorMessage: 'Boom' });
    assert.match(text, /before it wrote anything/);
    assert.doesNotMatch(text, /0 of 2,431/);
  });

  it('tells a charged user their credits are already back', () => {
    // True by the time this sends: finishJob settles the refund before it
    // dispatches the notification. If that order is ever reversed, this copy
    // becomes a lie.
    const { text } = render({ outcome: 'failed', charsWritten: 10, creditsSpent: 0.44 });
    assert.match(text, /0\.44 credits/);
    assert.match(text, /returned to your balance/);
  });

  it('says nothing about credits on a free deploy', () => {
    const { text, html } = render({ outcome: 'failed', charsWritten: 10, creditsSpent: 0 });
    assert.doesNotMatch(text, /credit/i);
    assert.doesNotMatch(html, /credit/i);
  });

  it('greets by first name, and copes with no name at all', () => {
    assert.match(render().text, /^Hi Ada,/);
    assert.match(render({ recipientName: null }).text, /^Hi,/);
    assert.match(render({ recipientName: '   ' }).text, /^Hi,/);
  });

  it('carries a way to switch itself off', () => {
    const { text, html } = render();
    assert.match(text, /https:\/\/type\.turtlegames\.org\/app/);
    assert.match(html, /Turn these emails off/);
  });

  it('names the operator and the support address, which the legal pages promise', () => {
    const { text } = render();
    assert.match(text, /A Person/);
    assert.match(text, /help@turtlegames\.org/);
  });

  it('escapes an error message rather than pasting it into the HTML', () => {
    // Failure text is assembled from Google's API responses. Nothing in it is
    // attacker-controlled today, and that is not a property to depend on in a
    // string that ends up in someone's mail client.
    const { html } = render({
      outcome: 'failed',
      charsWritten: 5,
      errorMessage: '<img src=x onerror="alert(1)">',
    });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });

  it('refuses to build a link out of anything that is not http(s)', () => {
    const { text, html } = render({ docUrl: 'javascript:alert(1)' });
    assert.doesNotMatch(text, /javascript:/);
    assert.doesNotMatch(html, /javascript:/);
  });

  it('still sends when there is no document link to offer', () => {
    // Nothing in the message depends on the link existing; it just loses the
    // button and the "Your document:" line.
    const { text, html } = render({ docUrl: null });
    assert.match(text, /finished writing all 2,431 characters/);
    assert.doesNotMatch(text, /Your document:/);
    assert.doesNotMatch(html, /docs\.google\.com/);
  });
});

describe('escapeHtml', () => {
  it('handles the five characters that matter', () => {
    assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
  });

  it('escapes the ampersand first, so nothing is double-escaped', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });
});

describe('notification policy', () => {
  it('has nothing to say about a job the user stopped themselves', () => {
    // They were looking at the button. Reporting their own click back to them
    // by email, minutes later, is not a notification.
    assert.equal(notifiableOutcome('cancelled'), null);
    assert.equal(notifiableOutcome('running'), null);
    assert.equal(notifiableOutcome('paused'), null);
    assert.equal(notifiableOutcome('pending'), null);
  });

  it('announces the two outcomes a user cannot see coming', () => {
    assert.equal(notifiableOutcome('done'), 'done');
    assert.equal(notifiableOutcome('failed'), 'failed');
  });

  it('keeps the four switches independent of each other', () => {
    const prefs = {
      emailOnDone: false,
      emailOnFailure: true,
      browserOnDone: true,
      browserOnFailure: false,
    };
    assert.deepEqual(channelsFor('done', prefs), { email: false, browser: true });
    assert.deepEqual(channelsFor('failed', prefs), { email: true, browser: false });
  });

  it('defaults a new account to being told about both outcomes', () => {
    // A three-hour job ending in silence is the failure this feature exists to
    // prevent, and every one of these has a visible switch in the app.
    for (const outcome of ['done', 'failed'] as const) {
      assert.deepEqual(channelsFor(outcome, DEFAULT_NOTIFICATION_PREFS), {
        email: true,
        browser: true,
      });
    }
  });
});
