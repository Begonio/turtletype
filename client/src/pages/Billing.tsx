import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Wordmark from '../components/Wordmark';
import { ApiError, api, type BillingSummary, type CatalogResponse } from '../lib/api';
import { creditNoun, formatCredits } from '../lib/credits';
import { useJobStore } from '../store/useJobStore';

/**
 * Balance, history, and the way out.
 *
 * The way out matters: a subscription with no visible cancellation path is a
 * support burden at best and a chargeback at worst. Stripe's hosted portal
 * handles cancellation, card changes and invoices, so this page's job is
 * mainly to be a door to it that a customer can actually find.
 *
 * The history is here for the same reason the ledger exists server-side — a
 * customer asking "where did my credits go" should be able to answer it
 * themselves rather than emailing.
 */
const REASON_LABELS: Record<string, string> = {
  signup_grant: 'Welcome credit',
  purchase: 'Credit pack',
  subscription_renewal: 'Monthly plan',
  job_reserve: 'Job started',
  job_refund: 'Refunded',
  manual_adjustment: 'Adjustment',
};

export default function Billing() {
  const user = useJobStore((state) => state.user);
  const authChecked = useJobStore((state) => state.authChecked);
  const billingEnabled = useJobStore((state) => state.billingEnabled);
  const navigate = useNavigate();

  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [portalPending, setPortalPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authChecked && !user) navigate('/', { replace: true });
  }, [authChecked, user, navigate]);

  useEffect(() => {
    if (!user) return;
    void api.billingSummary().then(setSummary).catch(() => {});
    void api.catalog().then(setCatalog).catch(() => {});
  }, [user]);

  async function openPortal(): Promise<void> {
    setPortalPending(true);
    setError(null);
    try {
      const { url } = await api.billingPortal();
      window.location.href = url;
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not open the billing portal. Try again.',
      );
      setPortalPending(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="flex min-h-full items-center justify-center text-sm text-ink-400">
        Loading…
      </div>
    );
  }
  if (!user) return null;

  const perCredit = catalog?.charsPerCredit ?? 7_700;
  const subscribed = summary?.subscriptionStatus === 'active' && Boolean(summary?.plan);

  return (
    <div className="min-h-full bg-ink-950">
      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link to="/app" className="font-mono text-sm tracking-tight text-ink-200">
            <Wordmark />
          </Link>
          <Link to="/app" className="text-sm text-ink-300 transition hover:text-ink-200">
            ← Back to the app
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-3xl font-semibold tracking-tight text-white">Billing</h1>

        {!billingEnabled ? (
          <p className="mt-6 rounded-lg border border-accent-600/40 bg-accent-600/10 px-4 py-3 text-sm text-ink-200">
            Billing is switched off on this deployment — every job runs free.
          </p>
        ) : null}

        {error ? (
          <p className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </p>
        ) : null}

        <section className="mt-8 rounded-xl border border-ink-800 bg-ink-900 p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-400">Balance</p>
          <p className="mt-3 text-4xl font-semibold tracking-tight text-white">
            {formatCredits(user.credits)}
            <span className="ml-2 text-base font-normal text-ink-400">
              {creditNoun(user.credits)}
            </span>
          </p>
          <p className="mt-2 text-sm text-ink-400">
            Enough for about {Math.floor(user.credits * perCredit).toLocaleString()} characters of
            writing. Jobs are charged by length, to a hundredth of a credit, so short pieces cost a
            fraction of one.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              to="/pricing"
              className="rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-accent-400"
            >
              Buy credits
            </Link>
            {summary?.hasBillingAccount ? (
              <button
                type="button"
                onClick={() => void openPortal()}
                disabled={portalPending}
                className="rounded-lg border border-ink-700 px-4 py-2.5 text-sm font-semibold text-ink-200 transition hover:border-ink-600 disabled:opacity-60"
              >
                {portalPending
                  ? 'Opening…'
                  : subscribed
                    ? 'Manage or cancel subscription'
                    : 'Invoices and payment methods'}
              </button>
            ) : null}
          </div>
        </section>

        {subscribed ? (
          <section className="mt-4 rounded-xl border border-ink-800 bg-ink-900 p-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-400">
              Subscription
            </p>
            <p className="mt-3 text-sm text-ink-200">
              Active
              {summary?.currentPeriodEnd
                ? ` — renews ${new Date(summary.currentPeriodEnd).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}`
                : ''}
              .
            </p>
            <p className="mt-2 text-sm leading-relaxed text-ink-400">
              Cancelling stops future charges and keeps every credit you have already received.
              Credits do not expire.
            </p>
          </section>
        ) : summary && summary.subscriptionStatus !== 'active' && summary.plan ? (
          <section className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-6">
            <p className="text-sm text-red-200">
              Your subscription is {summary.subscriptionStatus.replace('_', ' ')}. Open the billing
              portal to update your payment method — credits already in your balance are unaffected.
            </p>
          </section>
        ) : null}

        <section className="mt-8">
          <h2 className="text-sm font-semibold tracking-tight text-ink-100">
            Every credit in and out
          </h2>
          <p className="mt-2 text-sm text-ink-400">
            The complete record for this account. Nothing moves your balance without a line here.
          </p>

          {!summary ? (
            <p className="mt-4 text-sm text-ink-500">Loading…</p>
          ) : summary.ledger.length === 0 ? (
            <p className="mt-4 text-sm text-ink-500">Nothing yet.</p>
          ) : (
            <div className="mt-4 overflow-hidden rounded-xl border border-ink-800">
              <table className="w-full border-collapse text-left text-sm">
                <tbody>
                  {summary.ledger.map((entry, index) => (
                    <tr
                      key={`${entry.createdAt}-${index}`}
                      className="border-b border-ink-800/60 last:border-0"
                    >
                      <td className="px-4 py-3 text-ink-300">
                        {REASON_LABELS[entry.reason] ?? entry.reason}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-ink-500">
                        {new Date(entry.createdAt).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-mono ${
                          entry.delta > 0 ? 'text-accent-400' : 'text-ink-300'
                        }`}
                      >
                        {entry.delta > 0 ? '+' : ''}
                        {entry.delta}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-ink-500">
                        {entry.balanceAfter} left
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="mt-8 text-xs leading-relaxed text-ink-500">
          Card details never reach our servers — payment is handled entirely by Stripe. See the{' '}
          <Link to="/terms" className="underline underline-offset-2 hover:text-ink-300">
            terms
          </Link>{' '}
          for refund and cancellation rules, or the{' '}
          <Link to="/pricing" className="underline underline-offset-2 hover:text-ink-300">
            pricing page
          </Link>{' '}
          for what a credit covers.
        </p>
      </main>
    </div>
  );
}
