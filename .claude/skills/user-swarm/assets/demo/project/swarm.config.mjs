// Swarm config for the Demo Shop (assets/demo/app.mjs).
// A complete worked example: copy its shape for real projects.
//
// Only this file and personas/ are project-specific. The engine (scripts/) never changes.

const ADMIN = { headers: { 'x-admin-key': process.env.DEMO_ADMIN_KEY || 'demo-admin-key' } };

export default {
  project: 'demo-shop',

  // ── 1. Where the swarm is allowed to go ────────────────────────────────────
  environment: {
    name: 'staging',
    baseUrl: process.env.SWARM_BASE_URL || 'http://localhost:4600',
    allowHosts: ['localhost', '127.0.0.1'],
    // Real production domains. Requests to these are ALWAYS blocked, even by mistake.
    productionHosts: ['demo-shop.com', '*.demo-shop.com'],
    // Written only after the user said "yes, this is staging" for this exact host.
    confirmed: { host: 'localhost', by: 'demo (local app on this Mac)', on: '2026-11-15', note: 'demo app, in-memory data' },
    // Live proof from the app itself.
    async verify(ctx) {
      const h = await ctx.api.get('/api/health');
      if (h.env !== 'staging') return `health says env=${h.env}`;
      if (h.payments !== 'test') return `health says payments=${h.payments}`;
      return true;
    },
  },

  safety: {
    // Env files of the app under test, scanned for LIVE payment keys (values are never printed).
    scanEnvFiles: [],
  },

  identity: { tag: 'swarm-test', emailDomain: 'example.com' },

  // ── 2. How many users, and how they behave ─────────────────────────────────
  swarm: {
    users: 200,
    mix: { complete: 50, drop_halfway: 20, abandon: 15, signup_only: 10, cancel_refund: 5 },
    concurrency: 50,
    rampUpSeconds: 10,
    thinkTimeMs: [100, 600],
    settleSeconds: 3,
  },

  roles: [
    { persona: './personas/customer.mjs', share: 100 },
  ],

  // ── 3. Where notifications are caught ──────────────────────────────────────
  notifications: {
    email: { source: 'mailpit', url: 'http://localhost:4599' }, // the built-in catcher speaks the Mailpit API; use :8025 for real Mailpit
    sms: { source: 'catcher', url: 'http://localhost:4599' },
    push: { source: 'catcher', url: 'http://localhost:4599' },
  },

  // ── 4. Time fast-forward: run scheduled jobs now, as if hours/days had passed ──
  fastForward: [
    {
      label: 'Pretend 2 hours passed and run the abandoned-cart job',
      run: async (ctx) => ctx.log(JSON.stringify(await ctx.api.post('/api/internal/jobs/abandoned-cart/run', { asOf: ctx.hoursFromNow(2) }, ADMIN))),
    },
    {
      label: 'Pretend 4 days passed and run the inactivity-reminder job',
      run: async (ctx) => ctx.log(JSON.stringify(await ctx.api.post('/api/internal/jobs/inactivity-reminder/run', { asOf: ctx.daysFromNow(4) }, ADMIN))),
    },
  ],

  // ── 5. Expected (from the ledger) vs actual (from the system) ──────────────
  // expected(L) reads the ledger; actual(ctx) reads the app / inboxes.
  // Return lists (emails, phones…) to see exactly WHO is missing; numbers for totals.
  checks: [
    {
      group: 'Emails',
      label: 'Welcome email for every sign-up',
      expectedLabel: 'Users who signed up', actualLabel: 'Welcome emails sent',
      expected: (L) => L.users((u) => u.did('signup')).emails(),
      actual: (ctx) => ctx.email.recipients({ subject: /^Welcome to Demo Shop/ }),
    },
    {
      group: 'Emails',
      label: 'Abandoned-cart email (after 1 hour)',
      expectedLabel: "Users who added to cart but didn't check out", actualLabel: 'Abandoned-cart emails sent',
      expected: (L) => L.users((u) => u.did('addToCart') && !u.did('checkout')).emails(),
      actual: (ctx) => ctx.email.recipients({ subject: 'You left something in your cart' }),
    },
    {
      group: 'Emails',
      label: '"We miss you" email (after 3 days without logging in)',
      expectedLabel: 'Users who signed up and never came back', actualLabel: 'Reminder emails sent',
      expected: (L) => L.users((u) => u.did('signup') && !u.did('login')).emails(),
      actual: (ctx) => ctx.email.recipients({ subject: 'We miss you' }),
    },
    {
      group: 'Emails',
      label: 'Receipt email for every payment',
      expectedLabel: 'Orders paid', actualLabel: 'Receipt emails sent',
      expected: (L) => L.users((u) => u.did('pay')).emails(),
      actual: (ctx) => ctx.email.recipients({ subject: 'Your receipt' }),
    },
    {
      group: 'Emails',
      label: 'Refund email for every refund',
      expectedLabel: 'Refunds requested', actualLabel: 'Refund emails sent',
      expected: (L) => L.users((u) => u.did('refund')).emails(),
      actual: (ctx) => ctx.email.recipients({ subject: /refund for .* is on its way/i }),
    },
    {
      group: 'SMS & push',
      label: 'Payment SMS for every payment',
      expectedLabel: 'Orders paid', actualLabel: 'Payment SMS sent',
      expected: (L) => L.users((u) => u.did('pay')).phones(),
      actual: (ctx) => ctx.sms.recipients({ body: 'payment of' }),
      normalize: (p) => String(p).replace(/\D/g, ''),
    },
    {
      group: 'SMS & push',
      label: 'Order-confirmed push to every paying user’s device',
      expectedLabel: 'Orders paid (device registered)', actualLabel: 'Push notifications sent',
      expected: (L) => L.users((u) => u.did('pay') && u.did('login')).pushTokens(),
      actual: (ctx) => ctx.push.recipients({ subject: 'Order confirmed' }),
    },
    {
      group: 'Dashboard',
      label: 'New sign-ups on the dashboard',
      expectedLabel: 'Users who signed up', actualLabel: 'Dashboard sign-ups (change)',
      measure: 'delta', // dashboard after − before, so other staging data doesn't matter
      expected: (L) => L.count('signup'),
      actual: async (ctx) => (await ctx.api.get('/api/admin/stats', ADMIN)).signups,
    },
    {
      group: 'Dashboard',
      label: 'Paid orders on the dashboard',
      expectedLabel: 'Orders paid and not refunded', actualLabel: 'Dashboard paid orders (change)',
      measure: 'delta',
      expected: (L) => L.count('pay') - L.count('refund'),
      actual: async (ctx) => (await ctx.api.get('/api/admin/stats', ADMIN)).paidOrders,
    },
    {
      group: 'Dashboard',
      label: 'Revenue on the dashboard',
      expectedLabel: 'Money paid minus refunds ($)', actualLabel: 'Dashboard revenue (change, $)',
      measure: 'delta',
      tolerance: 0.01,
      expected: (L) => L.sum('pay') - L.sum('refund'),
      actual: async (ctx) => (await ctx.api.get('/api/admin/stats', ADMIN)).revenue,
    },
  ],

  // ── 6. Cleanup: delete every swarm-test record ─────────────────────────────
  // Must only ever touch records carrying ctx.tag. Return what was (or would be) deleted.
  async cleanup(ctx, { dryRun }) {
    const r = await ctx.api.delete(`/api/admin/test-data?emailContains=${encodeURIComponent(ctx.tag)}${dryRun ? '&dryRun=1' : ''}`, ADMIN);
    return [
      { label: 'users', count: r.users },
      { label: 'orders', count: r.orders },
      { label: 'carts', count: r.carts },
      { label: 'registered devices', count: r.devices },
    ];
  },
};
