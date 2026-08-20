import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Wordmark from '../components/Wordmark';
import Composer from '../components/Composer';
import Controls from '../components/Controls';
import ProgressPanel from '../components/ProgressPanel';
import { api } from '../lib/api';
import { formatCreditsWithUnit } from '../lib/credits';
import { isTerminal, useJobStore } from '../store/useJobStore';

export default function AppPage() {
  const user = useJobStore((state) => state.user);
  const authChecked = useJobStore((state) => state.authChecked);
  const phase = useJobStore((state) => state.phase);
  const jobId = useJobStore((state) => state.jobId);
  const attachStream = useJobStore((state) => state.attachStream);
  const detachStream = useJobStore((state) => state.detachStream);
  const signOut = useJobStore((state) => state.signOut);
  const billingEnabled = useJobStore((state) => state.billingEnabled);
  const refreshCredits = useJobStore((state) => state.refreshCredits);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    if (authChecked && !user) navigate('/', { replace: true });
  }, [authChecked, user, navigate]);

  /**
   * A job outlives the tab it was started from. On mount, re-check any job id
   * we remembered: if it is still going, reconnect the stream; if it finished
   * while we were away, show how it ended.
   */
  useEffect(() => {
    if (!user || !jobId) return;
    let cancelled = false;

    void api
      .getJob(jobId)
      .then(({ job }) => {
        if (cancelled) return;
        useJobStore.setState({
          phase: job.status,
          pct: job.progressPct,
          charsWritten: job.charsWritten,
          totalChars: job.totalChars,
          docUrl: job.docUrl,
          error: job.errorMessage,
        });
        if (!isTerminal(job.status)) attachStream(jobId);
      })
      .catch(() => {
        // The job is gone (old session, cleared database). Drop the stale id.
        if (!cancelled) useJobStore.setState({ jobId: null, phase: 'idle' });
      });

    return () => {
      cancelled = true;
    };
    // Only on mount / sign-in: attachStream is stable and jobId changes are
    // driven by startJob, which attaches its own stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => () => detachStream(), [detachStream]);

  /**
   * Just back from a successful Checkout.
   *
   * The success URL is not evidence of payment — Stripe's webhook is — so this
   * only re-reads the balance, and re-reads it a few times because the webhook
   * and the browser redirect race each other. The query parameter is cleared
   * either way so a refresh does not repeat the poll.
   */
  useEffect(() => {
    if (params.get('checkout') !== 'success') return;
    void refreshCredits();
    const next = new URLSearchParams(params);
    next.delete('checkout');
    setParams(next, { replace: true });
  }, [params, setParams, refreshCredits]);

  if (!authChecked) {
    return (
      <div className="flex min-h-full items-center justify-center text-sm text-ink-400">
        Loading…
      </div>
    );
  }
  if (!user) return null;

  const showProgress = phase !== 'idle';

  return (
    <div className="min-h-full bg-ink-950">
      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="font-mono text-sm tracking-tight text-ink-200">
            <Wordmark />
          </Link>
          <div className="flex items-center gap-4">
            {billingEnabled ? (
              <Link
                to="/billing"
                className="rounded-full border border-ink-700 px-3 py-1 font-mono text-[11px] text-ink-300 transition hover:border-accent-600/60 hover:text-accent-400"
                title="Balance, history and billing"
              >
                {formatCreditsWithUnit(user.credits)}
              </Link>
            ) : null}
            <span className="hidden text-xs text-ink-400 sm:inline">{user.email}</span>
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
                className="h-7 w-7 rounded-full border border-ink-700"
              />
            ) : null}
            <button
              type="button"
              onClick={() => void signOut()}
              className="text-xs text-ink-400 transition hover:text-ink-200"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-col gap-6 lg:flex-row">
          <Composer />
          <Controls />
        </div>

        {showProgress ? (
          <div className="mt-6">
            <ProgressPanel />
          </div>
        ) : null}
      </main>
    </div>
  );
}
