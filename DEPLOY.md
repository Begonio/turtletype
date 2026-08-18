# Deploying TurtleType to type.turtlegames.org

The app is a single service: the Node server serves the API **and** the built
React app from the same origin. That is deliberate — one origin means the
session cookie stays `SameSite=Lax` and no third-party cookie rules apply.

So `type.turtlegames.org` needs to point at exactly one thing.

---

## Read this first: Cloudflare cannot run this app

Cloudflare is where your DNS lives, and it will sit in front of the app happily.
But Workers and Pages **cannot host it**:

- A typing job is a long-lived process. A 5,000-character document at normal
  speed runs for roughly ten minutes, sleeping between keystrokes. Workers are
  billed and bounded per request and cannot hold a job in memory for minutes.
- The job queue, the per-job rate limiters, and the SSE subscriber lists all
  live in process memory, which Workers do not have between requests.
- It needs a persistent Postgres connection pool.

So the shape is always: **Cloudflare DNS (+ optional proxy) → a host that runs
containers or Node → the app.** Pick one of the three options below.

---

## Your path: Railway + Cloudflare

You already have Railway connected to GitHub, so this is the whole job in
order. Details for each step are below.

1. Railway → new project from `Begonio/turtletype`, branch
   `claude/humantype-production-app-x67x5i`. It builds the `Dockerfile` on its
   own — nothing to configure, and no Docker Hub account needed.
2. Add the **PostgreSQL** database to the same project.
3. Set the seven environment variables in [Option A](#option-a--railway).
4. Add the custom domain `type.turtlegames.org` in Railway and copy the CNAME
   target it gives you.
5. Cloudflare → DNS → `CNAME  type → <that target>`, **proxy off (grey cloud)**
   until the certificate issues.
6. Google Cloud Console → add the callback URL and the authorised domain.
7. Load `https://type.turtlegames.org` and sign in.

Two things will bite you if you skip them: Cloudflare's **Flexible** SSL mode
breaks login, and a consent screen left in **Testing** expires everyone's
refresh token after 7 days. Both are covered below.

---

## Step 1: pick a host

| Option | Good when | Cost |
| ------ | --------- | ---- |
| **A — Railway** | You want this working in ten minutes, with Postgres managed for you. | ~$5/mo |
| **B — Render** | Same as Railway. Avoid the free tier: it sleeps, which kills running jobs. | ~$7/mo + $7 db |
| **C — Your own VPS** | You already pay for a server and want everything in one `docker compose up`. | Whatever the box costs |

All three use the `Dockerfile` in this repo. You do **not** need a Docker Hub
account for any of them — Railway and Render build from your GitHub repo, and a
VPS pulls the public `node` and `postgres` images anonymously. (A Docker Hub
login only helps if you hit anonymous pull rate limits.)

### Option A — Railway

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo** → pick
   `Begonio/turtletype`, branch `claude/humantype-production-app-x67x5i`.
   Railway reads `railway.json` and builds the `Dockerfile`.
2. In the same project: **New** → **Database** → **PostgreSQL**. Railway injects
   `DATABASE_URL` automatically.
3. On the app service → **Variables**, set:

   ```
   NODE_ENV=production
   SESSION_SECRET=<openssl rand -hex 32>
   GOOGLE_CLIENT_ID=<from Google Cloud Console>
   GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
   GOOGLE_CALLBACK_URL=https://type.turtlegames.org/auth/google/callback
   CLIENT_URL=https://type.turtlegames.org
   TRUST_PROXY=1
   ```

   Leave `PORT` alone — Railway sets it. Leave `DATABASE_URL` alone too: use
   Railway's reference to the Postgres service so it tracks any credential
   rotation. Its internal host (`postgres.railway.internal`) has TLS switched
   off, which the app detects on its own — no `DATABASE_SSL` needed.

   Set `TRUST_PROXY=2` later if you turn Cloudflare's orange cloud on.
4. **Settings → Networking → Custom Domain** → `type.turtlegames.org`. Railway
   shows a CNAME target like `abc123.up.railway.app`. Keep that tab open for
   step 2.

> **Keep it at one replica.** The job queue is in memory, so two instances means
> a job started on one is invisible to the other and its SSE stream returns
> nothing. `railway.json` pins `numReplicas: 1`.

### Option B — Render

1. **New → Web Service**, connect the repo, **Runtime: Docker**.
2. **New → PostgreSQL**, then copy its *internal* connection string into
   `DATABASE_URL` on the web service.
3. Same variables as Railway above, plus `TRUST_PROXY=1`.
4. Health check path: `/health`. Instances: 1.
5. **Settings → Custom Domain** → `type.turtlegames.org`, and note the CNAME
   target Render gives you (`something.onrender.com`).

### Option C — Your own VPS

Everything is in `docker-compose.yml`: the app, Postgres, and Caddy for TLS.

```bash
git clone https://github.com/Begonio/turtletype.git
cd turtletype
git checkout claude/humantype-production-app-x67x5i
cp .env.example .env
```

Fill in `.env`:

```
APP_DOMAIN=type.turtlegames.org
POSTGRES_PASSWORD=<a long random string>
SESSION_SECRET=<openssl rand -hex 32>
GOOGLE_CLIENT_ID=<...>
GOOGLE_CLIENT_SECRET=<...>
TRUST_PROXY=2
```

`GOOGLE_CALLBACK_URL`, `CLIENT_URL` and `DATABASE_URL` are derived from
`APP_DOMAIN` inside the compose file — you do not set them by hand.

```bash
docker compose up -d
docker compose logs -f app     # expect: [boot] TurtleType API listening on :8080
```

Ports 80 and 443 must be open. Caddy fetches a Let's Encrypt certificate on
first boot, which requires DNS to already point at the box — so if you are
using Cloudflare's proxy, do step 2 with the **proxy off** first, let the
certificate issue, then turn the proxy on.

`deploy/Caddyfile` already excludes the SSE endpoint from compression and
disables response buffering on it. Without that, the live preview arrives in
one lump when the job finishes rather than character by character.

---

## Step 2: Cloudflare DNS

Cloudflare dashboard → `turtlegames.org` → **DNS** → **Add record**:

| Field | Value |
| ----- | ----- |
| Type | `CNAME` (use `A` with the server's IP for Option C) |
| Name | `type` |
| Target | the CNAME target from your host (Option C: your server's IP) |
| Proxy status | **DNS only** at first — see below |
| TTL | Auto |

**Start with the grey cloud (DNS only).** Every host needs to prove it owns the
domain to issue a TLS certificate, and Cloudflare's proxy hides the origin
during that check. Once the host reports the certificate as issued (usually a
minute or two), you can switch the cloud to orange if you want Cloudflare's
proxy — nothing in this app requires it.

### If you turn the proxy on (orange cloud)

These settings matter, and the first one is the classic silent breaker:

- **SSL/TLS → Overview → Full (strict).** The default *Flexible* mode talks
  plain HTTP to your origin, so the app sees an insecure request, refuses to
  set a `Secure` cookie, and login fails — or you get a redirect loop. Full
  (strict) is the only correct setting here.
- **SSL/TLS → Edge Certificates → Always Use HTTPS: On.**
- **Speed → Optimization → Rocket Loader: Off.** Rocket Loader rewrites and
  defers scripts, which breaks the React app's mount.
- **Set `TRUST_PROXY=2`** (Cloudflare is one hop, your host's router is the
  second). With the grey cloud, use `1`. Getting this wrong does not break
  login — the protocol is read from the leftmost `X-Forwarded-Proto` either way
  — but `req.ip` will report a proxy address instead of the visitor.
- **Caching:** add a Cache Rule that bypasses cache for
  `(http.request.uri.path contains "/api/") or (http.request.uri.path contains "/auth/")`.
  Cloudflare does not cache these by default, but an existing broad page rule on
  `turtlegames.org` might.

**On SSE and Cloudflare's 100-second limit:** Cloudflare drops a proxied
connection that produces nothing for 100 seconds (error 524). A typing job can
legitimately sit quiet during a 5-second paragraph pause, but the server sends a
heartbeat comment every 15 seconds, so the stream stays well inside the limit.
No configuration needed.

---

## Step 3: Google Cloud Console

The OAuth client must know about the new domain or every sign-in fails with
`redirect_uri_mismatch`.

1. **APIs & Services → Credentials →** your Web application OAuth client →
   **Authorised redirect URIs** → add:

   ```
   https://type.turtlegames.org/auth/google/callback
   ```

   Exactly that — scheme, host and path must match `GOOGLE_CALLBACK_URL`
   character for character. Keep the localhost entry for development.
2. **OAuth consent screen → Authorised domains →** add `turtlegames.org`.

### The 7-day refresh token trap

This one will bite you a week after launch if you skip it.

`https://www.googleapis.com/auth/documents` is a **sensitive** scope. While your
consent screen is in **Testing** status:

- only accounts on the test-user list can sign in at all, and
- **refresh tokens expire after 7 days**, so every user has to re-consent weekly.

The app handles that expiry gracefully — it clears the dead token and sends the
user back through consent rather than failing silently — but it is not something
you want in production.

To fix it, set the consent screen's publishing status to **In production**.
Google requires verification for sensitive scopes, which means providing a
privacy policy URL, a terms URL, a homepage on `turtlegames.org`, and a demo
video showing why the app needs Docs access. Verification typically takes a few
days to a few weeks, so start it early if you plan to open this beyond yourself.

If TurtleType is only ever for you and a handful of people, staying in Testing is
fine — just expect the weekly re-consent.

---

## Step 4: verify

```bash
curl https://type.turtlegames.org/health
# {"ok":true,"activeJobs":0,"queuedJobs":0}
```

Then in a browser:

1. `https://type.turtlegames.org` → landing page renders.
2. **Sign in with Google** → consent screen → lands on `/app`.
3. Paste a couple of sentences, **Start typing** → a new Google Doc opens and
   the progress panel starts moving.

If the live preview stays empty while the document fills in, the SSE stream is
being buffered somewhere — check the Caddy config (Option C) or that Cloudflare
is not compressing the stream.

### Common failures

| Symptom | Cause |
| ------- | ----- |
| `redirect_uri_mismatch` | Step 3.1 not done, or a trailing-slash mismatch. |
| Signs in, bounces back to the landing page | Cookie rejected. Check SSL/TLS is **Full (strict)**, not Flexible. |
| Redirect loop | Same — Flexible SSL mode. |
| Build succeeds, **`Network > Healthcheck` fails** | The container booted and exited. Open the **Deploy** log (not Build): a `[boot] FAILED TO START:` line names the cause. Usually a missing variable or an unreachable `DATABASE_URL`. |
| Railway created two services named `@turtletype/client` and `@turtletype/server` | It split the npm workspaces. Delete both, create one service with **Root Directory `/`** and **Builder: Dockerfile**. This app is a single service by design. |
| `502` / `Bad gateway` | App container not up. `docker compose logs app` or the host's log tab. |
| Preview empty, doc still fills | SSE buffered by a proxy. |
| Jobs die after 7 days for a user | The Testing-mode refresh token expiry above. |
| Job says "server restarted" | The host redeployed mid-job. Expected: in-memory jobs cannot resume. |

---

## Operating notes

- **One instance only.** Jobs and SSE subscribers live in memory. Scaling to two
  replicas breaks both. To scale horizontally the queue would need to move to
  Redis or Postgres advisory locks, with sticky sessions or pub/sub fan-out for
  SSE.
- **Deploys interrupt running jobs.** On `SIGTERM` the server cancels in-flight
  jobs, flushes what was already typed, and marks them cancelled. Anything still
  marked `running` at the next boot is marked failed with an explanatory message.
  Deploy when nobody is mid-document.
- **Backups.** Railway and Render both offer automated Postgres backups; on a
  VPS, `docker compose exec db pg_dump -U turtletype turtletype` on a cron.
- **Tokens at rest.** OAuth access and refresh tokens are stored as plain columns
  in `users`. If this ever serves people other than you, encrypt them with a
  KMS-managed key before launch.
