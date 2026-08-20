# Getting past the 100-user cap

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
lifetime of the project and cannot be reset. Verification is what removes both
the warning and the cap.

What verification takes depends entirely on which scopes you ask for, and that
is the decision this document is really about.

> Google's own pages are unreachable from the environment these notes were
> written in, so the table above is assembled from Google's documentation as
> quoted in search results rather than read first-hand. Confirm the cap wording
> in the Cloud Console before you rely on the "lifetime, non-resettable" detail
> — it is the one that would hurt to be wrong about.

> **Decision (August 2026): stay on `documents` and verify.** The alternative
> is written out below because it is genuinely the cheaper path and worth
> understanding before committing — but the call has been made, and everything
> from "If you stay on `documents`" onward is the live checklist. Read the fork
> if you want to know what was traded away; skip to
> [what to actually do](#if-you-stay-on-documents) if you just want to submit.

## What to do while you wait

Verification takes weeks. Two things are worth doing on day one rather than at
the end of it:

1. **Publish to production now, before the review finishes.** The 7-day grant
   expiry in Testing is not a nuisance for this product, it is a defect: jobs
   run for hours and users come back, so a token that dies weekly means
   re-consent as a routine part of using a thing they paid for. Production
   removes it while leaving the warning in place. Do this even though the
   warning stays.
2. **Watch the 100-user counter like a runway.** In production and unverified,
   it is 100 sign-ups and then nothing until review lands — and the count does
   not reset. For a paid product that is the whole customer base until Google
   answers. Submit verification the same week you start charging, not after.

The sign-in page and the pricing page both explain the warning screen while
`OAUTH_APP_VERIFIED` is false — what it means, and the Advanced → Go to
TurtleType (unsafe) path through it. Set `OAUTH_APP_VERIFIED=true` the day
verification lands and the explanation disappears on its own.

## The fork in the road

TurtleType currently requests `https://www.googleapis.com/auth/documents` —
read and write access to **every** Google Docs document the user owns. Google
classifies that as a **sensitive** scope, so production means going through
OAuth verification: a review that takes weeks and can come back with change
requests.

There is a second path. `https://www.googleapis.com/auth/drive.file` grants
per-file access — only files your app created, plus files the user explicitly
hands you through the Google Picker. Google classifies it as **non-sensitive
and recommended**, and non-sensitive scopes do not require verification at all.
You publish to production and the cap is gone the same day.

The two paths are worth comparing honestly, because one is a week of
engineering and the other is a month of waiting:

| | `documents` (today) | `drive.file` |
|---|---|---|
| Google classification | Sensitive | Non-sensitive |
| Verification needed | Yes — full review | No |
| Time to unlimited users | Weeks, reviewer-dependent | Same day |
| Annual re-review | Yes | No |
| Consent screen reads | "See, edit, create and delete **all** your Google Docs documents" | "See, edit, create and delete **only the specific files** you use with this app" |
| Work required | None | Google Picker for the existing-doc path |
| Security assessment (CASA) | Not required — that applies to *restricted* scopes, not sensitive ones | Not required |

The consent screen row deserves attention beyond the compliance angle. The
current wording asks a stranger to grant a tool they just found full access to
every document they own. That is a real conversion cost on the signup step, and
it is also, judging by `Landing.tsx`, already a known support problem — there is
a dedicated `missing_permission` error message for people who balk at the
checkbox. The narrower scope removes the objection instead of explaining it.

### What switching would involve

1. **Verify the Docs API accepts `drive.file`.** Google's Drive documentation
   states the scope "works with all Drive API REST Resources", and Docs API
   scopes are documented alongside it, but I could not reach
   `developers.google.com` from this environment to confirm the Docs API
   specifically. Test it before committing: change `config.google.scopes`,
   re-consent, and call `documents.batchUpdate` on a document the app created.
   Ten minutes, and it decides the whole plan.
2. **Creating new documents already works.** `drive.file` covers files the app
   creates, which is the default path in `Controls.tsx`.
3. **The existing-document path needs the Google Picker.** Today the user
   pastes a URL and the server calls `getAppendIndex` on the ID. Under
   `drive.file` that call fails unless the file came through the Picker, so the
   "Use an existing doc" radio becomes a Picker button. This is the only real
   work in the migration.
4. **Existing users must re-consent.** Their current grant is for the old
   scope. `includeGrantedScopes: true` is already set in `auth/routes.ts`, so
   the transition is a re-prompt rather than a break.

The case for switching was: verification is weeks of latency you cannot
compress, and it recurs annually. The case against — the one that won — is that
the Picker is real UI work on the path most users take, `drive.file` cannot
reach a document the user pastes a link to without it, and the ten-minute
compatibility test in step 1 was never run. Verification costs waiting; the
switch costs a rewrite of the existing-doc flow plus forcing every current user
to re-consent.

**This remains the fallback.** If review comes back with change requests you do
not want to meet, or drags past what the launch can absorb, step 1 is still ten
minutes and the escape hatch is still open.

## If you stay on `documents`

Everything below is what the review actually checks. The pages it requires are
now in the repo — `/privacy` and `/terms`, linked from the homepage footer —
because a missing privacy policy is the single most common reason a submission
bounces.

### Before you submit

- [ ] **Own the domain in Search Console.** Verify `turtlegames.org` at
      [search.google.com/search-console](https://search.google.com/search-console),
      using the same Google account that owns the Cloud project. Then add it
      under *APIs & Services → OAuth consent screen → Authorised domains*.
      Every URL you give the reviewer must sit on a verified domain.
- [ ] **Set the operator identity variables.** No longer a code change: the
      pages read `LEGAL_OPERATOR`, `LEGAL_JURISDICTION`, `SUPPORT_EMAIL` and
      `LEGAL_LAST_UPDATED` from `GET /api/legal` at runtime, so a correction a
      reviewer asks for is a variable change and a restart rather than a
      redeploy — which matters when each round trip restarts their clock. The
      first two are required and have no default; the support address already
      defaults to `help@turtlegames.org`. Run `npm run launch:check -w server`
      against the production environment, then load `/privacy` and `/terms` and
      confirm no amber "not configured" notice is showing.
- [ ] **Confirm `help@turtlegames.org` is monitored.** It is the user-support
      email on the consent screen, so Google's review correspondence goes
      there. An unread mailbox stalls the review indefinitely.
- [ ] **Have a lawyer look at the policy.** What is in the repo is accurate to
      what the code does — that is the part I could get right — but accuracy is
      not the same as sufficiency in your jurisdiction, and it is not legal
      advice.
- [ ] **Complete the OAuth consent screen.** App name, user-support email, an
      app logo (120×120 PNG), the homepage, the privacy policy URL, the terms
      URL, and a developer contact email. All required, all checked.
- [ ] **Paste the scope justification.** This is the field the review turns
      on. Text ready to use is in [Scope justification](#scope-justification)
      below.
- [ ] **Record the demo video** to the shot list in
      [Demo video script](#demo-video-script) below. Unlisted YouTube is fine.
- [ ] **Switch publishing status to In production** and submit. (If you took
      the advice above you did this weeks ago — submitting is the part that
      remains.)

### After you submit

Expect an initial response in several business days and the whole process to
run into weeks. Replies from the review team go to the developer contact email
— answer them quickly, because the clock restarts on each round trip. The most
common follow-up is a request to re-record the video showing something they
could not see the first time.

When it is granted, set `OAUTH_APP_VERIFIED=true` on the deploy. That is what
removes the "Google will show a warning first" notice from the sign-in and
pricing pages; nothing else reads the flag, so leaving it false only means
users are warned about a screen they will no longer see.

Note that verification is not permanent: sensitive-scope apps are re-reviewed
annually, and letting that lapse drops you back behind the cap — and back to
`OAUTH_APP_VERIFIED=false` until it is restored.

### What to enter in the Scopes step

The app requests exactly four scopes (`server/src/config.ts`), and the consent
screen should list exactly these — no more:

| Scope | Sensitivity | Why |
|---|---|---|
| `openid` | Non-sensitive | Sign-in |
| `https://www.googleapis.com/auth/userinfo.email` | Non-sensitive | Account identity, billing receipts |
| `https://www.googleapis.com/auth/userinfo.profile` | Non-sensitive | Name and avatar in the UI |
| `https://www.googleapis.com/auth/documents` | **Sensitive** | The whole product |

Passport sends the middle two as the `email` and `profile` shorthands, which is
why the console shows them under their full `userinfo.*` names. Only the last
row triggers verification, and it is the only one with a justification field.

**Add nothing else.** The temptation is to add a Drive scope "in case", and it
is an expensive mistake: `drive`, `drive.readonly` and friends are
**restricted**, not merely sensitive, and restricted scopes require a
third-party CASA security assessment on top of the review — a different order
of cost and delay. Nothing in this codebase needs one. All three Docs calls it
makes are covered by `documents` alone:

- `documents.create` — the new-document path (`docs/documents.ts`)
- `documents.get` — reading the document's length so text appends at the right
  index
- `documents.batchUpdate` — every write

Creating a document does **not** require a Drive scope, which is the usual
reason people reach for one.

### Enabling the API is a separate step

Declaring a scope and enabling the API are different settings, and having one
without the other fails in a way that does not mention the other. If the
**Google Docs API** is not enabled under *APIs & Services → Library*, every job
fails with `403 SERVICE_DISABLED` no matter how the consent screen is
configured. Check it before blaming scopes.

### Scope justification

The field the review turns on. Paste this, adjusting only the operator name:

> TurtleType writes text that the user supplies into a Google Docs document
> that the user nominates. The user pastes their own text into our app, gives
> us a document link or asks us to create a new document, and we insert that
> text into the document gradually over a period the user chooses.
>
> We request `https://www.googleapis.com/auth/documents` for exactly two
> operations, both on documents the user has identified:
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
>
> A narrower scope is not sufficient for our core use case. Most of our users
> want the text written into a document that already exists — an assignment
> template, a shared draft — which they identify to us by pasting its URL.
> `drive.file` grants access only to files our app created or that were passed
> through the Google Picker, so it cannot reach a document identified by link,
> which is the primary flow.

That last paragraph is the one reviewers actually weigh — they ask why
`drive.file` will not do, and "we did not want to build a Picker" is not an
answer. The reason given above is true of the product as it stands: the
existing-document path is a pasted URL. If you later build the Picker, this
justification stops being true, and at that point you should be switching
scopes rather than defending this one.

Everything else above is verifiable against the code, which is what makes it
worth saying: the text never reaches Postgres (`jobs` stores `doc_id`,
`total_chars` and status, never the text), and `getAppendIndex` in
`server/src/docs/documents.ts` is the only read.

### Demo video script

Reviewers reject videos that skip steps or cut between them, because a cut is
where a step could have been hidden. Record in one take, 2–3 minutes, screen
only, with narration. Keep the browser URL bar visible throughout.

1. **Start signed out**, on `https://type.turtlegames.org`. Let the URL bar be
   readable for a beat.
2. **Click Sign in with Google.** On the consent screen, pause long enough that
   the client ID in the URL is legible — they check it matches the project
   under review — and read the requested permission aloud.
3. **Tick the Google Docs permission box** on camera, and say why it is needed
   while you do: *"TurtleType needs this to write my text into the document I
   choose. It reads the document's length so it knows where to add text, and
   nothing else."*
4. **Land in the app** signed in.
5. **Paste text** into the composer.
6. **Choose the existing-document option and paste a Google Docs URL.** This is
   the step that justifies the scope over `drive.file` — do not skip it and do
   not use the create-new-document path here.
7. **Start the job.** Show the progress panel and the cost in credits.
8. **Switch to the Google Doc** in another tab and show the text arriving.
9. **Show the document's version history** (File → Version history) with
   several separate revisions. This is worth including even though review does
   not require it: it shows a reviewer what the product is for, which makes the
   scope request read as purposeful rather than broad.

Do not show a payment flow. It is not what they are reviewing, and it lengthens
the video.

## Separately: check your API quota before you have traffic

This is not part of verification, but it is the next thing that will bite once
the cap is gone, and it is invisible until it isn't.

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
