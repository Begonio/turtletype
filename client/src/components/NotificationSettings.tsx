import { useState } from 'react';
import { useJobStore } from '../store/useJobStore';
import { showTestNotification, type NotificationOutcome } from '../lib/notifications';
import type { NotificationPrefs } from '../lib/api';

/**
 * Where someone says how they want to hear that a job ended.
 *
 * The two channels are listed separately rather than merged into one "notify
 * me" switch, because they fail in opposite directions: a browser
 * notification arrives the instant it happens and cannot arrive at all once
 * the tab is closed, and an email arrives late and always. Since closing the
 * tab is the intended way to use this — the job runs server-side for hours —
 * saying so out loud on this panel matters more than the space it costs.
 */

interface ToggleProps {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

function Toggle({ id, label, checked, disabled, onChange }: ToggleProps) {
  return (
    <label
      htmlFor={id}
      className={`flex items-center gap-2.5 text-sm ${
        disabled ? 'cursor-not-allowed text-ink-500' : 'cursor-pointer text-ink-300'
      }`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 accent-accent-500 disabled:opacity-50"
      />
      <span>{label}</span>
    </label>
  );
}

export default function NotificationSettings() {
  const user = useJobStore((state) => state.user);
  const emailAvailable = useJobStore((state) => state.emailNotificationsAvailable);
  const permission = useJobStore((state) => state.browserPermission);
  const error = useJobStore((state) => state.notificationsError);
  const setPrefs = useJobStore((state) => state.setNotificationPrefs);
  const enableBrowser = useJobStore((state) => state.enableBrowserNotifications);

  const [open, setOpen] = useState(false);
  const [tested, setTested] = useState(false);

  if (!user) return null;
  const prefs = user.notifications;

  const set = (key: keyof NotificationPrefs) => (next: boolean) => {
    void setPrefs({ [key]: next } as Partial<NotificationPrefs>);
  };

  const granted = permission === 'granted';
  const browserUsable = granted;

  // What the header says when the panel is shut, so the state is readable
  // without opening it.
  const summary = describeSummary(prefs, { emailAvailable, granted });

  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-3.5 text-left"
      >
        <span className="font-mono text-xs uppercase tracking-[0.18em] text-ink-400">
          When a job ends
        </span>
        <span className="flex items-center gap-3">
          <span className="text-xs text-ink-400">{summary}</span>
          <span className="font-mono text-[10px] text-ink-500">{open ? '−' : '+'}</span>
        </span>
      </button>

      {open ? (
        <div className="grid gap-6 border-t border-ink-800 px-5 py-5 sm:grid-cols-2">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-400">Email</p>
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              {emailAvailable ? (
                <>
                  Sent to <span className="text-ink-300">{user.email}</span>. The only one that
                  reaches you after you close the tab — which is the normal way to use this, since
                  the job keeps writing without you.
                </>
              ) : (
                'This deployment has no mail provider configured, so it cannot send email. Browser notifications still work.'
              )}
            </p>
            <div className="mt-3 space-y-2.5">
              <Toggle
                id="notify-email-done"
                label="When it finishes"
                checked={prefs.emailOnDone}
                disabled={!emailAvailable}
                onChange={set('emailOnDone')}
              />
              <Toggle
                id="notify-email-failed"
                label="When it fails"
                checked={prefs.emailOnFailure}
                disabled={!emailAvailable}
                onChange={set('emailOnFailure')}
              />
            </div>
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-400">
              This browser
            </p>
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              A desktop notification, the moment it happens. Needs this tab left open somewhere —
              it can be in the background, but a closed tab cannot notify you.
            </p>

            {permission === 'unsupported' ? (
              <p className="mt-3 text-xs leading-relaxed text-amber-300">
                This browser does not support notifications.
              </p>
            ) : permission === 'denied' ? (
              <p className="mt-3 text-xs leading-relaxed text-amber-300">
                Notifications are blocked for this site. Allow them from the icon in your browser’s
                address bar, then reload.
              </p>
            ) : !granted ? (
              <button
                type="button"
                onClick={() => void enableBrowser()}
                className="mt-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs text-ink-200 transition hover:border-accent-600/60 hover:text-accent-400"
              >
                Allow notifications
              </button>
            ) : null}

            <div className="mt-3 space-y-2.5">
              <Toggle
                id="notify-browser-done"
                label="When it finishes"
                checked={prefs.browserOnDone && browserUsable}
                disabled={!browserUsable}
                onChange={set('browserOnDone')}
              />
              <Toggle
                id="notify-browser-failed"
                label="When it fails"
                checked={prefs.browserOnFailure && browserUsable}
                disabled={!browserUsable}
                onChange={set('browserOnFailure')}
              />
            </div>

            {granted ? (
              <button
                type="button"
                onClick={() => setTested(showTestNotification())}
                className="mt-3 font-mono text-[10px] text-ink-400 underline underline-offset-2 transition hover:text-ink-200"
              >
                {tested ? 'sent — check your desktop' : 'send a test notification'}
              </button>
            ) : null}
          </div>

          {error ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200 sm:col-span-2">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The one-line state shown on the closed header.
 *
 * Reports what will actually happen rather than what is stored: a browser
 * preference that is switched on without the browser's permission notifies
 * nobody, and saying "browser" there would be a lie the panel has to be opened
 * to catch.
 */
function describeSummary(
  prefs: NotificationPrefs,
  context: { emailAvailable: boolean; granted: boolean },
): string {
  const channels: string[] = [];
  if (context.emailAvailable && (prefs.emailOnDone || prefs.emailOnFailure)) channels.push('email');
  if (context.granted && (prefs.browserOnDone || prefs.browserOnFailure)) channels.push('browser');

  if (channels.length === 0) return 'no notifications';

  const outcomes: NotificationOutcome[] = [];
  const anyDone =
    (context.emailAvailable && prefs.emailOnDone) || (context.granted && prefs.browserOnDone);
  const anyFailed =
    (context.emailAvailable && prefs.emailOnFailure) || (context.granted && prefs.browserOnFailure);
  if (anyDone) outcomes.push('done');
  if (anyFailed) outcomes.push('failed');

  const what =
    outcomes.length === 2 ? 'finished + failed' : outcomes[0] === 'done' ? 'finished' : 'failed';
  return `${channels.join(' + ')} · ${what}`;
}
