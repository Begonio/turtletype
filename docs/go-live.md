# Going live

Three things have to be true before TurtleType stops being a beta: the copy has
to stop saying it is free, the deploy has to actually charge, and the Google
OAuth app has to leave Testing so more than 100 people can sign in.

The first is done — the landing page reads its line off the live catalog now,
so it cannot drift again. The other two are below, in the order they should
happen. **Do the Stripe half first.** OAuth verification is weeks of waiting on
someone else; billing is an afternoon of your own work, and there is no reason
for the two clocks to run in series.

---

## 1. Fill in who operates the service

Four environment variables, set on the deployed service (Railway → the service
→ Variables), not in a file in the repo:

| Variable | Example | Where it shows | Required |
|---|---|---|---|
| `LEGAL_OPERATOR` | `Jane Smith` | /privacy, /terms | **Yes** |
| `LEGAL_JURISDICTION` | `England and Wales` | /terms, governing law | **Yes** |
| `SUPPORT_EMAIL` | `help@turtlegames.org` | /privacy, /terms, OAuth consent screen | No — defaults to `help@turtlegames.org` |
| `LEGAL_LAST_UPDATED` | `20 August 2026` | both, as the date | No |

These are served by `GET /api/legal` and rendered at runtime, so correcting one
is a variable change and a restart — not a rebuild. That matters more than it
sounds: "please correct the operator name" is a common verification round trip,
and every round trip restarts the reviewer's clock.

The two required ones are required because no honest default exists for them:

- **`LEGAL_OPERATOR` falls back to the product name**, which is not an
  operator. A customer disputing a charge needs to know who they contracted
  with, and Google checks this against the Cloud project owner.
- **`LEGAL_JURISDICTION` has no default at all.** Left unset, `/terms` shows a
  visible "governing law has not been configured" notice instead of naming a
  jurisdiction. That is deliberate: an invented governing law is a worse thing
  to publish than an obvious gap, and this is the clause that decides where a
  dispute is heard.

`SUPPORT_EMAIL` is not on that list because it ships with the real address —
`help@turtlegames.org` — rather than a placeholder. Make sure that mailbox is
actually monitored before submitting: it is where Google's review
correspondence, deletion requests and refund requests all land, and a review
round trip stalls while nobody reads it.

> The policy text itself is written to match what the code actually does — the
> document text never reaches Postgres, tokens are stored for the runtime of a
> job, Stripe never hands us a card number. That accuracy is the part worth
> defending in review. It is not legal advice, and having a lawyer read it
> before you take money is a different question from having a reviewer accept
> it.

---

## 2. Make the deploy actually charge

Follow [`stripe-setup.md`](stripe-setup.md) end to end — products, prices, the
webhook endpoint, the customer portal, and the live-mode switch. Then:

```bash
# With the production environment loaded, so it reads what the service has:
railway run npm run launch:check -w server
railway run npm run stripe:verify -w server
```

`launch:check` answers "can this deploy take payment", `stripe:verify` answers
"do Stripe's real prices match the numbers the pricing page shows" — nothing at
runtime compares those two, so a drift would quietly bill a different figure
than the customer agreed to.

### What changed, and why it can't silently regress

Billing used to fail *open*: no Stripe keys meant `billing.enabled` was false,
the paywall waved every job through, and the only trace was one line in the
boot log. That is correct for a laptop and dangerous for the deploy that is
supposed to charge — the failure is silent, and you find out from the invoice
that never arrives.

So production now inverts it. `launchChecks.ts` refuses to boot a production
deploy that cannot bill, and the paywall middleware answers `503` rather than
`next()` if it somehow finds itself enabled-less in production. Requirements:

- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` — without the second one a
  payment is taken and no credit is ever created, since webhooks are the only
  place credit comes from.
- At least one `STRIPE_PRICE_PACK_*`. A deploy with keys but no prices
  paywalls every user against a pricing page whose buttons are all disabled —
  neither earning nor working, which is the one state worse than free.

`ALLOW_FREE_MODE=true` opts back out, for self-hosting or a staging copy. It
has to be typed exactly; an empty or misspelled value will not disable the
paywall.

**New accounts still get 1 free credit** (`SIGNUP_GRANT_CREDITS`) — 10,000
characters, about six and a half hours of writing. Keep it. The revision
history *is* the product and nobody buys it unseen; the grant is what lets
someone watch it work before deciding. Set it to `0` only if abuse makes the
trial cost more than it converts.

---

## 3. Get out of Testing on Google

Full detail in [`google-oauth-verification.md`](google-oauth-verification.md),
including the exact scope justification and demo-video script.

**Do this first, before the checklist below:** switch the consent screen to
**In production**. It is a separate setting from verification and you do not
have to wait for review to use it. In Testing, grants expire after 7 days —
which for a product whose jobs run for hours and whose users come back is not
an inconvenience but a defect. Production removes that. It does *not* remove
the "Google hasn't verified this app" warning or the user cap: unverified in
production still shows the warning and allows 100 new users over the lifetime
of the project, non-resettable. Treat those 100 as your runway and submit
verification the same week you start charging.

Then, in submission order:

- [ ] **Verify `turtlegames.org` in Search Console** using the Google account
      that owns the Cloud project, then add it under *APIs & Services → OAuth
      consent screen → Authorised domains*. Every URL you hand the reviewer
      must sit on a verified domain.
- [ ] **Confirm the legal pages render real values** — load
      `https://type.turtlegames.org/privacy` and `/terms` and check that no
      placeholder or amber "not configured" notice is showing. Step 1 above.
- [ ] **Complete the consent screen**: app name, user-support email, 120×120
      PNG logo, homepage, privacy URL, terms URL, developer contact.
- [ ] **Paste the scope justification** from the verification doc.
- [ ] **Record the demo video** to the script in the verification doc. Unlisted
      YouTube is fine.
- [ ] **Switch publishing status to In production** and submit.
- [ ] **Watch the developer contact inbox.** Replies go there and the clock
      restarts on each round trip; the usual follow-up is a re-record of the
      video showing something they could not see.
- [ ] **When it is granted, set `OAUTH_APP_VERIFIED=true`.** That removes the
      "Google will show a warning first" notice from the sign-in and pricing
      pages. Nothing else reads the flag, so a forgotten one only means warning
      people about a screen they will not see.

Expect a first response in several business days and the whole thing to take
weeks. Sensitive-scope apps are re-reviewed annually — letting that lapse drops
you back behind the 100-user cap, so put the renewal in a calendar now.

While you wait, the cap still applies: up to 100 hand-added test users whose
grants expire every 7 days. Paying customers cannot be onboarded past that
number until verification lands, which is the real reason to start it early.

---

## 4. After the switch

- **Check the Docs API quota before the traffic arrives.** *APIs & Services →
  Google Docs API → Quotas*. The runner caps itself at 55 writes/min *per job*
  and runs up to 20 jobs at once, so the worst case this process can produce is
  around 1,100 writes/minute against a project-wide limit. Steady state is far
  lower — jobs are writing maybe a quarter of the time — but a Sunday-night
  deadline is exactly when many jobs are mid-burst together. A quota increase
  also takes time to grant, so ask before you need it.
- **Watch the ceiling, not just the revenue.** `numReplicas: 1` is load-bearing:
  the job queue and the SSE subscriber list live in process memory, so a second
  instance breaks jobs rather than sharing them. Capacity is 20 concurrent jobs,
  and at current pacing a 10,000-character document holds a slot for about six
  and a half hours. That is roughly 480 job-hours a day before deadline
  clustering eats into it. Raising it is not a config change — the queue has to
  move to Postgres or Redis and SSE onto a pub/sub backend first.
- **`credit_ledger` shows the wall coming.** Consumption is visible there
  before it becomes a queue backlog. Watch it.
