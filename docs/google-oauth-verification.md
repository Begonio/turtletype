# Getting past the 100-user cap

**Decision reversed (20 August 2026): TurtleType now requests
`https://www.googleapis.com/auth/drive.file`, not `auth/documents`.** Google's
verification review refused the broader scope under the minimum-scope rule and
recommended the narrower one by name. The fallback documented here since
August has become the plan. What that took, and what still has to happen in the
Cloud Console, is [below](#the-migration).

**Correction (August 2026):** an earlier version of this document said moving
to **In production** removes the cap. It does not. Publishing status and
verification are two different things, and only the second one lifts the cap.

There are three states, not two:

| | Test users | Grant lifetime | "Unverified app" warning | Cap |
|---|---|---|---|---|
| **Testing** | Only accounts you add by hand, max 100 | **7 days**, then re-consent | Yes | 100 hand-added testers |
| **In production**, unverified | Anyone | Normal | **Yes, still** | **100 new users, for the lifetime of the project** |
| **In production**, verified | Anyone | Normal | No | None |

Publishing to production without verification buys two real things — anyone can
sign in, and grants stop dying every 7 days — and costs one: you start spending
a 100-user allowance that, per Google's documentation, applies over the entire
lifetime of the project and cannot be reset.

**On `drive.file` none of this applies.** The scope is non-sensitive, so there
is nothing to verify, no cap, and no warning screen — that is the whole reason
the review pushed us here, and the whole reason it is worth the work.

> Google's own pages are unreachable from the environment these notes were
> written in, so the table above is assembled from Google's documentation as
> quoted in search results rather than read first-hand. Confirm the cap wording
> in the Cloud Console before you rely on the "lifetime, non-resettable" detail
> — it is the one that would hurt to be wrong about.

## What Google actually said

The verification console shows four checks green — app functionality, branding,
appropriate data access — and one red:

> **Request minimum scopes.** Your app does not appear to use the minimum
> scope(s) necessary for functionality.

The accompanying mail from the Trust and Safety team names `auth/documents`,
recommends `drive.file`, and sets out two ways to answer:

- **Option 1** — add the recommended scope, remove the ones the app does not
  need from both the codebase and the Cloud project, and reply *"Confirming
  narrower scopes"*.
- **Option 2** — reply *"Unable to use narrower scopes"* with a justification.

Two sentences in that mail close off Option 2 for this app:

1. *"UI preferences or client library limitations alone are not valid policy
   exceptions from these requirements."* The justification this repo had
   prepared — that our existing-document path is a pasted URL, which
   `drive.file` cannot reach — is precisely a UI argument.
2. The mail points at `DocsView.setFileIds()`, added to the Google Picker API
   in January 2025, which opens a picker **pre-navigated to a file ID the app
   already knows**. That is the pasted-URL flow, preserved, with one
   confirmation click added. Google pre-empted our objection and then handed us
   the fix.

So the answer is Option 1, and the old justification is now false anyway: it
ended with the line *"If you later build the Picker, this justification stops
being true, and at that point you should be switching scopes rather than
defending this one."* The Picker is built.

## The migration

### What changed in the code

| | Before | After |
|---|---|---|
| Scope requested | `auth/documents` | `auth/drive.file` |
| Reach | Every document the account owns | Documents this app created + documents handed over through the Picker |
| Existing-doc flow | Paste a URL, server calls `documents.get` on the ID | Paste a URL *or* browse, confirm in the Google Picker, server gets an ID Google has granted |
| Verification | Required, weeks, annually | Not required |
| Consent screen reads | "See, edit, create and delete **all** your Google Docs documents" | "See, edit, create and delete **only the specific files** you use with this app" |

- `config.google.docsAccessScope` is the single place the scope string lives.
- `routes/picker.ts` (`GET /api/picker/session`) hands the browser its own
  access token plus the Picker API key. It is load-bearing, not a convenience:
  without it there is no way to reach a document the user already has.
- `client/src/lib/picker.ts` loads the Picker and, when the paste box holds a
  recognisable link, calls `setFileIds` so the user lands on that exact
  document rather than hunting for it.
- `users.granted_scopes` records what each account granted. Rows from before
  the migration hold the old scope (or NULL, from before the column existed),
  and both answer "no" — so those accounts are sent through consent once, the
  first time they open the picker. That is the whole migration for an existing
  user.

**The Docs API accepts `drive.file` for all three calls this app makes** —
`documents.create`, `documents.get` and `documents.batchUpdate` all list it
among their authorization scopes. That was the ten-minute question the old
version of this document flagged as never having been answered; it is answered.
Confirm it against a real document before submitting anyway — it is still the
assumption the whole plan rests on.

### What still has to happen in the Cloud Console

Code alone does not change what Google sees. All of this is manual:

- [ ] **Enable the Google Picker API** under *APIs & Services → Library*.
      Separate setting from the Docs API, and a missing one fails in a way that
      does not mention the other.
- [ ] **Create a browser API key** under *APIs & Services → Credentials*,
      restrict it by HTTP referrer to `type.turtlegames.org`, and set it as
      `GOOGLE_PICKER_API_KEY` on the deploy. Without it the existing-document
      option switches itself off — deliberately, rather than failing at job
      start.
- [ ] **Set `GOOGLE_PROJECT_NUMBER`** (the project *number*, not the ID). The
      Picker needs it to name the app being granted access and to show files on
      shared drives.
- [ ] **Add `auth/drive.file`** to the OAuth consent screen's scope list.
- [ ] **Remove `auth/documents`** from the consent screen. Google's mail says
      *"DO NOT remove any previously approved scopes"* — `auth/documents` was
      never approved, it is the scope under review, so it goes. Removing it is
      what actually makes the app non-sensitive.
- [ ] **Reply to the Trust and Safety mail** with the text below. Nothing moves
      until you reply — the mail is explicit that the request stays open until
      you confirm.
- [ ] **Set `OAUTH_APP_VERIFIED=true`** once the sensitive scope is gone from
      the consent screen. With only non-sensitive scopes there is no unverified
      warning to prepare people for, and a notice about a screen they will not
      see is worse than no notice. Nothing in the code can detect the console
      change, which is why this is a flag.
- [ ] **Run `npm run launch:check -w server`** against the production
      environment. It now fails on a missing Picker key as well as the legal
      identity variables.

### The reply to send

Reply directly to the Trust and Safety mail, keeping it on the same thread:

> Confirming narrower scopes.
>
> We have migrated TurtleType to `https://www.googleapis.com/auth/drive.file`
> and removed `https://www.googleapis.com/auth/documents` from both our
> application codebase and our Cloud Console project.
>
> Our existing-document flow previously relied on a user pasting a document
> URL. We have replaced it with the Google Picker, using
> `DocsView.setFileIds()` so that a user who pastes a link is taken straight to
> that document in the picker and grants access to that single file. Documents
> we create on the user's behalf are covered by `drive.file` already. The three
> Docs API methods we call — `documents.create`, `documents.get` and
> `documents.batchUpdate` — are all authorized by `drive.file`, so no
> functionality is lost.
>
> No other scopes are requested beyond `openid`, `userinfo.email` and
> `userinfo.profile`, which we use for sign-in and account identity.

### What the migration costs, honestly

- **Every existing user re-consents once.** Their grant is for a scope we no
  longer request. They are sent through the Google screen the first time they
  pick a document, and not again.
- **A pasted link is no longer sufficient by itself.** It survives as a
  shortcut — paste, then confirm in the picker — but the confirmation step is
  real and cannot be removed. That is the point of the scope.
- **Two more things must be right in the Cloud Console**, and both fail
  quietly if they are not. Hence the launch check.

Set against: no verification queue, no annual re-review, no 100-user cap, no
"unverified app" interstitial in front of a page that then asks for money, and
a consent screen that asks for one document instead of all of them. The last
one was already a known conversion problem — `Landing.tsx` has a dedicated
`missing_permission` message for people who balked at the old checkbox.

## What the review still checks

Publishing status is separate from verification, and the homepage and privacy
requirements are checked regardless of which scopes you ask for. Everything in
this section stands.

### Before you go live

- [ ] **Own the domain in Search Console.** Verify `turtlegames.org` at
      [search.google.com/search-console](https://search.google.com/search-console),
      using the same Google account that owns the Cloud project. Then add it
      under *APIs & Services → OAuth consent screen → Authorised domains*.
      Every URL you give Google must sit on a verified domain.
- [ ] **Set the operator identity variables.** The pages read `LEGAL_OPERATOR`,
      `LEGAL_JURISDICTION`, `SUPPORT_EMAIL` and `LEGAL_LAST_UPDATED` from
      `GET /api/legal` at runtime, so a correction is a variable change and a
      restart rather than a redeploy. The first two are required and have no
      default. Run `npm run launch:check -w server` against the production
      environment, then load `/privacy` and `/terms` and confirm no amber "not
      configured" notice is showing.
- [ ] **Confirm `help@turtlegames.org` is monitored.** It is the user-support
      email on the consent screen, so Google's correspondence goes there. An
      unread mailbox stalls everything indefinitely — including the reply above.
- [ ] **Have a lawyer look at the policy.** What is in the repo is accurate to
      what the code does — that is the part I could get right — but accuracy is
      not the same as sufficiency in your jurisdiction, and it is not legal
      advice.
- [ ] **Complete the OAuth consent screen.** App name, user-support email, an
      app logo (120×120 PNG), the homepage, the privacy policy URL, the terms
      URL, and a developer contact email.

### What to enter in the Scopes step

The app requests exactly four scopes (`server/src/config.ts`), and the consent
screen should list exactly these — no more:

| Scope | Sensitivity | Why |
|---|---|---|
| `openid` | Non-sensitive | Sign-in |
| `https://www.googleapis.com/auth/userinfo.email` | Non-sensitive | Account identity, billing receipts |
| `https://www.googleapis.com/auth/userinfo.profile` | Non-sensitive | Name and avatar in the UI |
| `https://www.googleapis.com/auth/drive.file` | **Non-sensitive** | The whole product |

Passport sends the middle two as the `email` and `profile` shorthands, which is
why the console shows them under their full `userinfo.*` names.

**Add nothing else.** The temptation is to reach for a wider Drive scope when
the per-file one feels restrictive, and it is an expensive mistake: `drive`,
`drive.readonly` and friends are **restricted**, not merely sensitive, and
restricted scopes require a third-party CASA security assessment — recertified
annually — on top of everything else. `drive.file` requires none of that, which
is exactly why Google recommends it. All three Docs calls this codebase makes
are covered by it:

- `documents.create` — the new-document path (`docs/documents.ts`)
- `documents.get` — reading the document's length so text appends at the right
  index
- `documents.batchUpdate` — every write

### Enabling the APIs is a separate step

Declaring a scope and enabling an API are different settings, and having one
without the other fails in a way that does not mention the other. Two APIs
matter now:

- **Google Docs API** — without it, every job fails with `403 SERVICE_DISABLED`
  no matter how the consent screen is configured.
- **Google Picker API** — without it, the picker will not load and the
  existing-document path is dead.

Check both under *APIs & Services → Library* before blaming scopes.

### Homepage requirements

Review rejected the homepage twice, so these are not optional and they are
checked by a person, not a crawler. What Google asks for, and where it now
lives:

| Requirement | Where it is met |
|---|---|
| Accurately identifies the app and brand | `<h1>TurtleType</h1>`, and the operator named in the footer |
| Fully describes functionality | "What TurtleType does" section |
| Explains why user data is requested | "Why TurtleType asks for access to your Google account" section |
| Hosted on a verified domain you own | `type.turtlegames.org` — verify `turtlegames.org` in Search Console |
| Not on a third-party platform | Own domain, own deploy |
| Links to the privacy policy | Header nav and footer, `/privacy` |
| Visible without logging in | The homepage no longer redirects signed-in visitors |

Three of these have bitten this project already:

**The app name must match the consent screen exactly.** The wordmark used to
render as lowercase `turtletype` while the consent screen said `TurtleType`,
and review rejected it as a mismatch. The name now comes from
`client/src/components/Wordmark.tsx`, which exists so there is one place to get
this right. Do not restyle it to lowercase, and do not replace it with an image
— a name that only appears inside a logo cannot be read as matching.

**The homepage must stay visible after sign-in.** It used to redirect anyone
with a session to `/app`, which meant the reviewer — who signs in to test the
app and then returns to the homepage URL — could not see it at all. "Visible
without requiring login" is not satisfied by a page that disappears once you
have logged in. There is a comment in `Landing.tsx` saying so; do not
reintroduce the redirect.

**The data explanation has to be findable.** It was one line of grey small
print under the sign-in button, which is not "explain with transparency". It is
now a section with a heading, listing each permission and what is never done
with it, saying the same things as `/privacy`.

The homepage URL you enter on the consent screen must be the page that actually
satisfies all of this — `https://type.turtlegames.org`, not a deep link — and
the privacy policy URL there must match the one the homepage links to, exactly,
including the scheme and any trailing slash.

### How to describe the scope

`drive.file` is non-sensitive, so there is no justification field to fill in
and nothing to defend. The description below is what the homepage, `/privacy`
and the consent screen all say, and it is worth keeping them in agreement:

> TurtleType writes text that the user supplies into a Google Docs document
> that the user chooses. The user pastes their own text into our app, then
> either asks us to create a new document or hands us an existing one through
> the Google Picker, and we insert that text into the document gradually over a
> period the user chooses.
>
> We use `https://www.googleapis.com/auth/drive.file` for exactly two
> operations, both on documents the user has explicitly given us:
>
> 1. `documents.batchUpdate` — to insert the user's own text into the document.
>    This is the entire function of the product.
> 2. `documents.get` — to read the document's current length, so that text is
>    appended at the correct index rather than overwriting existing content. We
>    request only the structural fields needed to compute that index.
>
> We do not read, store, index, analyse, or transmit document content. The text
> the user submits is held in server memory only while their job is running and
> is never written to our database; our database stores only the document ID,
> the character count, and the job's status. No document content is used for
> advertising, sold, shared, or used to train machine-learning models, and no
> human at our organisation reads user documents.

Everything in that paragraph is verifiable against the code, which is what
makes it worth saying: the text never reaches Postgres (`jobs` stores `doc_id`,
`total_chars` and status, never the text), and `getAppendIndex` in
`server/src/docs/documents.ts` is the only read. **If a change would make that
false, the change breaks the submission, not just a comment.**

### Demo video script

Not required for a non-sensitive scope, but Google may still ask, and recording
one is the cheapest way to answer a follow-up without another round trip.
Record in one take, 2–3 minutes, screen only, with narration. Keep the browser
URL bar visible throughout — reviewers reject videos that cut between steps,
because a cut is where a step could have been hidden.

1. **Start signed out**, on `https://type.turtlegames.org`. Let the URL bar be
   readable for a beat.
2. **Click Sign in with Google.** On the consent screen, pause long enough that
   the client ID in the URL is legible, and read the requested permission
   aloud — it now says *only the specific files you use with this app*.
3. **Tick the Google Drive permission box** on camera, and say why it is needed
   while you do: *"TurtleType needs this to write my text into the document I
   choose. It reads that document's length so it knows where to add text, and
   it cannot see anything else in my Drive."*
4. **Land in the app** signed in.
5. **Paste text** into the composer.
6. **Choose the existing-document option, paste a Google Docs URL, and open the
   picker.** Show the picker landing on that exact document and confirm it.
   This is the step that shows the narrower scope doing the job the broader one
   used to — do not skip it and do not use the create-new-document path here.
7. **Start the job.** Show the progress panel and the cost in credits.
8. **Switch to the Google Doc** in another tab and show the text arriving.
9. **Show the document's version history** (File → Version history) with
   several separate revisions. It shows a reviewer what the product is for,
   which makes the permission request read as purposeful rather than broad.

Do not show a payment flow. It is not what they are reviewing, and it lengthens
the video.

## Separately: check your API quota before you have traffic

This is not part of verification, but it is the next thing that will bite once
you have users, and it is invisible until it isn't.

The Docs API enforces per-minute write limits per project as well as per user.
The runner caps itself at `DOCS_WRITES_PER_MINUTE` (55) **per job**, and
`MAX_CONCURRENT_JOBS` is 20 — so the worst case this process can generate is
around 1,100 writes/minute against a project-wide limit. In practice jobs are
writing only about a quarter of the time and idle for the rest, so the steady
state is far lower, but a burst where many jobs are mid-sitting at once is
exactly what a Sunday-night deadline produces.

Before you have real traffic, open *APIs & Services → Google Docs API → Quotas*
in the Cloud Console and read your actual write-requests-per-minute limit. If
the headroom is thin, request an increase — that request also takes time, and
it is much easier to make before you need it than during an outage.

## The scaling wall behind all of this

Worth stating plainly since it now has revenue attached: `numReplicas: 1` is
load-bearing. The job queue and the SSE subscriber list live in process memory,
so a second instance does not share load — it breaks jobs. Capacity is
therefore whatever one container can hold, which is 20 concurrent jobs.

At current pacing a 10,000-character document occupies a slot for about six and
a half hours. Twenty slots is roughly 480 job-hours a day, and deadline
clustering means you will not get near full utilisation. That is the real
ceiling on paying customers, and raising it is not a config change: it needs
the queue moved into Postgres or Redis and the SSE channels onto a pub/sub
backend before the replica count can go above one.

Pricing in credits at least makes the constraint visible — you can see
consumption in `credit_ledger` before it becomes a queue backlog.
