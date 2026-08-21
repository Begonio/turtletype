import { useState } from 'react';
import { Link } from 'react-router-dom';
import { isActive, useJobStore } from '../store/useJobStore';
import { durationToSlider, formatDuration, formatFinishTime, sliderToDuration } from '../lib/format';
import { formatCredits, formatCreditsWithUnit } from '../lib/credits';

export default function Controls() {
  const durationMs = useJobStore((state) => state.durationMs);
  const minDurationMs = useJobStore((state) => state.minDurationMs);
  const maxDurationMs = useJobStore((state) => state.maxDurationMs);
  const bursts = useJobStore((state) => state.bursts);
  const estimating = useJobStore((state) => state.estimating);
  const docMode = useJobStore((state) => state.docMode);
  const docUrlInput = useJobStore((state) => state.docUrlInput);
  const selectedDoc = useJobStore((state) => state.selectedDoc);
  const pickerAvailable = useJobStore((state) => state.pickerAvailable);
  const pickerBusy = useJobStore((state) => state.pickerBusy);
  const pickerError = useJobStore((state) => state.pickerError);
  const text = useJobStore((state) => state.text);
  const phase = useJobStore((state) => state.phase);
  const error = useJobStore((state) => state.error);
  const jobCost = useJobStore((state) => state.jobCost);
  const billingEnabled = useJobStore((state) => state.billingEnabled);
  const needsCredits = useJobStore((state) => state.needsCredits);
  const credits = useJobStore((state) => state.user?.credits ?? 0);

  const setDurationMs = useJobStore((state) => state.setDurationMs);
  const setDocMode = useJobStore((state) => state.setDocMode);
  const setDocUrlInput = useJobStore((state) => state.setDocUrlInput);
  const chooseDoc = useJobStore((state) => state.chooseDoc);
  const clearSelectedDoc = useJobStore((state) => state.clearSelectedDoc);
  const startJob = useJobStore((state) => state.startJob);

  // Revealed on request when the picker is available, and the only option
  // when it is not. Starts open if a link survived a page refresh, and is
  // forced open by a picker failure — the fallback is no use to someone if
  // they have to find it themselves after the thing they clicked broke.
  const [showPasteField, setShowPasteField] = useState(() => docUrlInput.trim().length > 0);

  const locked = isActive(phase);
  const missingDoc = docMode === 'existing' && !selectedDoc && !docUrlInput.trim();
  const hasEstimate = minDurationMs > 0;
  // Priced but unaffordable. The server decides for real; this only avoids
  // sending a request that is already known to be refused.
  const cannotAfford = billingEnabled && jobCost > 0 && jobCost > credits;
  const canStart =
    !locked && text.trim().length > 0 && !missingDoc && hasEstimate && !cannotAfford;

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
            Paste some text and TurtleType works out the shortest believable schedule for it.
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

      <div className="rounded-lg border border-ink-800 bg-ink-850 px-3 py-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-400">How it writes</p>
        <p className="mt-2 text-xs leading-relaxed text-ink-400">
          Hesitation, uneven rhythm and real typos are always on. Mistakes are left in the text and
          fixed on a later pass — that's what makes them show up in the doc's history the way a
          person's do.
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
            {pickerAvailable ? (
              selectedDoc ? (
                <div className="rounded-lg border border-accent-600/40 bg-accent-600/10 px-3 py-2.5">
                  <p className="truncate text-sm text-ink-200" title={selectedDoc.name}>
                    {selectedDoc.name}
                  </p>
                  <div className="mt-2 flex items-center gap-3 font-mono text-[10px]">
                    <button
                      type="button"
                      onClick={() => void chooseDoc()}
                      disabled={pickerBusy}
                      className="text-accent-400 underline underline-offset-2 transition hover:text-accent-300 disabled:opacity-50"
                    >
                      {pickerBusy ? 'opening…' : 'change'}
                    </button>
                    <button
                      type="button"
                      onClick={clearSelectedDoc}
                      className="text-ink-400 underline underline-offset-2 transition hover:text-ink-200"
                    >
                      clear
                    </button>
                    <a
                      href={selectedDoc.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto text-ink-400 underline underline-offset-2 transition hover:text-ink-200"
                    >
                      open ↗
                    </a>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => void chooseDoc()}
                  disabled={pickerBusy}
                  className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 text-sm text-ink-200 transition hover:border-accent-600/60 hover:text-accent-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {pickerBusy ? 'Opening Google…' : 'Choose from your Google Docs'}
                </button>
              )
            ) : null}

            {/* The link field never goes away entirely. The picker depends on
                a Google popup, third-party scripts and a permission the user
                can decline, and none of those are things this panel should be
                able to strand someone behind. */}
            {!pickerAvailable || showPasteField || pickerError ? (
              <input
                type="text"
                value={docUrlInput}
                onChange={(event) => setDocUrlInput(event.target.value)}
                placeholder="https://docs.google.com/document/d/…"
                aria-label="Google Doc URL"
                className={`w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 font-mono text-xs text-ink-200 placeholder:text-ink-600 focus:border-accent-600/60 focus:outline-none ${
                  pickerAvailable ? 'mt-2' : ''
                }`}
              />
            ) : (
              <button
                type="button"
                onClick={() => setShowPasteField(true)}
                className="mt-2 font-mono text-[10px] text-ink-400 underline underline-offset-2 transition hover:text-ink-200"
              >
                or paste a link instead
              </button>
            )}

            {pickerError ? (
              <p className="mt-2 text-xs leading-relaxed text-amber-300">{pickerError}</p>
            ) : null}

            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              {pickerAvailable
                ? 'Text is appended to the end of the document you pick — nothing already in it is changed.'
                : 'Text is appended to the end of the document. Paste the full URL or just the document ID.'}
            </p>
          </div>
        ) : null}
      </fieldset>

      {billingEnabled && hasEstimate ? (
        <div className="rounded-lg border border-ink-800 bg-ink-850 px-3 py-3">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-400">
              Cost
            </span>
            <span className="font-mono text-xs text-ink-200">
              {formatCreditsWithUnit(jobCost)}
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-400">
            You have {formatCredits(credits)}. Jobs are priced by length, to a hundredth of a
            credit, and credits come back automatically if the job fails.
          </p>
        </div>
      ) : null}

      {cannotAfford || needsCredits ? (
        <div className="rounded-lg border border-accent-600/40 bg-accent-600/10 px-3 py-3">
          <p className="text-xs leading-relaxed text-ink-200">
            This job needs {formatCreditsWithUnit(jobCost)} and you have {formatCredits(credits)}.
          </p>
          <Link
            to="/pricing"
            className="mt-3 inline-block rounded-lg bg-accent-500 px-3 py-2 text-xs font-semibold text-ink-950 transition hover:bg-accent-400"
          >
            Get credits →
          </Link>
        </div>
      ) : error && !locked ? (
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
        <p className="-mt-4 text-xs text-ink-400">
          {pickerAvailable ? 'Choose a Google Doc to continue.' : 'Paste a Google Doc link to continue.'}
        </p>
      ) : null}
    </aside>
  );
}
