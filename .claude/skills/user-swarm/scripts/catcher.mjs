// Built-in notification catcher (no install needed).
//   • SMTP server (default port 1025): point the staging app's SMTP settings here and every
//     email is caught instead of delivered. Exposes the same HTTP API as Mailpit, so the
//     swarm reads it the same way. If real Mailpit is already running, SMTP is skipped.
//   • Sink for SMS / push / anything (POST /sink/<channel>): point the staging app's SMS and
//     push "drivers" here and every message is recorded instead of sent.
//   • A simple page at http://localhost:<port>/ to eyeball what arrived.
// Messages live in memory: restarting the catcher empties it.
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const mail = [];               // Mailpit-shaped message objects, newest last
const sink = new Map();        // channel → [{ id, channel, to, body, title, created, raw }]

export async function startCatcher({ port = 4599, smtpPort = 1025, quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const server = http.createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: e.message })));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });
  log(`📮 Catcher listening on http://localhost:${port}`);
  log(`   SMS  → POST http://localhost:${port}/sink/sms   { "to": "+44…", "body": "…" }`);
  log(`   Push → POST http://localhost:${port}/sink/push  { "to": "<device token>", "title": "…", "body": "…" }`);
  let smtp = null;
  if (smtpPort) {
    smtp = await startSmtp(smtpPort).catch((e) => {
      log(`   Email: port ${smtpPort} is busy (${e.code}). If Mailpit is running there, use it for email; the catcher only takes SMS/push.`);
      return null;
    });
    if (smtp) log(`   Email → SMTP localhost:${smtpPort} (no auth, no TLS) · read via http://localhost:${port}/api/v1/messages`);
  }
  log('   Open the page in a browser to see what arrived. Ctrl+C to stop.');
  return { server, smtp, close: () => { server.close(); smtp?.close(); } };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const body = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) ? await readBody(req) : null;

  // Mailpit-compatible subset
  if (p === '/api/v1/messages' && req.method === 'GET') return send(res, 200, page(mail, url));
  if (p === '/api/v1/search' && req.method === 'GET') return send(res, 200, page(mail.filter(searchFn(url.searchParams.get('query'))), url));
  if (p === '/api/v1/search' && req.method === 'DELETE') { remove(mail, searchFn(url.searchParams.get('query'))); return send(res, 200, 'ok'); }
  if (p === '/api/v1/messages' && req.method === 'DELETE') {
    const ids = parseJson(body)?.IDs;
    if (Array.isArray(ids) && ids.length) { const set = new Set(ids); remove(mail, (m) => set.has(m.ID)); } else mail.length = 0;
    return send(res, 200, 'ok');
  }
  const one = p.match(/^\/api\/v1\/message\/([^/]+)$/);
  if (one && req.method === 'GET') {
    const m = one[1] === 'latest' ? mail[mail.length - 1] : mail.find((x) => x.ID === one[1]);
    return m ? send(res, 200, m) : send(res, 404, { error: 'not found' });
  }
  if (p === '/api/v1/info') return send(res, 200, { Version: 'swarm-catcher', Messages: mail.length, Sink: Object.fromEntries([...sink].map(([k, v]) => [k, v.length])) });

  // Sink for SMS / push / anything else
  const sm = p.match(/^\/sink\/([a-z0-9_-]+)\/?$/i);
  if (sm) {
    const ch = sm[1].toLowerCase();
    if (!sink.has(ch)) sink.set(ch, []);
    const list = sink.get(ch);
    if (req.method === 'POST') {
      const data = parseJson(body) ?? Object.fromEntries(new URLSearchParams(body || ''));
      const items = Array.isArray(data) ? data : [data];
      const saved = items.map((d) => normalise(ch, d));
      list.push(...saved);
      return send(res, 201, { ok: true, ids: saved.map((s) => s.id), sid: saved[0]?.id, status: 'queued' });
    }
    if (req.method === 'GET') {
      const q = url.searchParams.get('contains');
      return send(res, 200, { channel: ch, total: list.length, messages: q ? list.filter((m) => JSON.stringify(m).toLowerCase().includes(q.toLowerCase())) : list });
    }
    if (req.method === 'DELETE') {
      const ids = parseJson(body)?.ids;
      const q = url.searchParams.get('contains');
      if (Array.isArray(ids)) { const set = new Set(ids); remove(list, (m) => set.has(m.id)); }
      else if (q) remove(list, (m) => JSON.stringify(m).toLowerCase().includes(q.toLowerCase()));
      else list.length = 0;
      return send(res, 200, { ok: true, left: list.length });
    }
  }
  if (p === '/sink' && req.method === 'GET') return send(res, 200, Object.fromEntries([...sink].map(([k, v]) => [k, v.length])));
  if (p === '/' && req.method === 'GET') return sendHtml(res, dashboard());
  return send(res, 404, { error: 'not found' });
}

function normalise(channel, d) {
  const pick = (...keys) => { for (const k of keys) if (d[k] !== undefined && d[k] !== '') return d[k]; return undefined; };
  let to = pick('to', 'To', 'phone', 'phoneNumber', 'phone_number', 'recipient', 'recipients', 'msisdn', 'token', 'tokens', 'deviceToken', 'registration_ids', 'userId', 'external_id');
  if (d.message && typeof d.message === 'object') to ??= d.message.token || d.message.topic; // FCM v1 shape
  return {
    id: randomUUID(),
    channel,
    to: [].concat(to ?? []).map(String),
    title: pick('title', 'subject', 'heading') ?? d.notification?.title ?? d.message?.notification?.title ?? '',
    body: String(pick('body', 'Body', 'message', 'text', 'sms', 'content') ?? d.notification?.body ?? d.message?.notification?.body ?? ''),
    subject: pick('title', 'subject') ?? '',
    created: new Date().toISOString(),
    raw: d,
  };
}

function page(list, url) {
  const start = Number(url.searchParams.get('start') || 0);
  const limit = Number(url.searchParams.get('limit') || 50);
  const newestFirst = [...list].reverse();
  const slice = newestFirst.slice(start, start + limit).map(({ Text, HTML, ...summary }) => summary);
  return { total: mail.length, unread: mail.filter((m) => !m.Read).length, count: slice.length, messages_count: list.length, messages_unread: list.filter((m) => !m.Read).length, start, tags: [], messages: slice };
}

// Tiny subset of Mailpit search: to:, from:, subject:, quoted phrases, free text (substring, case-insensitive).
function searchFn(query) {
  const terms = [...String(query || '').matchAll(/(-|!)?(?:(to|from|subject|cc|bcc):)?(?:"([^"]*)"|(\S+))/gi)]
    .map((m) => ({ neg: !!m[1], field: m[2]?.toLowerCase(), value: (m[3] ?? m[4] ?? '').toLowerCase() }))
    .filter((t) => t.value);
  return (m) => terms.every((t) => {
    const fields = {
      to: m.To.map((a) => `${a.Name} ${a.Address}`).join(' '),
      cc: (m.Cc || []).map((a) => a.Address).join(' '),
      bcc: (m.Bcc || []).map((a) => a.Address).join(' '),
      from: `${m.From.Name} ${m.From.Address}`,
      subject: m.Subject,
    };
    const hay = (t.field ? fields[t.field] : `${Object.values(fields).join(' ')} ${m.Text}`).toLowerCase();
    return hay.includes(t.value) !== t.neg;
  });
}

function remove(list, pred) { for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) list.splice(i, 1); }
function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); }); }
function send(res, code, data) {
  res.writeHead(code, { 'content-type': typeof data === 'string' ? 'text/plain' : 'application/json', 'access-control-allow-origin': '*' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}
function sendHtml(res, html) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function dashboard() {
  const rows = (list, f) => list.slice(-50).reverse().map(f).join('') || '<tr><td colspan="3" class="m">nothing yet</td></tr>';
  const mailRows = rows(mail, (m) => `<tr><td>${esc(m.Created.slice(11, 19))}</td><td>${esc(m.To.map((a) => a.Address).join(', '))}</td><td>${esc(m.Subject)}</td></tr>`);
  const sinkSections = [...sink].map(([ch, list]) => `<h2>${esc(ch)} <span class="m">(${list.length})</span></h2><table>${rows(list, (m) => `<tr><td>${esc(m.created.slice(11, 19))}</td><td>${esc(m.to.join(', '))}</td><td>${esc(m.title ? `${m.title}: ` : '')}${esc(m.body)}</td></tr>`)}</table>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Swarm Catcher</title>
<style>:root{--bg:#fafaf8;--ink:#1d1d1f;--m:#777;--line:#e5e5e0}@media (prefers-color-scheme:dark){:root{--bg:#151517;--ink:#eee;--m:#999;--line:#333}}
body{margin:0;padding:20px 16px;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,system-ui,sans-serif}table{width:100%;border-collapse:collapse}td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}.m{color:var(--m)}h1{font-size:20px}h2{font-size:16px;margin-top:24px}</style>
<h1>Swarm catcher</h1><p class="m">Refreshes every 5s · newest 50 per channel · in memory only</p>
<h2>email <span class="m">(${mail.length})</span></h2><table>${mailRows}</table>${sinkSections}`;
}

// ── SMTP (just enough of RFC 5321 for app mailers like nodemailer) ──────────
function startSmtp(port) {
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let from = '';
    let rcpt = [];
    let inData = false;
    let data = '';
    let buf = '';
    let authStep = null;
    const reply = (s) => sock.write(`${s}\r\n`);
    reply('220 swarm-catcher ESMTP ready');
    sock.on('data', (chunk) => {
      buf += chunk;
      for (;;) {
        if (inData) {
          // Accumulate first, then look for the terminator, so a "\r\n.\r\n" split across
          // two network chunks is still found.
          data += buf; buf = '';
          let end = data.indexOf('\r\n.\r\n');
          let skip = 5;
          if (end === -1 && data.startsWith('.\r\n')) { end = 0; skip = 3; }
          if (end === -1) return;
          buf = data.slice(end + skip);
          const msg = data.slice(0, end);
          inData = false; data = '';
          store(from, rcpt, msg.replace(/\r\n\.\./g, '\r\n.').replace(/^\.\./, '.'));
          rcpt = [];
          reply('250 OK: queued');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i === -1) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (authStep) { authStep = authStep === 'user' ? (reply('334 UGFzc3dvcmQ6'), 'pass') : (reply('235 Authentication successful'), null); continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') { sock.write('250-swarm-catcher\r\n250-8BITMIME\r\n250-SIZE 52428800\r\n250 AUTH PLAIN LOGIN\r\n'); }
        else if (cmd === 'HELO') reply('250 swarm-catcher');
        else if (cmd === 'AUTH') {
          const parts = line.split(/\s+/);
          if (parts[1]?.toUpperCase() === 'LOGIN' && parts[2]) { authStep = 'pass'; reply('334 UGFzc3dvcmQ6'); }
          else if (parts[1]?.toUpperCase() === 'LOGIN') { authStep = 'user'; reply('334 VXNlcm5hbWU6'); }
          else if (parts[1]?.toUpperCase() === 'PLAIN' && !parts[2]) { authStep = 'pass'; reply('334 '); }
          else reply('235 Authentication successful');
        } else if (cmd === 'MAIL') { from = (line.match(/<([^>]*)>/) || [])[1] || ''; rcpt = []; reply('250 OK'); }
        else if (cmd === 'RCPT') { rcpt.push(((line.match(/<([^>]*)>/) || [])[1] || '').toLowerCase()); reply('250 OK'); }
        else if (cmd === 'DATA') { inData = true; data = ''; reply('354 End data with <CR><LF>.<CR><LF>'); }
        else if (cmd === 'RSET') { from = ''; rcpt = []; reply('250 OK'); }
        else if (cmd === 'NOOP') reply('250 OK');
        else if (cmd === 'QUIT') { reply('221 Bye'); sock.end(); return; }
        else reply('502 Command not implemented');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, () => resolve(server)); });
}

function store(envFrom, envTo, raw) {
  const { headers, body } = splitMessage(raw);
  const text = extractText(headers, body);
  const addrList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(.*)<([^>]+)>$/);
    return m ? { Name: decodeWords(m[1].trim().replace(/^"|"$/g, '')), Address: m[2].toLowerCase() } : { Name: '', Address: s.toLowerCase() };
  });
  const headerTo = addrList(headers.to);
  const to = envTo.map((a) => headerTo.find((h) => h.Address === a) || { Name: '', Address: a });
  mail.push({
    ID: randomUUID(),
    MessageID: (headers['message-id'] || '').replace(/[<>]/g, ''),
    Read: false,
    From: addrList(headers.from)[0] || { Name: '', Address: envFrom },
    To: to,
    Cc: [], Bcc: [], ReplyTo: [],
    Subject: decodeWords(headers.subject || ''),
    Created: new Date().toISOString(),
    Tags: [],
    Size: raw.length,
    Attachments: 0,
    Snippet: text.replace(/\s+/g, ' ').trim().slice(0, 250),
    Text: text,
  });
}

function splitMessage(raw) {
  const i = raw.search(/\r?\n\r?\n/);
  const head = i === -1 ? raw : raw.slice(0, i);
  const body = i === -1 ? '' : raw.slice(i).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const j = line.indexOf(':');
    if (j > 0) headers[line.slice(0, j).trim().toLowerCase()] = line.slice(j + 1).trim();
  }
  return { headers, body };
}

function extractText(headers, body) {
  const ct = headers['content-type'] || 'text/plain';
  const boundary = (ct.match(/boundary="?([^";]+)"?/i) || [])[1];
  if (/multipart\//i.test(ct) && boundary) {
    const parts = body.split(`--${boundary}`).slice(1, -1).map(splitMessage);
    const plain = parts.find((p) => /text\/plain/i.test(p.headers['content-type'] || '')) || parts.find((p) => /multipart/i.test(p.headers['content-type'] || '')) || parts[0];
    if (!plain) return '';
    return /multipart/i.test(plain.headers['content-type'] || '') ? extractText(plain.headers, plain.body) : decodeBody(plain.headers, plain.body);
  }
  const t = decodeBody(headers, body);
  return /text\/html/i.test(ct) ? t.replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ') : t;
}

function decodeBody(headers, body) {
  const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    return Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
  }
  return body;
}

function decodeWords(s) {
  return String(s).replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, _cs, enc, txt) =>
    enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64').toString('utf8')
      : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'));
}

// Allow `node catcher.mjs` directly too.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.CATCHER_PORT || 4599);
  const smtpPort = process.env.CATCHER_SMTP === 'off' ? null : Number(process.env.CATCHER_SMTP || 1025);
  startCatcher({ port, smtpPort });
}
