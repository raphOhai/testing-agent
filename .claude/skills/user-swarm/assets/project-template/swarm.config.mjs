// Swarm config for __PROJECT__.
// Everything project-specific lives here and in personas/. The engine never changes.
// See the skill's references/config-reference.md for every option, and
// assets/demo/project/ for a complete working example.

// Secrets (admin keys, DB URLs) go in .env next to this file, never in this file.
const ADMIN = { headers: { authorization: `Bearer ${process.env.STAGING_ADMIN_TOKEN}` } };

export default {
  project: '__PROJECT__',

  // ── 1. Where the swarm is allowed to go ────────────────────────────────────
  environment: {
    name: 'staging',
    baseUrl: process.env.SWARM_BASE_URL || 'http://localhost:3000', // TODO: staging API base URL
    // uiBaseUrl: 'http://localhost:5173',                          // TODO: web app URL, if different (for --ui)
    allowHosts: ['localhost', '127.0.0.1'],                          // TODO: staging host(s) ONLY
    productionHosts: [],                                             // TODO: real production domains, always blocked
    // Set ONLY after the user has said "yes, this is staging" for this exact host:
    // confirmed: { host: 'localhost', by: 'the user', on: 'YYYY-MM-DD', note: 'local docker copy' },
    async verify(ctx) {
      // TODO: live proof it's staging, e.g. a health endpoint that reports the environment.
      // const h = await ctx.api.get('/health');
      // return h.env === 'staging' || `health says env=${h.env}`;
      return 'TODO: write environment.verify()';
    },
  },

  safety: {
    scanEnvFiles: [],      // TODO: the app's env files, scanned for LIVE payment keys (values never printed)
    requireTestKeys: [],   // e.g. ['PAYSTACK_SECRET_KEY'] → must contain "test"
    databaseUrls: [],      // e.g. [process.env.STAGING_MONGO_URL] → host must be local/allowed
  },

  identity: { tag: 'swarm-test', emailDomain: 'example.com' },

  // ── 2. How many users, and how they behave ─────────────────────────────────
  swarm: {
    users: 200,
    mix: { complete: 50, drop_halfway: 20, abandon: 15, signup_only: 10, cancel_refund: 5 },
    concurrency: 50,
    rampUpSeconds: 20,
    thinkTimeMs: [300, 1500],
    settleSeconds: 10,
  },

  // One persona file per role. `share` splits the users; `count` fixes a number; `wave` orders them.
  roles: [
    { persona: './personas/customer.mjs', share: 100 },
    // { persona: './personas/merchant.mjs', count: 5, wave: 1 },   // created first
    // { persona: './personas/courier.mjs', share: 15, wave: 2 },
  ],

  // Optional: create what users need before they arrive (courses, products…). Tag it with ctx.tag
  // so cleanup can remove it; users read it via u.shared.get('…').
  // async setup(ctx) {
  //   const course = await ctx.api.post('/admin/courses', { title: `${ctx.tag} course` }, ADMIN);
  //   ctx.shared.set('courses', [course]);
  // },

  // ── 3. Where notifications are caught (see references/notifications.md) ──
  notifications: {
    email: { source: 'mailpit', url: 'http://localhost:8025' }, // or the built-in catcher at :4599
    sms: { source: 'catcher', url: 'http://localhost:4599' },
    push: { source: 'catcher', url: 'http://localhost:4599' },
  },

  // ── 4. Time fast-forward (see references/time-travel.md) ───────────────────
  fastForward: [
    // { label: 'Run the abandoned-cart job as if 2 hours passed',
    //   run: async (ctx) => ctx.api.post('/internal/jobs/abandoned-cart', { asOf: ctx.hoursFromNow(2) }, ADMIN) },
    // { label: 'Run reminders now', command: 'docker compose exec -T api node scripts/run-job.js reminders', cwd: '../../path/to/app' },
  ],

  // ── 5. Expected (ledger) vs actual (system) ────────────────────────────────
  checks: [
    {
      group: 'Emails',
      label: 'Welcome email for every sign-up',
      expectedLabel: 'Users who signed up', actualLabel: 'Welcome emails sent',
      expected: (L) => L.users((u) => u.did('signup')).emails(),
      actual: (ctx) => ctx.email.recipients({ subject: /welcome/i }), // TODO: real subject line
    },
    // { group: 'Dashboard', label: 'Completed orders on the dashboard', measure: 'delta',
    //   expectedLabel: 'Orders completed', actualLabel: 'Dashboard orders (change)',
    //   expected: (L) => L.count('pay'),
    //   actual: async (ctx) => (await ctx.api.get('/admin/stats', ADMIN)).completedOrders },
  ],

  // ── 6. Cleanup: delete every record carrying ctx.tag ───────────────────────
  // Must ONLY touch swarm-test records. Return [{ label, count }]. Honour dryRun.
  async cleanup(ctx, { dryRun }) {
    // Example (MongoDB):
    // const { MongoClient } = await ctx.import('mongodb');
    // const client = await new MongoClient(process.env.STAGING_MONGO_URL).connect();
    // const db = client.db();
    // const users = await db.collection('users').find({ email: { $regex: ctx.tag } }, { projection: { _id: 1 } }).toArray();
    // const ids = users.map((u) => u._id);
    // const orders = await db.collection('orders').countDocuments({ userId: { $in: ids } });
    // if (!dryRun) { await db.collection('orders').deleteMany({ userId: { $in: ids } }); await db.collection('users').deleteMany({ _id: { $in: ids } }); }
    // await client.close();
    // return [{ label: 'users', count: ids.length }, { label: 'orders', count: orders }];
    throw new Error('TODO: write cleanup()');
  },
};
