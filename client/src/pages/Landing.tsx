import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Wordmark from '../components/Wordmark';
import GoogleButton from '../components/GoogleButton';
import UnverifiedAppNotice from '../components/UnverifiedAppNotice';
import { api, type CatalogResponse, type PublicConfig } from '../lib/api';
import { formatCreditsWithUnit } from '../lib/credits';
import { useJobStore } from '../store/useJobStore';

const AUTH_ERRORS: Record<string, string> = {
  auth_failed: 'Google sign-in did not complete. Please try again.',
  access_denied:
    'Sign-in was cancelled, so TurtleType did not get the permission it needs to write to your ' +
    'document. If you stopped at Google’s “hasn’t verified this app” screen, that warning is ' +
    'about our pending review, not about what the app does — choose Advanced → Go to TurtleType ' +
    '(unsafe) to carry on.',
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

const money = (cents: number, currency: string): string =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);

/**
 * The line under the sign-in button.
 *
 * Read off the live catalog rather than written here. The copy this replaced
 * said "free while in beta", which was true right up until it silently was
 * not; deriving it from the same data the pricing page and the checkout use
 * means it cannot go stale again when the grant or the cheapest pack changes.
 */
function priceLine(catalog: CatalogResponse | null): string | null {
  if (!catalog) return null;
  if (!catalog.enabled) return 'Free on this deployment · no card required';

  const cheapest = catalog.skus
    .filter((sku) => sku.kind === 'pack' && sku.available)
    .sort((a, b) => a.amountCents - b.amountCents)[0];
  const from = cheapest ? `packs from ${money(cheapest.amountCents, cheapest.currency)}` : null;

  if (catalog.signupGrantCredits > 0) {
    const chars = Math.floor(
      catalog.signupGrantCredits * catalog.charsPerCredit,
    ).toLocaleString();
    const grant = `${formatCreditsWithUnit(catalog.signupGrantCredits)} free on sign-up — ${chars} characters, no card needed`;
    return from ? `${grant} · then ${from}` : grant;
  }

  return from ? `Credits ${from}` : 'Sign in to get started';
}

export default function Landing() {
  const user = useJobStore((state) => state.user);
  const authChecked = useJobStore((state) => state.authChecked);
  const [params] = useSearchParams();
  const authError = params.get('error');
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [publicConfig, setPublicConfig] = useState<PublicConfig | null>(null);
  const price = priceLine(catalog);

  // Public endpoint, so this runs signed out — which is the only state that
  // sees this page. A failure leaves the line out entirely rather than
  // showing a price that might be wrong.
  useEffect(() => {
    void api.catalog().then(setCatalog).catch(() => {});
    // Names the operator in the footer. Google's homepage review checks that a
    // visitor can tell who runs the service, not only what it does.
    void api.publicConfig().then(setPublicConfig).catch(() => {});
  }, []);

  // Deliberately no redirect to /app for signed-in visitors.
  //
  // This page used to bounce anyone with a session straight into the app,
  // which made the homepage unreachable for exactly the person who most needs
  // to read it: a Google verification reviewer, who signs in to test the app
  // and then goes back to the homepage URL to check it against the consent
  // screen. "Visible to users without requiring them to log-in" is not
  // satisfied by a page that becomes invisible once they do. Signed-in users
  // get a prominent link into the app instead.

  return (
    <div className="min-h-full bg-ink-950">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <span className="font-mono text-sm tracking-tight text-ink-200">
          <Wordmark />
        </span>
        <nav className="flex items-center gap-5 text-sm">
          <Link to="/pricing" className="text-ink-300 transition hover:text-ink-200">
            Pricing
          </Link>
          {/* Google's homepage review requires the privacy policy to be linked
              from the homepage itself, and checks the URL against the one on
              the consent screen. Keeping it in the header as well as the
              footer means it is visible without scrolling. */}
          <Link to="/privacy" className="text-ink-300 transition hover:text-ink-200">
            Privacy
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
          {/* The app name in plain text, matching the OAuth consent screen
              exactly. Review rejected an earlier version whose only on-page
              name was a lowercase "turtletype" wordmark. */}
          <h1 className="mt-5 max-w-3xl text-4xl leading-[1.1] font-semibold tracking-tight text-white sm:text-6xl">
            TurtleType
          </h1>
          <p className="mt-4 max-w-2xl text-xl leading-snug text-ink-200 sm:text-2xl">
            Text that arrives in your Google Doc the way a person writes it.
          </p>
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
            {/* Signed-in visitors are no longer redirected away from this page,
                so the call to action has to make sense for them too. */}
            {authChecked && user ? (
              <Link
                to="/app"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-medium text-ink-950 transition hover:bg-ink-200"
              >
                Open the app →
              </Link>
            ) : (
              <GoogleButton />
            )}
            {price ? (
              <span className="text-sm text-ink-400">
                {price} ·{' '}
                <Link to="/pricing" className="underline underline-offset-2 hover:text-ink-200">
                  Pricing
                </Link>
              </span>
            ) : null}
          </div>

          <UnverifiedAppNotice className="mt-8" />
        </section>

        {/* "Fully describe your app's functionality to users" — the review
            criterion the three-step grid alone did not satisfy. */}
        <section className="mb-10">
          <h2 className="text-2xl font-semibold tracking-tight text-white">
            What TurtleType does
          </h2>
          <div className="mt-4 max-w-3xl space-y-4 text-base leading-relaxed text-ink-300">
            <p>
              TurtleType is a web app that types text into a Google Docs document for you, slowly,
              the way a person would. You sign in with Google, paste the text you have written,
              point it at a document, and choose how long the writing should take — anything from
              the shortest believable time for that text up to a full day.
            </p>
            <p>
              It then writes into that document over that period. Instead of inserting everything
              at once, it works in short sittings a few minutes apart, varies its typing speed,
              pauses at punctuation and paragraph breaks, makes occasional typos and comes back to
              correct them a few minutes later. The job runs on our servers, so you can close the
              tab and it carries on.
            </p>
            <p>
              The result is a document whose Google Docs version history shows the text being
              written across many revisions, rather than appearing in a single paste. That history
              is the entire point of the product — if you only need the text in the document, copy
              and paste is faster, free, and the right tool.
            </p>
            <p>
              TurtleType is paid. Jobs are priced in credits by the length of the text — to a
              hundredth of a credit, so you pay for what you actually write. The cost of a job is
              shown before you start it, and{' '}
              <Link to="/pricing" className="text-accent-400 underline underline-offset-2">
                the pricing page
              </Link>{' '}
              lists what a credit buys.
            </p>
          </div>
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

        {/* "Explain with transparency the purpose for which your app requests
            user data." This was a line of grey small print under the sign-in
            button before review; it is now a section a reviewer cannot miss,
            and it says the same things as /privacy. */}
        <section className="mt-16">
          <h2 className="text-2xl font-semibold tracking-tight text-white">
            Why TurtleType asks for access to your Google account
          </h2>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-ink-300">
            Signing in asks for four things. Each one is needed for the app to do what it says, and
            nothing else is requested.
          </p>

          <dl className="mt-6 grid gap-px overflow-hidden rounded-xl border border-ink-800 bg-ink-800">
            <div className="bg-ink-900 p-6">
              <dt className="text-base font-medium text-ink-100">
                Your name, email address and profile picture
              </dt>
              <dd className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-400">
                So we can create your account, show you who is signed in, and email you about your
                jobs and your receipts.
              </dd>
            </div>
            <div className="bg-ink-900 p-6">
              <dt className="text-base font-medium text-ink-100">
                Permission to see, edit, create and delete your Google Docs documents
              </dt>
              <dd className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-400">
                This is what lets TurtleType write into your document. We use it for exactly two
                things: inserting the text you gave us into the document you nominated, and reading
                that document's current length so the text is added at the end instead of over the
                top of what is already there. Google words this permission broadly because it is a
                single, all-or-nothing permission for Docs — there is no narrower version we can ask
                for that still reaches a document you paste a link to.
              </dd>
            </div>
            <div className="bg-ink-900 p-6">
              <dt className="text-base font-medium text-ink-100">
                Permission to open the specific files you choose with this app
              </dt>
              <dd className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-400">
                This is what powers the “choose a document” button, which opens Google's own file
                picker so you can select a doc instead of hunting for its link. The picker runs
                inside Google and hands us nothing but the one file you click — we cannot see the
                rest of your Drive, and we never ask Google for a list of your files.
              </dd>
            </div>
            <div className="bg-ink-900 p-6">
              <dt className="text-base font-medium text-ink-100">
                Permission to keep working while you are away
              </dt>
              <dd className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-400">
                A job deliberately runs for hours. Without offline access it would stop the moment
                your sign-in expired, usually within the hour.
              </dd>
            </div>
          </dl>

          <div className="mt-6 max-w-3xl space-y-3 text-base leading-relaxed text-ink-300">
            <p className="text-ink-200">What TurtleType never does with that access:</p>
            <ul className="ml-5 list-disc space-y-2 text-ink-400">
              <li>
                It never opens a document you did not point it at — not to read it, list it, or
                anything else. Browsing happens inside Google's own picker; TurtleType never asks
                Google for a list of your files.
              </li>
              <li>
                It never stores the text you submit. That text is held in memory only while your job
                runs and is gone when it finishes.
              </li>
              <li>
                It never sells your data, uses it for advertising, or uses it to train
                machine-learning models. No human here reads your documents.
              </li>
            </ul>
            <p>
              You can withdraw this access at any time from{' '}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent-400 underline underline-offset-2"
              >
                your Google account permissions page
              </a>
              . The{' '}
              <Link to="/privacy" className="text-accent-400 underline underline-offset-2">
                privacy policy
              </Link>{' '}
              sets all of this out in full, including who else touches your data and how to have it
              deleted.
            </p>
          </div>
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
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 text-xs text-ink-400 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-md">
            {/* Identifies who is behind the app, which the homepage review
                checks alongside what the app does. */}
            TurtleType
            {publicConfig?.legal.operator && publicConfig.legal.operator !== 'TurtleType'
              ? ` is operated by ${publicConfig.legal.operator}.`
              : '.'}{' '}
            Built for people who want their words to land like they were written, not pasted.
            {publicConfig?.legal.contactEmail ? (
              <>
                {' '}
                Contact{' '}
                <a
                  href={`mailto:${publicConfig.legal.contactEmail}`}
                  className="underline underline-offset-2 transition hover:text-ink-200"
                >
                  {publicConfig.legal.contactEmail}
                </a>
                .
              </>
            ) : null}
          </p>
          {/* Google's OAuth verification checks that the privacy policy is
              linked from the homepage, not just reachable by URL. */}
          <nav className="flex shrink-0 items-center gap-4">
            <Link to="/pricing" className="transition hover:text-ink-200">
              Pricing
            </Link>
            <Link to="/privacy" className="transition hover:text-ink-200">
              Privacy
            </Link>
            <Link to="/terms" className="transition hover:text-ink-200">
              Terms
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
