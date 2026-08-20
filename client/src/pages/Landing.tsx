import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import GoogleButton from '../components/GoogleButton';
import { useJobStore } from '../store/useJobStore';

const AUTH_ERRORS: Record<string, string> = {
  auth_failed: 'Google sign-in did not complete. Please try again.',
  access_denied: 'You declined the permissions TurtleType needs to write to your document.',
  session_failed: 'We could not start a session. Check that cookies are enabled and try again.',
  missing_permission:
    'Almost there — on the Google screen you need to tick the box for “See, edit, create and delete all your Google Docs documents”. ' +
    'Google requires that to be checked by hand and will not pre-select it. Without it TurtleType cannot write anything.',
};

const STEPS = [
  {
    title: 'Paste your text',
    body: 'Anything from a paragraph to a dissertation. Nothing is stored beyond the job record.',
  },
  {
    title: 'Pick a schedule',
    body: 'It works out the shortest believable time for your text. Stretch it over an afternoon if you like.',
  },
  {
    title: 'Close the tab',
    body: 'It writes in sittings with real gaps between them, so the doc\'s version history reads as written, not pasted.',
  },
];

export default function Landing() {
  const user = useJobStore((state) => state.user);
  const authChecked = useJobStore((state) => state.authChecked);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const authError = params.get('error');

  useEffect(() => {
    if (authChecked && user) navigate('/app', { replace: true });
  }, [authChecked, user, navigate]);

  return (
    <div className="min-h-full bg-ink-950">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <span className="font-mono text-sm tracking-tight text-ink-200">
          turtle<span className="text-accent-500">type</span>
        </span>
        <nav className="flex items-center gap-5 text-sm">
          <Link to="/pricing" className="text-ink-300 transition hover:text-ink-200">
            Pricing
          </Link>
          {authChecked && user ? (
            <Link to="/app" className="text-ink-300 transition hover:text-ink-200">
              Open the app →
            </Link>
          ) : null}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        <section className="pt-16 pb-20 sm:pt-24">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent-400">
            Google Docs · real-time
          </p>
          <h1 className="mt-5 max-w-3xl text-4xl leading-[1.1] font-semibold tracking-tight text-white sm:text-6xl">
            Text that arrives the way a person writes it.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-300">
            TurtleType writes your text into a Google Doc character by character, in sittings
            minutes apart — uneven rhythm, pauses at punctuation, and typos left in the page until a
            later pass catches them. The version history reads as written, not pasted.
          </p>

          {authError ? (
            <div className="mt-8 max-w-xl rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {AUTH_ERRORS[authError] ?? 'Something went wrong signing in. Please try again.'}
            </div>
          ) : null}

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <GoogleButton />
            <span className="text-sm text-ink-400">
              Free while in beta · no card required
            </span>
          </div>

          <p className="mt-4 max-w-xl text-xs leading-relaxed text-ink-400">
            TurtleType asks for permission to edit Google Docs so it can write into the document you
            choose. It never reads your Drive and never opens a file you did not point it at.
          </p>
        </section>

        <section className="grid gap-px overflow-hidden rounded-xl border border-ink-800 bg-ink-800 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <div key={step.title} className="bg-ink-900 p-6">
              <span className="font-mono text-xs text-accent-500">0{index + 1}</span>
              <h2 className="mt-3 text-base font-medium text-ink-200">{step.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-400">{step.body}</p>
            </div>
          ))}
        </section>

        <section className="mt-16 mb-24 rounded-xl border border-ink-800 bg-ink-900 p-6">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-400">
            What it looks like
          </p>
          <pre className="mt-4 overflow-x-auto font-mono text-sm leading-relaxed text-ink-200">
<span className="text-ink-400">{`10:02  `}</span>{`The quick brown fox jumps over the lazy `}<span className="text-red-400">{`dogg`}</span>{`.
`}<span className="text-ink-400">{`10:03  `}</span><span className="text-ink-400">{`— thinking —`}</span>{`
`}<span className="text-ink-400">{`10:21  `}</span>{`The quick brown fox jumps over the lazy `}<span className="text-accent-500">{`dog`}</span>{`.  `}<span className="text-ink-400">{`← fixed 19 min later`}</span>{`
`}<span className="text-ink-400">{`10:22  `}</span>{`It does so repeatedly, every single `}<span className="caret text-accent-500">▌</span>
          </pre>
        </section>
      </main>

      <footer className="border-t border-ink-800 py-8">
        <div className="mx-auto max-w-5xl px-6 text-xs text-ink-400">
          TurtleType — built for people who want their words to land like they were written, not
          pasted.
        </div>
      </footer>
    </div>
  );
}
