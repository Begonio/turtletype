import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Composer from '../components/Composer';
import Controls from '../components/Controls';
import ProgressPanel from '../components/ProgressPanel';
import { api } from '../lib/api';
import { isTerminal, useJobStore } from '../store/useJobStore';

export default function AppPage() {
  const user = useJobStore((state) => state.user);
  const authChecked = useJobStore((state) => state.authChecked);
  const phase = useJobStore((state) => state.phase);
  const jobId = useJobStore((state) => state.jobId);
  const attachStream = useJobStore((state) => state.attachStream);
  const detachStream = useJobStore((state) => state.detachStream);
  const signOut = useJobStore((state) => state.signOut);
  const navigate = useNavigate();

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
            human<span className="text-accent-500">type</span>
          </Link>
          <div className="flex items-center gap-4">
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
