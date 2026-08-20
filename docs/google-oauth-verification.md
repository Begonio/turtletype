# Getting past the 100-user cap

The cap is not a quota you can raise. It is what an OAuth app in **Testing**
publishing status gets: at most 100 named test users, each of whom you add by
hand, and their grants expire after 7 days. Moving to **In production** removes
it. What it takes to move there depends entirely on which scopes you ask for,
and that is the decision this document is really about.

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

My recommendation: spend the ten minutes on step 1. If it confirms, do the
Picker work and skip verification entirely. Verification is not hard, but it is
weeks of latency you cannot compress, and it recurs annually.

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
- [ ] **Fill in the placeholders in `client/src/pages/Legal.tsx`.** The `ENTITY`
      constant at the top has four: operator name, contact email, jurisdiction,
      and last-updated date. A reviewer reading `[Operator name]` will reject
      it, and rightly.
- [ ] **Have a lawyer look at the policy.** What is in the repo is accurate to
      what the code does — that is the part I could get right — but accuracy is
      not the same as sufficiency in your jurisdiction, and it is not legal
      advice.
- [ ] **Complete the OAuth consent screen.** App name, user-support email, an
      app logo (120×120 PNG), the homepage, the privacy policy URL, the terms
      URL, and a developer contact email. All required, all checked.
- [ ] **Write the scope justification.** This is the field the review turns on.
      Say plainly: the app writes user-supplied text into a Google Doc the user
      nominates; it needs `documents` to append text to an existing document
      the user identifies by URL and to read the document's current length so
      the insertion point is correct; it does not read, store, index or analyse
      document content. That last clause is true of this codebase — the
      document text is never written to Postgres, only held in memory while the
      job runs — and it is the strongest thing you can say.
- [ ] **Record the demo video.** Unlisted YouTube is fine. Reviewers reject
      videos that skip steps, so show, in one take: the OAuth consent screen
      with the URL bar visible and the client ID legible, ticking the Docs
      permission, landing in the app, pasting text, starting a job, and the
      text appearing in the document. Narrate why the scope is needed at the
      consent step. Two to three minutes.
- [ ] **Switch publishing status to In production** and submit.

### After you submit

Expect an initial response in several business days and the whole process to
run into weeks. Replies from the review team go to the developer contact email
— answer them quickly, because the clock restarts on each round trip. The most
common follow-up is a request to re-record the video showing something they
could not see the first time.

Note that verification is not permanent: sensitive-scope apps are re-reviewed
annually, and letting that lapse drops you back behind the cap.

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
