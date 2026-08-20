import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import GoogleButton from '../components/GoogleButton';
import { ApiError, api, loginUrl, type CatalogResponse, type PricedSku } from '../lib/api';
import { useJobStore } from '../store/useJobStore';

const money = (cents: number, currency: string): string =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);

/**
 * Everything the pricing page says about price comes from the server's
 * catalog, never from a copy hardcoded here. A pricing page that disagrees
 * with the checkout is worse than no pricing page.
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
        <section className="pt-10 pb-12">
          <h1 className="text-4xl leading-tight font-semibold tracking-tight text-white sm:text-5xl">
            Pay for what you write.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-300">
            One credit covers {perCredit.toLocaleString()} characters — about a 1,500-word essay.
            Credits from a pack never expire, and a job that fails gives its credits back
            automatically.
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
                  <h2 className="text-sm font-semibold tracking-tight text-ink-200">{sku.name}</h2>
                  <p className="mt-3 text-3xl font-semibold tracking-tight text-white">
                    {money(sku.amountCents, sku.currency)}
                  </p>
                  <p className="mt-1 font-mono text-xs text-ink-400">
                    {sku.credits} credits · {money(sku.centsPerCredit, sku.currency)} each
                  </p>
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
                          ? 'Buy credits'
                          : 'Sign in to buy'}
                  </button>
                </div>
              ))}
            </div>

            {plans.length > 0 ? (
              <div className="mt-10">
                <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-ink-400">
                  Or subscribe
                </h2>
                {plans.map((sku) => (
                  <div
                    key={sku.id}
                    className="mt-4 flex flex-col items-start justify-between gap-4 rounded-xl border border-ink-800 bg-ink-900 p-6 sm:flex-row sm:items-center"
                  >
                    <div>
                      <p className="text-sm font-semibold tracking-tight text-ink-200">
                        {sku.name} — {money(sku.amountCents, sku.currency)}/month
                      </p>
                      <p className="mt-2 max-w-lg text-sm leading-relaxed text-ink-400">
                        {sku.blurb} Works out to {money(sku.centsPerCredit, sku.currency)} a credit.
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
                ))}
              </div>
            ) : null}
          </>
        )}

        <section className="mt-16 border-t border-ink-800 pt-10">
          <h2 className="text-sm font-semibold tracking-tight text-ink-200">
            What a credit actually buys
          </h2>
          <dl className="mt-6 grid gap-6 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-ink-200">Why characters, not documents</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                A job runs for as long as the text is long — roughly six and a half hours per{' '}
                {perCredit.toLocaleString()} characters, because the gaps between sittings are the
                whole product. Charging per document would price a short note and a dissertation
                the same.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-200">Failed jobs are refunded</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                If a job fails for any reason — an expired Google permission, a document you lost
                access to, a restart on our side — its credits go straight back to your balance.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-200">Cancelling early</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                Stop a job in the first tenth and you get the credits back. After that the revision
                history you paid for is largely already in the document.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-200">Long documents</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-400">
                A single job is capped at {catalog?.maxCreditsPerJob ?? 20} credits. Beyond that,
                split the text across several jobs — which is also closer to how a long document
                really gets written.
              </dd>
            </div>
          </dl>
        </section>

        {!user ? (
          <section className="mt-14 rounded-xl border border-ink-800 bg-ink-900 p-6">
            <p className="text-sm text-ink-300">
              New here? Signing in gives you a free credit to try it with.
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
