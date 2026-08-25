/**
 * Desktop notifications for a job that ended.
 *
 * The honest scope of this file: a browser notification can only be raised by
 * a page that is running, so this covers the tab being *in the background* —
 * another window, another tab, a minimised browser — and not the tab being
 * closed. That is the common case worth covering (a job runs for hours and
 * nobody watches the progress bar), and the case it cannot cover is exactly
 * the one the email covers. Neither channel is a substitute for the other,
 * which is why the settings offer both.
 *
 * Everything here degrades to a no-op rather than throwing: `Notification` is
 * absent in some embedded webviews entirely, and on iOS Safari it exists only
 * for installed web apps.
 */

export type NotificationOutcome = 'done' | 'failed';

/** False where the browser has no Notification API at all. */
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export type PermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export function notificationPermission(): PermissionState {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission as PermissionState;
}

/**
 * Asks the browser for permission, if it has not already been answered.
 *
 * Only ever called from a click. Browsers refuse (and Chrome permanently
 * penalises the origin for) a permission prompt raised without a user
 * gesture, so this is deliberately not wired to page load or to the settings
 * being fetched.
 */
export async function requestNotificationPermission(): Promise<PermissionState> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission as PermissionState;
  try {
    return (await Notification.requestPermission()) as PermissionState;
  } catch {
    // Older Safari passed a callback instead of returning a promise; treat a
    // throw as "still undecided" rather than as a denial.
    return notificationPermission();
  }
}

export interface JobNotification {
  outcome: NotificationOutcome;
  totalChars: number;
  charsWritten: number;
  docUrl: string | null;
  /** Failure reason, when there is one. */
  message?: string | null;
}

/**
 * Raises the notification for a finished job.
 *
 * Returns false when nothing was shown — unsupported, not permitted, or the
 * page is already in the foreground, where a system notification for something
 * the user is looking at is just noise.
 *
 * Never contains any of the document's text: the same rule the email follows,
 * for the same reason. Counts and an outcome only.
 */
export function showJobNotification(input: JobNotification): boolean {
  if (notificationPermission() !== 'granted') return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return false;

  const total = input.totalChars.toLocaleString();
  const title =
    input.outcome === 'done' ? 'Your document is finished' : 'Your job stopped before finishing';
  const body =
    input.outcome === 'done'
      ? `TurtleType wrote all ${total} characters into your Google Doc.`
      : input.message?.trim()
        ? `${input.charsWritten.toLocaleString()} of ${total} characters written. ${input.message}`
        : `${input.charsWritten.toLocaleString()} of ${total} characters written.`;

  try {
    const notification = new Notification(title, {
      body,
      // A job only ends once, but the SSE channel replays its terminal event
      // to a client that reconnects late, so the same outcome can arrive
      // twice. Tagging by outcome makes the second one replace the first
      // rather than stack a duplicate on the desktop.
      tag: `turtletype-job-${input.outcome}`,
      icon: '/favicon.ico',
    });

    notification.onclick = () => {
      // Bring the app back first — clicking a notification should land
      // somewhere, and the doc opening in a new tab behind a minimised window
      // is not somewhere.
      window.focus();
      if (input.docUrl) window.open(input.docUrl, '_blank', 'noopener');
      notification.close();
    };
    return true;
  } catch {
    // Some browsers throw on `new Notification` outside a service worker
    // (Android Chrome, notably) rather than reporting it as unsupported.
    return false;
  }
}

/**
 * A notification raised on demand, so someone can confirm the permission
 * actually works before trusting it with a three-hour job.
 *
 * Ignores the visibility rule above on purpose: the person is looking at the
 * settings panel when they press this, so suppressing it would make a working
 * setup look broken.
 */
export function showTestNotification(): boolean {
  if (notificationPermission() !== 'granted') return false;
  try {
    new Notification('Notifications are on', {
      body: 'This is what you will see when a job finishes or fails.',
      tag: 'turtletype-test',
      icon: '/favicon.ico',
    });
    return true;
  } catch {
    return false;
  }
}
