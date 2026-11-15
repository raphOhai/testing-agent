# Config & persona reference

Everything project-specific lives in one folder:

```
projects/<name>/
  swarm.config.mjs      environment, mix, roles, notifications, fastForward, checks, cleanup
  personas/<role>.mjs   one file per role (customer, courier, merchant, learner, admin…)
  JOURNEYS.md           the journeys + notifications list the user confirmed
  .env                  secrets for staging (admin token, DB URL). Never commit, never print.
  package.json          extra packages: playwright (for --ui), mongodb / pg / mysql2 (DB checks)
  runs/<run-id>/        ledger.jsonl, ledger.csv, run.json, report.html, report.md, results.json
```

The complete working example is `assets/demo/project/` (with its app in `assets/demo/app.mjs`).

## Contents
- [swarm.config.mjs](#swarmconfigmjs)
- [Personas](#personas)
- [The `u` object (inside persona steps)](#the-u-object)
- [The `ctx` object (inside verify / fastForward / checks / cleanup)](#the-ctx-object)
- [The ledger view `L` (inside checks)](#the-ledger-view-l)
- [Checks](#checks)
- [CLI](#cli)

## swarm.config.mjs

```js
export default {
  project: 'aerrand',
  environment: {
    baseUrl: 'https://api.staging.aerrand.com',   // may include a path prefix, e.g. …/api/v1
    uiBaseUrl: 'https://staging.aerrand.com',     // web app for --ui (defaults to baseUrl)
    allowHosts: ['api.staging.aerrand.com', 'staging.aerrand.com'],  // '*.staging.x.com' wildcards ok
    productionHosts: ['aerrand.com', '*.aerrand.com'], // ALWAYS blocked, beats allowHosts
    confirmed: { host: 'api.staging.aerrand.com', by: 'the user', on: '2026-11-15', note: '…' },
    async verify(ctx) { … return true or 'reason it failed' },
  },
  safety: { scanEnvFiles: ['../../errandstack/…/.env.staging'], requireTestKeys: ['PAYSTACK_SECRET_KEY'],
            databaseUrls: [process.env.STAGING_MONGO_URL], allowDbHosts: ['staging-cluster.abc.mongodb.net'] },
  payments: { mode: 'test' },                       // anything else is refused
  identity: { tag: 'swarm-test', emailDomain: 'example.com',
              phone: ({ n, run }) => `+23490${String(n).padStart(8, '0')}` /* override when the app validates country */ },
  swarm: { users: 200, mix: {...}, concurrency: 50, rampUpSeconds: 20, thinkTimeMs: [300, 1500],
           settleSeconds: 10, requestTimeoutMs: 30000, maxUsers: 5000, uiBrowser: 'chrome' },
  roles: [ { persona: './personas/customer.mjs', share: 80, mix: {...optional per-role mix} },
           { persona: './personas/merchant.mjs', count: 5, wave: 1 },
           { persona: './personas/courier.mjs', share: 20, wave: 2, mix: { complete: 80, abandon: 20 } } ],
  async setup(ctx) { … ctx.shared.set('courses', [...]) },  // optional: seed data before users arrive
  notifications: { email: {...}, sms: {...}, push: {...}, whatsapp: {...} },  // see notifications.md
  fastForward: [ { label, run: async (ctx) => {} } | { label, command: '…', cwd: '…' }, waitSeconds? ],
  checks: [ … ],
  async cleanup(ctx, { dryRun }) { return [{ label: 'users', count: 12 }] },
};
```

Notes:
- **Identity**: every fake user gets `name`, `firstName`, `lastName`, `email`
  (`swarm-test.<run>.u0007@example.com`), `phone` (+44 7700 900xxx, a range reserved for fiction),
  `password`, `pushToken`, and `id`. Override any of `email/phone/name/password/pushToken` with a
  function `({ n, run, tag, ...defaults }) => value`. The email must keep the tag.
- **Mix keys** are free-form; the defaults are `complete`, `drop_halfway`, `abandon`,
  `signup_only`, `cancel_refund`. Counts are exact (200 × 15% is exactly 30); runs of ≤ 20 users get at least one of each behaviour unless `--exact-mix`.
- **Roles**: `count` (fixed number) is taken first, the rest is split by `share`. All roles in
  wave 1 finish before wave 2 starts. Use waves when one role must exist before another can act
  (merchants before customers). Roles that interact *during* the run (customer posts an errand,
  courier accepts it) should be in the same wave; the courier polls with `u.waitFor`.
- **`setup(ctx)`** runs once per run, after the safety check and before any user starts. Use it for
  things that must exist first and aren't part of anyone's journey (courses, products, stores,
  promo codes). Put what users need into `ctx.shared` (a `Map`; users read it as `u.shared`); it's
  saved to `runs/<id>/setup.json`. **Name or tag everything it creates with `ctx.tag`** (e.g. title
  `swarm-test course 3`) and delete it in `cleanup()`. If creating the thing *is* a journey you
  want to test (merchants onboarding), use a role with `wave: 1` instead.
- `uiBrowser: 'chrome'` uses the installed Google Chrome instead of Playwright's own Chromium.

## Personas

```js
export default {
  role: 'courier',
  steps: ['signup', 'goOnline', 'acceptJob', 'pickUp', 'deliver'],
  behaviours: {
    complete: { through: 'deliver' },
    drop_halfway: { through: 'acceptJob', then: ['cancelJob'] },
    abandon: { through: 'goOnline' },
  },
  actions: { async signup(u) {…}, async goOnline(u) {…}, … , async cancelJob(u) {…} },
  ui: { async signup(u, page) {…} },   // optional; steps without a UI version use the API version
};
```

A behaviour missing from `behaviours` but present in the mix is an error (doctor reports it). A role
that doesn't have a given behaviour should get its own `mix` in `roles`.

Each step is written to the ledger automatically, with timing and ok/failed/stopped status.
**A thrown error fails the step and ends that user's journey.** Never swallow errors to make a run
look clean: a failing step is a finding.

## The `u` object

| Field / method | What it is |
|---|---|
| `u.id, u.n, u.name, u.firstName, u.lastName, u.email, u.phone, u.password, u.pushToken` | This fake user's identity |
| `u.role, u.behaviour, u.plan, u.run, u.ui` | Role, behaviour, the steps it will do, run id, whether it's a browser user |
| `u.api` | HTTP client bound to `baseUrl`: `get(path, opts)`, `post(path, body, opts)`, `put`, `patch`, `delete`, `request(method, path, { body, form, query, headers, expect })`, `setToken(token, scheme='Bearer')`, `setHeader(k, v)`. Keeps cookies. Throws on 4xx/5xx unless `expect: [200, 409]`. |
| `u.page` | Playwright page (browser users only; also passed as 2nd arg to `ui` steps) |
| `u.state` | Scratch space for this user (order id, chosen item…) |
| `u.shared` | A `Map` shared by every user in the run (filled by `setup()`, or by wave-1 users, e.g. merchants publish their store ids) |
| `u.rand(), u.int(a, b), u.pick(list), u.chance(p)` | Seeded random choices (repeatable with `--seed`) |
| `u.record({ amount, currency, ref, note, ...anything })` | Adds details to this step's ledger line. Record `amount` on every step that moves money. |
| `u.stop(reason)` | End the journey early **without** counting it as an error (e.g. "no jobs to accept") |
| `u.waitFor(fn, { timeoutMs, everyMs, what })` | Poll until `fn()` returns something truthy |
| `u.waitForMessage(channel, filter, { timeoutMs, full })` | Wait for an email/SMS/push **to this user**, e.g. a sign-up code. `full: true` adds `.text` with the whole email body (to find a verification link). |
| `u.think()` | Random pause (the runner already pauses between steps) |
| `u.config, u.env, u.log()` | Config, `process.env`, prefixed logging |

## The `ctx` object

| Field / method | What it is |
|---|---|
| `ctx.api` | HTTP client for `baseUrl` (admin calls: pass headers per request) |
| `ctx.http(baseUrl)` | Client for another **allowed** host |
| `ctx.email`, `ctx.sms`, `ctx.push`, `ctx.<channel>` | Notification readers (below) |
| `ctx.tag` | `'swarm-test'`: everything cleanup touches must match it |
| `ctx.run` | `{ id, dir }` of the current run (in `setup`, `fastForward` and checks; `null` in cleanup) |
| `ctx.shared` | (`setup` only) the `Map` users will see as `u.shared` |
| `ctx.setups` | (`cleanup` only) `[{ run, data }]`: what `setup()` stored in every earlier run (from `runs/*/setup.json`) |
| `ctx.project` | `{ name, dir }`: the project folder |
| `ctx.shell(cmd, { cwd })` | Run a command (cwd relative to the project folder) |
| `ctx.import(pkg)` | Import a package installed in the project folder (`mongodb`, `pg`, …) |
| `ctx.hoursFromNow(h)`, `ctx.daysFromNow(d)` | ISO strings for "pretend it's later" |
| `ctx.hoursAgo(h)`, `ctx.daysAgo(d)` | `Date`s for backdating records |
| `ctx.env`, `ctx.log()`, `ctx.config` | |

**Notification readers.** In checks, readers only see messages to *this run's* fake users that
arrived *after the run started*. In cleanup they see every message carrying the tag.
- `await ctx.email.recipients(filter)`: one address per message (duplicates kept, so double-sends show)
- `await ctx.email.messages(filter)` → `[{ id, to: [..], subject, body, created }]`
- `await ctx.email.count(filter)`
- `filter`: `{ subject, body, text, to, where }`. Strings match case-insensitively as substrings; or pass a RegExp; `where: (m) => bool`.
- For email, `body` is Mailpit's 250-character snippet; use `subject` where possible.

**Cleanup's return value**: `[{ label, count, note?, deletable? }]`. Use `deletable: false` (with a
`note` saying why) for swarm data the app gives no way to delete; it's printed as a warning
instead of "Would delete".

## The ledger view `L`

| | |
|---|---|
| `L.users(filter?)` | List of user summaries; `.emails()`, `.phones()`, `.pushTokens()`, `.ids()`, `.count` |
| user summary | `id, n, name, email, phone, pushToken, role, behaviour, mode, plan, stepsOk, stepsFailed, stoppedAt, outcome ('completed-plan' / 'stopped' / 'error'), error`, plus `did(step)`, `tried(step)`, `amount(step)` |
| `L.count(step, filter?)` | Number of successful `step` records |
| `L.sum(step, field='amount', filter?)` | Sum over successful `step` records |
| `L.byRole(r)`, `L.byBehaviour(b)`, `L.records(filter)` | |

Base expectations on **what users actually did** (`u.did('addToCart') && !u.did('checkout')`), not on
the behaviour they were assigned. If a step failed, the user didn't do it, and expecting a
notification for it would blame the wrong thing.

## Checks

```js
{
  group: 'Emails',                       // report section
  label: 'Abandoned-cart email (after 1 hour)',
  expectedLabel: "Users who didn't check out",  // left side:  "Users who didn't check out: 30
  actualLabel: 'Abandoned-cart emails sent',    // right side:  → Abandoned-cart emails sent: 28 ❌"
  expected: (L, ctx) => list | number,
  actual: (ctx, L) => list | number,
  measure: 'delta',        // optional: actual = value after − value before the run (dashboards/DB totals)
  tolerance: 0.01,         // optional, numbers only
  normalize: (x) => …,     // optional, lists: how to compare items (default: trim + lowercase)
  allowDuplicates: false,  // optional, lists: a recipient getting it twice is a failure by default
  when: (L) => bool,       // optional: skip when not applicable
  note: '…',               // optional: shown under the result
}
```

- **Lists beat numbers** for notifications: the report names who is missing, who was unexpected,
  and who got it twice. Use numbers for dashboard totals and money.
- **Dashboards and DB totals** include everything on staging, so use `measure: 'delta'`. The
  "before" value is captured automatically when `run` starts.
- Money: compare with `tolerance: 0.01` and make sure the ledger recorded `amount` with the same
  unit (kobo vs naira, cents vs dollars).

## CLI

`S="<skill-dir>/scripts/swarm.mjs"`

| Command | What it does |
|---|---|
| `node $S new projects/<name> [--example demo]` | Scaffold a project folder (won't overwrite) |
| `node $S catcher [--port 4599] [--smtp 1025\|off]` | Built-in email (SMTP + Mailpit-compatible API) / SMS / push catcher. Run in the background. |
| `node $S doctor projects/<name>` | Safety check + wiring checklist. Exit code 0 = ready. |
| `node $S run projects/<name> --users N [--ui K] [--seed S] [--concurrency C] [--headed] [--exact-mix]` | Run the swarm; writes the ledger. ≤ 20 users get at least one of every behaviour unless `--exact-mix`. |
| `node $S fast-forward projects/<name> [--run ID]` | Trigger scheduled jobs (latest run by default) |
| `node $S check projects/<name> [--run ID]` | Build the report. Exit code 2 = something failed. |
| `node $S all projects/<name> --users N [--ui K] [--settle S]` | run → wait → fast-forward → wait → check |
| `node $S cleanup projects/<name> [--yes]` | Preview, or with `--yes` delete, all swarm-test data |

Set `SWARM_DEBUG=1` for stack traces.
