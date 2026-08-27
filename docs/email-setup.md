# Turning email notifications on

Everything in the code is done. What is left is a provider account, three DNS
records, and two environment variables. With either of `MAIL_API_KEY` and
`MAIL_FROM` missing, `config.notifications.emailEnabled` is false: no email is
sent, `notifyJobFinished` returns before it touches the database, and the
settings panel renders the two email switches as unavailable rather than
offering something that cannot happen. That is deliberate, so a laptop and a
self-hosted box run with no mail account at all.

Read this before starting, because it decides how much of the rest matters:

> **Nothing fails loudly here.** `mailer.ts` never throws — a notification is
> the least important thing happening at the moment a job ends, and a slow
> provider must not hold up the SSE `done` event or become an unhandled
> rejection. So a wrong key, an unverified sending domain, and a typo in
> `MAIL_FROM` all present identically: a job that finishes, a log line nobody
> is reading, and a user who never hears. There is no bounce to notice,
> because the send never happened. `npm run mail:verify -w server` exists
> because of this, and step 5 is not optional.

Unlike billing, this is **not** inverted in production. A deploy that cannot
bill is giving the product away and refuses to boot; a deploy that cannot email
is merely quieter than it should be, so `launchChecks.ts` warns and starts.

---

## 1. Pick a provider

The default target is [Resend](https://resend.com) — its free tier covers
3,000 emails a month, which at one email per finished job is more than this app
will produce for a long time.

Nothing is Resend-specific in the code. The sender is a bare `fetch` to a
`POST` endpoint with a bearer token and a
`{ from, to, subject, text, html, reply_to }` body, which several providers
copy; `MAIL_API_URL` points it somewhere else. That shape is the whole
integration — there is no SDK to install, no lockfile to regenerate, and no
outbound SMTP port to discover the platform has blocked.

## 2. Verify a sending domain

The step everything else depends on. A provider will not send from a domain you
have not proved you control, and it refuses **at send time** rather than when
you save the setting.

*Resend → Domains → Add Domain.* Give it a domain you own, then add the records
it shows you at your DNS host — for `type.turtlegames.org` that is Cloudflare.

Three records, and it is worth knowing what each one is for:

| Record | What it does | If you skip it |
|---|---|---|
| **SPF** (`TXT`, on the sending domain) | Lists who may send as this domain | Sends are rejected or land in spam |
| **DKIM** (`TXT`/`CNAME`, on a selector subdomain) | Signs each message so it cannot be forged in transit | Same, and the provider will not verify the domain |
| **DMARC** (`TXT` on `_dmarc.`) | Tells receivers what to do when the first two fail | Gmail and Yahoo increasingly treat unauthenticated bulk mail as spam |

Two things that catch people out:

- **If your DNS is behind Cloudflare's proxy, these records must stay
  unproxied** (grey cloud). A proxied CNAME breaks DKIM.
- **Send from a subdomain**, e.g. `notifications@mail.your-domain.org`, not
  from the domain your human mail is on. A notification that gets marked as
  spam then damages the reputation of the subdomain rather than of the address
  your customers reply to.

Verification usually completes in minutes and can take up to a few hours. The
provider's dashboard is the authority on whether it has — this app cannot tell,
which is why an unverified domain looks exactly like everything working.

## 3. Create an API key

*Resend → API Keys → Create.* **Sending access** is all it needs; there is no
reason for this app to hold a key that can read your mail logs or delete
domains. Copy it now — the value is shown once.

## 4. Set the environment variables

| Variable | Required | What it is |
|---|---|---|
| `MAIL_API_KEY` | yes | The key from step 3. Email is off without it. |
| `MAIL_FROM` | yes | Sender, on the domain from step 2. Use the display-name form: `TurtleType <notifications@mail.your-domain.org>`. |
| `MAIL_REPLY_TO` | no | Where replies go. Defaults to `SUPPORT_EMAIL`, which is already on `/privacy`, `/terms` and the OAuth consent screen — usually right. |
| `MAIL_API_URL` | no | Send endpoint. Defaults to `https://api.resend.com/emails`. |
| `MAIL_TIMEOUT_MS` | no | How long one send may take. Defaults to 10,000. |

Two variables owned elsewhere also show up in the message, and are worth
getting right at the same time:

- `CLIENT_URL` is the "turn these emails off" link. `render.ts` drops the link
  rather than emitting a relative or broken one, so a wrong value here means
  notifications with no visible way to switch them off.
- `LEGAL_OPERATOR` and `SUPPORT_EMAIL` are the footer — who sent this and where
  to complain.

On Railway these go in *Variables* on the app service. On a self-hosted box
they are in `.env`, which `docker-compose.yml` passes through.

## 5. Check it

```bash
# Reads the settings and says what is wrong with them.
npm run mail:verify -w server

# The only check that proves the domain is verified: sends you the real
# finished-job email, rendered by the same code a real job uses.
npm run mail:verify -w server -- --send you@your-domain.org
```

The first half is pure and offline: it catches an unparseable sender, a
placeholder domain copied out of `.env.example`, a key over plain HTTP, an
endpoint still pointed at a local fake, a reply address nobody reads. None of
that proves a send will work, because domain verification is a fact about DNS.
The second half asks the provider, and prints its rejection verbatim — which is
the only thing that separates "the key is wrong" from "the domain is not
verified".

On Railway, run it against what the service actually has rather than your
laptop's `.env`:

```bash
railway run npm run mail:verify -w server -- --send you@your-domain.org
```

**Check the spam folder as well as the inbox.** A first send from a new domain
routinely lands there, and it is a DMARC/reputation question rather than
anything this app can fix.

## 6. Test the whole path

With the variables set, submit a short job and let it finish. That exercises
the parts `--send` skips: the `notified_at` claim, the per-user preferences,
and the dispatch from `finishJob`.

Worth doing both outcomes. The failure email is the one that carries the refund
line, and it is the one nobody looks at until it matters.

To run the path with no provider account at all — which is how the test suite
does it — point `MAIL_API_URL` at a local server that accepts `POST /emails`
and returns `200`. `server/src/notify/mailer.test.ts` has one.

## 7. What the user then controls

Four preferences on `users`, one per channel × outcome, patched through `PATCH
/api/me/notifications` from the panel under the composer. All four default on:
these are transactional notices about the account holder's own job, sent to the
address they signed in with, and each has a visible switch.

The browser channel needs nothing configured here. It is raised from the live
SSE `done` / `error` events, so it needs a tab open somewhere — background is
fine, closed is not — and additionally needs the browser's own permission,
which is only ever requested from a click. `GET /api/public-config` carries
`notifications.email`, so on a deploy with no provider the panel shows the
email pair as unavailable instead of pretending.

## 8. Troubleshooting

| What you see | What it usually is |
|---|---|
| `mail:verify` says email is OFF | One of `MAIL_API_KEY` / `MAIL_FROM` is unset or whitespace. Both are required; either alone does nothing. |
| Provider replies "domain is not verified" | Step 2 is unfinished, or the DNS records have not propagated. Check the provider's dashboard, not the app. |
| Provider replies about the API key | Wrong key, a key from another account, or a value copied from a different dashboard field. |
| `--send` succeeds, nothing arrives | Spam folder first, then the provider's own delivery log — once it has accepted the message, what happened next is only visible there. |
| Emails arrive for a job that failed but not one that finished | That is `notify_email_done` switched off for that account, working as intended. |
| A job finished and nothing was sent, once | Look for `[notify]` in the logs. A send that fails is logged and the claim stays claimed — there is no retry, deliberately (see below). |
| Two emails for one job | Should be impossible; `notified_at` is claimed with a conditional `UPDATE`. If it happens, that predicate has been broken and it is a real bug. |
| Nothing for a cancelled job | Intended. The person who stopped it was looking at the button. |

## What maps to what in the code

| Thing | Code |
|---|---|
| Whether email happens at all | `config.notifications.emailEnabled`, `notify/mailer.ts` |
| Who is told, on which channel | `notify/policy.ts` — pure, no I/O |
| The words | `notify/render.ts` — pure; text and HTML from one input |
| Send-once | `notify/jobNotifications.ts`, the `notified_at IS NULL` claim |
| The switches | `users.notify_*`, `PATCH /api/me/notifications` |
| The browser half | `client/src/lib/notifications.ts`, off the SSE stream |
| This setup, checked | `notify/verify.ts`, `npm run mail:verify -w server` |

## Deliberately not built

Worth knowing before you go looking for them.

- **No retries and no send queue.** A failed send is logged and the claim stays
  claimed. Re-opening it would mean the next path through `finishJob` — or the
  next boot sweep — sending a duplicate of a message that may well have gone
  out, and a logged miss beats a doubled inbox.
- **No unsubscribe token.** The footer links to `/app`, where the switches are,
  behind the sign-in the recipient already has. These are transactional notices
  to the account holder, not a list.
- **No document text, ever.** Counts, an outcome, and a link to the user's own
  document are the entire vocabulary. The OAuth submission tells Google
  reviewers that document content is never stored or transmitted, `jobs`
  deliberately holds no text, and an email is the obvious place for that
  promise to be broken by accident — `render.test.ts` asserts the input shape
  has nowhere to put it. A change that makes this false breaks the
  verification, not just the taste of it.
