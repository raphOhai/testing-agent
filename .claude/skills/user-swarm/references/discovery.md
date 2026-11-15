# Discovery: reading a codebase for journeys and notifications

Goal: produce a list the user can confirm in a minute: roles, journeys (steps), notifications
(with trigger and delay), scheduled jobs, payments, and how to clean up. Every row should point to
the code it came from (`file:line`) so the user can trust it.

For a multi-service repo, split the work: one Explore subagent per service/app (customer API,
courier API, admin, workers…), each asked for the same table below. Merge the results yourself.

## 1. Roles
Look at: user models/schemas (`role`, `type`, `userType` enums), auth guards/middleware
(`isAdmin`, `requireRole('merchant')`), separate apps/folders (`customer_backend`, `driver_app`),
route prefixes (`/merchant/*`, `/courier/*`).

## 2. Journeys (what each role does, in order)
Look at route definitions and the client apps that call them:
- Express/Fastify/Nest: `router.(get|post|put|patch|delete)\(`, `@(Get|Post|Put|Patch|Delete)\(`, `app.(get|post)`
- Django/DRF: `urls.py`, `@api_view`, `ViewSet`; Laravel: `routes/api.php`; Rails: `config/routes.rb`
- Go: `HandleFunc`, `r.(GET|POST)`, chi/gin/echo routers; Rust: axum `route(`, actix `#[post(`
- Next.js: `app/**/route.ts`, `pages/api/**`; Supabase/Firebase: functions folders, `onCall`, `onRequest`
- Mobile/web clients: API service files (`api.ts`, `services/*.dart`, `axios.create`, `fetch(`)
- Postman collections / OpenAPI specs if present (often the fastest map)

Write each journey as user-level steps (signup → verify phone → add address → create errand →
pay → track → rate), then note the endpoint behind each step. Mark what "half way", "began but
didn't pay", and "cancel/refund" mean for this app; the user's behaviour mix depends on it.

## 3. Notifications (what is sent, to whom, when)
Search for senders:
- Email: `nodemailer`, `createTransport`, `@sendgrid/mail`, `sgMail`, `resend`, `postmark`, `mailgun`, `SES`, `sendEmail(`, `Mail::to`, `send_mail(`, `ActionMailer`, email template folders (`templates/emails`, `*.mjml`, `*.hbs`)
- SMS / WhatsApp: `twilio`, `termii`, `africastalking`, `vonage`, `nexmo`, `messagebird`, `sendSms(`, `whatsapp`
- Push: `firebase-admin` `messaging()`, `sendToDevice`, `sendEachForMulticast`, `expo-server-sdk`, `onesignal`, `apns`, `fcm`
- In-app: `notifications` collection/table inserts, socket emits

For each, find the **trigger** (which endpoint/event/job calls it), the **recipient** (customer?
courier? admin?), and the **delay** (immediate, or scheduled). A notification with a delay
is almost always sent by a scheduled job. Find it in step 4.

## 4. Scheduled / delayed jobs
- Node: `node-cron`, `cron`, `croner`, `agenda` (`agenda.every`, `agenda.schedule`), `bull`/`bullmq` (`repeat:`, `delay:`), `@nestjs/schedule` `@Cron(`, `setInterval(` in workers
- Python: Celery beat (`beat_schedule`, `@periodic_task`, `apply_async(countdown=`), APScheduler, django-q, RQ scheduler
- PHP/Ruby: Laravel `Kernel::schedule`, `->delay(`; sidekiq-cron, `whenever`, `perform_in`/`perform_at`
- Infra: `vercel.json` `crons`, Kubernetes `CronJob`, GitHub Actions `schedule:`, Firebase `onSchedule`/`pubsub.schedule`, Cloud Scheduler, Supabase `pg_cron`, `crontab` files in Docker images
- Look for the **threshold** inside the job query (`createdAt < now - 1h`, `lastLoginAt < now - 3d`). That's what fast-forwarding has to beat.

## 5. Payments
Provider SDK/imports, the payment step endpoint, the webhook route, what status the order gets on
success/refund, and whether a webhook is needed to finish a payment (see safety.md).

## 6. Cleanup map
Which collections/tables hold user-created data, and how they link to the user (foreign keys,
`userId`, `customerId`, `courierId`). Cleanup will find swarm users by the tag in their email,
then delete their children first.

## 7. Dashboard numbers
What the admin dashboard shows (counts, revenue, active users) and where it reads them from (an
`/admin/stats` endpoint, aggregation pipeline, SQL view). These become `measure: 'delta'` checks.

## Output: present this to the user, then save it as `projects/<name>/JOURNEYS.md`

```markdown
## Roles
- Customer: books errands (aerrand_customer_backend)
- Courier: accepts and delivers (aerrand_driver_backend)

## Journeys
| Role | Step | Endpoint | Code |
|---|---|---|---|
| Customer | Sign up + verify phone (OTP) | POST /auth/signup, POST /auth/verify | auth.controller.ts:42 |

## Notifications
| What | Channel | To | Trigger | Delay | Code |
|---|---|---|---|---|---|
| Welcome | Email | Customer | signup | immediate | mail/welcome.ts:10 |
| Abandoned errand | Push | Customer | errand created, not paid | 1 hour (cron every 15 min) | jobs/abandoned.ts:5 |

## Scheduled jobs
| Job | Schedule | Threshold | How to trigger now |
|---|---|---|---|

## Behaviour mapping
- Drop halfway = …   - Began but never paid = …   - Cancel/refund = …

## Questions / unknowns
- …
```

Keep unknowns visible rather than guessing. "I couldn't find what sends the 3-day reminder" is
a useful finding in itself.
