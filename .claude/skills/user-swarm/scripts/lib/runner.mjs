// The journey runner: sends every fake user through their journey at the same time,
// with random timing and choices, stopping where their behaviour says they give up.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { sleep, pool, fmtMs, say, slug } from './util.mjs';
import { makeRng, apportion, apportionAtLeastOne, makeIdentity, BEHAVIOUR_LABELS } from './random.mjs';
import { createHttp } from './http.mjs';
import { planFor } from './project.mjs';

class StopJourney extends Error { constructor(reason) { super(reason); this.stop = true; } }

// Decide who is who: how many of each role, and how many of each behaviour per role.
export function planSwarm(project, { users, uiUsers = 0, runId, seed, everyBehaviour = false }) {
  const { config, roles } = project;
  const rng = makeRng(seed ?? runId);
  const fixed = roles.filter((r) => Number.isInteger(r.count));
  const fixedTotal = fixed.reduce((s, r) => s + r.count, 0);
  const shared = roles.filter((r) => !Number.isInteger(r.count));
  const shares = apportion(Math.max(0, users - fixedTotal), Object.fromEntries(shared.map((r, i) => [i, r.share ?? 1])));
  const perRole = roles.map((r) => (Number.isInteger(r.count) ? Math.min(r.count, users) : shares[shared.indexOf(r)] || 0));

  const people = [];
  let n = 0;
  roles.forEach((r, ri) => {
    const mix = (everyBehaviour ? apportionAtLeastOne : apportion)(perRole[ri], r.mix || config.swarm.mix);
    const behaviours = rng.shuffle(Object.entries(mix).flatMap(([b, k]) => Array(k).fill(b)));
    for (const behaviour of behaviours) {
      const ident = makeIdentity({ runId, n: n++, tag: config.identity.tag, emailDomain: config.identity.emailDomain, custom: config.identity });
      people.push({ ...ident, role: r.role, roleIndex: ri, wave: r.wave ?? 1, behaviour, plan: planFor(r.persona, behaviour), mode: 'api' });
    }
  });

  // Pick UI users: spread across behaviours, only from roles that have UI steps.
  if (uiUsers > 0) {
    const candidates = rng.shuffle(people.filter((p) => roles[p.roleIndex].persona.ui));
    const byB = new Map();
    for (const p of candidates) { if (!byB.has(p.behaviour)) byB.set(p.behaviour, []); byB.get(p.behaviour).push(p); }
    let picked = 0;
    while (picked < uiUsers && [...byB.values()].some((l) => l.length)) {
      for (const list of byB.values()) { if (picked < uiUsers && list.length) { list.shift().mode = 'ui'; picked++; } }
    }
  }
  return people;
}

export async function runSwarm(project, ctx, { people, runId, runDir, ledger, seed, headed, concurrency, shared = new Map() }) {
  const { config, roles } = project;
  const sw = config.swarm;
  const stats = { done: 0, failed: 0, total: people.length, started: Date.now() };
  const uiCount = people.filter((p) => p.mode === 'ui').length;
  const browser = uiCount ? await launchBrowser(project, headed) : null;

  for (const p of people) {
    ledger.write({ type: 'user', user: p.id, n: p.n, name: p.name, email: p.email, phone: p.phone, pushToken: p.pushToken, role: p.role, behaviour: p.behaviour, mode: p.mode, plan: p.plan });
  }

  const ticker = setInterval(() => {
    say(`   … ${stats.done}/${stats.total} users finished · ${stats.failed} hit an error · ${fmtMs(Date.now() - stats.started)}`);
  }, 5000);

  try {
    const waves = [...new Set(people.map((p) => p.wave))].sort((a, b) => a - b);
    for (const wave of waves) {
      const group = people.filter((p) => p.wave === wave);
      if (waves.length > 1) say(`   Wave ${wave}: ${group.length} users (${[...new Set(group.map((p) => p.role))].join(', ')})`);
      // Each user gets a random start time inside the ramp-up window, so they don't all
      // arrive in the same millisecond. Sorted so a free slot always takes the next arrival.
      const rampMs = (group.length > 1 ? sw.rampUpSeconds : 0) * 1000;
      const arrivals = group
        .map((p) => { const urng = makeRng(`${seed ?? runId}:${p.n}`); return { p, urng, at: urng.rand() * rampMs }; })
        .sort((a, b) => a.at - b.at);
      const waveStart = Date.now();
      await pool(arrivals, concurrency || sw.concurrency, async ({ p, urng, at }) => {
        await sleep(waveStart + at - Date.now());
        const ok = await runOne({ p, persona: roles[p.roleIndex].persona, urng, ctx, shared, ledger, project, browser, runDir });
        stats.done++;
        if (!ok) stats.failed++;
      });
    }
  } finally {
    clearInterval(ticker);
    if (browser) await browser.close();
  }
  stats.ms = Date.now() - stats.started;
  return stats;
}

async function runOne({ p, persona, urng, ctx, shared, ledger, project, browser, runDir }) {
  const { config } = project;
  const sw = config.swarm;
  const api = createHttp({ baseUrl: config.environment.baseUrl, guard: ctx.guard, timeoutMs: sw.requestTimeoutMs });
  let page = null;
  let browserCtx = null;
  if (p.mode === 'ui') {
    browserCtx = await browser.newContext({ baseURL: config.environment.uiBaseUrl || config.environment.baseUrl });
    // Block anything listed as production, even inside the browser.
    await browserCtx.route('**/*', (route) => {
      try { ctx.guard.assertUrl(route.request().url()); return route.continue(); } catch (e) {
        if (/PRODUCTION/.test(e.message)) return route.abort('blockedbyclient');
        return route.continue(); // third-party assets (fonts, CDNs) are allowed in the browser
      }
    });
    page = await browserCtx.newPage();
  }

  let current = null;
  let note = {};
  const u = {
    ...p,
    run: ctx.run.id,
    api,
    page,
    ui: p.mode === 'ui',
    state: {},
    shared,
    env: process.env,
    config,
    rand: urng.rand, int: urng.int, pick: urng.pick, chance: urng.chance,
    /** Add details (amount, currency, ref, note…) to the ledger line for the current step. */
    record(info = {}) { Object.assign(note, info); },
    /** End this user's journey early without counting it as an error (e.g. "no jobs available"). */
    stop(reason) { throw new StopJourney(reason); },
    sleep,
    think: () => sleep(urng.between(sw.thinkTimeMs)),
    async waitFor(fn, { timeoutMs = 60000, everyMs = 1000, what = 'condition' } = {}) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > until) throw new Error(`Timed out after ${fmtMs(timeoutMs)} waiting for ${what}`);
        await sleep(everyMs);
      }
    },
    /**
     * Wait for a message to THIS user, e.g. a sign-up code or a verification link:
     *   const m = await u.waitForMessage('sms', { body: /code/i });
     *   const code = m.body.match(/\b\d{6}\b/)[0];
     *   const link = (await u.waitForMessage('email', { subject: /verify/i }, { full: true })).text.match(/https?:\/\/\S+/)[0];
     */
    async waitForMessage(channel, filter = {}, { timeoutMs = 60000, everyMs = 1500, full = false } = {}) {
      const reader = ctx[channel];
      if (!reader?.configured) throw new Error(`notifications.${channel} is not configured, so this user can't read their ${channel}`);
      const addr = filter.to ?? (channel === 'email' ? p.email : channel === 'sms' ? p.phone : p.pushToken);
      const { to, ...rest } = filter;
      return u.waitFor(async () => {
        const [m] = await reader.forRecipient(addr, rest);
        if (m && full) m.text = await reader.text(m);
        return m;
      }, { timeoutMs, everyMs, what: `a ${channel} to ${addr}` });
    },
    log: (...a) => say(`   [${p.id}]`, ...a),
  };

  let stoppedAt = null;
  let outcome = 'completed-plan';
  try {
    for (const step of p.plan) {
      current = step;
      note = {};
      const fn = (p.mode === 'ui' && persona.ui?.[step]) || persona.actions[step];
      const t0 = Date.now();
      try {
        await (p.mode === 'ui' && persona.ui?.[step] ? fn(u, page) : fn(u));
        ledger.write({ type: 'step', user: p.id, role: p.role, behaviour: p.behaviour, mode: p.mode, step, status: 'ok', ms: Date.now() - t0, ...note });
        stoppedAt = step;
      } catch (e) {
        if (e.stop) {
          ledger.write({ type: 'step', user: p.id, role: p.role, behaviour: p.behaviour, mode: p.mode, step, status: 'stopped', ms: Date.now() - t0, note: e.message, ...note });
          outcome = 'stopped';
          break;
        }
        ledger.write({ type: 'step', user: p.id, role: p.role, behaviour: p.behaviour, mode: p.mode, step, status: 'failed', ms: Date.now() - t0, error: e.message?.slice(0, 500), ...note });
        if (page) {
          const shots = path.join(runDir, 'screenshots');
          fs.mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: path.join(shots, `${p.id}-${slug(step)}.png`), fullPage: true }).catch(() => {});
        }
        stoppedAt = step;
        outcome = 'error';
        break;
      }
      if (step !== p.plan[p.plan.length - 1]) await u.think();
    }
  } finally {
    ledger.write({ type: 'end', user: p.id, role: p.role, behaviour: p.behaviour, mode: p.mode, stoppedAt, outcome, lastTried: current });
    if (browserCtx) await browserCtx.close().catch(() => {});
  }
  return outcome !== 'error';
}

async function launchBrowser(project, headed) {
  let pw;
  try {
    const req = createRequire(path.join(project.dir, 'package.json'));
    pw = await import(pathToFileURL(req.resolve('playwright')).href);
  } catch {
    throw new Error(
      'The --ui option needs Playwright installed in the project folder. Run:\n' +
      `   cd "${project.dir}" && npm install --save-dev playwright && npx playwright install chromium`,
    );
  }
  const chromium = pw.chromium || pw.default?.chromium;
  const channel = project.config.swarm.uiBrowser; // e.g. 'chrome' to use the installed Google Chrome
  try {
    return await chromium.launch({ headless: !headed, ...(channel ? { channel } : {}) });
  } catch (e) {
    // No downloaded Chromium? Fall back to the Google Chrome already on this machine.
    if (!channel && /Executable doesn't exist|browserType\.launch/i.test(e.message)) {
      try { return await chromium.launch({ headless: !headed, channel: 'chrome' }); } catch { /* report the original error */ }
    }
    throw new Error(`Could not start a browser for --ui: ${e.message.split('\n')[0]}\n` +
      `   Either install Playwright's browser (npx playwright install chromium) or set swarm.uiBrowser: 'chrome' to use Google Chrome.`);
  }
}

export function describePlan(people) {
  const lines = [];
  const roles = [...new Set(people.map((p) => p.role))];
  for (const r of roles) {
    const rp = people.filter((p) => p.role === r);
    const counts = {};
    for (const p of rp) counts[p.behaviour] = (counts[p.behaviour] || 0) + 1;
    const ui = rp.filter((p) => p.mode === 'ui').length;
    lines.push(`   ${r}: ${rp.length} user${rp.length === 1 ? '' : 's'}${ui ? ` (${ui} through the real UI)` : ''}`);
    for (const [b, k] of Object.entries(counts)) lines.push(`      • ${k} × ${BEHAVIOUR_LABELS[b] || b}`);
  }
  return lines.join('\n');
}
