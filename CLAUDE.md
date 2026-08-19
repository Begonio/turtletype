# TurtleType

Writes text into a Google Doc the way a human would type it, instead of pasting. Google Docs checkpoints a revision roughly every 2 minutes, so a paste or fast scripted typing collapses into one obviously-machine-made edit. TurtleType paces input around that checkpoint interval so the revision history looks human.

## Flow

1. User signs in with Google, pastes text, picks a target duration, points it at a doc ID.
2. Server plans the whole session upfront in memory: an event sequence of per-character delays, thinking pauses, typos, and deferred corrections.
3. Types in bursts of ~55-150 characters separated by 150+ second rests (deliberately above the Docs checkpoint interval, so each burst becomes its own revision).
4. Plants realistic typos (QWERTY-adjacent slips, transpositions), keeps typing, circles back to fix them a revision or two later.
5. Streams progress to the browser over SSE with a countdown. Job runs server-side, so the user can close the tab.

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
- **`humanize.ts` is pure and seedable.** No I/O, deterministic given a seed. This is what makes the engine testable — don't introduce side effects into it.
- **`config.ts` keeps secrets behind getters** so pure modules can be imported in tests without a live database.
- **`preflight.ts` must stay the first import in `index.ts`.** It validates env before `db/pool.ts` reads it at module load. Reordering imports can silently break env validation.
- **Regenerate `package-lock.json` whenever `package.json` changes.** A rename passed locally and failed on Railway's `npm ci`, because local dev reuses `node_modules` and never revalidates the lockfile.

## Known open issue

`MAX_TEXT_LENGTH` is 200,000 chars, `MAX_JOB_DURATION_MS` caps jobs at 24 hours. At current pacing, anything over ~18,000 characters has a minimum runtime that exceeds the job's own max duration. Needs either a duration cap adjustment or a pacing speedup for long jobs. Flag this if asked to raise the length limit further.

## Working conventions

- TypeScript throughout, ESM. Match existing style, don't introduce CommonJS.
- Keep timing/humanization logic (`humanize.ts` and friends) pure — no fetch, no db calls, no Date.now() side effects that break seedability.
- When touching anything that writes to Docs, check it against the batching/rate-limit invariant above before proposing a change.
- When touching deploy config (Dockerfile, Railway config, replica count), flag the single-replica constraint before changing it.
