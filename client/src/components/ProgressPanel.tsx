import { useEffect, useRef } from 'react';
import { isTerminal, useJobStore, type Phase } from '../store/useJobStore';

const PHASE_COPY: Record<Phase, { label: string; tone: string }> = {
  idle: { label: 'Idle', tone: 'text-ink-400' },
  starting: { label: 'Starting', tone: 'text-accent-400' },
  pending: { label: 'Queued', tone: 'text-amber-300' },
  running: { label: 'Typing', tone: 'text-accent-400' },
  paused: { label: 'Paused', tone: 'text-amber-300' },
  done: { label: 'Finished', tone: 'text-accent-500' },
  failed: { label: 'Failed', tone: 'text-red-400' },
  cancelled: { label: 'Stopped', tone: 'text-ink-300' },
};

export default function ProgressPanel() {
  const phase = useJobStore((state) => state.phase);
  const pct = useJobStore((state) => state.pct);
  const preview = useJobStore((state) => state.preview);
  const charsWritten = useJobStore((state) => state.charsWritten);
  const totalChars = useJobStore((state) => state.totalChars);
  const charsPerMinute = useJobStore((state) => state.charsPerMinute);
  const docUrl = useJobStore((state) => state.docUrl);
  const error = useJobStore((state) => state.error);
  const notice = useJobStore((state) => state.notice);
  const connection = useJobStore((state) => state.connection);

  const pauseJob = useJobStore((state) => state.pauseJob);
  const resumeJob = useJobStore((state) => state.resumeJob);
  const cancelJob = useJobStore((state) => state.cancelJob);
  const resetJob = useJobStore((state) => state.resetJob);

  const previewRef = useRef<HTMLPreElement>(null);

  // Follow the text as it arrives, the way a terminal does.
  useEffect(() => {
    const element = previewRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [preview]);

  const copy = PHASE_COPY[phase];
  const finished = isTerminal(phase);

  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className={`font-mono text-xs uppercase tracking-[0.18em] ${copy.tone}`}>
            {copy.label}
          </span>
          {connection === 'reconnecting' ? (
            <span className="font-mono text-[10px] text-amber-300">reconnecting…</span>
          ) : null}
        </div>

        <div className="flex items-center gap-4 font-mono text-xs text-ink-400">
          <span>
            {charsWritten.toLocaleString()} / {totalChars.toLocaleString()} chars
          </span>
          <span className="text-ink-300">{charsPerMinute.toLocaleString()} chars/min</span>
        </div>
      </header>

      <div className="px-4 pt-4">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ease-out ${
              phase === 'failed' ? 'bg-red-500' : 'bg-accent-500'
            }`}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Typing progress"
          />
        </div>
        <div className="mt-2 text-right font-mono text-xs text-ink-400">{pct.toFixed(1)}%</div>
      </div>

      <div className="px-4 pb-4">
        <pre
          ref={previewRef}
          className="thin-scroll h-56 overflow-y-auto rounded-lg border border-ink-800 bg-ink-950 px-4 py-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-ink-200"
          aria-live="polite"
          aria-label="Live preview of what has been typed"
        >
          {preview}
          {phase === 'running' ? <span className="caret text-accent-500">▌</span> : null}
        </pre>

        {notice ? (
          <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
            {notice}
          </p>
        ) : null}

        {error ? (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {phase === 'running' || phase === 'pending' ? (
            <button
              type="button"
              onClick={() => void pauseJob()}
              className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-200 transition hover:border-ink-600 hover:bg-ink-800"
            >
              Pause
            </button>
          ) : null}

          {phase === 'paused' ? (
            <button
              type="button"
              onClick={() => void resumeJob()}
              className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-ink-950 transition hover:bg-accent-400"
            >
              Resume
            </button>
          ) : null}

          {!finished && phase !== 'idle' ? (
            <button
              type="button"
              onClick={() => void cancelJob()}
              className="rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-300 transition hover:bg-red-500/10"
            >
              Stop
            </button>
          ) : null}

          {finished ? (
            <button
              type="button"
              onClick={resetJob}
              className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-200 transition hover:border-ink-600 hover:bg-ink-800"
            >
              Start another
            </button>
          ) : null}

          {docUrl ? (
            <a
              href={docUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto rounded-lg border border-accent-600/40 px-4 py-2 text-sm text-accent-400 transition hover:bg-accent-600/10"
            >
              Open the doc ↗
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}
