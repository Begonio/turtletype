import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

/**
 * Warns people about the screen Google puts in front of them.
 *
 * Until verification completes, an app requesting a sensitive scope shows
 * "Google hasn't verified this app" before the consent screen, and the only
 * way forward is Advanced → Go to TurtleType (unsafe). Meeting that unprepared
 * reads as a malware warning, and it lands on the exact step where someone is
 * deciding whether to trust us with their documents and their card. Most people
 * who bail there never come back to find out it was procedural.
 *
 * Rendered from `oauthVerified` rather than hardcoded, so it disappears on its
 * own the day verification lands — a notice about a temporary state outlives
 * the state unless something removes it, which is how the landing page ended
 * up advertising a beta that had finished.
 */
export default function UnverifiedAppNotice({ className = '' }: { className?: string }) {
  const [unverified, setUnverified] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .publicConfig()
      .then((value) => {
        if (!cancelled) setUnverified(!value.oauthVerified);
      })
      // Say nothing rather than guess. Warning about a screen that no longer
      // appears would be worse than the surprise it was meant to prevent.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!unverified) return null;

  return (
    <div
      className={`max-w-xl rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-sm leading-relaxed text-ink-400 ${className}`}
    >
      <p className="font-medium text-ink-200">Google will show a warning first</p>
      <p className="mt-2">
        You will see <span className="text-ink-300">“Google hasn’t verified this app”</span> before
        the permission screen. That means Google has not finished reviewing our request for Docs
        access — a queue that takes weeks — not that anything was found wrong. To continue, choose{' '}
        <span className="text-ink-300">Advanced</span> →{' '}
        <span className="text-ink-300">Go to TurtleType (unsafe)</span>.
      </p>
      <p className="mt-2">
        What we do with that access does not change either way: we write the text you give us into
        the document you choose, and read its length so the text lands in the right place. We never
        open anything else, and your document text is never stored. The{' '}
        <Link to="/privacy" className="text-accent-400 underline underline-offset-2">
          privacy policy
        </Link>{' '}
        says so in full, and you can revoke access at any time from your Google account.
      </p>
    </div>
  );
}
