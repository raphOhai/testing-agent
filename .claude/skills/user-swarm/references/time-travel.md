# Time fast-forward: trigger "later" notifications now

Abandoned-cart emails after 1 hour, reminders after 3 days, trial-ending notices after 14 days:
we can't wait that long. Fast-forwarding makes the app *believe* the time has passed for the
swarm's records, then runs the job immediately. Only the swarm's records and only on staging.

Pick the least invasive technique that works, roughly in this order:

## 1. Call the job directly, with a "pretend it's this time" input
If the job's logic is a function (e.g. `sendAbandonedCartEmails(now = new Date())`), the cleanest
trigger is that function with a future `now`. Ways to reach it:
- An existing admin/internal route (`POST /internal/jobs/:name/run`). Check it's protected and
  disabled in production.
- A CLI/script the repo already has (`npm run job:abandoned`, `php artisan schedule:run`,
  `python manage.py <command>`, `rails runner 'AbandonedCartJob.perform_now'`).
- `docker compose exec -T <service> node -e "require('./dist/jobs/abandoned').run(new Date(Date.now()+2*3600e3))"`.

```js
fastForward: [{ label: 'Abandoned-cart job as if 2 hours passed',
  run: (ctx) => ctx.api.post('/internal/jobs/abandoned-cart/run', { asOf: ctx.hoursFromNow(2) }, ADMIN) }]
```

**On a shared staging, technique 1 affects everyone.** A job run with "now = 4 days from now" acts
on *every* record on staging, not just the swarm's, so other testers' accounts can get emails
too. If other people use this staging, prefer a job input that limits it to the swarm (user ids,
or the tag), or technique 2, or ask the user first.

## 2. Backdate the swarm's records, then trigger the job normally
When the job reads `now` itself, move the swarm's timestamps into the past instead. Filter by the
tag (or the users found by it), never by date alone:

```js
{ label: 'Make swarm carts 2 hours old, then run the job', run: async (ctx) => {
  const { MongoClient } = await ctx.import('mongodb');
  const c = await new MongoClient(process.env.STAGING_MONGO_URL).connect();
  const ids = (await c.db().collection('users').find({ email: { $regex: ctx.tag } }).project({ _id: 1 }).toArray()).map((u) => u._id);
  await c.db().collection('carts').updateMany({ userId: { $in: ids } }, { $set: { updatedAt: ctx.hoursAgo(2) } });
  await c.close();
  ctx.shell('docker compose exec -T worker node jobs/abandoned-cart.js', { cwd: '../../path/to/app' });
} }
```
Backdate *every* field the job looks at (`createdAt`, `updatedAt`, `lastLoginAt`, `lastSeenAt`).
Reading the job's query tells you which.

## 3. Queue-based delays (BullMQ / Bull / Agenda / Celery / Sidekiq)
The work is already queued as a delayed job. Promote it instead of waiting:
- BullMQ: `const jobs = await queue.getDelayed(); for (const j of jobs) if (isSwarm(j.data)) await j.promote();`
- Agenda: `await agenda.now('abandoned cart', data)` or update `nextRunAt` for the swarm's jobs
- Celery: call the task directly (`task.apply(args=…)`) or revoke+re-send without `countdown`
- Sidekiq: `Sidekiq::ScheduledSet.new.each { |j| j.add_to_queue if swarm?(j) }`
- Repeating schedulers (node-cron, `@Cron`, Celery beat) just call the handler on a timer: export
  the handler and call it (technique 1).

## 4. Platform schedulers
- Kubernetes: `kubectl create job --from=cronjob/<name> swarm-ff-$(date +%s) -n staging`
- Vercel cron: call the cron route with the staging `CRON_SECRET`
- Firebase scheduled functions: run in the emulator, or call the exported function via `firebase functions:shell`
- GitHub Actions schedule: `gh workflow run <workflow> --ref staging`
- Supabase `pg_cron`: `select cron.schedule(...)` is the timer, so run the job's SQL/function directly

## 5. Shorten the delay on staging (last resort)
If the delay is configurable (`ABANDONED_CART_DELAY_MINUTES`), set it to 1 on staging and add
`waitSeconds: 90` to the step. Slower and less precise, but needs no code.

Avoid libfaketime / changing the server clock: it affects every record and every job on staging.

## Adding a trigger to the app
If none of the above exists, the smallest useful addition is a staging-only, admin-protected route
or script that runs a job with an optional `asOf`. That's a change to the user's app: propose it,
show the diff, and wait for approval. Make sure it is impossible to call in production (e.g.
refuse when `NODE_ENV === 'production'`).

## Test "not too early" as well as "eventually"

A reminder that fires at 1 minute instead of 3 days is also a bug. Add a step *before* the real
one that runs the job just short of its delay and fails if anything is sent. A failed fast-forward
step shows up in the report as a failed check:

```js
{ label: 'Study reminder as if 2 days passed (too early: must send nothing)', run: async (ctx) => {
  const r = await ctx.api.post('/internal/cron/study-reminder', { now: ctx.daysFromNow(2) }, ADMIN);
  if (r.sent) throw new Error(`sent ${r.sent} reminder(s) after only 2 days`);
} },
{ label: 'Study reminder as if 4 days passed', run: (ctx) => ctx.api.post('/internal/cron/study-reminder', { now: ctx.daysFromNow(4) }, ADMIN) },
```

## Verify it
After `fast-forward`, the report's "Time fast-forward" section shows each step's result. Log what
the job reports (`due`, `sent`) with `ctx.log(...)`. A job that says "sent 25 of 30 due" is
exactly the kind of thing the swarm exists to catch.
