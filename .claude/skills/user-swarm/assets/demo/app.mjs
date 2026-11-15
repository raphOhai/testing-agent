#!/usr/bin/env node
// Demo Shop: a tiny fake "staging" app for trying the swarm end to end. No dependencies.
//
//   node app.mjs            → http://localhost:4600  (APP_ENV=staging, PAYMENTS_MODE=test)
//
// It sends real SMTP email to localhost:1025 (Mailpit or `swarm.mjs catcher`) and posts
// SMS/push to the catcher's sink at http://localhost:4599. Data is in memory.
//
// It has TWO PLANTED BUGS so the report has something to catch:
//   1. The abandoned-cart job only processes the first 25 carts per run (a batch limit
//      with no loop). Invisible with 10 users, obvious with 200.
//   2. The dashboard's revenue figure never subtracts refunds.
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 4600);
const APP_ENV = process.env.APP_ENV || 'staging';
const PAYMENTS_MODE = process.env.PAYMENTS_MODE || 'test';
const ADMIN_KEY = process.env.ADMIN_KEY || 'demo-admin-key';
const SMTP_HOST = process.env.SMTP_HOST || '127.0.0.1';
const SMTP_PORT = Number(process.env.SMTP_PORT || 1025);
const SINK_URL = process.env.SINK_URL || 'http://127.0.0.1:4599/sink';
const ABANDON_AFTER_MS = 60 * 60 * 1000;         // abandoned-cart email after 1 hour
const INACTIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // "we miss you" after 3 days without a login
const BATCH = 25;

const PRODUCTS = [
  { id: 'p1', name: 'Canvas tote', price: 18 },
  { id: 'p2', name: 'Ceramic mug', price: 12.5 },
  { id: 'p3', name: 'Notebook set', price: 9 },
  { id: 'p4', name: 'Desk lamp', price: 42 },
  { id: 'p5', name: 'Wool scarf', price: 27 },
];

const db = { users: new Map(), sessions: new Map(), carts: new Map(), orders: new Map(), devices: new Map() };

// ── notifications ────────────────────────────────────────────────────────────
function sendEmail(to, subject, text) {
  const sock = net.createConnection(SMTP_PORT, SMTP_HOST);
  const lines = [
    'EHLO demo-shop', 'MAIL FROM:<shop@demo-shop.test>', `RCPT TO:<${to}>`, 'DATA',
    `From: Demo Shop <shop@demo-shop.test>\r\nTo: <${to}>\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@demo-shop.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text.replace(/^\./gm, '..')}\r\n.`,
    'QUIT',
  ];
  let i = 0;
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    // Send the next command each time the server finishes a reply line.
    while (/\r\n/.test(buf)) {
      const line = buf.slice(0, buf.indexOf('\r\n'));
      buf = buf.slice(buf.indexOf('\r\n') + 2);
      if (/^\d{3}-/.test(line)) continue; // multi-line reply, wait for the last line
      if (i < lines.length) sock.write(`${lines[i++]}\r\n`);
    }
  });
  sock.on('error', (e) => console.error(`[email] could not send to ${to}: ${e.message}`));
}

function sendSink(channel, payload) {
  fetch(`${SINK_URL}/${channel}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    .catch((e) => console.error(`[${channel}] could not send: ${e.message}`));
}
const sendSms = (to, body) => sendSink('sms', { to, body });
const sendPush = (userId, title, body) => { for (const token of db.devices.get(userId) || []) sendSink('push', { to: token, title, body }); };

// ── jobs (normally run by a scheduler; triggered on demand for testing) ──────
const JOBS = {
  'abandoned-cart'(now) {
    const due = [...db.carts.values()].filter((c) => c.items.length && !c.checkedOut && !c.remindedAt && now - c.updatedAt >= ABANDON_AFTER_MS);
    // PLANTED BUG 1: only the first batch is processed; the rest wait forever.
    for (const cart of due.slice(0, BATCH)) {
      const u = db.users.get(cart.userId);
      sendEmail(u.email, 'You left something in your cart', `Hi ${u.name.split(' ')[0]}, your ${cart.items.length} item(s) are still waiting.`);
      cart.remindedAt = now;
    }
    return { due: due.length, sent: Math.min(due.length, BATCH) };
  },
  'inactivity-reminder'(now) {
    let sent = 0;
    for (const u of db.users.values()) {
      if (!u.lastLoginAt && !u.remindedAt && now - u.createdAt >= INACTIVE_AFTER_MS) {
        sendEmail(u.email, 'We miss you: your account is ready', `Hi ${u.name.split(' ')[0]}, come back and take a look.`);
        u.remindedAt = now; sent++;
      }
    }
    return { sent };
  },
};

// ── HTTP ─────────────────────────────────────────────────────────────────────
const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const authUser = (req) => db.users.get(db.sessions.get((req.headers.authorization || '').replace(/^Bearer /, '')));
const isAdmin = (req) => req.headers['x-admin-key'] === ADMIN_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const body = req.method === 'GET' ? {} : await readBody(req);
  await sleep(5 + Math.random() * 40); // a little realistic latency

  if (p === '/' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(UI); }
  if (p === '/api/health') return json(res, 200, { ok: true, env: APP_ENV, payments: PAYMENTS_MODE });

  if (p === '/api/signup' && req.method === 'POST') {
    const email = String(body.email || '').toLowerCase();
    if (!email || !body.password || !body.name) return json(res, 400, { error: 'name, email and password are required' });
    if ([...db.users.values()].some((u) => u.email === email)) return json(res, 409, { error: 'email already registered' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const u = { id: randomUUID(), name: body.name, email, phone: body.phone, password: body.password, createdAt: Date.now(), lastLoginAt: null, verified: false, code };
    db.users.set(u.id, u);
    const token = randomUUID();
    db.sessions.set(token, u.id);
    sendSms(u.phone, `Your Demo Shop code is ${code}`);
    sendEmail(email, `Welcome to Demo Shop, ${u.name.split(' ')[0]}!`, 'Thanks for signing up.');
    return json(res, 201, { userId: u.id, token });
  }
  if (p === '/api/verify' && req.method === 'POST') {
    const u = authUser(req);
    if (!u) return json(res, 401, { error: 'log in first' });
    if (String(body.code) !== u.code) return json(res, 400, { error: 'wrong code' });
    u.verified = true;
    return json(res, 200, { verified: true });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const u = [...db.users.values()].find((x) => x.email === String(body.email || '').toLowerCase() && x.password === body.password);
    if (!u) return json(res, 401, { error: 'wrong email or password' });
    if (!u.verified) return json(res, 403, { error: 'verify your phone number first' });
    u.lastLoginAt = Date.now();
    const token = randomUUID();
    db.sessions.set(token, u.id);
    return json(res, 200, { token, userId: u.id });
  }
  if (p === '/api/products' && req.method === 'GET') return json(res, 200, { products: PRODUCTS });

  const user = authUser(req);
  if (p.startsWith('/api/') && !p.startsWith('/api/admin') && !p.startsWith('/api/internal') && !user) return json(res, 401, { error: 'log in first' });

  if (p === '/api/devices' && req.method === 'POST') {
    if (!db.devices.has(user.id)) db.devices.set(user.id, new Set());
    db.devices.get(user.id).add(String(body.token));
    return json(res, 201, { ok: true });
  }
  if (p === '/api/cart/items' && req.method === 'POST') {
    const prod = PRODUCTS.find((x) => x.id === body.productId);
    if (!prod) return json(res, 404, { error: 'no such product' });
    const cart = db.carts.get(user.id) || { userId: user.id, items: [], checkedOut: false };
    cart.items.push({ productId: prod.id, price: prod.price, qty: Math.max(1, Number(body.qty) || 1) });
    cart.updatedAt = Date.now();
    db.carts.set(user.id, cart);
    return json(res, 200, { cart });
  }
  if (p === '/api/checkout' && req.method === 'POST') {
    const cart = db.carts.get(user.id);
    if (!cart?.items.length) return json(res, 400, { error: 'cart is empty' });
    const amount = Math.round(cart.items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
    const order = { id: `ord_${randomUUID().slice(0, 8)}`, userId: user.id, amount, currency: 'USD', status: 'pending', createdAt: Date.now() };
    db.orders.set(order.id, order);
    cart.checkedOut = true;
    return json(res, 201, { order });
  }
  const pay = p.match(/^\/api\/orders\/([^/]+)\/pay$/);
  if (pay && req.method === 'POST') {
    if (PAYMENTS_MODE !== 'test') return json(res, 403, { error: 'refusing: payments are not in test mode' });
    const o = db.orders.get(pay[1]);
    if (!o || o.userId !== user.id) return json(res, 404, { error: 'no such order' });
    if (body.card !== '4242424242424242') return json(res, 402, { error: 'card declined (test cards: 4242424242424242)' });
    o.status = 'paid'; o.paidAt = Date.now();
    sendEmail(user.email, `Your receipt for order ${o.id}`, `We received $${o.amount.toFixed(2)}.`);
    if (user.phone) sendSms(user.phone, `Demo Shop: payment of $${o.amount.toFixed(2)} received for ${o.id}.`);
    sendPush(user.id, 'Order confirmed', `Order ${o.id} is confirmed.`);
    return json(res, 200, { order: o });
  }
  const refund = p.match(/^\/api\/orders\/([^/]+)\/refund$/);
  if (refund && req.method === 'POST') {
    const o = db.orders.get(refund[1]);
    if (!o || o.userId !== user.id) return json(res, 404, { error: 'no such order' });
    if (o.status !== 'paid') return json(res, 400, { error: `can't refund an order that is ${o.status}` });
    o.status = 'refunded'; o.refundedAt = Date.now();
    sendEmail(user.email, `Your refund for ${o.id} is on its way`, `$${o.amount.toFixed(2)} will be back on your card in 3–5 days.`);
    return json(res, 200, { order: o });
  }

  // Admin dashboard numbers
  if (p === '/api/admin/stats' && req.method === 'GET') {
    if (!isAdmin(req)) return json(res, 403, { error: 'admin only' });
    const orders = [...db.orders.values()];
    return json(res, 200, {
      signups: db.users.size,
      paidOrders: orders.filter((o) => o.status === 'paid').length,
      refundedOrders: orders.filter((o) => o.status === 'refunded').length,
      // PLANTED BUG 2: refunded orders are still counted as revenue.
      revenue: Math.round(orders.filter((o) => o.paidAt).reduce((s, o) => s + o.amount, 0) * 100) / 100,
    });
  }
  // Trigger a scheduled job now. `asOf` lets a test pretend it's later than it is.
  const job = p.match(/^\/api\/internal\/jobs\/([a-z-]+)\/run$/);
  if (job && req.method === 'POST') {
    if (!isAdmin(req)) return json(res, 403, { error: 'admin only' });
    if (APP_ENV === 'production') return json(res, 403, { error: 'job triggers are disabled in production' });
    if (!JOBS[job[1]]) return json(res, 404, { error: `no job called ${job[1]}` });
    const now = body.asOf ? new Date(body.asOf).getTime() : Date.now();
    return json(res, 200, { job: job[1], asOf: new Date(now).toISOString(), ...JOBS[job[1]](now) });
  }
  // Remove test data (staging only).
  if (p === '/api/admin/test-data' && req.method === 'DELETE') {
    if (!isAdmin(req)) return json(res, 403, { error: 'admin only' });
    const tag = String(url.searchParams.get('emailContains') || '');
    if (tag.length < 5) return json(res, 400, { error: 'emailContains must be at least 5 characters' });
    const dry = url.searchParams.get('dryRun') === '1';
    const ids = new Set([...db.users.values()].filter((u) => u.email.includes(tag)).map((u) => u.id));
    const orders = [...db.orders.values()].filter((o) => ids.has(o.userId));
    const carts = [...db.carts.values()].filter((c) => ids.has(c.userId));
    const counts = { users: ids.size, orders: orders.length, carts: carts.length, devices: [...ids].filter((i) => db.devices.has(i)).length };
    if (!dry) {
      for (const o of orders) db.orders.delete(o.id);
      for (const id of ids) { db.users.delete(id); db.carts.delete(id); db.devices.delete(id); }
      for (const [t, uid] of db.sessions) if (ids.has(uid)) db.sessions.delete(t);
    }
    return json(res, 200, { dryRun: dry, ...counts });
  }
  return json(res, 404, { error: 'not found' });
});

const UI = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo Shop</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px}section{border:1px solid #ddd;border-radius:10px;padding:14px;margin:12px 0}
input,button{font:inherit;padding:6px 10px;margin:3px 0}input{width:100%;box-sizing:border-box}#msg{color:#0a6}#err{color:#b00}</style></head><body>
<h1>Demo Shop</h1><p id="msg"></p><p id="err"></p>
<section id="signup"><h2>Create account</h2>
<input id="name" placeholder="Full name"><input id="email" placeholder="Email"><input id="phone" placeholder="Phone"><input id="password" type="password" placeholder="Password">
<button id="signup-btn">Sign up</button></section>
<section id="verify" hidden><h2>Enter the code we texted you</h2><input id="code" placeholder="6-digit code"><button id="verify-btn">Verify</button></section>
<section id="shop" hidden><h2>Products</h2><div id="products"></div><p>Cart: <span id="cart-count">0</span> item(s)</p><button id="checkout-btn">Checkout</button></section>
<section id="payment" hidden><h2>Pay</h2><p>Total: $<span id="total"></span></p><input id="card" placeholder="Card number"><button id="pay-btn">Pay now</button></section>
<section id="done" hidden><h2>Thank you!</h2><p>Order <span id="order-id"></span> is confirmed.</p></section>
<script>
let token=null,order=null,count=0;const $=id=>document.getElementById(id);
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok){$('err').textContent=d.error;throw new Error(d.error)}$('err').textContent='';return d}
$('signup-btn').onclick=async()=>{const d=await api('/api/signup',{name:$('name').value,email:$('email').value,phone:$('phone').value,password:$('password').value});token=d.token;$('signup').hidden=true;$('verify').hidden=false};
$('verify-btn').onclick=async()=>{await api('/api/verify',{code:$('code').value});$('msg').textContent='Welcome!';$('verify').hidden=true;$('shop').hidden=false;
const {products}=await api('/api/products');$('products').innerHTML=products.map(p=>'<div>'+p.name+' — $'+p.price+' <button data-add="'+p.id+'">Add to cart</button></div>').join('');
document.querySelectorAll('[data-add]').forEach(b=>b.onclick=async()=>{await api('/api/cart/items',{productId:b.dataset.add,qty:1});$('cart-count').textContent=++count})};
$('checkout-btn').onclick=async()=>{const d=await api('/api/checkout',{});order=d.order;$('total').textContent=order.amount.toFixed(2);$('shop').hidden=true;$('payment').hidden=false};
$('pay-btn').onclick=async()=>{await api('/api/orders/'+order.id+'/pay',{card:$('card').value});$('order-id').textContent=order.id;$('payment').hidden=true;$('done').hidden=false};
</script></body></html>`;

server.listen(PORT, () => {
  console.log(`🛍  Demo Shop (${APP_ENV}, payments: ${PAYMENTS_MODE}) on http://localhost:${PORT}`);
  console.log(`   Email → SMTP ${SMTP_HOST}:${SMTP_PORT} · SMS/push → ${SINK_URL}`);
});
