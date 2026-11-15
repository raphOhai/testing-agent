// The checker: compares what the fake users DID (ledger) with what the system SHOWS
// (dashboard, database, notifications). Each check is expected vs actual.
//
// expected/actual may each return:
//   • a number              → compared with optional `tolerance`
//   • a list (of emails, phones, ids…) → compared item by item, so we can say exactly
//     WHO is missing a notification, who got one they shouldn't, and who got two.
import { slug, textMatches } from './util.mjs';

export async function computeBaselines(project, ctx) {
  const out = {};
  for (const ch of project.config.checks) {
    if (ch.measure !== 'delta') continue;
    try { out[ch.id || slug(ch.label)] = await ch.actual(ctx, null); } catch (e) { out[ch.id || slug(ch.label)] = { error: e.message }; }
  }
  return out;
}

export async function runChecks(project, ctx, L, { baselines = {} } = {}) {
  const results = [];
  for (const ch of project.config.checks) {
    const id = ch.id || slug(ch.label);
    const r = { id, label: ch.label, group: ch.group || 'Checks', expectedLabel: ch.expectedLabel, actualLabel: ch.actualLabel, note: ch.note };
    try {
      if (typeof ch.when === 'function' && !(await ch.when(L, ctx))) { results.push({ ...r, status: 'skipped', message: ch.skipMessage || 'Not applicable to this run.' }); continue; }
      let expected = await ch.expected(L, ctx);
      let actual = await ch.actual(ctx, L);
      if (ch.measure === 'delta') {
        const base = baselines[id];
        if (base === undefined || base?.error) throw new Error(`No "before" value was recorded for this check${base?.error ? ` (${base.error})` : ''}. Run it again from \`run\`.`);
        r.before = base;
        r.after = actual;
        actual = Number(actual) - Number(base);
      }
      Object.assign(r, compare(expected, actual, ch));
    } catch (e) {
      r.status = 'error';
      r.message = `The check itself failed: ${e.message}`;
    }
    results.push(r);
  }
  return results;
}

function compare(expected, actual, ch) {
  const isList = (v) => Array.isArray(v);
  if (isList(expected) && isList(actual)) {
    const norm = ch.normalize || ((x) => String(x).trim().toLowerCase());
    const exp = expected.map(norm);
    const act = actual.map(norm);
    const expSet = new Set(exp);
    const counts = new Map();
    for (const a of act) counts.set(a, (counts.get(a) || 0) + 1);
    const missing = [...expSet].filter((e) => !counts.has(e));
    const unexpected = [...counts.keys()].filter((a) => !expSet.has(a));
    const duplicates = ch.allowDuplicates ? [] : [...counts].filter(([, n]) => n > 1).map(([a, n]) => `${a} (×${n})`);
    const pass = !missing.length && !unexpected.length && !duplicates.length;
    return {
      status: pass ? 'pass' : 'fail',
      expected: exp.length,
      actual: act.length,
      missing, unexpected, duplicates,
      message: pass ? '' : [
        missing.length && `${missing.length} expected but never received`,
        unexpected.length && `${unexpected.length} received but not expected`,
        duplicates.length && `${duplicates.length} received more than once`,
      ].filter(Boolean).join(' · '),
    };
  }
  const e = isList(expected) ? expected.length : Number(expected);
  const a = isList(actual) ? actual.length : Number(actual);
  if (!Number.isFinite(e) || !Number.isFinite(a)) {
    return { status: 'error', expected: String(expected), actual: String(actual), message: 'expected() and actual() must return numbers or lists.' };
  }
  const tol = ch.tolerance ?? 0;
  const pass = Math.abs(e - a) <= tol + 1e-9;
  return { status: pass ? 'pass' : 'fail', expected: round(e), actual: round(a), message: pass ? '' : `off by ${round(a - e)}` };
}

const round = (n) => Math.round(n * 100) / 100;

// Built-in summary of the swarm itself (no config needed).
export function summariseSwarm(L) {
  const users = L.all;
  const byRole = {};
  const stoppedAt = {};
  for (const u of users) {
    byRole[u.role] ??= {};
    byRole[u.role][u.behaviour] = (byRole[u.role][u.behaviour] || 0) + 1;
    const k = `${u.role} → ${u.stoppedAt ?? '(nothing done)'}`;
    stoppedAt[k] = (stoppedAt[k] || 0) + 1;
  }
  const errGroups = new Map();
  for (const r of L.records((r) => r.status === 'failed')) {
    const key = `${r.step}|${String(r.error).replace(/[0-9a-f]{8,}|\d+/gi, '#').slice(0, 160)}`;
    if (!errGroups.has(key)) errGroups.set(key, { step: r.step, error: r.error, count: 0, users: [] });
    const g = errGroups.get(key); g.count++; if (g.users.length < 5) g.users.push(r.user);
  }
  const latency = {};
  for (const r of L.records((r) => r.status === 'ok')) (latency[r.step] ??= []).push(r.ms);
  const lat = Object.fromEntries(Object.entries(latency).map(([s, arr]) => {
    arr.sort((a, b) => a - b);
    const pct = (p) => arr[Math.min(arr.length - 1, Math.ceil((p / 100) * arr.length) - 1)];
    return [s, { n: arr.length, p50: pct(50), p95: pct(95), max: arr[arr.length - 1] }];
  }));
  return {
    users: users.length,
    uiUsers: users.filter((u) => u.mode === 'ui').length,
    completedPlan: users.filter((u) => u.outcome === 'completed-plan').length,
    errored: users.filter((u) => u.outcome === 'error').length,
    stopped: users.filter((u) => u.outcome === 'stopped').length,
    byRole, stoppedAt, errors: [...errGroups.values()].sort((a, b) => b.count - a.count), latency: lat,
  };
}

export { textMatches };
