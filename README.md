# TurtleType

Paste text and watch it get written into your Google Doc the way a person would write it — in
sittings minutes apart, with uneven rhythm, pauses at punctuation, and typos left in the text until
a later pass catches them. The doc's version history reads as written, not pasted.

```
client/   Vite + React + TypeScript + Tailwind + Zustand
server/   Express + TypeScript + Passport (Google OAuth) + PostgreSQL
```

---

## How it stays under the Google Docs rate limit

This is the constraint the whole backend is designed around, so it is worth stating plainly.

**The Google Docs API allows roughly 60 write requests per minute, per document.** A naive
implementation sends one `batchUpdate` per character and dies in the first second.

TurtleType never does that:

1. **`humanize.ts` is pure.** It converts text into a flat array of `type` / `backspace` / `pause`
   events with millisecond delays. It performs no I/O and makes no API calls. An entire document is
   planned up front, in memory, in about a millisecond.
2. **The runner replays that array in real time.** Each event's delay is slept out for real — that
   is what makes the typing look human — but the replay loop only ever appends to an in-memory
   buffer.
3. **A separate flush loop drains the buffer every 800ms** as a single `batchUpdate` containing
   everything that happened in that window: merged inserts, and `deleteContentRange` operations for
   backspaces. Typing speed and request rate are completely decoupled, so a job stretched over an
   afternoon issues requests at the same bounded cadence as one running at its minimum.
4. **Every flush passes through a per-job token bucket** capped at `DOCS_WRITES_PER_MINUTE`
   (default 55). Each job constructs its own `RateLimiter`; state is never shared between jobs or
   users, so one heavy user can never eat another's quota.
5. **Every `batchUpdate` is wrapped in exponential backoff with full jitter** — 2s, 4s, 8s, 16s,
   32s, five retries — on `429` and `5xx`. Permanent errors (`400`, `401`, `403`, `404`) fail fast
   instead of burning retries on a certain failure. When retries are exhausted the job fails
   cleanly and the browser gets an `error` SSE event with a human-readable reason.

### One deliberate deviation from the brief

The brief specifies an 800ms flush interval and describes it as "~1.25/sec, well under the cap".
**1.25 requests/second is 75 requests/minute, which is above the 60/minute cap, not below it.**

Rather than silently changing the interval, the implementation keeps the 800ms window *and* puts a
real token bucket in front of it. In steady state the limiter releases ~55 flushes/minute; when the
bucket is empty a flush simply waits, the buffer keeps accumulating, and the next `batchUpdate`
carries the extra characters. Nothing is dropped and nothing is reordered — the only effect is that
a sustained job settles at a safe ~1.1s effective cadence instead of 800ms.

Both numbers are configurable (`FLUSH_INTERVAL_MS`, `DOCS_WRITES_PER_MINUTE`) if Google's quota
changes or you have per-project quota raised.

### Cursor tracking

The server tracks the exact document index throughout a job. Requests inside one `batchUpdate`
apply in order, each seeing the document as the previous request left it, so `planRequests()` walks
a local cursor the same way Google will. Two reductions happen there:

- adjacent inserts merge into one `insertText`;
- a backspace over characters still sitting in an *unsent* insert trims that insert instead of
  emitting a delete — no observer can see an intermediate state inside a single batch, so the
  visible result is identical and it costs one request fewer.

A backspace that crosses a flush boundary becomes a real `deleteContentRange` against text Google
already has. The runner forces that boundary before every correction (see *Making typos visible*
below), so the mistake genuinely lands in the document and is then removed — which is what shows up
in version history.

Deletes are floored at the index the job started from, so a job appending to an existing document
can never chew into content that was already there.

---

## The humanization engine

`server/src/jobs/humanize.ts` — pure, seedable, no I/O.

```ts
humanize(text, { humanness: 0.5, targetDurationMs: 3_600_000 }) // => HumanEvent[]

type HumanEvent =
  | { type: 'type';      char: string;  delay: number }
  | { type: 'backspace'; count: number; delay: number }
  | { type: 'pause';     duration: number; rest?: true }
  | { type: 'repair';    offset: number; remove: number; insert: string; delay: number }
```

| Input              | Effect                                                              |
| ------------------ | ------------------------------------------------------------------- |
| `humanness`        | 0 = no mistakes ever; 1 ≈ 8% of words get a typo. Fixed at 0.85 in the app. |
| `targetDurationMs` | Wall-clock time for the whole job. Below the natural minimum it is ignored. |
| `minChunkRestMs`   | Shortest gap between writing bursts. 60s in production.             |

### Why it writes in bursts

**Google Docs groups edits into revisions by how close together in time they
happen, not by how many API calls arrive.** A document typed start to finish
inside a minute collapses into a single revision that reads exactly like a
paste — which is what an early version of this app produced, despite issuing
dozens of `batchUpdate` calls.

So the engine writes the way people do: a burst of a sentence or two, then a
rest of at least a minute. Each burst becomes its own revision in version
history, and the trail looks like someone working through a document.

There is no speed multiplier. `targetDurationMs` sets how long the job should
take, and **all** the extra time goes into the rests — keystrokes stay at
60–140ms no matter what. A person writing an essay over an afternoon still
types at ordinary speed; they just stop and think a lot. Slowing the keys
themselves to fill three hours would read as obviously synthetic.

`minimumDurationMs(text)` gives the floor for a piece of text — natural typing
plus one minimum rest per seam — and a job can never be scheduled faster. A
~1,150 character essay works out to about 14 minutes across 10 bursts.

### Making typos visible

This took two attempts, and the first one was not enough.

A typo corrected a second after it happens is invisible in version history no
matter how it is transmitted, because Docs folds both edits into one revision.
Sending the mistake as its own API call does not help. **The mistake has to
still be in the document when Docs takes its next snapshot.**

So mistakes are not corrected on the spot at all. The engine fumbles a word,
carries on to the end of the word and the sentence, and leaves the error
sitting there. At the next rest — after a minute or more of nothing — it goes
back and fixes it with a targeted edit at that position, the way a person
rereads a paragraph and clicks into a word:

```
 1.3m  REST  doc now: ..."dly, without ever complaining about the arrangement."
 2.6m  REST  doc now: ..."r that afternoon the dog finally responded in kindd."
 2.6m  FIX   "onded in kindd." -> "onded in kind."
```

That is a `repair` event: `{ offset, remove, insert }`, an offset from the
start of the job's own text. `DocWriter.repair()` sends it as its own
`batchUpdate` — a `deleteContentRange` plus an `insertText` at that index —
after the append buffer has been drained, since a mid-text edit shifts every
index after it.

Only one mistake is ever outstanding. That keeps the offset arithmetic honest
and matches how people work: you fix the last thing you got wrong, not four at
once. A mistake made in the final burst still gets found — the engine adds a
closing rest so it can come back to it.

There is no humanness slider. `DEFAULT_HUMANNESS` is a single tuned constant,
because "slightly human" is not a useful setting.

- **Base rhythm:** 60–140ms per character, gaussian-distributed (Box–Muller, clamped).
- **Pauses:** comma/semicolon/colon 150–400ms; `.` `!` `?` 400ms–1.2s;
  paragraph break 1.5–5s; single line break 400–900ms; 5% chance of a 300–800ms mid-word
  hesitation.
- **Common words** (`the and is to a of in`) come out 30% faster, as a single burst.
- **Typos** are modelled three ways: wrong-key substitution from a full QWERTY adjacency map,
  transposition (`teh`, `hte`), and doubled letters. They are left in the text and repaired at the
  next rest, not backspaced on the spot — see *Making typos visible*.

The engine guarantees the replayed event stream reproduces the input **exactly**. This is
property-tested over hundreds of seeds and the full humanness and duration range.

---

## Setup

### 1. Google Cloud Console

1. Go to <https://console.cloud.google.com/> and create (or select) a project.
2. **APIs & Services → Library →** enable the **Google Docs API**.
3. **APIs & Services → OAuth consent screen:**
   - User type: **External** (or Internal for a Workspace-only app).
   - Fill in app name, support email, developer contact.
   - **Scopes:** add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, and
     `https://www.googleapis.com/auth/documents`.
   - While the app is unverified, add yourself under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Web application**.
   - **Authorised redirect URIs:** `http://localhost:8080/auth/google/callback` for local
     development, plus `https://your-api-domain/auth/google/callback` for production. This must
     match `GOOGLE_CALLBACK_URL` character for character.
5. Copy the client ID and secret into `.env`.

> The `documents` scope lets TurtleType edit a document you point it at. It does not grant Drive
> access, so the app cannot list or open files you did not give it.

### 2. PostgreSQL

Any Postgres 13+ instance works (13+ is needed for the built-in `gen_random_uuid()`).

```bash
createdb turtletype
# or: docker run -d --name turtletype-pg -p 5432:5432 \
#       -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=turtletype postgres:16
```

Set `DATABASE_URL`, then:

```bash
npm run migrate
```

`server/src/db/schema.sql` is fully idempotent and also runs automatically on every server boot, so
this step is really only needed if you want to create the schema ahead of time.

### 3. Run it locally

```bash
cp .env.example .env      # then fill in the Google credentials and DATABASE_URL
npm install               # installs both workspaces
npm run dev               # API on :8080, client on :5173
```

Open <http://localhost:5173>. Vite proxies `/api` and `/auth` through to the API, so the browser
stays on a single origin and session cookies behave exactly as they do in production.

### 4. Tests

```bash
npm test          # 36 tests
npm run typecheck
```

The suite covers the engine (round-trip fidelity over hundreds of seeds), the request planner
(index arithmetic across flush boundaries), the rate limiter, backoff classification, and a full
pipeline test that runs `humanize → buffer → planRequests → simulated document` at five different
flush cadences.

If `DATABASE_URL` is set, an additional integration suite runs the **real** `JobRunner` against
real Postgres and a local fake Docs API, covering: exact text delivery, appending to an existing
document, recovery from a run of `429`s, cancellation leaving a clean prefix, and pause/resume.
Without `DATABASE_URL` those tests skip automatically.

---

## Environment variables

| Variable               | Required | Description                                                   |
| ---------------------- | -------- | ------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | yes      | OAuth client ID.                                               |
| `GOOGLE_CLIENT_SECRET` | yes      | OAuth client secret.                                           |
| `GOOGLE_CALLBACK_URL`  | yes      | Must exactly match an authorised redirect URI.                 |
| `SESSION_SECRET`       | yes      | Signs session cookies. `openssl rand -hex 32`.                 |
| `DATABASE_URL`         | yes      | Postgres connection string.                                    |
| `PORT`                 | no       | API port. Default `8080`.                                      |
| `CLIENT_URL`           | no       | Frontend origin, used for CORS and post-login redirects.       |
| `FLUSH_INTERVAL_MS`    | no       | Buffer flush cadence. Default `800`.                           |
| `DOCS_WRITES_PER_MINUTE` | no     | Per-job write ceiling. Must stay under 60. Default `55`.       |
| `MAX_CONCURRENT_JOBS`  | no       | Jobs replaying at once; the rest queue. Default `20`.          |
| `MAX_TEXT_LENGTH`      | no       | Rejects longer submissions. Default `200000`.                  |
| `TRUST_PROXY`          | no       | Set `true` behind a TLS-terminating proxy. Default: on in prod.|

---

## API

| Method   | Route                    | Notes                                                      |
| -------- | ------------------------ | ---------------------------------------------------------- |
| `GET`    | `/auth/google`           | Starts OAuth (`access_type=offline`, `prompt=consent`).    |
| `GET`    | `/auth/google/callback`  | Upserts the user, sets the session, redirects to `/app`.   |
| `GET`    | `/auth/logout`           | Destroys the session and redirects. `POST` returns JSON.   |
| `GET`    | `/api/me`                | Current user, or `401`.                                    |
| `POST`   | `/api/estimate`          | `{ text }` → minimum duration, burst count, typo count.     |
| `POST`   | `/api/jobs`              | `{ text, durationMs?, docId? }` → `{ jobId, docUrl }`.      |
| `GET`    | `/api/jobs`              | Recent jobs for the signed-in user.                        |
| `GET`    | `/api/jobs/:id`          | Poll job status.                                           |
| `GET`    | `/api/jobs/:id/stream`   | SSE: `snapshot`, `progress`, `status`, `retry`, `done`, `error`. |
| `POST`   | `/api/jobs/:id/pause`    | Pauses replay.                                             |
| `POST`   | `/api/jobs/:id/resume`   | Resumes replay.                                            |
| `DELETE` | `/api/jobs/:id`          | Cancels; already-typed characters are kept.                |

Everything under `/api` is behind `isAuthenticated`. `docId` accepts a full Google Docs URL or a
bare document ID; omit it and a new document is created and returned.

Every SSE event carries an `id:`, and the server keeps a replay buffer per job, so `EventSource`'s
automatic reconnect resumes with `Last-Event-ID` and misses nothing. Jobs run server-side and
survive the tab closing — reopening `/app` re-attaches to a job still in flight.

---

## Deploying

**See [DEPLOY.md](DEPLOY.md)** for the full runbook — Railway, Render or a self-hosted Docker
stack, plus Cloudflare DNS/TLS settings and the Google consent-screen steps.

The server serves `client/dist` when it exists, so the simplest production setup is one service on
one origin (which also sidesteps third-party cookie restrictions entirely).

```bash
npm run build     # builds server -> server/dist and client -> client/dist
npm start
```

### Railway

1. New project → Deploy from GitHub repo.
2. Add a **PostgreSQL** plugin; Railway injects `DATABASE_URL`.
3. Variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`,
   `GOOGLE_CALLBACK_URL=https://<your-app>.up.railway.app/auth/google/callback`,
   `CLIENT_URL=https://<your-app>.up.railway.app`, `NODE_ENV=production`, `TRUST_PROXY=true`.
4. Build command `npm install && npm run build`, start command `npm start`.
5. Add the callback URL to the OAuth client's authorised redirect URIs.

### Render

1. New → **Web Service**, connected to the repo.
2. Build command `npm install && npm run build`, start command `npm start`.
3. New → **PostgreSQL**, then copy its internal connection string into `DATABASE_URL`.
4. Same environment variables as above, with your `onrender.com` host.

If you host the API and the frontend on **different** origins, set `CLIENT_URL` to the frontend
origin and `NODE_ENV=production`; the session cookie automatically switches to
`SameSite=None; Secure`, which requires HTTPS on both.

---

## Operational notes

- **Restarts.** The job queue is in memory. A restart cannot safely resume a half-typed document,
  so boot marks any job left in `pending` / `running` / `paused` as `failed` with an explanatory
  message rather than leaving rows stuck forever.
- **Token refresh.** Access tokens are refreshed silently two minutes before expiry and the new
  credentials are written back to the `users` row. If Google returns `invalid_grant` (access
  revoked), the stored tokens are cleared and the user is asked to sign in again.
- **Tokens at rest.** OAuth tokens are stored as plain columns. For a production deployment
  handling other people's documents, encrypting `access_token` / `refresh_token` with a KMS-managed
  key is the obvious next hardening step.
- **Concurrency.** `MAX_CONCURRENT_JOBS` bounds replays per process; the rest sit in `pending` and
  start automatically as slots free. For horizontal scaling, the in-memory queue would need to move
  to Redis or Postgres advisory locks — SSE would then need sticky sessions or a pub/sub fan-out.

## Stripe, later

The groundwork is already in place, so wiring up billing touches almost nothing:

- `users.stripe_customer_id` and `users.subscription_status` already exist. Everyone is created
  `'active'`, so the app is free today.
- `hasActiveSubscription` in `server/src/middleware/isAuthenticated.ts` is already applied to
  `POST /api/jobs`. It returns `403 SUBSCRIPTION_REQUIRED` the moment a user's status is anything
  other than `'active'`.

So Stripe integration is: checkout session, customer portal, and a webhook that writes
`subscription_status`. No changes to the job pipeline at all.
