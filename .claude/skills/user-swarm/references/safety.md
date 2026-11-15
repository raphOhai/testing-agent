# Safety: staging only, test payments only

The swarm creates hundreds of real records, sends hundreds of notifications and makes payments.
Pointed at production, that means real customers get spam, real money moves, and real dashboards
are polluted. So the rule is simple: **if you can't show it's staging, stop and ask.**

The engine enforces this (`scripts/lib/safety.mjs`): `run`, `fast-forward`, `check` and `cleanup`
all refuse to start unless the safety check passes, and every HTTP request is checked against the
allow-list. Your job is to make sure what goes *into* the config is true.

## Confirming the target is staging

Before writing `environment.confirmed`, you need **the user's explicit yes** for the exact host,
plus as much evidence as you can gather. Good evidence:

- The host is local (`localhost`, a private IP, a docker service) and you started it yourself.
- The hostname says so (`staging.`, `stg-`, `-dev`, `test.`) **and** it's different from the
  production domain the user named.
- The app reports it: a `/health` or `/version` endpoint returning `env: "staging"`, or a staging
  banner in the UI. Put this in `environment.verify()` so it's re-checked on every run.
- The app's env/config for that deployment says `NODE_ENV/APP_ENV=staging` and uses test payment keys.
- The database it uses is a staging database (name, host, or the user tells you).

Red flags (stop and ask, even if the user said "it's staging"):
- The hostname is the same as, or a `www`/`api` variant of, the production domain.
- `verify()` can't be written because nothing on the server distinguishes staging from prod.
- The env file has live payment keys, `NODE_ENV=production` *and* a production DB host.
- Real customer-looking data appears in responses.

Ask in plain words, e.g.: *"I'm about to send 200 fake users to `api.staging.aerrand.com`. Its health
check says `env: staging` and its Paystack key is a test key. Can you confirm this is staging and
not used by real customers?"* Only after a clear yes, record:

```js
confirmed: { host: 'api.staging.aerrand.com', by: 'the user', on: '2026-11-15', note: 'health=staging, paystack test key' }
```

The confirmation is tied to the host. A different host means asking again. Always list the real
production domains in `productionHosts`; they're blocked even if someone adds them to `allowHosts`.

## Payments: test mode only

Before any persona makes a payment, check the staging app uses **test** credentials. Add the app's
env file to `safety.scanEnvFiles` (the engine blocks live keys and reports only the variable
*name*) and the key names to `requireTestKeys`. Never print secret values in chat or logs.

`scanEnvFiles`/`requireTestKeys` only see files on this machine. When staging is hosted, or the app
reports its payment mode at runtime (a health/config endpoint), make `environment.verify()` check
that too. It runs before every command, against the live app.

| Provider | Test-mode sign | Test card / method | Completing a payment in tests |
|---|---|---|---|
| Stripe | keys start `sk_test_` / `pk_test_` | `4242 4242 4242 4242`, any future date/CVC; `4000 0000 0000 0002` declines | PaymentIntents with `pm_card_visa`; webhooks via `stripe listen --forward-to` or `stripe trigger` |
| Paystack | keys start `sk_test_` / `pk_test_` | `4084 0840 8408 4081`, CVV 408, PIN 0000, OTP 123456 | Server-side `transaction/initialize` then `charge`; or post the app's own webhook with an `x-paystack-signature` = HMAC-SHA512(body, test secret) |
| Flutterwave | keys contain `_TEST` (`FLWSECK_TEST-…`) | `5531 8866 5214 2950`, CVV 564, PIN 3310, OTP 12345 | Webhook header `verif-hash` = your test secret hash |
| PayPal | sandbox client id, `api-m.sandbox.paypal.com` | sandbox buyer accounts | sandbox webhooks / simulator |
| Monnify | `sandbox.monnify.com` base URL | sandbox test accounts | sandbox webhook |
| Razorpay | `rzp_test_` | `4111 1111 1111 1111` | test-mode webhooks |

(Check the provider's current docs if a test value is rejected; they change occasionally.)

**Webhooks are the usual trap.** Many apps mark an order "paid" only when the provider's webhook
arrives. Against a local staging copy, the provider can't reach `localhost`, so either:
1. run the provider's CLI tunnel (Stripe CLI), or
2. have the persona call the app's webhook endpoint itself with a correctly signed **test** payload
   (the signature uses the test secret from the staging env), or
3. use the app's own "mark as paid" staging/admin route if it has one.
Say which one you chose in JOURNEYS.md so the report is read correctly.

## Data hygiene

- Every fake user's email contains `swarm-test` (the tag); cleanup finds everything by it. Child
  records (orders, payments, addresses) are found through those users' ids.
- Default email domain is `example.com` (reserved, never delivers). Default phones are
  `+44 7700 900xxx` (reserved for fiction). If the app insists on local numbers, pick a range that
  is unallocated or the provider's documented test numbers, and make sure SMS is caught (see
  notifications.md). **Never let the swarm send SMS through a live gateway.**
- Firebase phone auth: use Firebase's *test phone numbers* (fixed code, no SMS sent) or the Auth
  emulator.
- Cleanup must filter by the tag. Never by date, never "delete all", never a broad collection drop.
  Always preview (`cleanup` without `--yes`) and show the user the counts first.
- If staging has rate limits, CAPTCHAs or bot protection, ask the user to relax them **on staging
  only** (or allow-list your IP) rather than working around them in code.
