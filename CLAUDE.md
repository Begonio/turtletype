# TurtleType

Writes text into a Google Doc the way a human would type it, instead of pasting. Google Docs checkpoints a revision roughly every 2 minutes, so a paste or fast scripted typing collapses into one obviously-machine-made edit. TurtleType paces input around that checkpoint interval so the revision history looks human.

## Flow

1. User signs in with Google, pastes text, picks a target duration, points it at a doc ID.
2. Server plans the whole session upfront in memory: an event sequence of per-character delays, thinking pauses, typos, and deferred corrections.
3. Types in bursts of ~55-150 characters separated by 150+ second rests (deliberately above the Docs checkpoint interval, so each burst becomes its own revision).
4. Writes about a third of those bursts "laboured" — one long stall mid-burst, so the burst runs past a checkpoint and a revision lands mid-sentence. The rest go down in flow, twenty seconds each.
5. Plants realistic typos (QWERTY-adjacent slips, transpositions), keeps typing, circles back to fix them a revision or two later.
6. Streams progress to the browser over SSE with a countdown. Job runs server-side, so the user can close the tab.

Typical result on a ~400-char sample: ~7 revisions over 19 minutes, ~54 chars each, with a couple of standalone correction edits.

## Stack

Monorepo, npm workspaces, `server/` + `client/`, TypeScript throughout, ESM.

**Backend (`server/`)**
- Node.js + Express
- Passport + `passport-google-oauth20` (scopes: openid, email, profile, `documents`)
- `express-session` + `connect-pg-simple`
- PostgreSQL via `pg` — users, tokens, jobs
- Google Docs REST API v1 called directly with `fetch` (base URL is env-configurable for integration tests against a fake Docs server)
- SSE for job progress, with event IDs and `Last-Event-ID` replay
- Tests: `node:test` + `node:assert`, run via `tsx`

**Frontend (`client/`)**
- React + TypeScript, Vite
- Zustand for state
- Tailwind CSS
- React Router
- `EventSource` for the SSE stream

**Billing (`server/src/billing/`)**
- Stripe Checkout (packs + one subscription) and the hosted billing portal
- Credits: 1 credit = 10,000 chars, priced per job and charged on submission
- `credit_ledger` is the source of truth; `users.credits` is a cache of it
- Off entirely unless both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set — except in production, where `launchChecks.ts` refuses to boot a deploy that cannot bill (`ALLOW_FREE_MODE=true` opts out deliberately)
- New accounts get 1 free credit (`SIGNUP_GRANT_CREDITS`) as the trial; the paywall bites from the second job
- Dashboard setup, webhook events and the go-live path: `docs/stripe-setup.md`
- `npm run stripe:verify -w server` checks Stripe's real prices against the catalog's cached `amountCents` — nothing at runtime compares them, so a drift would silently bill a different figure than the page shows
- Pricing-page figures come from `whatYouGet.ts`, which runs the real planner — never hardcode a duration or revision count into copy
- The landing page's price line is derived from the live catalog for the same reason: it used to read "free while in beta", which stayed on the page after it stopped being true

**Deploy**
- Multi-stage Dockerfile (tini, non-root user, healthcheck)
- Railway, Dockerfile builder, pinned to 1 replica
- Postgres on Railway (internal networking, TLS off)
- Cloudflare DNS + Full (strict) SSL, live at `type.turtlegames.org`
- `docker-compose.yml` + Caddy as a self-host alternative

## Invariants — do not break these

- **Never one API call per character or word.** Events accumulate in a buffer and flush as a single `batchUpdate` every 800ms, gated by a token bucket that keeps it under the Docs 60-writes/min/document quota.
- **`numReplicas: 1` is load-bearing.** The job queue and SSE subscribers live in process memory. A second instance breaks jobs instead of sharing them. Do not casually bump replica count.
- **Rate limiters are per-job, never shared across users.**
- **`humanize.ts` is pure and seedable.** No I/O, deterministic given a seed. This is what makes the engine testable — don't introduce side effects into it. The plan's own wall clock is a counter accumulated as events are emitted, never `Date.now()`.
- **Timing guarantees are measured, not assumed.** The correction gap is computed from the keystroke that made the typo to the edit that fixes it, and topped up only if the plan still owes time. Don't reintroduce blanket multipliers on rests — that was the old approach and it paid for the same guarantee several times over. `DOCS_CHECKPOINT_MS` is the one place the model's assumption about Docs lives; the tests in `humanize.test.ts` under "version-history structure" pin what must not regress when pacing changes.
- **Credit moves and the ledger row explaining them are written in one transaction.** `users.credits` is a cache of `SUM(credit_ledger.delta)`; `reconcile()` proves they agree. Charging for a job and creating the job row are likewise one transaction.
- **Billing operations are idempotent via the unique index on `(reason, reference)`**, never via a check-then-act. The index is global, not per-user, so one Stripe session cannot credit two accounts. Idempotency keys are the *payment object* (Checkout session, invoice), not the event id — Stripe emits several events per payment.
- **Lock the user row before inserting anything that references it.** `INSERT INTO jobs` takes a KEY SHARE lock on `users` for the FK; taking `FOR UPDATE` afterwards is a lock upgrade and two concurrent submissions deadlock. `lockUserCredits` must come first. There is a test for this.
- **Migrations must stay true no-ops on re-run.** `schema.sql` runs on every boot. A `DROP CONSTRAINT`/`ADD CONSTRAINT` pair looks idempotent but takes ACCESS EXCLUSIVE on the table and re-validates every row each time — concurrently with live row locks, that deadlocks. Guard DDL with `IF NOT EXISTS` or a `pg_constraint` check, and note `migrate()` takes an advisory lock so overlapping deploys queue.
- **The Stripe webhook route mounts before `express.json`** and takes the raw body — signature verification needs the exact bytes Stripe signed.
- **Webhooks are the only place credit is created.** A Checkout success URL is just a URL a user can open.
- **`config.ts` keeps secrets behind getters** so pure modules can be imported in tests without a live database.
- **Billing fails open in development and closed in production.** `config.billing.enabled` is false with no Stripe keys and the paywall waves jobs through — correct on a laptop, a silent giveaway on the deploy that is meant to charge. `preflight.ts` runs `launchChecks.ts` and exits non-zero in production unless the deploy can bill, and `hasCredits` answers 503 rather than `next()` if it ever finds itself there anyway. Don't "simplify" either back into a plain `next()`.
- **`launchChecks.ts` is pure** — it reads an env object passed to it, never `process.env` directly, so the launch rules are testable without an environment. Same discipline as `humanize.ts`.
- **Operator identity lives in env, not in the client bundle.** `/privacy` and `/terms` read `LEGAL_OPERATOR`, `SUPPORT_EMAIL`, `LEGAL_JURISDICTION` from `GET /api/legal` at runtime. Google's OAuth review commonly asks for a correction here, and every round trip restarts their clock — a variable change beats a redeploy. An unset jurisdiction renders a visible notice rather than an invented one; don't replace it with a plausible default.
- **`preflight.ts` must stay the first import in `index.ts`.** It validates env before `db/pool.ts` reads it at module load. Reordering imports can silently break env validation.
- **Regenerate `package-lock.json` whenever `package.json` changes.** A rename passed locally and failed on Railway's `npm ci`, because local dev reuses `node_modules` and never revalidates the lockfile.

## Known open issue

`MAX_TEXT_LENGTH` is 200,000 chars, `MAX_JOB_DURATION_MS` caps jobs at 24 hours. At current pacing, anything over roughly 36,000 characters has a minimum runtime that exceeds the job's own max duration (it was ~26,000 before the pacing work in `humanize.ts`). Still unresolved for genuinely long documents. Flag this if asked to raise the length limit further.

The remaining lever is burst size: duration is essentially `bursts x (burst span + rest)`, and burst size is fixed at 55-150 chars regardless of length, so a 40,000-char document plans 348 revisions. No human produces that in one document — real long documents are written across sessions. Scaling `BURST_MIN_CHARS` / `BURST_MAX_CHARS` up with text length would cut the runtime proportionally, but it trades away history granularity (each revision becomes a bigger lump of new text), so it is a product decision, not a tuning one.

## Google OAuth verification

The app is capped at 100 test users because `auth/documents` is a **sensitive**
scope and the OAuth app is in Testing status. **Decision (August 2026): stay on
`documents` and go through verification** rather than switching to the
non-sensitive `drive.file` scope — the existing-doc path is a pasted URL, which
`drive.file` cannot reach without a Google Picker nobody has built. That
remains the documented fallback if review drags.

Publishing status and verification are **separate settings**. In production but
unverified, users still meet the "Google hasn't verified this app" interstitial
and the app is capped at 100 new users for the lifetime of the project — but
grants stop expiring every 7 days, which in Testing they do. So publish to
production early and submit verification early; only verification lifts the
warning and the cap.

`OAUTH_APP_VERIFIED` drives the sign-in warning notice (`UnverifiedAppNotice`)
and nothing else. It is a flag rather than hardcoded copy for the same reason
the landing page stopped hardcoding "free while in beta" — a notice about a
temporary state outlives the state unless something removes it.

`docs/google-oauth-verification.md` holds the submission checklist, the scope
justification text, and the demo-video shot list.
`docs/go-live.md` is the wider launch sequence (identity → billing → OAuth).

The scope justification tells reviewers document content is never stored — that
is true today (`jobs` holds `doc_id`, `total_chars` and status, never text) and
it is the strongest claim in the submission. If a change would make it false,
that change breaks the verification, not just a comment.

`npm run launch:check -w server` is the gate before submitting: stricter than
the boot check, and it fails while the legal identity variables are unset.

## Working conventions

- TypeScript throughout, ESM. Match existing style, don't introduce CommonJS.
- Keep timing/humanization logic (`humanize.ts` and friends) pure — no fetch, no db calls, no Date.now() side effects that break seedability.
- When touching anything that writes to Docs, check it against the batching/rate-limit invariant above before proposing a change.
- When touching deploy config (Dockerfile, Railway config, replica count), flag the single-replica constraint before changing it.
