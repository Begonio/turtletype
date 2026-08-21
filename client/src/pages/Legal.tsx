import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Wordmark from '../components/Wordmark';
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
      .publicConfig()
      .then((value) => {
        if (!cancelled) setEntity(value.legal);
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
          <Wordmark />
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
            <span className="text-ink-200">
              Access to the specific files you select with this app
            </span>{' '}
            — used only by the Google file picker, so you can choose a document instead of pasting
            its link. The picker runs inside Google and returns only the file you select.
            TurtleType never requests a listing of your Drive.
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

      <Section heading="Who else touches your data">
        <p>
          Your data is never sold, rented, or shared for advertising. It reaches other companies
          only where the service cannot function otherwise, and only these:
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <span className="text-ink-200">Google</span> — to sign you in and to write the document
            you nominate.
          </li>
          <li>
            <span className="text-ink-200">Railway</span> — hosting and the database the account and
            job records live in.
          </li>
          <li>
            <span className="text-ink-200">Cloudflare</span> — DNS and traffic routing for this
            site.
          </li>
          <li>
            <span className="text-ink-200">Stripe</span> — payment processing. Stripe collects card
            details directly; they never pass through our servers.
          </li>
        </ul>
        <p>
          Each processes data only to provide their service to us. They operate internationally, so
          your data may be processed outside the country you are in, under the transfer safeguards
          those providers maintain.
        </p>
      </Section>

      <Section heading="Cookies and tracking">
        <p>
          TurtleType sets one cookie: a session cookie that keeps you signed in. It is HTTP-only,
          scoped to this site, and necessary for the service to work at all — without it every page
          load would sign you out.
        </p>
        <p>
          <span className="text-ink-200">There is no analytics, advertising, or tracking of any
          kind.</span> No Google Analytics, no advertising pixels, no session recording, no
          third-party scripts watching what you do. That is why this site shows no cookie banner:
          there is nothing to ask consent for beyond the cookie that signs you in.
        </p>
      </Section>

      <Section heading="Your rights over your data">
        <p>
          You can ask us to show you what we hold about you, correct it, delete it, or hand it to
          you in a portable form. You can also object to how we process it or ask us to restrict
          that processing. Write to <Contact entity={entity} /> and we will respond within 30 days.
        </p>
        <p>
          We process your data because it is necessary to provide the service you asked for and to
          take payment for it. Nothing here relies on your consent as a legal basis except the
          Google permission you grant at sign-in, which you can withdraw at any time from your
          Google account.
        </p>
        <p>
          If you are in the UK, the EU, or another region with a data protection authority and you
          think we have handled your data badly, you are entitled to complain to that authority. We
          would rather you told us first, but that right does not depend on it.
        </p>
      </Section>

      <Section heading="Children">
        <p>
          TurtleType is not directed at children. We do not knowingly collect data from anyone under
          13, and accounts must meet the age requirements in the{' '}
          <Link to="/terms" className="text-accent-400 underline underline-offset-2">
            terms of service
          </Link>
          . If you believe a child has given us data, write to <Contact entity={entity} /> and we
          will delete it.
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

      <Section heading="Who can use TurtleType">
        <p>
          You must be 18 or older to buy credits or hold an account that has been paid for. If you
          are under 18 but at least 13, you may use TurtleType only with the involvement of a parent
          or guardian who agrees to these terms and who makes any purchase themselves. TurtleType is
          not for anyone under 13.
        </p>
        <p>
          By using the service you confirm you meet these requirements and that you are able to
          enter into this agreement.
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
          Jobs are priced in credits by the length of the text, charged to a hundredth of a credit
          and rounded up to that hundredth, so a short piece costs a fraction of a credit rather
          than a whole one. How many characters one credit covers is shown on the pricing page, and
          the cost of a job is shown before you start it. Credits bought in a pack do not expire. Credits included with a subscription are added to your balance each
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

      <Section heading="Cancelling a purchase and refunds">
        <p>
          <span className="text-ink-200">Unused credits are refundable for 14 days.</span> If you
          buy a pack and change your mind, write to <Contact entity={entity} /> within 14 days and
          we will refund it, provided the credits are still unspent. You do not have to give a
          reason.
        </p>
        <p>
          If you have already spent some of the credits, we will refund the unspent remainder at the
          price you paid for them. Credits spent on jobs that ran are not refundable — the work was
          done — though a job that fails returns its credits automatically, as described above.
        </p>
        <p>
          If the service does not do what it says it does, contact us and we will refund the
          purchase regardless of the 14 days. Refunding a purchase removes the credits it provided.
        </p>
        <p>
          If you are a consumer in the UK or EU, you have a statutory right to cancel a purchase of
          digital content within 14 days. Nothing here reduces that right, and the policy above is
          meant to be at least as generous as it. Where the two ever disagree, the statutory right
          wins.
        </p>
      </Section>

      <Section heading="Suspension and closing your account">
        <p>
          You can stop using TurtleType at any time, and you can have your account and its data
          deleted by writing to <Contact entity={entity} /> — see the{' '}
          <Link to="/privacy" className="text-accent-400 underline underline-offset-2">
            privacy policy
          </Link>
          . Unspent credits at that point are refundable under the section above.
        </p>
        <p>
          We may suspend or close an account that is using the service unlawfully, attempting to
          impersonate someone, abusing the infrastructure, or charging back payments in bad faith.
          Where we do, we will say why, and we will refund unspent credits unless the account was
          being used to break the law.
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
