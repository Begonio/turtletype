import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import GoogleButton from '../components/GoogleButton';
import { ApiError, api, loginUrl, type CatalogResponse, type PricedSku } from '../lib/api';
import { formatDuration } from '../lib/format';
import { useJobStore } from '../store/useJobStore';

const money = (cents: number, currency: string): string =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);

/**
 * Everything on this page comes from the server's catalog: the prices, and
 * also the worked examples, which are produced by running the real planner
 * rather than written into the copy. A pricing page that disagrees with the
 * checkout is bad; one that disagrees with how long the product actually takes
 * is worse, because the customer only finds out after paying.
 */
export default function Pricing() {
  const user = useJobStore((state) => state.user);
  const [params] = useSearchParams();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancelled = params.get('checkout') === 'cancelled';

  useEffect(() => {
    void api
      .catalog()
      .then(setCatalog)
      .catch(() => setError('Could not load pricing. Please refresh.'));
  }, []);

  async function buy(sku: PricedSku): Promise<void> {
    if (!user) {
      // Buying needs an account to attach the credits to; come straight back
      // here afterwards rather than dumping them in the app with no purchase.
      window.location.href = loginUrl('/pricing');
      return;
    }
    setPending(sku.id);
    setError(null);
    try {
      const { url } = await api.checkout(sku.id);
      window.location.href = url;
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not start checkout. Please try again.',
      );
      setPending(null);
    }
  }

  const packs = catalog?.skus.filter((sku) => sku.kind === 'pack') ?? [];
  const plans = catalog?.skus.filter((sku) => sku.kind === 'plan') ?? [];
  const perCredit = catalog?.charsPerCredit ?? 10_000;
  const perWord = catalog?.charsPerWord ?? 5.9;
  const wordsPerCredit = Math.round(perCredit / perWord / 50) * 50;
  /**
   * The worked example the warning callout quotes. Taken from the measured
   * reference set rather than written into the sentence — a hardcoded "about
   * six hours" sitting next to a measured table is exactly the drift this data
   * exists to prevent.
   */
  const oneCreditExample =
    catalog?.reference.find((row) => row.chars === perCredit) ??
    catalog?.reference[catalog.reference.length - 1];

  /** What a pack's credits add up to, in the units someone actually thinks in. */
  const allowance = (credits: number): string =>
    `${(credits * perCredit).toLocaleString()} characters · about ${(
      Math.round((credits * perCredit) / perWord / 100) * 100
    ).toLocaleString()} words`;

  return (
    <div className="min-h-full bg-ink-950">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <Link to="/" className="font-mono text-sm tracking-tight text-ink-200">
          turtle<span className="text-accent-500">type</span>
        </Link>
        {user ? (
          <div className="flex items-center gap-4 text-sm">
            <span className="font-mono text-xs text-ink-400">
              {user.credits} {user.credits === 1 ? 'credit' : 'credits'}
            </span>
            <Link to="/app" className="text-ink-300 transition hover:text-ink-200">
              Open the app →
            </Link>
          </div>
        ) : null}
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-24">
        <section className="pt-10 pb-10">
          <h1 className="text-4xl leading-tight font-semibold tracking-tight text-white sm:text-5xl">
            Pay for what you write.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-300">
            One credit covers {perCredit.toLocaleString()} characters — roughly{' '}
            {wordsPerCredit.toLocaleString()} words. Every job tells you its exact cost and finish
            time before you start it, and nothing is charged until you press start.
          </p>
        </section>

        {/*
          The single most important disclosure on the page, and the one a
          customer is most likely to be surprised by after paying. The gaps
          between sittings ARE the product, so a job takes hours by design.
        */}
        <section className="mb-12 rounded-xl border border-accent-600/40 bg-accent-600/[0.07] p-6">
          <h2 className="text-sm font-semibold tracking-tight text-ink-100">
            Read this first: jobs take hours, on purpose
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-300">
            TurtleType is not a fast way to get text into a document — copy and paste is, and it is
            free. What you are paying for is the <span className="text-ink-100">time</span>: the
            document is written in short sittings with real gaps of two to four minutes between
            them, because that is what makes Google Docs record a separate revision for each one.
            {oneCreditExample ? (
              <>
                {' '}
                A {oneCreditExample.chars.toLocaleString()}-character essay — about{' '}
                {oneCreditExample.words.toLocaleString()} words — takes{' '}
                <span className="text-ink-100">{formatDuration(oneCreditExample.durationMs)}</span>{' '}
                from start to finish, and produces {oneCreditExample.revisions} separate revisions.
              </>
            ) : null}
          </p>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-300">
            You can close the tab — the job runs on our servers — but you cannot make it go faster
            than the minimum, and if you need the document finished in ten minutes this is the
            wrong tool. Plan around the deadline, not the other way round.
          </p>
        </section>

        {cancelled ? (
          <div className="mb-8 rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-sm text-ink-300">
            Checkout cancelled — nothing was charged.
          </div>
        ) : null}

        {error ? (
          <div className="mb-8 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {catalog && !catalog.enabled ? (
          <div className="mb-8 rounded-lg border border-accent-600/40 bg-accent-600/10 px-4 py-3 text-sm text-ink-200">
            This deployment has billing switched off — every job runs free.
          </div>
        ) : null}

        {!catalog ? (
          <p className="text-sm text-ink-400">Loading…</p>
        ) : (
          <>
            {/* What a credit buys, measured rather than claimed. */}
            <section className="mb-14">
              <h2 className="text-sm font-semibold tracking-tight text-ink-100">
                Exactly what a credit gets you
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-400">
                These are produced by running the real scheduler, not estimated. Times are the
                minimum for that length; you can stretch a job over longer if you want, never
                shorter. Revisions are the separate entries that appear in the document's version
                history — the thing you are actually buying.
              </p>

              <div className="mt-5 overflow-x-auto rounded-xl border border-ink-800">
                <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-ink-800 bg-ink-900">
                      {['Document', 'Words', 'Credits', 'Takes', 'Revisions', 'Corrections'].map(
                        (heading) => (
                          <th
                            key={heading}
                            className="px-4 py-3 font-mono text-[10px] font-normal uppercase tracking-[0.15em] text-ink-400"
                          >
                            {heading}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.reference.map((row) => (
                      <tr key={row.chars} className="border-b border-ink-800/60 last:border-0">
                        <td className="px-4 py-3 text-ink-200">
                          {row.chars.toLocaleString()} chars
                        </td>
                        <td className="px-4 py-3 text-ink-400">~{row.words.toLocaleString()}</td>
                        <td className="px-4 py-3 font-mono text-accent-400">{row.credits}</td>
                        <td className="px-4 py-3 text-ink-200">
                          {formatDuration(row.durationMs)}
                        </td>
                        <td className="px-4 py-3 text-ink-400">{row.revisions}</td>
                        <td className="px-4 py-3 text-ink-400">{row.corrections}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-500">
                Word counts assume ordinary English prose at about {perWord.toFixed(1)} characters
                per word. Your document is priced on its exact character count, rounded up to the
                next whole credit.
              </p>
            </section>

            <h2 className="mb-5 text-sm font-semibold tracking-tight text-ink-100">
              Credit packs — one payment, no subscription
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              {packs.map((sku) => (
                <div
                  key={sku.id}
                  className={`flex flex-col rounded-xl border p-6 ${
                    sku.highlight
                      ? 'border-accent-600/60 bg-accent-600/[0.07]'
                      : 'border-ink-800 bg-ink-900'
                  }`}
                >
                  {sku.highlight ? (
                    <span className="mb-3 self-start rounded-full bg-accent-500/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-accent-400">
                      Most popular
                    </span>
                  ) : null}
                  <h3 className="text-sm font-semibold tracking-tight text-ink-200">{sku.name}</h3>
                  <p className="mt-3 text-3xl font-semibold tracking-tight text-white">
                    {money(sku.amountCents, sku.currency)}
                  </p>
                  <p className="mt-1 font-mono text-xs text-ink-400">
                    {sku.credits} credits · {money(sku.centsPerCredit, sku.currency)} each
                  </p>

                  <dl className="mt-5 space-y-2 border-t border-ink-800 pt-4 text-xs">
                    <div className="flex justify-between gap-3">
                      <dt className="text-ink-500">Total allowance</dt>
                      <dd className="text-right text-ink-300">
                        {(sku.credits * perCredit).toLocaleString()} chars
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-ink-500">In words</dt>
                      <dd className="text-right text-ink-300">
                        ~
                        {(
                          Math.round((sku.credits * perCredit) / perWord / 100) * 100
                        ).toLocaleString()}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-ink-500">Expires</dt>
                      <dd className="text-right text-ink-300">Never</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-ink-500">Billing</dt>
                      <dd className="text-right text-ink-300">One payment</dd>
                    </div>
                  </dl>

                  <p className="mt-4 flex-1 text-sm leading-relaxed text-ink-400">{sku.blurb}</p>
                  <button
                    type="button"
                    disabled={!sku.available || pending !== null}
                    onClick={() => void buy(sku)}
                    className={`mt-6 rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400 ${
                      sku.highlight
                        ? 'bg-accent-500 text-ink-950 hover:bg-accent-400'
                        : 'bg-ink-700 text-ink-100 hover:bg-ink-600'
                    }`}
                  >
                    {pending === sku.id
                      ? 'Opening checkout…'
                      : !sku.available
                        ? 'Unavailable'
                        : user
                          ? `Buy ${sku.credits} credits`
                          : 'Sign in to buy'}
                  </button>
                  <p className="mt-3 text-center font-mono text-[10px] text-ink-500">
                    {allowance(sku.credits)}
                  </p>
                </div>
              ))}
            </div>

            {plans.length > 0 ? (
              <div className="mt-12">
                <h2 className="mb-5 text-sm font-semibold tracking-tight text-ink-100">
                  Or subscribe — for writing every week
                </h2>
                {plans.map((sku) => (
                  <div
                    key={sku.id}
                    className="rounded-xl border border-ink-800 bg-ink-900 p-6"
                  >
                    <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                      <div>
                        <p className="text-sm font-semibold tracking-tight text-ink-200">
                          {sku.name} — {money(sku.amountCents, sku.currency)} per month
                        </p>
                        <p className="mt-2 max-w-lg text-sm leading-relaxed text-ink-400">
                          {sku.credits} credits added to your balance every month, at{' '}
                          {money(sku.centsPerCredit, sku.currency)} a credit — that is{' '}
                          {allowance(sku.credits)} monthly.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={!sku.available || pending !== null}
                        onClick={() => void buy(sku)}
                        className="shrink-0 rounded-lg bg-ink-700 px-4 py-2.5 text-sm font-semibold text-ink-100 transition hover:bg-ink-600 disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-ink-500"
                      >
                        {pending === sku.id
                          ? 'Opening checkout…'
                          : !sku.available
                            ? 'Unavailable'
                            : user
                              ? 'Subscribe'
                              : 'Sign in to subscribe'}
                      </button>
                    </div>
                    <ul className="mt-5 grid gap-2 border-t border-ink-800 pt-4 text-xs text-ink-400 sm:grid-cols-2">
                      <li>
                        Renews monthly on the day you subscribe, until you cancel. Card charged
                        automatically.
                      </li>
                      <li>Cancel any time from the billing page — takes effect at period end.</li>
                      <li>
                        Monthly credits never expire and stack up if you do not use them, including
                        after you cancel.
                      </li>
                      <li>Credits you have already received are yours to keep on cancellation.</li>
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}

        <section className="mt-16 border-t border-ink-800 pt-10">
          <h2 className="text-sm font-semibold tracking-tight text-ink-100">
            The terms in full, in plain words
          </h2>
          <dl className="mt-6 grid gap-x-10 gap-y-7 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-ink-200">When you are charged</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                Credits come off your balance the moment a job is accepted, not when it finishes.
                The exact cost is shown next to the start button before you press it, along with
                the finish time.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-200">If a job fails, you pay nothing</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                Any failure — an expired Google permission, a document you lost access to, a
                restart on our side — returns the full credits to your balance automatically. You
                do not have to ask.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-200">If you cancel partway</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                Stop within the first 10% of the text and the credits come back in full. After
                that they do not, because most of the revision history you paid for is already in
                the document.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-200">Per-job limit</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                One job can cost at most {catalog?.maxCreditsPerJob ?? 20} credits (
                {((catalog?.maxCreditsPerJob ?? 20) * perCredit).toLocaleString()} characters).
                Longer documents split across several jobs — which is also how long documents
                genuinely get written.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-200">Why characters, not documents</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                A job occupies a slot on our servers for as long as it runs, and that scales with
                length. Charging per document would price a short note and a dissertation the
                same when one takes sixty times the resources.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-200">Refunds</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                If the service does not do what this page says, email us and we will refund the
                purchase. Refunding removes the credits it provided.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-200">What we never do</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                Your document text is never saved to our database — it lives in memory only while
                the job runs. Card details never reach our servers; Stripe handles payment. See the{' '}
                <Link to="/privacy" className="text-accent-400 underline underline-offset-2">
                  privacy policy
                </Link>
                .
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-200">Queueing at busy times</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                Jobs run a limited number at a time. If we are at capacity yours waits in a queue
                and starts automatically — you will see its position. Queued time is on top of the
                writing time above.
              </dd>
            </div>
          </dl>
        </section>

        {!user ? (
          <section className="mt-14 rounded-xl border border-ink-800 bg-ink-900 p-6">
            <p className="text-sm text-ink-300">
              New here?{' '}
              {catalog && catalog.signupGrantCredits > 0
                ? `Signing in gives you ${catalog.signupGrantCredits} free ${
                    catalog.signupGrantCredits === 1 ? 'credit' : 'credits'
                  } — ${(catalog.signupGrantCredits * perCredit).toLocaleString()} characters, no card needed.`
                : 'Sign in to get started.'}
            </p>
            <div className="mt-4">
              <GoogleButton next="/pricing" />
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
