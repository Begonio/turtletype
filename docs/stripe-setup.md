# Turning billing on

Everything in the code is done. What is left is account configuration in the
Stripe dashboard and six environment variables. Nothing charges anyone until
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are both set — with either
missing, `config.billing.enabled` is false, every job is free, no ledger rows
are written, and the credit UI does not render. That is deliberate, so a
half-finished setup fails safe.

Work through this in **test mode** first. Every step is identical in live mode
except the keys, and Stripe keeps the two worlds completely separate — test
products do not exist in live mode, so you will do the product setup twice.

---

## 1. Create the products and prices

*Dashboard → Product catalogue → Add product.* Four products. The credit
amounts live in `server/src/billing/catalog.ts`; Stripe only needs to agree on
the money, since credits are granted from the SKU, not from what Stripe says.

| Product name | Price | Type | Environment variable |
|---|---|---|---|
| TurtleType — Starter | $9.00 | One-off | `STRIPE_PRICE_PACK_STARTER` |
| TurtleType — Standard | $19.00 | One-off | `STRIPE_PRICE_PACK_STANDARD` |
| TurtleType — Bulk | $39.00 | One-off | `STRIPE_PRICE_PACK_BULK` |
| TurtleType — Monthly | $12.00 | Recurring, monthly | `STRIPE_PRICE_PLAN_MONTHLY` |

After creating each one, copy the **price** ID — it starts with `price_`, not
`prod_`. The `prod_` id is the product; the API needs the price. This is the
single most common thing to get wrong here.

Put the customer-facing description on the product in Stripe too. It appears on
the Checkout page and on the receipt, and a receipt reading "TurtleType —
Standard, 15 credits (150,000 characters)" prevents a certain number of "what
was this charge" emails.

> A SKU with no price ID configured is not broken — it renders on the pricing
> page as **Unavailable** with a disabled button. You can launch with packs
> only and add the subscription later.

## 2. Get your API keys

*Dashboard → Developers → API keys.* Copy the **secret** key (`sk_test_…`, and
later `sk_live_…`). The publishable key is not needed — this integration uses
Stripe-hosted Checkout, so no Stripe JavaScript runs in the browser and no card
data ever touches your servers.

## 3. Create the webhook endpoint

This is the part that actually moves credit. Without it customers are charged
and never credited.

*Dashboard → Developers → Webhooks → Add endpoint.*

- **URL:** `https://type.turtlegames.org/api/webhooks/stripe`
- **Events to send** — exactly these six:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `invoice.paid`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `charge.refunded`

Then copy the endpoint's **signing secret** (`whsec_…`) into
`STRIPE_WEBHOOK_SECRET`.

Why each one is subscribed:

- `checkout.session.completed` — a pack purchase; this is what grants the
  credits.
- `checkout.session.async_payment_succeeded` — some payment methods settle
  after Checkout returns. The first event correctly declines to pay out while
  `payment_status` is still `unpaid`, and this one carries the settled result.
  Skip it and those customers are charged and never credited.
- `invoice.paid` — a subscription period, the first one and every renewal. This
  is what grants monthly credits, not the Checkout session.
- `customer.subscription.updated` / `.deleted` — mirrors the subscription
  status so a past-due card shows up in the app. Never grants anything.
- `charge.refunded` — clears the balance when you refund a purchase in full.

Anything else you subscribe to is acknowledged and ignored, so adding extra
events is harmless but pointless.

## 4. Turn on the customer portal

*Dashboard → Settings → Billing → Customer portal.* It has to be activated
before `billingPortal.sessions.create` will work at all — an unconfigured
portal returns an error, and the "Manage subscription" button on `/billing`
will fail.

Enable at minimum: cancel subscriptions, update payment methods, and view
invoice history. Set the return URL handling to allow your domain.

Cancellation matters beyond convenience: a subscription customers cannot cancel
themselves generates chargebacks, and card networks treat those far more
harshly than refunds.

## 5. Set the environment variables

On Railway, *service → Variables*. Six of them:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PACK_STARTER=price_...
STRIPE_PRICE_PACK_STANDARD=price_...
STRIPE_PRICE_PACK_BULK=price_...
STRIPE_PRICE_PLAN_MONTHLY=price_...
```

Three optional ones, all with sensible defaults — see `.env.example`:
`CHARS_PER_CREDIT` (10000), `SIGNUP_GRANT_CREDITS` (1), `MAX_CREDITS_PER_JOB`
(20).

**Do not change `CHARS_PER_CREDIT` on a live deploy with credits outstanding.**
It reprices every future job, so a customer who bought expecting 10,000
characters per credit silently gets less. If you must change it, honour the old
rate for existing balances or grant the difference.

The boot log tells you which mode you are in:

```
[boot] billing ON — 1 credit = 10,000 chars, 1 free on signup
[boot] billing OFF (no STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET) — every job is free
```

## 6. Test the whole path locally

Install the [Stripe CLI](https://stripe.com/docs/stripe-cli), then:

```bash
stripe login
stripe listen --forward-to localhost:8080/api/webhooks/stripe
```

`stripe listen` prints its **own** `whsec_…`, different from the dashboard
endpoint's. Use that one in your local `.env` — the dashboard secret will not
verify CLI-forwarded events.

With the app running, sign in, go to `/pricing`, buy a pack, and pay with test
card `4242 4242 4242 4242`, any future expiry, any CVC. You should see, in
order:

1. The `stripe listen` terminal logging `checkout.session.completed`.
2. The server logging
   `[stripe] checkout.session.completed (evt_…): granted 15 credit(s) for pack_standard, balance 16`.
3. The balance in the app header updating.
4. A new row on `/billing` reading "Credit pack +15".

Then check the things that are easy to get wrong:

- **Redelivery.** In the dashboard, find the event and hit *Resend*. The
  balance must not move, and the log should read `already credited; no-op`.
- **Refund.** Refund the payment in the dashboard. The balance should go to 0.
- **Subscription renewal.** `stripe trigger invoice.paid` — or advance a test
  clock — and confirm the monthly credits land exactly once.
- **A failed job refunds.** Start a job, then stop the server mid-run. On
  restart the boot log should report the orphaned job and the credits should
  be back.

Test cards for the paths worth seeing at least once:
`4000 0000 0000 9995` declines for insufficient funds, `4000 0025 0000 3155`
requires 3-D Secure authentication.

## 7. Going live

- Activate the Stripe account (business details, bank account) — a test account
  cannot take real money.
- Recreate all four products in **live mode**. Test products do not carry over,
  and their price IDs are different.
- Create a **new** webhook endpoint in live mode and use its signing secret.
- Swap `sk_test_…` for `sk_live_…` and all four `price_…` values.
- Do one real purchase of the smallest pack with your own card, confirm the
  credits land, then refund it from the dashboard and confirm they come back.

### Two things worth setting up before you have volume

**Tax.** *Settings → Tax.* Digital services are taxable in most places at the
customer's location, and the thresholds for registering in the EU and UK are
low. Stripe Tax calculates and collects automatically; enabling it later means
reconstructing what you owed. Once registered, `automatic_tax` needs to be
enabled on the Checkout session in `server/src/routes/billing.ts`, along with
address collection so Stripe knows where the customer is. Small change, but it
is not on today.

**Fraud rules.** *Settings → Radar.* The defaults are reasonable. The pattern
worth blocking here is many small purchases from one IP on different cards.

---

## What each Stripe object maps to in the code

Useful when something looks wrong and you are reading the dashboard next to the
logs.

| Stripe object | Code | Note |
|---|---|---|
| Checkout session id (`cs_…`) | `credit_ledger.reference`, reason `purchase` | The idempotency key for a pack |
| Invoice id (`in_…`) | `credit_ledger.reference`, reason `subscription_renewal` | The idempotency key for a month |
| Customer id (`cus_…`) | `users.stripe_customer_id` | Unique index — one account per customer |
| Subscription id (`sub_…`) | `users.stripe_subscription_id` | Status mirrored to `subscription_status` |
| Event id (`evt_…`) | `stripe_events.id` | Fast-path dedupe only, not the real guarantee |

The real idempotency guarantee is the unique index on
`credit_ledger (reason, reference)`, and it is keyed on the **payment object**
rather than the event id, because Stripe emits several events for one payment
and only one of them should pay out. The index is global rather than per-user,
so a single Checkout session cannot be credited to two accounts.

To answer "why does this account have this balance", query the ledger — it is
the source of truth, and `users.credits` is a cache of it. `GET
/api/billing/reconcile` proves the two agree for the signed-in account.
