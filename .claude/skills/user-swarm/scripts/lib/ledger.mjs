// The ledger: one shared, append-only file (JSON Lines) where every fake user writes
// down what it did — who, which action, how much, where it stopped, and when.
// A CSV copy is written at the end so it opens in Excel/Sheets.
import fs from 'node:fs';
import path from 'node:path';

export function openLedger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: 'a' });
  return {
    file,
    write(entry) { stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`); },
    close() { return new Promise((r) => stream.end(r)); },
  };
}

export function readLedgerEntries(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const CSV_COLS = ['ts', 'type', 'user', 'name', 'email', 'phone', 'role', 'behaviour', 'mode', 'step', 'status', 'amount', 'currency', 'ref', 'note', 'stoppedAt', 'outcome', 'ms', 'error'];

export function writeCsv(entries, file) {
  const users = new Map(entries.filter((e) => e.type === 'user').map((e) => [e.user, e]));
  const esc = (v) => {
    if (v === undefined || v === null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = entries.map((e) => {
    const u = users.get(e.user) || {};
    const merged = { ...e, name: u.name, email: u.email, phone: u.phone, mode: e.mode || u.mode };
    return CSV_COLS.map((c) => esc(merged[c])).join(',');
  });
  fs.writeFileSync(file, [CSV_COLS.join(','), ...rows].join('\n') + '\n');
}

// A list of users with handy helpers: L.users(u => !u.did('pay')).emails()
export class UserSet extends Array {
  static get [Symbol.species]() { return UserSet; }
  emails() { return this.map((u) => u.email).filter(Boolean); }
  phones() { return this.map((u) => u.phone).filter(Boolean); }
  pushTokens() { return this.map((u) => u.pushToken).filter(Boolean); }
  ids() { return this.map((u) => u.id); }
  get count() { return this.length; }
}

// Turn raw ledger lines into one summary per fake user, plus query helpers.
export function buildLedgerView(entries) {
  const byUser = new Map();
  for (const e of entries) {
    if (e.type === 'user') {
      byUser.set(e.user, {
        id: e.user, n: e.n, name: e.name, email: e.email, phone: e.phone, pushToken: e.pushToken,
        role: e.role, behaviour: e.behaviour, mode: e.mode, plan: e.plan || [],
        stepsOk: [], stepsFailed: [], records: [], stoppedAt: null, outcome: null, error: null,
      });
    }
  }
  for (const e of entries) {
    const u = byUser.get(e.user);
    if (!u) continue;
    if (e.type === 'step') {
      u.records.push(e);
      if (e.status === 'ok') u.stepsOk.push(e.step);
      else if (e.status === 'failed') { u.stepsFailed.push(e.step); u.error = e.error; }
    } else if (e.type === 'end') {
      u.stoppedAt = e.stoppedAt;
      u.outcome = e.outcome;
    }
  }
  const users = UserSet.from([...byUser.values()].map((u) => Object.assign(u, {
    did: (step) => u.stepsOk.includes(step),
    tried: (step) => u.records.some((r) => r.step === step),
    amount: (step) => u.records.filter((r) => r.step === step && r.status === 'ok').reduce((s, r) => s + (Number(r.amount) || 0), 0),
    get completedPlan() { return u.outcome === 'completed-plan'; },
  })));

  const stepRecords = entries.filter((e) => e.type === 'step');
  const L = {
    entries,
    all: users,
    users: (filter) => (filter ? users.filter(filter) : users),
    records: (filter) => (filter ? stepRecords.filter(filter) : stepRecords),
    // Number of successful `step` records (optionally only for users matching `filter`).
    count(step, filter) {
      return stepRecords.filter((r) => r.step === step && r.status === 'ok' && (!filter || filter(byUser.get(r.user)))).length;
    },
    // Sum a numeric field (default "amount") over successful `step` records.
    sum(step, field = 'amount', filter) {
      return stepRecords
        .filter((r) => r.step === step && r.status === 'ok' && (!filter || filter(byUser.get(r.user))))
        .reduce((s, r) => s + (Number(r[field]) || 0), 0);
    },
    byBehaviour(b) { return users.filter((u) => u.behaviour === b); },
    byRole(r) { return users.filter((u) => u.role === r); },
  };
  return L;
}
