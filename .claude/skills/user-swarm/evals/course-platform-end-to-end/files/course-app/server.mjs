// LearnLoop API: online courses. Staging copy: `node server.mjs` → http://localhost:4700
// Env: APP_ENV (default staging), ADMIN_TOKEN (default staging-admin), SMTP_HOST/SMTP_PORT (Mailpit),
//      PAYMENT_MODE (default test; only test card 4242424242424242 is accepted in test mode).
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { db } from './src/store.mjs';
import { sendMail, mails } from './src/mailer.mjs';
import { jobs } from './src/jobs/index.mjs';

const PORT = Number(process.env.PORT || 4700);
const APP_ENV = process.env.APP_ENV || 'staging';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'staging-admin';
const PAYMENT_MODE = process.env.PAYMENT_MODE || 'test';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const send = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const learnerFrom = (req) => db.learners.get(db.sessions.get(String(req.headers.authorization || '').replace('Bearer ', '')));
const admin = (req) => req.headers['x-admin-token'] === ADMIN_TOKEN;

http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const p = url.pathname;
  const b = req.method === 'GET' ? {} : await body(req);

  if (p === '/health') return send(res, 200, { status: 'ok', environment: APP_ENV, paymentMode: PAYMENT_MODE });

  // ── auth ──
  if (p === '/auth/register' && req.method === 'POST') {
    const email = String(b.email || '').trim().toLowerCase();
    if (!b.fullName || !email || String(b.password || '').length < 8) return send(res, 422, { message: 'fullName, email and an 8+ character password are required' });
    if ([...db.learners.values()].some((l) => l.email === email)) return send(res, 409, { message: 'Email already registered' });
    const l = { id: randomUUID(), fullName: b.fullName, email, password: b.password, verified: false, verifyToken: randomUUID(), createdAt: Date.now() };
    db.learners.set(l.id, l);
    sendMail(mails.verify(l, `${PUBLIC_URL}/auth/verify?token=${l.verifyToken}`));
    return send(res, 201, { id: l.id, message: 'Check your email to confirm your account' });
  }
  if (p === '/auth/verify' && req.method === 'GET') {
    const l = [...db.learners.values()].find((x) => x.verifyToken === url.searchParams.get('token'));
    if (!l) return send(res, 400, { message: 'Invalid link' });
    l.verified = true;
    return send(res, 200, { message: 'Email confirmed' });
  }
  if (p === '/auth/login' && req.method === 'POST') {
    const l = [...db.learners.values()].find((x) => x.email === String(b.email || '').toLowerCase() && x.password === b.password);
    if (!l) return send(res, 401, { message: 'Invalid credentials' });
    if (!l.verified) return send(res, 403, { message: 'Confirm your email first' });
    l.lastLoginAt = Date.now();
    const token = randomUUID(); db.sessions.set(token, l.id);
    return send(res, 200, { accessToken: token, learner: { id: l.id, fullName: l.fullName } });
  }

  // ── admin ──
  if (p.startsWith('/admin/') || p.startsWith('/internal/')) {
    if (!admin(req)) return send(res, 403, { message: 'Admin token required' });
    if (p === '/admin/courses' && req.method === 'POST') {
      const c = { id: `crs_${randomUUID().slice(0, 6)}`, title: String(b.title || 'Untitled'), priceCents: Number(b.priceCents) || 0, lessons: Number(b.lessons) || 3 };
      db.courses.set(c.id, c);
      return send(res, 201, c);
    }
    if (p === '/admin/metrics' && req.method === 'GET') {
      const es = [...db.enrollments.values()];
      return send(res, 200, {
        learners: db.learners.size,
        enrollments: es.length,
        activeEnrollments: es.filter((e) => e.status === 'active').length,
        completedEnrollments: es.filter((e) => e.status === 'completed').length,
        refundedEnrollments: es.filter((e) => e.status === 'refunded').length,
        netRevenueCents: es.filter((e) => e.paidAt && e.status !== 'refunded').reduce((s, e) => s + e.priceCents, 0),
      });
    }
    const cron = p.match(/^\/internal\/cron\/([a-z-]+)$/);
    if (cron && req.method === 'POST') {
      if (APP_ENV === 'production') return send(res, 403, { message: 'Disabled in production' });
      if (!jobs[cron[1]]) return send(res, 404, { message: 'Unknown job' });
      const now = b.now ? Date.parse(b.now) : Date.now();
      return send(res, 200, { job: cron[1], ...jobs[cron[1]](now) });
    }
    if (p === '/admin/learners' && req.method === 'DELETE') {
      // Staging data tool: delete learners whose email contains ?match= (and their enrollments).
      const match = String(url.searchParams.get('match') || '');
      if (match.length < 6) return send(res, 400, { message: 'match must be at least 6 characters' });
      const ids = new Set([...db.learners.values()].filter((l) => l.email.includes(match)).map((l) => l.id));
      const ens = [...db.enrollments.values()].filter((e) => ids.has(e.learnerId));
      if (url.searchParams.get('preview') !== 'true') {
        ens.forEach((e) => db.enrollments.delete(e.id));
        ids.forEach((id) => db.learners.delete(id));
        for (const [t, id] of db.sessions) if (ids.has(id)) db.sessions.delete(t);
      }
      return send(res, 200, { learners: ids.size, enrollments: ens.length, preview: url.searchParams.get('preview') === 'true' });
    }
    return send(res, 404, { message: 'Not found' });
  }

  // ── learner ──
  const me = learnerFrom(req);
  if (!me) return send(res, 401, { message: 'Login required' });
  if (p === '/courses' && req.method === 'GET') return send(res, 200, { courses: [...db.courses.values()] });
  const enroll = p.match(/^\/courses\/([^/]+)\/enroll$/);
  if (enroll && req.method === 'POST') {
    const c = db.courses.get(enroll[1]);
    if (!c) return send(res, 404, { message: 'Course not found' });
    const e = { id: `enr_${randomUUID().slice(0, 8)}`, learnerId: me.id, courseId: c.id, status: 'pending_payment', priceCents: c.priceCents, createdAt: Date.now(), lessonsDone: 0 };
    db.enrollments.set(e.id, e);
    return send(res, 201, e);
  }
  const m = p.match(/^\/enrollments\/([^/]+)\/(pay|refund|lessons\/(\d+)\/complete)$/);
  if (m && req.method === 'POST') {
    const e = db.enrollments.get(m[1]);
    if (!e || e.learnerId !== me.id) return send(res, 404, { message: 'Enrollment not found' });
    const course = db.courses.get(e.courseId);
    if (m[2] === 'pay') {
      if (PAYMENT_MODE !== 'test') return send(res, 403, { message: 'Live payments are disabled on staging' });
      if (b.cardNumber !== '4242424242424242') return send(res, 402, { message: 'Card declined' });
      if (e.status !== 'pending_payment') return send(res, 409, { message: `Enrollment is ${e.status}` });
      e.status = 'active'; e.paidAt = Date.now();
      sendMail(mails.receipt(me, course, e.priceCents));
      return send(res, 200, e);
    }
    if (m[2] === 'refund') {
      if (!e.paidAt || e.status === 'refunded') return send(res, 409, { message: 'Nothing to refund' });
      e.status = 'refunded'; e.refundedAt = Date.now();
      sendMail(mails.refund(me, course));
      return send(res, 200, e);
    }
    // lesson complete
    if (e.status !== 'active') return send(res, 409, { message: `Enrollment is ${e.status}` });
    e.lessonsDone = Math.max(e.lessonsDone, Number(m[3]));
    e.lastActivityAt = Date.now();
    if (e.lessonsDone >= course.lessons) { e.status = 'completed'; e.completedAt = Date.now(); sendMail(mails.certificate(me, course)); }
    return send(res, 200, e);
  }
  return send(res, 404, { message: 'Not found' });
}).listen(PORT, () => console.log(`LearnLoop API (${APP_ENV}) on ${PUBLIC_URL}`));
