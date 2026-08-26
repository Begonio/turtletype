/**
 * Who gets told about a finished job, and through which channel.
 *
 * Pure — no I/O, no database, no `process.env` — for the same reason
 * `humanize.ts` and `launchChecks.ts` are: the rule about when a person is
 * emailed is worth testing on its own, and a rule that has to be tested
 * through a mail provider never gets tested.
 */

/**
 * A user's answer to "tell me when a job ends".
 *
 * Two channels because they cover different absences. A job runs server-side
 * for hours and the tab is expected to be closed, so email is the only one
 * that reaches someone who walked away; a browser notification is the only one
 * that arrives the moment it happens, and it cannot arrive at all once the tab
 * is gone. Neither is a substitute for the other, so neither is derived from
 * the other.
 *
 * Two events because "tell me when it breaks" and "tell me when it lands" are
 * genuinely different appetites, and a single switch would force someone who
 * only wants the first to accept the second.
 */
export interface NotificationPrefs {
  emailOnDone: boolean;
  emailOnFailure: boolean;
  browserOnDone: boolean;
  browserOnFailure: boolean;
}

/**
 * What a new account gets.
 *
 * On, deliberately. These are transactional notices about the account
 * holder's own job, sent to the address they signed in with, and the failure
 * this feature exists to prevent is a three-hour job ending in silence.
 * Every one of them has a visible switch in the app, and the browser pair
 * additionally cannot fire until the person has accepted the browser's own
 * permission prompt — so defaulting them on grants nothing they have not
 * already agreed to twice.
 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  emailOnDone: true,
  emailOnFailure: true,
  browserOnDone: true,
  browserOnFailure: true,
};

/** The two outcomes worth announcing. */
export type NotifiableOutcome = 'done' | 'failed';

/**
 * Narrows a job status to something worth sending, or null.
 *
 * `cancelled` is the interesting exclusion: the person who stopped the job is
 * the person who would be told about it, and they were looking at the button
 * when they did it. Announcing it would be the app reporting the user's own
 * click back to them, by email, minutes later.
 */
export function notifiableOutcome(status: string): NotifiableOutcome | null {
  if (status === 'done' || status === 'failed') return status;
  return null;
}

export interface Channels {
  email: boolean;
  browser: boolean;
}

/** Which channels this outcome should go out on, given what the user asked for. */
export function channelsFor(outcome: NotifiableOutcome, prefs: NotificationPrefs): Channels {
  return outcome === 'done'
    ? { email: prefs.emailOnDone, browser: prefs.browserOnDone }
    : { email: prefs.emailOnFailure, browser: prefs.browserOnFailure };
}
