import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type LegalEntity } from '../lib/api';

/**
 * Privacy policy and terms.
 *
 * These exist for a specific reason beyond good manners: Google's OAuth
 * verification requires a privacy policy hosted on the same verified domain as
 * the app, linked from both the homepage and the OAuth consent screen, and
 * describing what is done with the data each requested scope grants access to.
 * An app requesting a sensitive scope without one does not get through review.
 *
 * Everything below is written to match what the code actually does. If the
 * data handling changes, this changes with it — a policy that overstates or
 * understates what happens is worse than none, both for users and for review.
 *
 * Who operates the service comes from the API rather than from a constant
 * here. A reviewer asking for the operator name or support address to be
 * corrected is a common round trip, and each round trip restarts their clock —
 * so that correction should be an environment variable on the platform, not a
 * rebuild of this bundle.
 */
function useLegalEntity(): LegalEntity | null {
  const [entity, setEntity] = useState<LegalEntity | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .legal()
      .then((value) => {
        if (!cancelled) setEntity(value);
      })
      // A failed fetch leaves the fallbacks below in place. The policy text is
      // the part that matters for review and it is all static; the identity is
      // one line of it, and a blank page would be the worse failure.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return entity;
}

/** The operator's name, or the product name until the real one has loaded. */
function operatorName(entity: LegalEntity | null): string {
  return entity?.operator ?? 'TurtleType';
}

/** Contact address as a mailto, degrading to prose before it is known. */
function Contact({ entity }: { entity: LegalEntity | null }) {
  if (!entity?.contactEmail) return <>our support address</>;
  return (
    <a
      href={`mailto:${entity.contactEmail}`}
      className="text-accent-400 underline underline-offset-2"
    >
      {entity.contactEmail}
    </a>
  );
}

function Shell({
  title,
  entity,
  children,
}: {
  title: string;
  entity: LegalEntity | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-full bg-ink-950">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-6">
        <Link to="/" className="font-mono text-sm tracking-tight text-ink-200">
          turtle<span className="text-accent-500">type</span>
        </Link>
        <nav className="flex items-center gap-5 text-sm text-ink-300">
          <Link to="/privacy" className="transition hover:text-ink-200">
            Privacy
          </Link>
          <Link to="/terms" className="transition hover:text-ink-200">
            Terms
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-3xl px-6 pb-24">
        <h1 className="pt-8 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 font-mono text-xs text-ink-500">
          {entity ? `Last updated ${entity.lastUpdated}` : '\u00a0'}
        </p>
        <div className="mt-10 space-y-8 text-sm leading-relaxed text-ink-300">{children}</div>
      </main>
    </div>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold tracking-tight text-ink-100">{heading}</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function Privacy() {
  const entity = useLegalEntity();

  return (
    <Shell title="Privacy policy" entity={entity}>
      <p>
        TurtleType writes text you provide into a Google Docs document on your behalf. This policy
        describes exactly what data that involves, why each piece is needed, and how long it is
        kept. It is written to be checkable against the service's behaviour rather than to be
        comprehensive-sounding.
      </p>

      <Section heading="Google account data we access">
        <p>
          Signing in with Google grants TurtleType three things, and nothing else is requested:
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <span className="text-ink-200">Your name, email address and profile picture</span> —
            used to identify your account, show who is signed in, and contact you about your jobs
            or billing.
          </li>
          <li>
            <span className="text-ink-200">Access to your Google Docs documents</span> — used
            solely to write the text you submit into the document you choose, and to read that
            document's current length so new text is appended in the right place. TurtleType does
            not read, index, analyse, or store the contents of any document.
          </li>
          <li>
            <span className="text-ink-200">An offline refresh token</span> — required because a job
            deliberately runs for hours after you close the tab. Without it, a job would stop the
            moment your access token expired.
          </li>
        </ul>
      </Section>

      <Section heading="What is stored, and what is not">
        <p>
          <span className="text-ink-200">The text you submit is never written to our database.</span>{' '}
          It is held in the server's memory only for as long as the job is running, and is
          discarded when the job ends, is cancelled, or the process restarts. There is no copy of
          your writing on our side after that.
        </p>
        <p>Our database holds only:</p>
        <ul className="ml-5 list-disc space-y-2">
          <li>Your Google account identifier, email address, name and profile picture URL.</li>
          <li>
            Your Google access and refresh tokens, so a running job can keep writing. These are
            deleted when you sign out of all sessions or revoke access.
          </li>
          <li>
            For each job: the target document's ID and URL, how many characters were requested and
            written, its status and timestamps, and any error message. Not the text.
          </li>
          <li>
            Billing records: a Stripe customer identifier, your credit balance, and a ledger of
            every credit added or spent. Card details never reach our servers — Stripe handles
            payment entirely.
          </li>
        </ul>
      </Section>

      <Section heading="Limited use">
        <p>
          TurtleType's use of information received from Google APIs adheres to the{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent-400 underline underline-offset-2"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. Specifically: Google user data is used only to
          provide the writing feature you asked for, is never sold, is never used for advertising,
          and is never used to train machine-learning models. No human reads your documents.
        </p>
      </Section>

      <Section heading="Sharing">
        <p>
          Data is not sold or shared for advertising. It reaches third parties only where the
          service cannot function otherwise: Google (to write your document), our hosting and
          database provider (to run the service), and Stripe (to take payment). Each processes data
          only to provide their service to us.
        </p>
      </Section>

      <Section heading="Retention and deletion">
        <p>
          Job records are kept so you can see your own history. You can delete your account and
          everything associated with it by emailing <Contact entity={entity} />; we remove your
          account, tokens and job records within 30 days. Billing records are retained where tax or
          accounting law requires it.
        </p>
        <p>
          You can revoke TurtleType's access to your Google account at any time from{' '}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent-400 underline underline-offset-2"
          >
            your Google account permissions page
          </a>
          . Any running job stops the next time it tries to write.
        </p>
      </Section>

      <Section heading="Security">
        <p>
          Traffic is encrypted in transit. Google tokens are held in our database and used only by
          the job runner. Sessions are cookie-based, HTTP-only, and scoped to this site.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          {operatorName(entity)} operates this service. Privacy questions, data requests and
          deletion requests go to <Contact entity={entity} />.
        </p>
      </Section>
    </Shell>
  );
}

export function Terms() {
  const entity = useLegalEntity();

  return (
    <Shell title="Terms of service" entity={entity}>
      <Section heading="What the service does">
        <p>
          TurtleType writes text you supply into a Google Docs document over an extended period,
          simulating the pacing of a person typing. You choose the text and the destination
          document; the service performs the writing.
        </p>
      </Section>

      <Section heading="Your responsibilities">
        <p>
          You are responsible for the text you submit and for how you use the resulting document.
          You must have the right to write to the document you nominate, and to use the text you
          provide.
        </p>
        <p>
          Many schools, universities and employers have rules about how work is produced and
          submitted. Using this service does not change those rules, and following them is your
          responsibility, not ours. If you are submitting work for academic credit or professional
          assessment, check what your institution permits before using TurtleType.
        </p>
        <p>Do not use the service to write content that is unlawful, or to impersonate anyone.</p>
      </Section>

      <Section heading="Credits and payment">
        <p>
          Jobs are priced in credits. One credit covers a fixed number of characters, shown on the
          pricing page, and the cost of a job is shown before you start it. Credits bought in a
          pack do not expire. Credits included with a subscription are added to your balance each
          billing period and likewise do not expire.
        </p>
        <p>
          If a job fails, its credits are returned to your balance automatically. If you cancel a
          job before roughly a tenth of the text has been written, its credits are returned; after
          that point they are not, because the work has largely been done.
        </p>
        <p>
          Subscriptions renew monthly until cancelled. You can cancel at any time from the billing
          portal; cancellation stops future charges and leaves credits you have already received.
        </p>
      </Section>

      <Section heading="Refunds">
        <p>
          If the service does not do what it says, contact <Contact entity={entity} /> and we will
          refund the purchase. Refunding a purchase removes the credits it provided.
        </p>
      </Section>

      <Section heading="Availability">
        <p>
          Jobs run for hours and depend on Google's API remaining available and your permission
          remaining granted. We do not guarantee uninterrupted service. Where a job fails for any
          reason, your credits come back — that is the remedy the service offers, and it is
          automatic.
        </p>
      </Section>

      <Section heading="Liability">
        <p>
          The service is provided as is. To the extent the law allows, {operatorName(entity)}'s
          liability for any claim relating to the service is limited to the amount you paid for it
          in the twelve months before the claim.
        </p>
      </Section>

      <Section heading="Changes and governing law">
        <p>
          These terms may change; material changes will be announced on this page with a new date.
        </p>
        {entity?.jurisdiction ? (
          <p>They are governed by the laws of {entity.jurisdiction}.</p>
        ) : entity ? (
          // Deliberately visible rather than a plausible-looking default. An
          // invented governing law is a worse thing to publish than an
          // obvious gap, and this is the sentence a Google reviewer and a
          // disputing customer both read. LEGAL_JURISDICTION fixes it.
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-200">
            Governing law has not been configured for this deployment. Set{' '}
            <code className="font-mono text-xs">LEGAL_JURISDICTION</code> before accepting
            payments.
          </p>
        ) : null}
      </Section>
    </Shell>
  );
}
