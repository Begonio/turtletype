import { useEffect } from 'react';
import { useJobStore, isActive } from '../store/useJobStore';
import { formatDuration } from '../lib/format';

/** Above this, a job runs long enough that the user deserves a heads-up. */
const LONG_TEXT_THRESHOLD = 50_000;

export default function Composer() {
  const text = useJobStore((state) => state.text);
  const phase = useJobStore((state) => state.phase);
  const minDurationMs = useJobStore((state) => state.minDurationMs);
  const setText = useJobStore((state) => state.setText);
  const refreshEstimate = useJobStore((state) => state.refreshEstimate);

  // Text restored from a previous session needs an estimate too.
  useEffect(() => {
    if (text.trim() && minDurationMs === 0) refreshEstimate();
    // Only on mount: subsequent edits refresh through setText.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const locked = isActive(phase);
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-ink-800 bg-ink-900">
      <header className="flex items-center justify-between border-b border-ink-800 px-4 py-3">
        <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-ink-400">Your text</h2>
        <span className="font-mono text-xs text-ink-400">
          {chars.toLocaleString()} chars · {words.toLocaleString()} words
        </span>
      </header>

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={locked}
        spellCheck={false}
        placeholder="Paste the text you want typed into your Google Doc…"
        aria-label="Text to type"
        className="thin-scroll min-h-[280px] flex-1 resize-none bg-transparent px-4 py-4 font-mono text-sm leading-relaxed text-ink-200 placeholder:text-ink-600 focus:outline-none disabled:opacity-60"
      />

      {chars > LONG_TEXT_THRESHOLD ? (
        <div className="border-t border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-amber-200/90">
          That is {chars.toLocaleString()} characters — writing it at a believable pace takes at least{' '}
          {minDurationMs > 0 ? formatDuration(minDurationMs) : 'a long while'}. You can close this tab;
          the job keeps running on the server, and reopening the app reconnects you to it.
        </div>
      ) : null}
    </section>
  );
}
