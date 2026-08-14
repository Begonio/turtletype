import { useJobStore, isActive } from '../store/useJobStore';

/** Above this, a job runs long enough that the user deserves a heads-up. */
const LONG_TEXT_THRESHOLD = 50_000;

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return 'under a minute';
  if (totalMinutes < 60) return `about ${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `about ${hours}h` : `about ${hours}h ${minutes}m`;
}

/**
 * Rough client-side estimate for the warning banner: ~100ms per character at
 * 1x, before pauses. The server returns an exact figure once the job starts.
 */
function roughEstimateMs(chars: number, speed: number): number {
  return (chars * 118) / speed;
}

export default function Composer() {
  const text = useJobStore((state) => state.text);
  const speed = useJobStore((state) => state.speed);
  const phase = useJobStore((state) => state.phase);
  const setText = useJobStore((state) => state.setText);

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
          That is {chars.toLocaleString()} characters — at this speed it will take{' '}
          {formatDuration(roughEstimateMs(chars, speed))} to type. You can close this tab; the job
          keeps running on the server, and reopening the app reconnects you to it.
        </div>
      ) : null}
    </section>
  );
}
