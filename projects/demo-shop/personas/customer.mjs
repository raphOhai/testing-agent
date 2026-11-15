// Persona: a Demo Shop customer.
//
// `steps` is the full journey in order. Each behaviour says how far a user gets
// (`through` = the last step they do) and anything extra they do after (`then`).
// `actions` makes the API calls for each step; `ui` (optional) does the same step
// through the real website with Playwright, for the few users run with --ui.

const TEST_CARD = '4242424242424242'; // test-mode card: never a real one

export default {
  role: 'customer',

  steps: ['signup', 'login', 'browse', 'addToCart', 'checkout', 'pay'],
  // signup includes reading the 6-digit code the app texts, like a real phone verification.

  behaviours: {
    complete: { through: 'pay' },
    drop_halfway: { through: 'browse' },       // logs in, looks around, leaves
    abandon: { through: 'addToCart' },         // fills a cart, never checks out
    signup_only: { through: 'signup' },        // signs up, never comes back
    cancel_refund: { through: 'pay', then: ['refund'] },
  },

  actions: {
    async signup(u) {
      const r = await u.api.post('/api/signup', { name: u.name, email: u.email, phone: u.phone, password: u.password });
      u.api.setToken(r.token);
      // Read the code from this user's SMS (caught by the catcher), then type it in.
      const sms = await u.waitForMessage('sms', { body: /code is/i });
      await u.api.post('/api/verify', { code: sms.body.match(/\b\d{6}\b/)[0] });
      u.record({ ref: r.userId });
    },
    async login(u) {
      // "Coming back later" = a fresh login, then register this device for push.
      const r = await u.api.post('/api/login', { email: u.email, password: u.password });
      u.api.setToken(r.token);
      await u.api.post('/api/devices', { token: u.pushToken });
    },
    async browse(u) {
      const { products } = await u.api.get('/api/products');
      u.state.products = products;
    },
    async addToCart(u) {
      const products = u.state.products || (await u.api.get('/api/products')).products;
      const howMany = u.int(1, 3);
      for (let i = 0; i < howMany; i++) {
        await u.api.post('/api/cart/items', { productId: u.pick(products).id, qty: u.int(1, 2) });
      }
      u.record({ note: `${howMany} item line(s)` });
    },
    async checkout(u) {
      const { order } = await u.api.post('/api/checkout', {});
      u.state.order = order;
      u.record({ ref: order.id, amount: order.amount, currency: order.currency });
    },
    async pay(u) {
      const { order } = await u.api.post(`/api/orders/${u.state.order.id}/pay`, { card: TEST_CARD });
      u.record({ ref: order.id, amount: order.amount, currency: order.currency });
    },
    async refund(u) {
      const { order } = await u.api.post(`/api/orders/${u.state.order.id}/refund`, {});
      u.record({ ref: order.id, amount: order.amount, currency: order.currency });
    },
  },

  // Real-browser versions of some steps. Steps without a UI version fall back to the API.
  // The demo UI is one page, so a UI user does signup → addToCart → checkout → pay in the
  // browser; login/browse fall back to the API.
  ui: {
    async signup(u, page) {
      await page.goto('/');
      await page.fill('#name', u.name);
      await page.fill('#email', u.email);
      await page.fill('#phone', u.phone);
      await page.fill('#password', u.password);
      await page.click('#signup-btn');
      await page.waitForSelector('#verify:not([hidden])');
      const sms = await u.waitForMessage('sms', { body: /code is/i });
      await page.fill('#code', sms.body.match(/\b\d{6}\b/)[0]);
      await page.click('#verify-btn');
      await page.waitForSelector('#shop:not([hidden])');
      // Share the browser's session with the API client so API-only steps keep working.
      // (Don't log in again via the API: that would count as "coming back".)
      const token = await page.evaluate(() => (typeof token !== 'undefined' ? token : null));
      if (!token) throw new Error('Signed up in the browser but could not read the session token');
      u.api.setToken(token);
    },
    async addToCart(u, page) {
      await page.waitForSelector('[data-add]');
      const n = u.int(1, 3);
      for (let i = 0; i < n; i++) {
        const buttons = page.locator('[data-add]');
        await buttons.nth(u.int(0, (await buttons.count()) - 1)).click();
        await page.waitForFunction((want) => Number(document.querySelector('#cart-count').textContent) >= want, i + 1);
      }
      u.record({ note: `${n} item(s) via UI` });
    },
    async checkout(u, page) {
      await page.click('#checkout-btn');
      await page.waitForSelector('#payment:not([hidden])');
      u.record({ amount: Number(await page.textContent('#total')), currency: 'USD' });
    },
    async pay(u, page) {
      await page.fill('#card', TEST_CARD);
      await page.click('#pay-btn');
      await page.waitForSelector('#done:not([hidden])');
      const id = await page.textContent('#order-id');
      u.state.order = { id }; // so a later API step (refund) knows which order
      u.record({ ref: id, amount: Number(await page.textContent('#total')), currency: 'USD' });
    },
  },
};
