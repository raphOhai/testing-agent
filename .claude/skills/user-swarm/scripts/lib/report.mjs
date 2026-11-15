// Writes the expected-vs-actual report as Markdown and as a self-contained HTML page.
import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml as h, fmtNum, fmtMs } from './util.mjs';
import { BEHAVIOUR_LABELS } from './random.mjs';

const ICON = { pass: '✅', fail: '❌', error: '⚠️', skipped: '➖' };

export function headline(r) {
  const e = r.expectedLabel || 'Expected';
  const a = r.actualLabel || 'Actual';
  if (r.status === 'error') return `${r.label}: could not be checked ⚠️`;
  if (r.status === 'skipped') return `${r.label}: skipped ➖`;
  return `${e}: ${fmtNum(r.expected)} → ${a}: ${fmtNum(r.actual)} ${ICON[r.status]}`;
}

export function writeReports(runDir, data) {
  const md = toMarkdown(data);
  const html = toHtml(data);
  fs.writeFileSync(path.join(runDir, 'report.md'), md);
  fs.writeFileSync(path.join(runDir, 'report.html'), html);
  return { md: path.join(runDir, 'report.md'), html: path.join(runDir, 'report.html') };
}

function tally(checks) {
  const t = { pass: 0, fail: 0, error: 0, skipped: 0 };
  for (const c of checks) t[c.status]++;
  return t;
}

function toMarkdown(d) {
  const t = tally(d.checks);
  const s = d.swarm;
  const L = [];
  L.push(`# User swarm report — ${d.project}`);
  L.push('');
  L.push(`Run \`${d.run.id}\` · ${d.run.users} fake users · target ${d.target} · generated ${d.generatedAt}`);
  L.push('');
  L.push(`**${t.pass} passed · ${t.fail} failed · ${t.error} could not be checked${t.skipped ? ` · ${t.skipped} skipped` : ''}**`);
  L.push('');
  const groups = groupBy(d.checks, (c) => c.group);
  for (const [g, list] of groups) {
    L.push(`## ${g}`);
    L.push('');
    for (const c of list) {
      L.push(`- ${headline(c)}`);
      if (c.message) L.push(`  - ${c.message}`);
      if (c.before !== undefined) L.push(`  - Dashboard before the run: ${fmtNum(c.before)}, after: ${fmtNum(c.after)}`);
      if (c.missing?.length) L.push(`  - Missing (first 10): ${c.missing.slice(0, 10).join(', ')}`);
      if (c.unexpected?.length) L.push(`  - Unexpected (first 10): ${c.unexpected.slice(0, 10).join(', ')}`);
      if (c.duplicates?.length) L.push(`  - Duplicates (first 10): ${c.duplicates.slice(0, 10).join(', ')}`);
      if (c.note) L.push(`  - Note: ${c.note}`);
    }
    L.push('');
  }
  L.push('## What the fake users did');
  L.push('');
  L.push(`${s.users} users · ${s.completedPlan} did everything their behaviour asked · ${s.stopped} stopped early on purpose · ${s.errored} hit an error${s.uiUsers ? ` · ${s.uiUsers} ran through the real UI` : ''}`);
  L.push('');
  L.push('| Role | Behaviour | Users |');
  L.push('|---|---|---|');
  for (const [role, bs] of Object.entries(s.byRole)) for (const [b, n] of Object.entries(bs)) L.push(`| ${role} | ${BEHAVIOUR_LABELS[b] || b} | ${n} |`);
  L.push('');
  L.push('**Where they stopped**');
  L.push('');
  for (const [k, n] of Object.entries(s.stoppedAt)) L.push(`- ${k}: ${n}`);
  L.push('');
  if (s.errors.length) {
    L.push('## Errors the fake users hit');
    L.push('');
    for (const e of s.errors) L.push(`- **${e.step}** × ${e.count}: ${e.error} _(e.g. ${e.users.slice(0, 3).join(', ')})_`);
    L.push('');
  }
  L.push('## Speed per step');
  L.push('');
  L.push('| Step | Count | Typical (p50) | Slow (p95) | Slowest |');
  L.push('|---|---|---|---|---|');
  for (const [step, v] of Object.entries(s.latency)) L.push(`| ${step} | ${v.n} | ${fmtMs(v.p50)} | ${fmtMs(v.p95)} | ${fmtMs(v.max)} |`);
  L.push('');
  if (d.fastForward?.length) {
    L.push('## Time fast-forward steps that ran');
    L.push('');
    for (const f of d.fastForward) L.push(`- ${f.ok ? '✓' : '✗'} ${f.label}${f.error ? ` — ${f.error}` : ''}`);
    L.push('');
  }
  L.push(`Ledger: \`${d.ledgerFile}\``);
  return L.join('\n') + '\n';
}

function toHtml(d) {
  const t = tally(d.checks);
  const s = d.swarm;
  const groups = groupBy(d.checks, (c) => c.group);
  const checkRow = (c) => {
    const details = [
      c.message && `<p>${h(c.message)}</p>`,
      c.before !== undefined && `<p>Dashboard before the run: <b>${h(fmtNum(c.before))}</b>, after: <b>${h(fmtNum(c.after))}</b></p>`,
      c.missing?.length && listBlock('Expected but never received', c.missing),
      c.unexpected?.length && listBlock('Received but not expected', c.unexpected),
      c.duplicates?.length && listBlock('Received more than once', c.duplicates),
      c.note && `<p class="muted">${h(c.note)}</p>`,
    ].filter(Boolean).join('');
    return `<tr class="${c.status}">
      <td class="ico">${ICON[c.status]}</td>
      <td><div class="label">${h(c.label)}</div>${details ? `<details><summary>Details</summary>${details}</details>` : ''}</td>
      <td class="num"><span class="cap">${h(c.expectedLabel || 'Expected')}</span>${h(fmtNum(c.expected ?? '—'))}</td>
      <td class="arrow">→</td>
      <td class="num"><span class="cap">${h(c.actualLabel || 'Actual')}</span>${h(fmtNum(c.actual ?? '—'))}</td>
    </tr>`;
  };
  const roleRows = Object.entries(s.byRole).flatMap(([role, bs]) => Object.entries(bs).map(([b, n]) => `<tr><td>${h(role)}</td><td>${h(BEHAVIOUR_LABELS[b] || b)}</td><td class="r">${n}</td></tr>`)).join('');
  const stopRows = Object.entries(s.stoppedAt).map(([k, n]) => `<tr><td>${h(k)}</td><td class="r">${n}</td></tr>`).join('');
  const errRows = s.errors.map((e) => `<tr><td>${h(e.step)}</td><td class="r">${e.count}</td><td><code>${h(e.error)}</code><div class="muted">e.g. ${h(e.users.slice(0, 3).join(', '))}</div></td></tr>`).join('');
  const latRows = Object.entries(s.latency).map(([st, v]) => `<tr><td>${h(st)}</td><td class="r">${v.n}</td><td class="r">${fmtMs(v.p50)}</td><td class="r">${fmtMs(v.p95)}</td><td class="r">${fmtMs(v.max)}</td></tr>`).join('');
  const ffRows = (d.fastForward || []).map((f) => `<li>${f.ok ? '✓' : '✗'} ${h(f.label)}${f.error ? ` — <code>${h(f.error)}</code>` : ''}</li>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Swarm Report</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#e4e4e0;--pass:#1f7a3d;--passbg:#e7f5ec;--fail:#b3261e;--failbg:#fdecea;--warn:#8a5a00;--warnbg:#fff4dc}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141416;--card:#1d1d20;--ink:#ececee;--muted:#9a9aa2;--line:#2e2e33;--pass:#6fd08f;--passbg:#16301f;--fail:#ff8a80;--failbg:#3a1a18;--warn:#ffcc66;--warnbg:#33290f}}
:root[data-theme="dark"]{--bg:#141416;--card:#1d1d20;--ink:#ececee;--muted:#9a9aa2;--line:#2e2e33;--pass:#6fd08f;--passbg:#16301f;--fail:#ff8a80;--failbg:#3a1a18;--warn:#ffcc66;--warnbg:#33290f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 60px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 10px}
.muted{color:var(--muted);font-size:13px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:18px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.tile b{display:block;font-size:26px;line-height:1.1}
.tile.p b{color:var(--pass)}.tile.f b{color:var(--fail)}.tile.e b{color:var(--warn)}
table{width:100%;border-collapse:collapse}td,th{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}
tr:last-child td{border-bottom:0}th{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
tr.fail{background:var(--failbg)}tr.error{background:var(--warnbg)}.ico{width:34px;font-size:18px}.num{white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums;font-size:18px;font-weight:600}
.cap{display:block;font-size:11px;font-weight:500;color:var(--muted);white-space:normal;max-width:220px;margin-left:auto}.arrow{color:var(--muted);width:20px;text-align:center;padding-top:26px}
.label{font-weight:600}.r{text-align:right;font-variant-numeric:tabular-nums}details{margin-top:6px}summary{cursor:pointer;color:var(--muted);font-size:13px}
details ul{margin:6px 0;padding-left:18px;font-size:13px;max-height:180px;overflow:auto}code{font-size:12px;word-break:break-word}
.scroll{overflow-x:auto}@media (max-width:640px){.cap{max-width:110px}.num{font-size:15px}td,th{padding:8px}}
</style></head><body><main>
<h1>User swarm report: ${h(d.project)}</h1>
<div class="muted">Run <code>${h(d.run.id)}</code> · ${d.run.users} fake users · target ${h(d.target)} · ${h(d.generatedAt)}</div>
<div class="tiles">
  <div class="tile p"><b>${t.pass}</b>checks passed</div>
  <div class="tile f"><b>${t.fail}</b>checks failed</div>
  <div class="tile e"><b>${t.error}</b>could not be checked</div>
  <div class="tile"><b>${s.users}</b>fake users (${s.errored} hit errors)</div>
</div>
${[...groups].map(([g, list]) => `<h2>${h(g)}</h2><div class="card scroll"><table>${list.map(checkRow).join('')}</table></div>`).join('')}
<h2>What the fake users did</h2>
<p class="muted">${s.completedPlan} did everything their behaviour asked · ${s.stopped} stopped early on purpose · ${s.errored} hit an error${s.uiUsers ? ` · ${s.uiUsers} ran through the real UI` : ''}</p>
<div class="card scroll"><table><tr><th>Role</th><th>Behaviour</th><th class="r">Users</th></tr>${roleRows}</table></div>
<h2>Where they stopped</h2>
<div class="card scroll"><table><tr><th>Role → last successful step</th><th class="r">Users</th></tr>${stopRows}</table></div>
${errRows ? `<h2>Errors the fake users hit</h2><div class="card scroll"><table><tr><th>Step</th><th class="r">Times</th><th>Error</th></tr>${errRows}</table></div>` : ''}
<h2>Speed per step</h2>
<div class="card scroll"><table><tr><th>Step</th><th class="r">Count</th><th class="r">Typical</th><th class="r">Slow (p95)</th><th class="r">Slowest</th></tr>${latRows}</table></div>
${ffRows ? `<h2>Time fast-forward</h2><ul>${ffRows}</ul>` : ''}
<p class="muted">Ledger: <code>${h(d.ledgerFile)}</code></p>
</main></body></html>
`;
}

function listBlock(title, items) {
  return `<p><b>${h(title)}</b> (${items.length})</p><ul>${items.slice(0, 200).map((i) => `<li><code>${h(i)}</code></li>`).join('')}${items.length > 200 ? `<li>…and ${items.length - 200} more</li>` : ''}</ul>`;
}

function groupBy(list, fn) {
  const m = new Map();
  for (const x of list) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
