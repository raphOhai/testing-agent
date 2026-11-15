#!/usr/bin/env node
// User swarm — reusable core. Everything project-specific lives in a project folder
// (swarm.config.mjs + personas/). Usage: node swarm.mjs <command> <project-folder> [options]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, newRunId, writeJson, readJson, say, hr, sleep, fmtMs } from './lib/util.mjs';
import { loadProject, makeContext, resolveRun, allRunDirs, CONFIG_FILE } from './lib/project.mjs';
import { checkSafety, printSafety, hostOf } from './lib/safety.mjs';
import { planSwarm, runSwarm, describePlan } from './lib/runner.mjs';
import { openLedger, readLedgerEntries, writeCsv, buildLedgerView } from './lib/ledger.mjs';
import { runScope, tagScope, serverTime } from './lib/notify.mjs';
import { computeBaselines, runChecks, summariseSwarm } from './lib/checker.mjs';
import { writeReports, headline } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');

const HELP = `
User swarm: many fake users, one staging app, and a check that the numbers add up.

  node swarm.mjs new <folder> [--example demo]   Create a project folder from the template (or the demo)
  node swarm.mjs catcher [--port 4599] [--smtp 1025]
                                                  Start the built-in email/SMS/push catcher
  node swarm.mjs doctor <folder>                  Safety check + "is everything wired up?" checklist
  node swarm.mjs run <folder> --users 1 [--ui 2] [--seed abc] [--concurrency 50] [--headed] [--exact-mix]
                                                  Send fake users through their journeys (writes a ledger)
  node swarm.mjs fast-forward <folder> [--run ID] Trigger scheduled jobs now (abandoned cart, reminders…)
  node swarm.mjs check <folder> [--run ID]        Compare ledger vs dashboard/DB/notifications → report
  node swarm.mjs all <folder> --users 200 [...]   run → wait → fast-forward → wait → check
  node swarm.mjs cleanup <folder> [--yes]         Delete every swarm-test user, order and message
                                                  (shows what it WOULD delete unless --yes)
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, target] = args._;
  try {
    switch (cmd) {
      case 'new': return await cmdNew(target, args);
      case 'catcher': {
        const { startCatcher } = await import('./catcher.mjs');
        return await startCatcher({ port: Number(args.port || 4599), smtpPort: args.smtp === 'off' ? null : Number(args.smtp || 1025) });
      }
      case 'doctor': return process.exit((await cmdDoctor(target, args)) ? 0 : 1);
      case 'run': return void (await cmdRun(target, args));
      case 'fast-forward': case 'ff': return void (await cmdFastForward(target, args));
      case 'check': return process.exit((await cmdCheck(target, args)) ? 0 : 2);
      case 'all': return process.exit((await cmdAll(target, args)) ? 0 : 2);
      case 'cleanup': return void (await cmdCleanup(target, args));
      default: say(HELP); return process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    say(`\n🛑 ${e.message}`);
    if (process.env.SWARM_DEBUG) console.error(e);
    process.exit(1);
  }
}

// ── new ──────────────────────────────────────────────────────────────────────
async function cmdNew(target, args) {
  if (!target) throw new Error('Give a folder name, e.g. `swarm.mjs new projects/aerrand`.');
  const src = args.example ? path.join(SKILL, 'assets', args.example, 'project') : path.join(SKILL, 'assets', 'project-template');
  if (!fs.existsSync(src)) throw new Error(`No example called "${args.example}".`);
  const dest = path.resolve(target);
  if (fs.existsSync(path.join(dest, CONFIG_FILE))) throw new Error(`${dest} already has a ${CONFIG_FILE}; not overwriting it.`);
  const name = path.basename(dest);
  copyDir(src, dest, (text) => text.replaceAll('__PROJECT__', name));
  say(`✓ Created ${dest}`);
  say(`  Edit ${path.join(dest, CONFIG_FILE)} and the files in personas/, then run:\n  node "${path.join(HERE, 'swarm.mjs')}" doctor "${dest}"`);
}

function copyDir(src, dest, transform) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'runs' || entry.name === 'node_modules') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, transform);
    else if (!fs.existsSync(d)) fs.writeFileSync(d, /\.(mjs|js|json|md|txt|example)$/.test(entry.name) ? transform(fs.readFileSync(s, 'utf8')) : fs.readFileSync(s));
  }
}

// ── shared: load + safety gate ───────────────────────────────────────────────
async function loadAndGuard(target, { quiet } = {}) {
  const project = await loadProject(target);
  if (project.problems.length) {
    say('🛑 The project config has problems:');
    for (const p of project.problems) say(`   ✗ ${p}`);
    throw new Error('Fix the config first (nothing was sent).');
  }
  const ctx = makeContext(project);
  const safety = await checkSafety(project, ctx);
  if (!quiet || !safety.ok) printSafety(safety);
  if (!safety.ok) throw new Error('Stopped by the safety check. Nothing was sent to the app. If you believe this IS staging, confirm it with the user and update environment settings.');
  return { project, ctx, safety };
}

// ── doctor ───────────────────────────────────────────────────────────────────
async function cmdDoctor(target) {
  const project = await loadProject(target);
  say(`🩺 Checking project "${project.name}" (${project.dir})`);
  hr();
  let ok = true;
  if (project.problems.length) { ok = false; for (const p of project.problems) say(`   ✗ Config: ${p}`); }
  else say('   ✓ Config and personas load, every step has code');

  const known = allRunDirs(project).flatMap((d) => buildLedgerView(readLedgerEntries(path.join(d, 'ledger.jsonl'))).all);
  const ctx = makeContext(project, { scope: tagScope(project.config.identity.tag, known) });
  const safety = await checkSafety(project, ctx);
  printSafety(safety);
  if (!safety.ok) ok = false;

  const { config } = project;
  // Notification channels reachable?
  for (const ch of ['email', 'sms', 'push', ...Object.keys(config.notifications).filter((k) => !['email', 'sms', 'push'].includes(k))]) {
    const r = ctx[ch];
    if (!r.configured) { say(`   ➖ ${ch}: not configured (fine if the app doesn't send ${ch})`); continue; }
    try { const n = (await r.all()).length; say(`   ✓ ${ch}: reading from ${r.source}${config.notifications[ch].url ? ` at ${config.notifications[ch].url}` : ''} (${n} swarm message(s) there now)`); }
    catch (e) { ok = false; say(`   ✗ ${ch}: can't read from ${r.source}: ${e.message}`); }
  }
  if (config.notifications.email?.source === 'mailpit') {
    try {
      const info = await (await fetch(`${config.notifications.email.url.replace(/\/$/, '')}/api/v1/info`)).json();
      if (info.Version !== 'swarm-catcher') say('   ℹ Real Mailpit detected. It keeps only 500 emails by default; start it with MP_MAX_MESSAGES=0 for big runs (see assets/mailpit-compose.yml).');
    } catch { /* reachability already reported above */ }
  }
  // Time travel, checks, cleanup present?
  say(config.fastForward.length ? `   ✓ ${config.fastForward.length} fast-forward step(s) configured` : '   ⚠ No fastForward steps: delayed notifications (abandoned cart, reminders) will not be triggered');
  say(config.checks.length ? `   ✓ ${config.checks.length} check(s) configured` : '   ✗ No checks: the report would be empty');
  if (!config.checks.length) ok = false;
  say(typeof config.cleanup === 'function' ? '   ✓ Cleanup is configured' : '   ✗ No cleanup() function: swarm data could not be removed');
  if (typeof config.cleanup !== 'function') ok = false;
  if (config.swarm.users > 1000 && !config.identity.phone) say('   ⚠ More than 1,000 users with default phone numbers: numbers will repeat. Set identity.phone if the app needs unique phones.');
  const uiRoles = project.roles.filter((r) => r.persona.ui).map((r) => r.role);
  if (uiRoles.length) {
    let has = false;
    try { const { createRequire } = await import('node:module'); createRequire(path.join(project.dir, 'package.json')).resolve('playwright'); has = true; } catch { /* not installed */ }
    say(has ? `   ✓ Playwright installed (UI journeys available for: ${uiRoles.join(', ')})` : `   ⚠ UI journeys exist for ${uiRoles.join(', ')} but Playwright isn't installed in the project folder (only needed for --ui)`);
  }
  hr();
  say(ok ? '✅ Ready. Start small: `run <folder> --users 1`' : '❌ Not ready. Fix the ✗ items above.');
  return ok;
}

// ── run ──────────────────────────────────────────────────────────────────────
async function cmdRun(target, args, loaded) {
  const { project, ctx } = loaded || (await loadAndGuard(target));
  const { config } = project;
  const users = Number(args.users ?? config.swarm.users);
  const ui = Number(args.ui || 0);
  if (!Number.isInteger(users) || users < 1) throw new Error('--users must be a whole number of 1 or more.');
  if (ui > users) throw new Error('--ui can’t be more than --users.');
  if (users > (config.swarm.maxUsers ?? 5000)) throw new Error(`--users ${users} is above swarm.maxUsers (${config.swarm.maxUsers ?? 5000}). Raise it in the config if you really mean it.`);

  const runId = newRunId();
  const runDir = path.join(project.dir, 'runs', runId);
  const seed = args.seed ?? runId;
  // Small runs (≤ 20 users) include at least one user of every behaviour, unless --exact-mix.
  const everyBehaviour = users <= 20 && !args.exactMix;
  const people = planSwarm(project, { users, uiUsers: ui, runId, seed, everyBehaviour });
  ctx.run = { id: runId, dir: runDir };

  hr();
  say(`🐝 Run ${runId}: ${people.length} fake user${people.length === 1 ? '' : 's'} → ${config.environment.baseUrl}`);
  say(describePlan(people));
  if (everyBehaviour && users > 1) say('   (small run: at least one user of every behaviour, so rare paths like refunds are tested too)');
  say(`   Emails look like: ${people[0]?.email}`);

  // Record "before" numbers for dashboard checks that measure the change.
  const baselines = await computeBaselines(project, makeContext(project, { run: ctx.run }));
  // Note each catcher's clock now, so checks only count messages sent during this run.
  const since = {};
  for (const [ch, c] of Object.entries(config.notifications)) if (c?.url) since[ch] = await serverTime(c.url, ctx.guard);
  writeJson(path.join(runDir, 'run.json'), {
    id: runId, project: project.name, target: config.environment.baseUrl, seed, users: people.length, uiUsers: ui,
    startedAt: new Date().toISOString(), since, baselines,
  });

  // Journeys read notifications (e.g. sign-up codes) only from this run onwards.
  const runCtx = makeContext(project, { run: ctx.run, since });
  // Optional one-time setup before anyone arrives (e.g. an admin creates the courses/products/stores
  // the users will need). Whatever it puts in `ctx.shared` is visible to every user as `u.shared`.
  const shared = new Map();
  if (typeof config.setup === 'function') {
    say('🧰 Setting up test data before the users arrive…');
    await config.setup({ ...runCtx, shared });
    writeJson(path.join(runDir, 'setup.json'), Object.fromEntries([...shared].map(([k, v]) => [k, v])));
  }
  const ledger = openLedger(path.join(runDir, 'ledger.jsonl'));
  const stats = await runSwarm(project, runCtx, { shared, people, runId, runDir, ledger, seed, headed: !!args.headed, concurrency: args.concurrency && Number(args.concurrency) });
  await ledger.close();

  const entries = readLedgerEntries(ledger.file);
  writeCsv(entries, path.join(runDir, 'ledger.csv'));
  const meta = readJson(path.join(runDir, 'run.json'), {});
  writeJson(path.join(runDir, 'run.json'), { ...meta, finishedAt: new Date().toISOString(), durationMs: stats.ms, failedUsers: stats.failed });

  const L = buildLedgerView(entries);
  const s = summariseSwarm(L);
  hr();
  say(`✓ Done in ${fmtMs(stats.ms)}: ${s.completedPlan} users did everything their behaviour asked, ${s.stopped} stopped early on purpose, ${s.errored} hit an error.`);
  for (const e of s.errors.slice(0, 5)) say(`   ✗ ${e.count} × "${e.step}" failed: ${e.error}`);
  say(`   Ledger: ${path.join(runDir, 'ledger.csv')}`);
  return { runId, runDir, stats };
}

// ── fast-forward ─────────────────────────────────────────────────────────────
async function cmdFastForward(target, args, loaded) {
  const { project } = loaded || (await loadAndGuard(target, { quiet: true }));
  const run = resolveRun(project, args.run);
  const ctx = makeContext(project, { run: { id: run.id, dir: run.dir } });
  const steps = project.config.fastForward;
  if (!steps.length) { say('⏩ No fast-forward steps configured, nothing to trigger.'); return []; }
  say(`⏩ Fast-forwarding time for run ${run.id}`);
  const done = [];
  for (const step of steps) {
    say(`   → ${step.label}`);
    try {
      if (typeof step.run === 'function') await step.run(ctx);
      else if (step.command) ctx.shell(step.command, { cwd: step.cwd });
      if (step.waitSeconds) await sleep(step.waitSeconds * 1000);
      done.push({ label: step.label, ok: true });
    } catch (e) {
      say(`     ✗ ${e.message}`);
      done.push({ label: step.label, ok: false, error: e.message });
    }
  }
  writeJson(path.join(run.dir, 'fast-forward.json'), { at: new Date().toISOString(), steps: done });
  return done;
}

// ── check ────────────────────────────────────────────────────────────────────
async function cmdCheck(target, args, loaded) {
  const { project } = loaded || (await loadAndGuard(target, { quiet: true }));
  const run = resolveRun(project, args.run);
  const entries = readLedgerEntries(path.join(run.dir, 'ledger.jsonl'));
  const L = buildLedgerView(entries);
  const ctx = makeContext(project, { run: { id: run.id, dir: run.dir }, scope: runScope(L.all), since: run.meta.since || {} });
  say(`🔎 Checking run ${run.id} (${L.all.length} fake users)`);
  const checks = await runChecks(project, ctx, L, { baselines: run.meta.baselines || {} });
  // A fast-forward step that failed (e.g. "too early: must send nothing") is a failed check too.
  for (const f of readJson(path.join(run.dir, 'fast-forward.json'), {}).steps || []) {
    if (!f.ok) checks.push({ id: `ff-${f.label}`, group: 'Time fast-forward', label: f.label, status: 'fail', expectedLabel: f.label, expected: 'should succeed', actualLabel: 'result', actual: 'failed', message: f.error });
  }
  const swarm = summariseSwarm(L);
  const data = {
    project: project.name, target: project.config.environment.baseUrl, generatedAt: new Date().toLocaleString(),
    run: { id: run.id, users: L.all.length }, checks, swarm,
    fastForward: readJson(path.join(run.dir, 'fast-forward.json'), {}).steps || [],
    ledgerFile: path.join(run.dir, 'ledger.csv'),
  };
  writeJson(path.join(run.dir, 'results.json'), data);
  const files = writeReports(run.dir, data);
  hr();
  for (const c of checks) say(`   ${headline(c)}${c.message && c.status !== 'pass' ? `\n      ${c.message}` : ''}`);
  if (swarm.errored) say(`   ⚠ ${swarm.errored} fake user(s) hit errors during their journey (see report)`);
  hr();
  const failed = checks.filter((c) => c.status === 'fail' || c.status === 'error').length;
  say(failed ? `❌ ${failed} of ${checks.length} checks need attention.` : `✅ All ${checks.length} checks passed.`);
  say(`   Report: ${files.html}\n           ${files.md}`);
  return failed === 0 && swarm.errored === 0;
}

// ── all ──────────────────────────────────────────────────────────────────────
async function cmdAll(target, args) {
  const loaded = await loadAndGuard(target);
  const { runId } = await cmdRun(target, args, loaded);
  const settle = Number(args.settle ?? loaded.project.config.swarm.settleSeconds);
  if (settle) { say(`⏳ Waiting ${settle}s for the app to finish sending notifications…`); await sleep(settle * 1000); }
  await cmdFastForward(target, { run: runId }, loaded);
  if (loaded.project.config.fastForward.length && settle) { say(`⏳ Waiting ${settle}s for scheduled jobs to send…`); await sleep(settle * 1000); }
  return cmdCheck(target, { run: runId }, loaded);
}

// ── cleanup ──────────────────────────────────────────────────────────────────
async function cmdCleanup(target, args) {
  const { project } = await loadAndGuard(target, { quiet: true });
  const dryRun = !args.yes;
  const { config } = project;
  const known = allRunDirs(project).flatMap((d) => buildLedgerView(readLedgerEntries(path.join(d, 'ledger.jsonl'))).all);
  const ctx = makeContext(project, { scope: tagScope(config.identity.tag, known), run: null });
  // What setup() created in every earlier run, so cleanup can remove it too.
  ctx.setups = allRunDirs(project).map((d) => ({ run: path.basename(d), data: readJson(path.join(d, 'setup.json'), null) })).filter((s) => s.data);
  say(dryRun ? `🧹 Cleanup PREVIEW for "${project.name}" (nothing is deleted without --yes)` : `🧹 Deleting every "${config.identity.tag}" record from ${hostOf(config.environment.baseUrl)}`);
  hr();
  if (typeof config.cleanup !== 'function') throw new Error('No cleanup() function in the config.');
  const summary = (await config.cleanup(ctx, { dryRun })) || [];
  for (const row of summary) {
    if (row.deletable === false) say(`   ⚠ Can't delete ${row.count} ${row.label}${row.note ? `: ${row.note}` : ''}`);
    else say(`   ${dryRun ? 'Would delete' : 'Deleted'} ${row.count} ${row.label}${row.note ? ` (${row.note})` : ''}`);
  }
  for (const ch of ['email', 'sms', 'push']) {
    if (!ctx[ch].configured || ctx[ch].source === 'log') continue;
    try {
      const n = dryRun ? (await ctx[ch].all()).length : await ctx[ch].removeAll();
      say(`   ${dryRun ? 'Would delete' : 'Deleted'} ${n} caught ${ch} message(s)`);
    } catch (e) { say(`   ⚠ ${ch}: ${e.message}`); }
  }
  hr();
  say(dryRun ? 'Run again with --yes to delete these.' : `✓ Cleanup finished. Ledgers and reports are kept in ${path.join(project.dir, 'runs')} as a record.`);
}

main();
