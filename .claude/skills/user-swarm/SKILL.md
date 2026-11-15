---
name: user-swarm
description: Build and run a "user swarm" test against a STAGING copy of an app: hundreds of fake users (customers, couriers, merchants, learners, admins…) run real journeys at the same time with a realistic mix of completing, dropping off, abandoning carts and asking for refunds. The swarm then checks that dashboards, database totals, emails, SMS, push notifications and test payments match what the fake users actually did, and writes an expected-vs-actual report. Includes a per-project config, a shared ledger, notification catchers (Mailpit + built-in sink), fast-forwarding scheduled jobs (abandoned cart, reminders) and one-command cleanup of all swarm-test data. Use this whenever the user wants to simulate many users, load/soak/swarm-test real user flows, check that abandoned-cart or reminder notifications actually fire, verify dashboard numbers against real activity, test cron/scheduled jobs end to end, or delete swarm-test data, even if they never say "swarm" (e.g. "throw 500 fake customers at Aerrand staging", "make sure the 3-day reminder emails really go out", "do our admin numbers add up under load?"). Not for unit tests, single-endpoint benchmarks, or production monitoring.
---

# User swarm

A swarm sends many fake users through an app's real journeys at once, then compares two things:

- **The ledger**: what the fake users *did* (each one writes down who, what action, how much, where it stopped, when).
- **The system**: what the app *shows and sent* (dashboard numbers, database totals, emails, SMS, push, payments).

When they disagree, you've found a bug that unit tests rarely catch: a job that only processes
25 carts, a dashboard that forgets refunds, a reminder that never fires.

The reusable engine is in `scripts/` (Node 18+, nothing to install). Everything about a particular
app lives in its own project folder, so the engine never changes between projects.

## How to work with the user

The user may not be a developer. Before each step, say in one or two plain sentences what you're
about to do and why. After it, say what you found. Explain any technical word the first time
(e.g. "staging: a private copy of the app where nothing affects real customers"). Keep it short.
These explanations are part of the deliverable, not decoration.

## Rules that never bend (and why)

1. **Never run against production.** Hundreds of fake sign-ups, emails and payments would hit real
   people and real money. If you can't show the target is staging, stop and ask. The engine
   refuses to run without a recorded confirmation, but you decide what gets recorded, so only
   write it after the user's explicit yes. Details: `references/safety.md`.
2. **Payments in test mode only.** Test keys, test cards. A live key anywhere in the target is a stop.
3. **Ask before building.** Answer-first (Step 0), then confirm the journey list (Step 1), *then*
   write code. Building the wrong journeys wastes everyone's time.
4. **Start small: 1 user, then 10, then the full number.** One user shows the wiring works; ten show
   it works concurrently; the full run finds the bugs. Skipping ahead makes failures unreadable.
5. **Project-specific things go in the project folder only.** If the engine lacks something, add it
   to the engine *generically* so every project benefits.
6. **Don't change the app without approval.** Pointing SMTP at a catcher, adding a staging job
   trigger, or a sink driver are changes to *their* app: propose the smallest diff, explain it,
   wait for a yes. When the swarm finds an app bug, report it with evidence; fix only if asked.

## Where things live

- Engine: `scripts/swarm.mjs` in this skill's folder. Below, `S` means its absolute path.
- Projects: `projects/<name>/` under the current working directory (create `projects/` if needed).
  If the current directory is the app's own repository, ask whether to keep the swarm files there
  or in a separate testing folder.
- A project folder that already has `swarm.config.mjs` + `JOURNEYS.md` means this is a re-run.
  Skip what's already confirmed, but still ask about size and mix, and run `doctor`, which
  re-checks staging.
- Worked example: `assets/demo/` (a small shop app with two planted bugs + its full project config).
  Read `assets/demo/project/swarm.config.mjs` and `personas/customer.mjs` before writing a new
  project; they show every feature in use.

## Workflow

### Step 0: Ask first (no code yet)

Look around briefly first (sibling folders, existing `projects/`) so the questions name real
things. Then ask with AskUserQuestion. Skip anything the user already answered:

1. **Which project?** (e.g. Aerrand, Growth, a client app)
2. **Where is the code, and where is staging?** (a local copy you start with Docker is the safest
   default when there's no hosted staging)
3. **How many fake users?** (e.g. 200 or 1,000)
4. **What behaviour mix?** Default: 50% complete the journey · 20% start but drop halfway ·
   15% begin (add to cart / start a booking) but never pay · 10% sign up and never come back ·
   5% cancel or request a refund. (AskUserQuestion allows 4 questions; combine size and mix.)
5. **What should be checked afterwards?** Dashboard numbers, emails, SMS, push, payments.

Wait for the answers.

### Step 1: Read the code, confirm journeys and notifications

Follow `references/discovery.md`. For a repo with several services, send one Explore subagent per
service with the same brief, then merge. Present to the user:
- roles and their journeys (as user-level steps),
- every notification with channel, recipient, trigger and **delay** (e.g. "abandoned-cart email after 1 hour"),
- the scheduled jobs behind delayed notifications,
- what "drop halfway", "began but never paid" and "cancel/refund" mean in this app,
- unknowns.

Ask the user to confirm or correct it. After confirmation, save it as `projects/<name>/JOURNEYS.md`.
Every check you write later should trace back to a row in this file.

### Step 2: Make staging safe and observable

Read `references/safety.md` and `references/notifications.md`.
1. Establish that the target is staging (evidence + the user's explicit yes for that exact host).
2. Confirm payments use test keys; plan how a test payment completes (watch for webhooks).
3. Route notifications to catchers: Mailpit (`assets/mailpit-compose.yml`, keep `MP_MAX_MESSAGES=0`)
   or the built-in catcher (`node $S catcher`, run in the background). If the app needs a config
   or code change for this, propose it and wait.
4. Find how to trigger each scheduled job now (`references/time-travel.md`).
5. Find how to delete swarm data (tag in email → their child records).

### Step 3: Write the project folder

```bash
node $S new projects/<name>          # scaffold from the template (never overwrites)
```
Then fill in, using `references/config-reference.md`:
- `environment` (baseUrl, allowHosts, productionHosts, `confirmed`, `verify()`), `safety`
- `setup()` if users need things to exist first (courses, products, stores), tagged so cleanup removes them
- one persona per role in `personas/`: `steps`, `behaviours`, `actions` (API calls), and `ui` steps if the user wants the browser option
- `notifications`, `fastForward`, `cleanup()`
- `checks`: one per confirmed notification (list of recipients, so the report names who is missing),
  plus dashboard/DB totals (`measure: 'delta'`) and money (`tolerance: 0.01`). Base expectations on
  what users *did* (`u.did('checkout')`), not on their assigned behaviour. Fill in `expectedLabel`
  and `actualLabel` so each result reads like "Users who didn't check out: 30 → abandoned-cart emails sent: 28 ❌".

Secrets go in the project's `.env` (loaded automatically, never printed). Then:
```bash
node $S doctor projects/<name>       # repeat until it says ✅ Ready
```

### Step 4: 1 user → 10 users → full run

```bash
node $S all projects/<name> --users 1
node $S all projects/<name> --users 10 [--ui 2]
node $S all projects/<name> --users <N> [--ui 5]
```
`all` = run → wait `settleSeconds` → fast-forward → wait → check → report. (Run the pieces
separately with `run`, `fast-forward`, `check` when debugging.)

- **1 user:** read the ledger (`runs/<id>/ledger.csv`) and the report. Failures here are almost
  always the persona or config (wrong endpoint, field, subject filter, token). Fix and repeat
  until every check passes or a failure is clearly the app's.
- **10 users:** catches shared-state and concurrency mistakes in personas. Runs of 20 users or
  fewer automatically include at least one user of every behaviour (so a 5% refund path isn't
  rounded away); `--exact-mix` turns that off.
- **Full run:** this is where app bugs appear (batch limits, rate limits, race conditions, queues
  falling behind). Large runs may need a longer timeout or `run_in_background`.
- **Browser option (`--ui K`)**: needs Playwright in the project folder
  (`npm i -D playwright`; it falls back to installed Google Chrome, or set `swarm.uiBrowser: 'chrome'`).
  Keep K small (5–10); browser users test the real UI while API users make the volume.

Before calling something an app bug, rule out the harness: is the subject filter right, was the
wait long enough, did the job run (see the fast-forward log), is the expectation based on what
users actually did? Then find the cause in the app's code and cite `file:line`.

### Step 5: Report back

Give the user the headline lines from the check output, the path to `runs/<id>/report.html`
(and `report.md`), and for each ❌ a plain explanation: what was expected, what happened, who was
affected (the report lists them), and the likely cause in the code. Say which results you trust
less and why (e.g. other people were using staging during the run, so a dashboard delta may be noisy).

### Step 6: Clean up

```bash
node $S cleanup projects/<name>        # preview: shows what would be deleted
node $S cleanup projects/<name> --yes  # only after the user agrees
```
Show the preview counts, ask, then delete. Ledgers and reports are kept as the record.

If `setup()` created things the app has no way to delete (e.g. no delete-course route), report them
with `deletable: false` in `cleanup()`, tell the user, and offer the options (leave them, delete
via the database, or a staging-only delete route, which is an app change that needs their yes).

Stopping background processes: the catcher, and in-memory apps like the demo, lose everything
when stopped, including caught messages the user may still want to look at. Ask before stopping
them (or save a snapshot first); stopping is effectively a delete.

## When things go wrong

| Symptom | Usually means |
|---|---|
| Safety check fails | Exactly what it says. Fix the config only with real evidence + the user's yes. Never weaken the guard. |
| Every user fails at step 1 | Wrong baseUrl/path prefix, field names, or the app needs a header (API key, `x-client`) |
| 401/403 after signup | Token not set (`u.api.setToken`), cookie auth, or the account needs verifying first (`u.waitForMessage`) |
| 429s or timeouts only at large N | Staging rate limits or capacity. Ask the user to relax limits on staging; it's also a finding. |
| `waitForMessage` times out | The app isn't sending to the catcher. Open http://localhost:4599 or Mailpit's UI and check |
| Notifications short only at large N | A real finding (batch limits, queues) or `settleSeconds` too short; rerun `check` later to tell which |
| Mailpit counts stuck at 500 | Mailpit's default cap; restart it with `MP_MAX_MESSAGES=0` |
| Dashboard delta off by a little | Other activity on staging during the run; say so, or rerun at a quiet time |

## Files

- `scripts/swarm.mjs`: CLI (`new`, `catcher`, `doctor`, `run`, `fast-forward`, `check`, `all`, `cleanup`)
- `scripts/lib/`: safety guard, runner, ledger, notification readers, checker, report
- `scripts/catcher.mjs`: built-in email/SMS/push catcher
- `references/config-reference.md`: every config option, the `u` / `ctx` / `L` APIs, check format
- `references/discovery.md`: finding journeys, notifications, jobs, payments, cleanup keys in code
- `references/safety.md`: confirming staging, payment test modes per provider, data hygiene
- `references/notifications.md`: Mailpit, the catcher, pointing an app's email/SMS/push at them
- `references/time-travel.md`: triggering delayed jobs now
- `assets/project-template/`: what `new` copies · `assets/demo/`: demo app + complete example project
