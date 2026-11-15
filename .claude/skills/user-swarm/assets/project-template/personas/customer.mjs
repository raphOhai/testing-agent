// Persona: TODO describe this role (e.g. "a customer who books an errand").
//
// steps      → the full journey, in order (one entry per thing a real person does)
// behaviours → how far each behaviour gets: `through` = last step done, `then` = extra steps after
// actions    → the API calls for each step (u.api is this user's own logged-in client)
// ui         → optional real-browser versions of steps, for users run with --ui

export default {
  role: 'customer',

  steps: ['signup', 'login', 'browse', 'start', 'pay'], // TODO: the real journey

  behaviours: {
    complete: { through: 'pay' },
    drop_halfway: { through: 'browse' },
    abandon: { through: 'start' },          // began (cart/booking/enrolment) but never paid
    signup_only: { through: 'signup' },
    cancel_refund: { through: 'pay', then: ['cancel'] },
  },

  actions: {
    async signup(u) {
      // TODO: real endpoint + fields. u.name / u.email / u.phone / u.password are unique per user.
      const r = await u.api.post('/auth/signup', { name: u.name, email: u.email, phone: u.phone, password: u.password });
      u.api.setToken(r.token);
      // If the app texts/emails a code: const m = await u.waitForMessage('sms', { body: /code/i });
      u.record({ ref: r.id });
    },
    async login(u) { const r = await u.api.post('/auth/login', { email: u.email, password: u.password }); u.api.setToken(r.token); },
    async browse(u) { u.state.items = (await u.api.get('/items')).items; },
    async start(u) {
      const item = u.pick(u.state.items);
      const r = await u.api.post('/orders', { itemId: item.id });
      u.state.order = r.order;
      u.record({ ref: r.order.id, amount: r.order.amount, currency: r.order.currency });
    },
    async pay(u) {
      // Test-mode payment only (see references/safety.md for each provider's test cards/flows).
      const r = await u.api.post(`/orders/${u.state.order.id}/pay`, { card: '4242424242424242' });
      u.record({ ref: u.state.order.id, amount: r.amount, currency: r.currency });
    },
    async cancel(u) {
      const r = await u.api.post(`/orders/${u.state.order.id}/cancel`, {});
      u.record({ ref: u.state.order.id, amount: r.refundAmount });
    },
  },

  // ui: {
  //   async signup(u, page) { await page.goto('/signup'); await page.fill('[name=email]', u.email); /* … */ },
  // },
};
