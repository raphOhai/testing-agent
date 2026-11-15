# Catching notifications

To count what was *actually* sent, every email, SMS and push from staging must land somewhere we
can read, and **nothing may reach a real inbox or phone**. Two catchers:

- **Mailpit** (recommended for email): real fake inbox with a web UI.
  `docker compose -f assets/mailpit-compose.yml up -d` (SMTP :1025, UI/API :8025), or
  `brew install mailpit && mailpit --max 0`. Its default limit of 500 messages silently deletes
  older mail, so always set `MP_MAX_MESSAGES=0` / `--max 0` for swarms.
- **Built-in catcher** (`node scripts/swarm.mjs catcher`, no install): SMTP on :1025 with a
  Mailpit-compatible API on :4599, plus a sink for SMS/push/anything at `POST :4599/sink/<channel>`
  and a live page at http://localhost:4599. In-memory: restarting it empties it. If Mailpit already
  owns :1025, the catcher skips SMTP and only takes SMS/push.

Start whichever you use in the background before running the swarm.

## Config sources

```js
notifications: {
  email: { source: 'mailpit', url: 'http://localhost:8025' },   // Mailpit, or the catcher at :4599
  sms:   { source: 'catcher', url: 'http://localhost:4599' },   // reads /sink/sms
  push:  { source: 'catcher', url: 'http://localhost:4599' },   // reads /sink/push
  whatsapp: { source: 'catcher', url: 'http://localhost:4599', channel: 'whatsapp' },
  // App logs instead (e.g. a staging driver that logs messages). Group 1 = recipient, group 2 = text:
  // sms: { source: 'log', command: 'docker compose logs api --no-color --since 2h', cwd: '../../app', pattern: /\[sms\] to=(\S+) body=(.*)/ },
  // Anything else (a provider's test-mode API, a DB table of sent notifications):
  // push: { source: 'custom', fetch: async (ctx) => [{ to, subject, body, created }], remove: async (ctx, msgs) => {} },
}
```

A `notifications` table in the app's own DB is a great `custom` source, but it proves the app
*meant* to send, not that the provider *accepted* it. Say which one you're counting.

## Pointing the staging app at the catcher

Prefer config over code. Look for the app's existing switches first.

**Email**
- SMTP-based (nodemailer, Laravel, Django, Rails): set staging `SMTP_HOST=localhost` (or the docker
  service name, e.g. `mailpit`), `SMTP_PORT=1025`, no TLS, any user/pass.
- API-based providers (SendGrid, Resend, Postmark, Mailgun, SES): these don't speak SMTP to us.
  Options, best first: (1) the app already has a "use SMTP in non-production" switch; (2) add a
  small staging-only transport switch (`EMAIL_TRANSPORT=smtp` → nodemailer to Mailpit), a few
  lines, **with the user's approval**; (3) SendGrid/Mailgun/Resend all support SMTP relay, so
  point the same code at Mailpit by host. Provider "sandbox/test modes" usually don't store
  messages anywhere you can count, so they're a last resort.

**SMS / WhatsApp** (Twilio, Termii, Africa's Talking, Vonage…)
- Real gateways can't be pointed at localhost, and test credentials (e.g. Twilio's) don't keep a
  list of messages, so a staging driver that POSTs to the sink is the dependable route:
  ```js
  // staging-only: SMS_DRIVER=sink
  if (process.env.SMS_DRIVER === 'sink') {
    await fetch(`${process.env.SMS_SINK_URL}/sink/sms`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, body }) });
    return;
  }
  ```
  Or, if the app already logs messages in non-prod, use the `log` source.
- Africa's Talking has a sandbox with a simulator. Fine for a handful of users, not for counting.

**Push** (FCM / firebase-admin, Expo, OneSignal)
- Same pattern: `PUSH_DRIVER=sink` posts `{ to: deviceToken, title, body }` to `/sink/push`.
  The sink also understands FCM's `{ message: { token, notification: { title, body } } }` shape.
- Fake users register `u.pushToken` (`swarm-test-<run>-device-0007`) as their device token so pushes
  can be matched to users.

Any change to the app's code or staging config is the user's call. Propose the smallest change,
show the diff, explain it in plain words, and wait for a yes.

## Reading codes and links inside a journey

```js
const sms = await u.waitForMessage('sms', { body: /code/i });
const code = sms.body.match(/\b\d{4,6}\b/)[0];

const mail = await u.waitForMessage('email', { subject: /verify/i }, { full: true });
const link = mail.text.match(/https?:\/\/\S+/)[0];
```

Only messages to this user, sent after the run started, are considered.

## Counting in checks

`ctx.email.recipients({ subject: 'You left something' })` returns one entry per message per swarm
recipient, so the checker can report missing, unexpected and duplicate sends by name. Match on
**subject** for email (the body is only a 250-character snippet) and on body text for SMS/push.
If subjects are personalised ("Welcome, Ada!"), use a RegExp (`/^Welcome, /`).
