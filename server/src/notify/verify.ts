/**
 * Checks that this deploy can actually send a job-finished email.
 *
 * `mailer.ts` never throws — a notification is the least important thing
 * happening when a job ends, so an unreachable provider is logged and
 * swallowed. That is the right behaviour at runtime and a terrible one at
 * setup time: a wrong key, an unverified sending domain and a typo in
 * `MAIL_FROM` all look identical from the outside, which is *nothing
 * happening*, hours later, to a user who has already closed the tab.
 *
 * So the check is a thing you run on purpose:
 *
 *   npm run mail:verify -w server                 # read the settings
 *   npm run mail:verify -w server -- --send you@example.org
 *
 * The first half is pure and reads an env object handed to it — same
 * discipline as `launchChecks.ts` — so the rules are testable without a mail
 * provider. The second half is the only part that proves anything about the
 * provider: domain verification is a fact about DNS that no amount of reading
 * variables can establish, and the provider's rejection message is the only
 * thing that distinguishes "bad key" from "unverified domain".
 */
import { config } from '../config.js';
import { sendEmail } from './mailer.js';
import { renderJobEmail } from './render.js';
import type { NotifiableOutcome } from './policy.js';

export type MailCheckStatus = 'ok' | 'warn' | 'fail';

export interface MailCheck {
  /** Environment variable at fault, or a short label when it is not one. */
  subject: string;
  status: MailCheckStatus;
  detail: string;
}

export interface MailConfigReport {
  /** What `config.notifications.emailEnabled` will say: both key and sender present. */
  enabled: boolean;
  /** Domain of the sender address, which is the domain that must be verified. */
  fromDomain: string | null;
  checks: MailCheck[];
}

/** Trimmed value, or undefined when unset or whitespace. */
function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const trimmed = env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Pulls the bare address out of `MAIL_FROM`.
 *
 * Both `notifications@example.org` and `TurtleType <notifications@example.org>`
 * are valid to every provider that speaks this shape, so both are accepted
 * here and the second is the one worth using — a display name is the
 * difference between "notifications@" and "TurtleType" in an inbox list.
 */
export function parseAddress(raw: string): string | null {
  const angled = raw.match(/<([^>]+)>\s*$/)?.[1];
  const address = (angled ?? raw).trim();
  return ADDRESS.test(address) ? address : null;
}

/**
 * Domains that are reserved, or that appear in this repo's own examples.
 *
 * Copying the sender straight out of `.env.example` is the single most likely
 * way to end up configured-looking and undeliverable, because the provider
 * will reject every send from a domain nobody has verified — and it rejects it
 * at send time, which is to say silently, hours after the user submitted a job.
 */
const PLACEHOLDER_DOMAINS = ['example.com', 'example.org', 'example.net', 'your-domain.org', 'your-domain.com'];

const RESEND_HOSTS = ['api.resend.com'];

/**
 * Reads the mail settings and says what is wrong with them.
 *
 * Pure: `env` in, findings out. Nothing here proves a send will succeed — see
 * the note at the top of the file — it rules out the failures that are visible
 * without one.
 */
export function checkMailConfig(env: NodeJS.ProcessEnv): MailConfigReport {
  const checks: MailCheck[] = [];

  const apiKey = value(env, 'MAIL_API_KEY');
  const from = value(env, 'MAIL_FROM');
  const enabled = Boolean(apiKey && from);

  const apiUrl = value(env, 'MAIL_API_URL') ?? 'https://api.resend.com/emails';
  let endpoint: URL | null = null;
  try {
    endpoint = new URL(apiUrl);
  } catch {
    endpoint = null;
  }

  // --- the two that decide whether email exists at all --------------------

  if (!apiKey) {
    checks.push({
      subject: 'MAIL_API_KEY',
      status: 'fail',
      detail:
        'Not set, so email notifications are off entirely and every job finishes quietly. ' +
        'Create a key at your provider (Resend: API Keys, with Sending access) and set it.',
    });
  } else if (endpoint && RESEND_HOSTS.includes(endpoint.hostname) && !apiKey.startsWith('re_')) {
    // Soft, because a compatible provider reached through Resend's URL is
    // nobody's plan but is not impossible, and the shape is not documented as
    // stable. Still worth saying: a key pasted from the wrong dashboard field
    // (a webhook signing secret, a publishable id) is a common first mistake.
    checks.push({
      subject: 'MAIL_API_KEY',
      status: 'warn',
      detail:
        `The endpoint is Resend but the key does not start with "re_". Check you copied an API ` +
        'key rather than another value from the dashboard.',
    });
  } else {
    checks.push({ subject: 'MAIL_API_KEY', status: 'ok', detail: 'Set.' });
  }

  const fromAddress = from ? parseAddress(from) : null;
  // The regex above guarantees an @, so the second half is always there.
  const fromDomain = fromAddress ? (fromAddress.split('@')[1] ?? '').toLowerCase() : null;

  if (!from) {
    checks.push({
      subject: 'MAIL_FROM',
      status: 'fail',
      detail:
        'Not set, so email notifications are off entirely. It must be an address on a domain ' +
        'you have verified with the provider — there is no honest default, and an invented ' +
        'sender is rejected at send time rather than at boot.',
    });
  } else if (!fromAddress) {
    checks.push({
      subject: 'MAIL_FROM',
      status: 'fail',
      detail:
        `"${from}" is not an address the provider will accept. Use either ` +
        '"notifications@your-domain.org" or "TurtleType <notifications@your-domain.org>".',
    });
  } else if (fromDomain && PLACEHOLDER_DOMAINS.includes(fromDomain)) {
    checks.push({
      subject: 'MAIL_FROM',
      status: 'fail',
      detail:
        `The sender is still on the placeholder domain "${fromDomain}" from .env.example. ` +
        'Nobody has verified it, so every send is rejected — and rejected quietly, because the ' +
        'mailer never throws. Use a domain you control.',
    });
  } else {
    checks.push({
      subject: 'MAIL_FROM',
      status: from.includes('<') ? 'ok' : 'warn',
      detail: from.includes('<')
        ? `Sending as ${from}. The domain that must be verified with the provider is ${fromDomain}.`
        : `Sending as ${fromAddress}, with no display name — inboxes will show the raw address. ` +
          `"TurtleType <${fromAddress}>" reads better. Verified domain: ${fromDomain}.`,
    });
  }

  // --- where the send goes -------------------------------------------------

  if (!endpoint) {
    checks.push({
      subject: 'MAIL_API_URL',
      status: 'fail',
      detail: `"${apiUrl}" is not a URL, so every send fails before it leaves the process.`,
    });
  } else if (endpoint.hostname === 'localhost' || endpoint.hostname.startsWith('127.')) {
    // This is how the test suite works, and it is exactly what you do not want
    // to discover on a deploy: mail that appears to send and lands in a fake.
    checks.push({
      subject: 'MAIL_API_URL',
      status: 'warn',
      detail:
        `Points at ${endpoint.origin}, which is a local fake rather than a provider. Correct for ` +
        'tests, wrong for anything anyone is expected to receive.',
    });
  } else if (endpoint.protocol !== 'https:') {
    checks.push({
      subject: 'MAIL_API_URL',
      status: 'fail',
      detail: `${endpoint.origin} is not HTTPS — the API key would go out in clear text.`,
    });
  } else {
    checks.push({
      subject: 'MAIL_API_URL',
      status: 'ok',
      detail: value(env, 'MAIL_API_URL') ? `Sending through ${apiUrl}.` : `Default (${apiUrl}).`,
    });
  }

  // --- where a reply lands -------------------------------------------------

  const replyTo = value(env, 'MAIL_REPLY_TO');
  const support = value(env, 'SUPPORT_EMAIL');
  const effectiveReply = replyTo ?? support;

  if (replyTo && !parseAddress(replyTo)) {
    checks.push({
      subject: 'MAIL_REPLY_TO',
      status: 'fail',
      detail: `"${replyTo}" is not an address. Unset it to fall back to SUPPORT_EMAIL.`,
    });
  } else if (!replyTo && !support) {
    // config.legal.contactEmail has a real default, so this is informational
    // rather than broken — but a reply going to a mailbox nobody reads is the
    // same as no reply address at all.
    checks.push({
      subject: 'MAIL_REPLY_TO',
      status: 'warn',
      detail:
        'Neither MAIL_REPLY_TO nor SUPPORT_EMAIL is set, so replies go to the built-in default ' +
        'support address. Make sure somebody reads that mailbox, or set one of the two.',
    });
  } else {
    checks.push({
      subject: 'MAIL_REPLY_TO',
      status: 'ok',
      detail: `Replies go to ${effectiveReply}${replyTo ? '' : ' (from SUPPORT_EMAIL)'}.`,
    });
  }

  // --- the one link in the message ----------------------------------------

  const clientUrl = value(env, 'CLIENT_URL');
  if (!clientUrl || !/^https?:\/\//i.test(clientUrl)) {
    checks.push({
      subject: 'CLIENT_URL',
      status: 'warn',
      detail:
        'Not an http(s) URL, so render.ts drops the "turn these emails off" link rather than ' +
        'emitting a broken one. Every notification should carry a way to switch it off.',
    });
  } else if (/localhost|127\.0\.0\.1/.test(clientUrl)) {
    checks.push({
      subject: 'CLIENT_URL',
      status: 'warn',
      detail: `The unsubscribe link would point at ${clientUrl}, which only opens on this machine.`,
    });
  } else {
    checks.push({ subject: 'CLIENT_URL', status: 'ok', detail: `Unsubscribe link: ${clientUrl}/app.` });
  }

  // --- how long a send may take -------------------------------------------

  const rawTimeout = value(env, 'MAIL_TIMEOUT_MS');
  if (rawTimeout !== undefined) {
    const timeout = Number(rawTimeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      checks.push({
        subject: 'MAIL_TIMEOUT_MS',
        status: 'fail',
        detail: `"${rawTimeout}" is not a positive number of milliseconds.`,
      });
    } else if (timeout < 2_000) {
      checks.push({
        subject: 'MAIL_TIMEOUT_MS',
        status: 'warn',
        detail: `${timeout}ms will abandon sends the provider would have accepted.`,
      });
    } else {
      checks.push({ subject: 'MAIL_TIMEOUT_MS', status: 'ok', detail: `${timeout}ms per send.` });
    }
  }

  return { enabled, fromDomain, checks };
}

/**
 * Sends one real notification, using the same renderer a finished job uses.
 *
 * Deliberately not a "test message": what you want to look at is the thing
 * users get — the subject line in a list, whether the button renders, whether
 * the footer address is the one you meant. Figures are plausible rather than
 * round for the same reason.
 */
export async function sendSampleEmail(to: string, outcome: NotifiableOutcome): Promise<boolean> {
  const { subject, text, html } = renderJobEmail({
    outcome,
    recipientName: null,
    docUrl: 'https://docs.google.com/document/d/EXAMPLE_DOCUMENT_ID/edit',
    totalChars: 5_490,
    charsWritten: outcome === 'done' ? 5_490 : 2_137,
    errorMessage: outcome === 'done' ? null : 'Google rejected the write: the document was deleted.',
    creditsSpent: 1,
    appUrl: config.clientUrl,
    operator: config.legal.operator,
    supportEmail: config.legal.contactEmail,
  });
  return sendEmail({ to, subject, text, html });
}

function parseArgs(argv: string[]): { send: string | null } {
  const index = argv.findIndex((arg) => arg === '--send' || arg.startsWith('--send='));
  if (index === -1) return { send: null };
  const flag = argv[index] ?? '';
  const inline = flag.startsWith('--send=') ? flag.slice('--send='.length) : argv[index + 1];
  return { send: inline?.trim() || '' };
}

async function main(): Promise<void> {
  const { send } = parseArgs(process.argv.slice(2));
  const report = checkMailConfig(process.env);

  const icon: Record<MailCheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  console.log('TurtleType email check\n');
  for (const check of report.checks) {
    console.log(`[${icon[check.status]}] ${check.subject}`);
    console.log(`         ${check.detail}`);
  }

  const failures = report.checks.filter((c) => c.status === 'fail');
  const warnings = report.checks.filter((c) => c.status === 'warn');
  console.log('');

  if (!report.enabled) {
    console.log(
      'Email notifications are OFF. Jobs still run and browser notifications still work; nobody ' +
        'is told when a job ends with the tab closed. See docs/email-setup.md.',
    );
    process.exitCode = 1;
    return;
  }

  if (failures.length > 0) {
    console.log(`${failures.length} problem(s) above would stop mail from arriving.`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Settings look right${warnings.length > 0 ? `, with ${warnings.length} warning(s)` : ''}. ` +
      'Nothing here proves the sending domain is verified — only a send does.',
  );

  if (send === null) {
    console.log('\nRun with --send you@example.org to send yourself a real finished-job email.');
    return;
  }

  if (!send || !parseAddress(send)) {
    console.error(`\n"${send}" is not an address to send to. Use --send you@example.org.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nSending a sample "done" notification to ${send}…`);
  // sendEmail logs the provider's own rejection verbatim, which is the only
  // thing that separates a bad key from an unverified domain, so there is
  // nothing useful to add to it here.
  const ok = await sendSampleEmail(send, 'done');
  if (!ok) {
    console.error(
      'The provider did not accept it. The line above is its own message — "domain is not ' +
        'verified" means the DNS records are missing or not propagated; anything about the key ' +
        'means the key. See docs/email-setup.md.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    'Accepted by the provider. Check the inbox — and check the spam folder, because a first send ' +
      'from a new domain with no DMARC record often lands there.',
  );
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isDirectRun) {
  main().catch((error) => {
    console.error('Verification failed to run:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
