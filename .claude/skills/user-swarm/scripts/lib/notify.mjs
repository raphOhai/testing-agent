// Notification readers: count what was ACTUALLY sent.
//   email → Mailpit (or the built-in catcher, which speaks the same API)
//   sms / push / anything else → the built-in catcher's sink, app logs, or a custom fetcher
//
// Every message is normalised to { id, channel, to: [..], subject, body, created }.
// Readers are "scoped": for a check they only see messages addressed to that run's fake users;
// for cleanup they see everything carrying the swarm tag.
import { execSync } from 'node:child_process';
import { textMatches, digits } from './util.mjs';

async function getJson(guard, url, init) {
  guard.assertUrl(url);
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${url} → ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ── Sources ──────────────────────────────────────────────────────────────────
const sources = {
  // Mailpit API (also served by `swarm catcher`). We list everything and filter locally,
  // because Mailpit's search operators are not guaranteed to do substring matches.
  mailpit: (cfg, guard) => ({
    async list() { return mailpitPages(cfg, guard, '/api/v1/messages?'); },
    // One user's inbox (used while a journey runs, e.g. to read a sign-up code).
    async listFor(addr) { return mailpitPages(cfg, guard, `/api/v1/search?query=${encodeURIComponent(`to:"${addr}"`)}&`); },
    async text(m) {
      const full = await getJson(guard, `${cfg.url.replace(/\/$/, '')}/api/v1/message/${encodeURIComponent(m.id)}`);
      return full.Text || String(full.HTML || '').replace(/<[^>]+>/g, ' ');
    },
    async remove(ids) {
      if (!ids.length) return;
      const base = cfg.url.replace(/\/$/, '');
      for (let i = 0; i < ids.length; i += 500) {
        await getJson(guard, `${base}/api/v1/messages`, {
          method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ IDs: ids.slice(i, i + 500) }),
        });
      }
    },
  }),

  // The built-in catcher's sink for SMS / push / WhatsApp / webhooks.
  catcher: (cfg, guard, channel) => ({
    async list(contains) {
      const base = cfg.url.replace(/\/$/, '');
      const q = contains ? `?contains=${encodeURIComponent(contains)}` : '';
      const data = await getJson(guard, `${base}/sink/${cfg.channel || channel}${q}`);
      return (data.messages || []).map((m) => ({ ...m, channel, to: [].concat(m.to || []).map(String) }));
    },
    async listFor(addr) {
      const d = digits(addr);
      return this.list(d.length >= 7 ? d.slice(-7) : addr);
    },
    async remove(ids) {
      if (!ids.length) return;
      const base = cfg.url.replace(/\/$/, '');
      await getJson(guard, `${base}/sink/${cfg.channel || channel}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
      });
    },
  }),

  // Parse the app's own logs, e.g. a staging SMS driver that logs instead of sending.
  // cfg: { command: 'docker compose logs api --no-color', cwd, pattern: /SMS to (\S+): (.*)/ }
  // The first capture group is the recipient, the optional second is the message text.
  log: (cfg, _guard, channel) => ({
    async list() {
      const text = execSync(cfg.command, { cwd: cfg.cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      const re = new RegExp(cfg.pattern, 'g' + (cfg.pattern.flags || '').replace('g', ''));
      const out = [];
      let m; let i = 0;
      while ((m = re.exec(text))) out.push({ id: `log-${i++}`, channel, to: [m[1]], subject: '', body: m[2] || m[0] });
      return out;
    },
    async remove() { /* logs can't be deleted; nothing to do */ },
  }),

  // Project-supplied: { fetch: async (ctx) => [{ to, subject?, body?, created? }], remove?: async (ctx, msgs) => {} }
  custom: (cfg, _guard, channel, ctx) => ({
    async list() {
      const msgs = await cfg.fetch(ctx);
      return msgs.map((m, i) => ({ id: m.id ?? `custom-${i}`, channel, ...m, to: [].concat(m.to || []).map(String) }));
    },
    async remove(ids, msgs) { if (cfg.remove) await cfg.remove(ctx, msgs); },
  }),

  none: () => ({ async list() { return []; }, async remove() {} }),
};

// ── Reader with scoping + query helpers ──────────────────────────────────────
export function makeReader(channel, cfg, guard, ctx, scope, since) {
  const kind = cfg?.source || 'none';
  if (!sources[kind]) throw new Error(`notifications.${channel}.source "${kind}" is not one of: ${Object.keys(sources).join(', ')}`);
  const src = sources[kind](cfg || {}, guard, channel, ctx);
  let cache = null;

  // `since`: ignore messages that arrived before the run started (fake phone numbers can
  // repeat between runs; emails and device tokens carry the run id, phones can't).
  const sinceMs = since ? Date.parse(since) : null;
  const inScope = (m) => m.to.some((addr) => scope(addr, channel)) &&
    (!sinceMs || !m.created || Date.parse(m.created) >= sinceMs);
  const matches = (m, f = {}) =>
    (f.subject === undefined || textMatches(m.subject, f.subject)) &&
    (f.body === undefined || textMatches(m.body, f.body)) &&
    (f.text === undefined || textMatches(`${m.subject}\n${m.body}`, f.text)) &&
    (f.to === undefined || m.to.some((a) => textMatches(a, f.to))) &&
    (typeof f.where !== 'function' || f.where(m));

  const reader = {
    channel,
    source: kind,
    configured: kind !== 'none',
    async all() { cache ??= (await src.list()).filter(inScope); return cache; },
    refresh() { cache = null; return reader; },
    /** Messages matching a filter: { subject, body, text, to, where } — strings match case-insensitively, or pass a RegExp. */
    async messages(filter) { return (await reader.all()).filter((m) => matches(m, filter)); },
    async count(filter) { return (await reader.messages(filter)).length; },
    /** One entry per (message, swarm recipient) — duplicates are kept so double-sends show up. */
    async recipients(filter) {
      const out = [];
      for (const m of await reader.messages(filter)) for (const a of m.to) if (scope(a, channel)) out.push(a);
      return out;
    },
    /** Messages to ONE address/phone/token, newest first (used inside journeys). */
    async forRecipient(addr, filter) {
      const raw = src.listFor ? await src.listFor(addr) : await src.list();
      return raw
        .filter((m) => m.to.some((t) => sameAddress(t, addr)) && (!sinceMs || !m.created || Date.parse(m.created) >= sinceMs))
        .filter((m) => matches(m, filter))
        .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
    },
    /** Full text of a message (an email's snippet is only the first 250 characters). */
    async text(m) { return src.text ? src.text(m) : `${m.subject || ''}\n${m.body || ''}`; },
    async removeAll() {
      const msgs = await reader.all();
      await src.remove(msgs.map((m) => m.id), msgs);
      cache = null;
      return msgs.length;
    },
  };
  return reader;
}

async function mailpitPages(cfg, guard, pathAndQuery) {
  const base = cfg.url.replace(/\/$/, '');
  const out = [];
  for (let start = 0; ; ) {
    const page = await getJson(guard, `${base}${pathAndQuery}start=${start}&limit=250`);
    const msgs = page.messages || [];
    for (const m of msgs) {
      out.push({
        id: m.ID, channel: 'email',
        to: [...(m.To || []), ...(m.Cc || []), ...(m.Bcc || [])].map((a) => String(a.Address || '').toLowerCase()),
        from: m.From?.Address, subject: m.Subject || '', body: m.Snippet || '', created: m.Created,
      });
    }
    start += msgs.length;
    if (!msgs.length || start >= (page.messages_count ?? page.total ?? 0)) break;
  }
  return out;
}

function sameAddress(a, b) {
  if (String(a).toLowerCase() === String(b).toLowerCase()) return true;
  const da = digits(a); const db = digits(b);
  return da.length >= 7 && db.length >= 7 && (da.endsWith(db.slice(-9)) || db.endsWith(da.slice(-9)));
}

// Read the catcher's/Mailpit's own clock (HTTP Date header), so "messages since the run
// started" works even if that server's clock differs from this machine's.
export async function serverTime(url, guard) {
  try {
    guard.assertUrl(url);
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    await res.arrayBuffer().catch(() => {});
    const d = res.headers.get('date');
    if (d) return new Date(Date.parse(d) - 1000).toISOString();
  } catch { /* fall through */ }
  return new Date(Date.now() - 1000).toISOString();
}

// Scope helpers.
// For a run: only the run's own fake users' addresses / phones / device tokens.
export function runScope(users) {
  const emails = new Set(users.map((u) => String(u.email || '').toLowerCase()));
  const phones = new Set(users.map((u) => digits(u.phone)).filter(Boolean));
  const tokens = new Set(users.map((u) => String(u.pushToken || '')).filter(Boolean));
  const ids = new Set(users.map((u) => String(u.id)));
  return (addr) => {
    const a = String(addr).toLowerCase();
    return emails.has(a) || tokens.has(String(addr)) || ids.has(String(addr)) || (digits(addr).length >= 7 && phones.has(digits(addr)));
  };
}

// For cleanup: anything carrying the tag, plus any phone/token we've ever used.
export function tagScope(tag, knownUsers = []) {
  const known = runScope(knownUsers);
  return (addr) => String(addr).toLowerCase().includes(tag.toLowerCase()) || known(addr);
}
