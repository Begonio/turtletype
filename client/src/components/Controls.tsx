import { isActive, useJobStore } from '../store/useJobStore';
import { durationToSlider, formatDuration, formatFinishTime, sliderToDuration } from '../lib/format';

const HUMANNESS_LABELS = [
  { upTo: 0.05, label: 'Robot' },
  { upTo: 0.3, label: 'Careful' },
  { upTo: 0.6, label: 'Human' },
  { upTo: 0.85, label: 'Very human' },
  { upTo: 1.01, label: 'Caffeinated' },
] as const;

function humannessLabel(value: number): string {
  return HUMANNESS_LABELS.find((entry) => value < entry.upTo)?.label ?? 'Human';
}

export default function Controls() {
  const durationMs = useJobStore((state) => state.durationMs);
  const minDurationMs = useJobStore((state) => state.minDurationMs);
  const maxDurationMs = useJobStore((state) => state.maxDurationMs);
  const bursts = useJobStore((state) => state.bursts);
  const estimating = useJobStore((state) => state.estimating);
  const humanness = useJobStore((state) => state.humanness);
  const docMode = useJobStore((state) => state.docMode);
  const docUrlInput = useJobStore((state) => state.docUrlInput);
  const text = useJobStore((state) => state.text);
  const phase = useJobStore((state) => state.phase);
  const error = useJobStore((state) => state.error);

  const setDurationMs = useJobStore((state) => state.setDurationMs);
  const setHumanness = useJobStore((state) => state.setHumanness);
  const setDocMode = useJobStore((state) => state.setDocMode);
  const setDocUrlInput = useJobStore((state) => state.setDocUrlInput);
  const startJob = useJobStore((state) => state.startJob);

  const locked = isActive(phase);
  const missingDoc = docMode === 'existing' && !docUrlInput.trim();
  const hasEstimate = minDurationMs > 0;
  const canStart = !locked && text.trim().length > 0 && !missingDoc && hasEstimate;

  // No explicit choice means "as fast as is still believable".
  const effectiveMs = Math.max(minDurationMs, durationMs ?? 0);
  const sliderMax = Math.max(minDurationMs * 2, maxDurationMs);
  const sliderPosition = durationToSlider(effectiveMs, minDurationMs, sliderMax);

  return (
    <aside className="flex w-full flex-col gap-6 rounded-xl border border-ink-800 bg-ink-900 p-5 lg:w-80">
      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="duration" className="font-mono text-xs uppercase tracking-[0.18em] text-ink-400">
            Time to write
          </label>
          <span className="font-mono text-xs text-accent-400">
            {estimating ? 'measuring…' : hasEstimate ? formatDuration(effectiveMs) : '—'}
          </span>
        </div>

        <input
          id="duration"
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={sliderPosition}
          disabled={locked || !hasEstimate}
          onChange={(event) =>
            setDurationMs(sliderToDuration(Number(event.target.value), minDurationMs, sliderMax))
          }
          className="mt-3 w-full disabled:opacity-50"
        />

        <div className="mt-2 flex justify-between font-mono text-[10px] text-ink-400">
          <span>{hasEstimate ? `min ${formatDuration(minDurationMs)}` : 'min —'}</span>
          <span>{formatDuration(sliderMax)}</span>
        </div>

        {hasEstimate ? (
          <p className="mt-3 text-xs leading-relaxed text-ink-400">
            Written in <span className="text-ink-300">{bursts}</span>{' '}
            {bursts === 1 ? 'sitting' : 'sittings'} with real gaps between them, finishing around{' '}
            <span className="text-ink-300">{formatFinishTime(effectiveMs)}</span>. Those gaps are what
            make the doc's version history look written rather than pasted — it can't go faster than
            the minimum.
          </p>
        ) : (
          <p className="mt-3 text-xs leading-relaxed text-ink-400">
            Paste some text and HumanType works out the shortest believable schedule for it.
          </p>
        )}

        {durationMs !== null && durationMs > minDurationMs ? (
          <button
            type="button"
            onClick={() => setDurationMs(null)}
            disabled={locked}
            className="mt-2 font-mono text-[10px] text-ink-400 underline underline-offset-2 transition hover:text-ink-200"
          >
            reset to minimum
          </button>
        ) : null}
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="humanness" className="font-mono text-xs uppercase tracking-[0.18em] text-ink-400">
            Human-ness
          </label>
          <span className="font-mono text-xs text-accent-400">{humannessLabel(humanness)}</span>
        </div>
        <input
          id="humanness"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={humanness}
          disabled={locked}
          onChange={(event) => setHumanness(Number(event.target.value))}
          className="mt-3 w-full disabled:opacity-50"
        />
        <div className="mt-2 flex justify-between font-mono text-[10px] text-ink-400">
          <span>Robot</span>
          <span>Very human</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-400">
          Higher settings add hesitation and typos that get caught and corrected mid-word.
        </p>
      </div>

      <fieldset disabled={locked} className="disabled:opacity-60">
        <legend className="font-mono text-xs uppercase tracking-[0.18em] text-ink-400">
          Destination
        </legend>
        <div className="mt-3 space-y-2">
          {(
            [
              { value: 'new', label: 'Create a new doc' },
              { value: 'existing', label: 'Use an existing doc' },
            ] as const
          ).map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition ${
                docMode === option.value
                  ? 'border-accent-600/60 bg-accent-600/10 text-ink-200'
                  : 'border-ink-700 text-ink-300 hover:border-ink-600'
              }`}
            >
              <input
                type="radio"
                name="docMode"
                value={option.value}
                checked={docMode === option.value}
                onChange={() => setDocMode(option.value)}
                className="h-3.5 w-3.5 accent-accent-500"
              />
              {option.label}
            </label>
          ))}
        </div>

        {docMode === 'existing' ? (
          <div className="mt-3">
            <input
              type="text"
              value={docUrlInput}
              onChange={(event) => setDocUrlInput(event.target.value)}
              placeholder="https://docs.google.com/document/d/…"
              aria-label="Google Doc URL"
              className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 font-mono text-xs text-ink-200 placeholder:text-ink-600 focus:border-accent-600/60 focus:outline-none"
            />
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              Text is appended to the end of the document. Paste the full URL or just the document
              ID.
            </p>
          </div>
        ) : null}
      </fieldset>

      {error && !locked ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-200">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void startJob()}
        disabled={!canStart}
        className="rounded-lg bg-accent-500 px-4 py-3 text-sm font-semibold text-ink-950 transition hover:bg-accent-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400"
      >
        {phase === 'starting' ? 'Starting…' : locked ? 'Typing…' : 'Start typing'}
      </button>

      {missingDoc && !locked ? (
        <p className="-mt-4 text-xs text-ink-400">Paste a Google Doc link to continue.</p>
      ) : null}
    </aside>
  );
}
