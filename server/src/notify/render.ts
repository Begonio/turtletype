import { formatCreditsWithUnit } from '../billing/amount.js';
import type { NotifiableOutcome } from './policy.js';

/**
 * The words in a job-finished email.
 *
 * Pure, and separated from the thing that sends it, so the copy can be read in
 * a test rather than in an inbox.
 *
 * **The document's text is never in here, and must never be.** The OAuth
 * verification submission tells Google reviewers that document content is
 * never stored or transmitted anywhere but the user's own document, and that
 * is the strongest claim in it — `jobs` holds an id, a character count and a
 * status, deliberately. An email quoting the first line of what was written
 * would break that claim, not merely the taste of it. Counts, a status and a
 * link to the user's own document are the whole vocabulary available here.
 */

export interface JobEmailInput {
  outcome: NotifiableOutcome;
  /** Display name from the Google profile, when there is one. */
  recipientName: string | null;
  docUrl: string | null;
  totalChars: number;
  charsWritten: number;
  /** Failure reason, already phrased for a human by the runner. */
  errorMessage: string | null;
  /** Credits the job cost, and therefore what a failure has just paid back. */
  creditsSpent: number;
  /** Origin of the app itself, for the "manage these emails" link. */
  appUrl: string;
  /** Who operates the service, as the legal pages name them. */
  operator: string;
  supportEmail: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Minimal HTML escape. Everything interpolated into the HTML body goes through it. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A URL safe to put in an href.
 *
 * Document URLs are built by this server from a document id, so they are
 * already ours — but this function is the one place a link is emitted, and an
 * `href` that will accept `javascript:` because nothing checked is a footgun
 * left lying about for whoever adds the next link.
 */
function safeUrl(url: string | null): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

function greeting(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `Hi ${first},` : 'Hi,';
}

export function renderJobEmail(input: JobEmailInput): RenderedEmail {
  const docUrl = safeUrl(input.docUrl);
  const written = input.charsWritten.toLocaleString('en-US');
  const total = input.totalChars.toLocaleString('en-US');
  const manageUrl = safeUrl(`${input.appUrl.replace(/\/$/, '')}/app`);

  const subject =
    input.outcome === 'done'
      ? `Your document is finished (${total} characters)`
      : 'Your TurtleType job stopped before it finished';

  const lines: string[] = [greeting(input.recipientName), ''];

  if (input.outcome === 'done') {
    lines.push(
      `TurtleType has finished writing all ${total} characters into your Google Doc.`,
      '',
      // Worth saying, because it is the entire product and it is invisible
      // from the document itself — you have to go and open File → Version
      // history to see what was actually bought.
      'Open the document and check File → Version history: the text should be there in ' +
        'separate revisions with real gaps between them, the way a person writing it would ' +
        'have left it.',
    );
  } else {
    lines.push(
      input.charsWritten > 0
        ? `Your job stopped after writing ${written} of ${total} characters. ` +
            'Everything it had typed by then is in the document and was left there.'
        : `Your job stopped before it wrote anything. Nothing was added to the document.`,
    );
    if (input.errorMessage) {
      lines.push('', `What went wrong: ${input.errorMessage}`);
    }
    if (input.creditsSpent > 0) {
      lines.push(
        '',
        `The ${formatCreditsWithUnit(input.creditsSpent)} this job cost have been returned to ` +
          'your balance automatically — a job that fails is never charged for.',
      );
    }
  }

  if (docUrl) {
    lines.push('', `Your document: ${docUrl}`);
  }

  lines.push(
    '',
    '—',
    `${input.operator} · TurtleType`,
    `Questions: ${input.supportEmail}`,
  );
  if (manageUrl) {
    lines.push(`Turn these emails off: ${manageUrl}`);
  }

  return { subject, text: lines.join('\n'), html: renderHtml(input, { subject, docUrl, manageUrl }) };
}

/**
 * The HTML half.
 *
 * Deliberately plain: a table-free, inline-styled block that degrades to
 * something readable in any client. Nothing here is loaded from a remote host,
 * so no image proxy or blocked-content bar gets in the way of a two-line
 * message.
 */
function renderHtml(
  input: JobEmailInput,
  context: { subject: string; docUrl: string | null; manageUrl: string | null },
): string {
  const written = escapeHtml(input.charsWritten.toLocaleString('en-US'));
  const total = escapeHtml(input.totalChars.toLocaleString('en-US'));
  const accent = input.outcome === 'done' ? '#16a34a' : '#dc2626';
  const heading =
    input.outcome === 'done' ? 'Your document is finished' : 'Your job stopped before it finished';

  const body: string[] = [];

  if (input.outcome === 'done') {
    body.push(
      `<p style="margin:0 0 16px">TurtleType has finished writing all <strong>${total}</strong> ` +
        'characters into your Google Doc.</p>',
      '<p style="margin:0 0 16px">Open the document and check <strong>File → Version history</strong>: ' +
        'the text should be there in separate revisions with real gaps between them, the way a ' +
        'person writing it would have left it.</p>',
    );
  } else {
    body.push(
      input.charsWritten > 0
        ? `<p style="margin:0 0 16px">Your job stopped after writing <strong>${written}</strong> of ` +
            `${total} characters. Everything it had typed by then is in the document and was ` +
            'left there.</p>'
        : '<p style="margin:0 0 16px">Your job stopped before it wrote anything. Nothing was ' +
            'added to the document.</p>',
    );
    if (input.errorMessage) {
      body.push(
        `<p style="margin:0 0 16px;padding:12px 14px;border-left:3px solid ${accent};` +
          `background:#f8f8f7;color:#3f3f46">${escapeHtml(input.errorMessage)}</p>`,
      );
    }
    if (input.creditsSpent > 0) {
      body.push(
        `<p style="margin:0 0 16px">The <strong>${escapeHtml(
          formatCreditsWithUnit(input.creditsSpent),
        )}</strong> this job cost have been returned to your balance automatically — a job that ` +
          'fails is never charged for.</p>',
      );
    }
  }

  if (context.docUrl) {
    body.push(
      `<p style="margin:24px 0"><a href="${escapeHtml(context.docUrl)}" ` +
        `style="display:inline-block;padding:10px 18px;border-radius:8px;background:${accent};` +
        'color:#ffffff;text-decoration:none;font-weight:600">Open the document</a></p>',
    );
  }

  const footer = [
    `<p style="margin:0 0 4px">${escapeHtml(input.operator)} · TurtleType</p>`,
    `<p style="margin:0 0 4px">Questions: <a href="mailto:${escapeHtml(input.supportEmail)}" ` +
      `style="color:#6b7280">${escapeHtml(input.supportEmail)}</a></p>`,
  ];
  if (context.manageUrl) {
    footer.push(
      `<p style="margin:0"><a href="${escapeHtml(context.manageUrl)}" style="color:#6b7280">` +
        'Turn these emails off</a></p>',
    );
  }

  return [
    '<div style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,' +
      '\'Segoe UI\',Helvetica,Arial,sans-serif;color:#18181b">',
    '<div style="max-width:520px;margin:0 auto;padding:28px;background:#ffffff;border-radius:12px;' +
      'line-height:1.55;font-size:15px">',
    `<h1 style="margin:0 0 20px;font-size:19px;color:${accent}">${escapeHtml(heading)}</h1>`,
    `<p style="margin:0 0 16px">${escapeHtml(greeting(input.recipientName))}</p>`,
    ...body,
    '<hr style="margin:28px 0 16px;border:0;border-top:1px solid #e4e4e7">',
    `<div style="font-size:12px;color:#6b7280">${footer.join('')}</div>`,
    '</div>',
    '</div>',
  ].join('');
}
