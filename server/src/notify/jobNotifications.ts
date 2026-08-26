import { parseCredits } from '../billing/amount.js';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { emailEnabled, sendEmail } from './mailer.js';
import { channelsFor, notifiableOutcome } from './policy.js';
import { renderJobEmail } from './render.js';

/**
 * Tells a user their job ended.
 *
 * Only the email half lives here. The browser half is the client's — a
 * notification can only be raised by a page that is open, so the browser
 * pings off the SSE `done` / `error` events the stream already carries and
 * this server does nothing for it beyond storing the preference.
 *
 * Called from `finishJob`, which every terminal transition goes through, and
 * from the boot sweep that fails jobs a restart orphaned. Both call it
 * fire-and-forget: the document is written and the credits are settled by the
 * time this runs, and a slow mail provider must not hold up the `done` event
 * the browser is waiting on.
 */

interface ClaimedJob {
  status: string;
  doc_url: string | null;
  total_chars: number;
  chars_written: number;
  error_message: string | null;
  credits_spent: string | number;
  email: string;
  name: string | null;
  notify_email_done: boolean;
  notify_email_failed: boolean;
}

/**
 * Claims the right to announce this job, and returns what to say — or null if
 * there is nothing to announce.
 *
 * The claim and the read are one statement on purpose. Several paths mark a
 * job finished and more than one can fire for the same job: the runner's
 * failure path and the queue's last-resort catch both call `finishJob`, and a
 * restart mid-flight adds the boot sweep. Credits survive that because
 * `settleJobCredits` is idempotent. An email has no such property, so the
 * `notified_at IS NULL` predicate is what makes "send once" a fact about the
 * database rather than a hope about the call sites.
 */
async function claim(jobId: string): Promise<ClaimedJob | null> {
  const { rows } = await query<ClaimedJob>(
    `UPDATE jobs
        SET notified_at = NOW()
       FROM users
      WHERE jobs.id = $1
        AND jobs.user_id = users.id
        AND jobs.notified_at IS NULL
        AND jobs.status IN ('done', 'failed')
     RETURNING jobs.status, jobs.doc_url, jobs.total_chars, jobs.chars_written,
               jobs.error_message, jobs.credits_spent,
               users.email, users.name,
               users.notify_email_done, users.notify_email_failed`,
    [jobId],
  );
  return rows[0] ?? null;
}

export async function notifyJobFinished(jobId: string): Promise<void> {
  // Nothing to claim on a deploy that cannot send mail. Checked before the
  // database is touched so a laptop, the test suite and a self-hosted instance
  // run exactly as they did before notifications existed.
  if (!emailEnabled()) return;

  let job: ClaimedJob | null;
  try {
    job = await claim(jobId);
  } catch (error) {
    console.error(`[notify] could not claim job ${jobId} for notification:`, error);
    return;
  }
  if (!job) return;

  const outcome = notifiableOutcome(job.status);
  if (!outcome) return;

  const wanted = channelsFor(outcome, {
    emailOnDone: job.notify_email_done,
    emailOnFailure: job.notify_email_failed,
    // The browser pair is not consulted here and is not read by the query.
    // Whether a notification is raised in a browser is decided in that
    // browser, by a page that may not exist.
    browserOnDone: false,
    browserOnFailure: false,
  });
  if (!wanted.email) return;

  const { subject, text, html } = renderJobEmail({
    outcome,
    recipientName: job.name,
    docUrl: job.doc_url,
    totalChars: job.total_chars,
    charsWritten: job.chars_written,
    errorMessage: job.error_message,
    creditsSpent: parseCredits(job.credits_spent),
    appUrl: config.clientUrl,
    operator: config.legal.operator,
    supportEmail: config.legal.contactEmail,
  });

  const sent = await sendEmail({ to: job.email, subject, text, html });
  if (!sent) {
    // The claim stays claimed. There is no retry loop to hand this back to,
    // and re-opening it would only mean the next path through `finishJob` —
    // or the next boot sweep — sending a duplicate of a message that may well
    // have gone out. A logged miss beats a doubled inbox.
    console.error(`[notify] ${outcome} email for job ${jobId} was not delivered`);
  }
}
