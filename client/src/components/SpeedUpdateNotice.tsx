import { useState } from 'react';
import { useJobStore } from '../store/useJobStore';

/**
 * Announces the change that made jobs take a fraction of the time they used
 * to, and — in the same breath — that a credit now buys three hours instead of
 * five.
 *
 * Both halves belong here. Announcing the speed-up alone, while the price per
 * character moved in the other direction, would be the kind of omission that
 * costs more trust than the good news buys. Someone who reads this and decides
 * the trade is not for them has been told honestly, which is the point.
 *
 * Dismissal is keyed to this specific announcement rather than a generic
 * "seen the notice" flag, so a later one is not silently swallowed by a click
 * from months ago. Bump the key when the message changes.
 */
const DISMISS_KEY = 'turtletype:notice:checkpoint-confirmation-1';

function readDismissed(): boolean {
  // A browser with storage blocked should get the notice, not a crash.
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export default function SpeedUpdateNotice() {
  const confirmsCheckpoints = useJobStore((state) => state.confirmsCheckpoints);
  const [dismissed, setDismissed] = useState(readDismissed);

  const dismiss = (): void => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Dismissed for this page view only. Better than refusing to close.
    }
  };

  // Nothing to announce on a deploy that does not do this.
  if (!confirmsCheckpoints || dismissed) return null;

  return (
    <div className="mb-6 rounded-xl border border-accent-600/40 bg-accent-600/10 px-4 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ink-100">Jobs now finish in about a third of the time</p>
          <p className="mt-2 text-xs leading-relaxed text-ink-300">
            Most of a job used to be spent waiting out a fixed timer, guessing when Google Docs
            had saved a revision. TurtleType now watches the document’s version history and carries
            on the moment each revision actually lands. The writing itself is unchanged — same
            sittings, same gaps in the history, same typos fixed on a later pass — it just stops
            waiting for something that has already happened.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-300">
            This needs permission to see the document, which we get for docs TurtleType creates and
            for docs you choose with the Google button. A doc reached by{' '}
            <span className="text-ink-200">pasting a link</span> still runs the full time, because
            Google does not let us read its history.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-400">
            Pricing changed with it: one credit is now three hours of planned writing rather than
            five, so a credit covers about 5,490 characters. Credits already in your balance are
            unaffected in number, but they buy less writing than before.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-full border border-ink-700 px-2 py-0.5 font-mono text-[11px] text-ink-400 transition hover:border-ink-500 hover:text-ink-200"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
