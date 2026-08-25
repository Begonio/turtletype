import { config } from '../config.js';

/**
 * Sends one email over a provider's HTTPS API.
 *
 * The payload shape is Resend's (`POST /emails` with a bearer token and a
 * `{ from, to, subject, text, html }` body), which several providers copy;
 * `MAIL_API_URL` points the sender at a different one, and at a local fake in
 * the tests.
 *
 * Nothing here throws. A notification is the least important thing happening
 * at the moment a job ends — the document is written, the credits are settled,
 * the SSE stream has already said so — and an unreachable mail provider must
 * not turn a finished job into an unhandled rejection. Failures are logged and
 * reported as `false`.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** False on a deploy with no mail provider configured, where every send is a no-op. */
export function emailEnabled(): boolean {
  return config.notifications.emailEnabled;
}

export async function sendEmail(email: OutgoingEmail): Promise<boolean> {
  if (!emailEnabled()) return false;

  const body = {
    from: config.notifications.from,
    to: [email.to],
    subject: email.subject,
    text: email.text,
    html: email.html,
    // Replies to an automated notice should reach a human, so they go to the
    // same public address the legal pages and the consent screen publish
    // unless the operator has named a different one.
    reply_to: config.notifications.replyTo || config.legal.contactEmail,
  };

  try {
    const response = await fetch(config.notifications.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.notifications.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.notifications.timeoutMs),
    });

    if (!response.ok) {
      // The provider's own message is the only thing that distinguishes a bad
      // key from an unverified sending domain, which are the two ways this
      // realistically fails, so it goes in the log verbatim.
      const detail = await response.text().catch(() => '');
      console.error(
        `[notify] mail provider rejected the send (${response.status}): ${detail.slice(0, 500)}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error('[notify] could not reach the mail provider:', error);
    return false;
  }
}
