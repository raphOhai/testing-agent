// Loads a project folder (swarm.config.mjs + personas) and builds the `ctx` object
// that config hooks receive. Everything project-specific lives in that folder;
// this file is the reusable core.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { loadDotEnv, readJson } from './util.mjs';
import { DEFAULT_MIX } from './random.mjs';
import { makeGuard } from './safety.mjs';
import { createHttp } from './http.mjs';
import { makeReader } from './notify.mjs';

export const CONFIG_FILE = 'swarm.config.mjs';

export async function loadProject(dirArg) {
  if (!dirArg) throw new Error('Tell me which project folder to use, e.g. `swarm.mjs run projects/aerrand`.');
  const dir = path.resolve(dirArg);
  const file = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(file)) throw new Error(`No ${CONFIG_FILE} in ${dir}. Create one with \`swarm.mjs new ${dirArg}\`.`);
  loadDotEnv(path.join(dir, '.env'));
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  const raw = mod.default || mod.config;
  const config = applyDefaults(typeof raw === 'function' ? await raw() : raw);

  const roles = [];
  for (const r of config.roles) {
    const pFile = path.resolve(dir, r.persona);
    if (!fs.existsSync(pFile)) throw new Error(`Persona file not found: ${r.persona}`);
    const pm = await import(`${pathToFileURL(pFile).href}?t=${Date.now()}`);
    const persona = pm.default || pm.persona;
    roles.push({ ...r, persona, role: persona.role || path.basename(pFile).replace(/\.m?js$/, ''), file: r.persona });
  }
  const project = { dir, file, config, roles, name: config.project || path.basename(dir) };
  const problems = validate(project);
  return { ...project, problems };
}

function applyDefaults(c = {}) {
  return {
    ...c,
    identity: { tag: 'swarm-test', emailDomain: 'example.com', ...(c.identity || {}) },
    swarm: {
      users: 200, concurrency: 50, rampUpSeconds: 20, thinkTimeMs: [300, 1500], settleSeconds: 5, requestTimeoutMs: 30000,
      ...(c.swarm || {}),
      mix: { ...(c.swarm?.mix || DEFAULT_MIX) },
    },
    roles: (c.roles || []).map((r) => (typeof r === 'string' ? { persona: r } : r)),
    notifications: c.notifications || {},
    fastForward: c.fastForward || [],
    checks: c.checks || [],
    safety: c.safety || {},
  };
}

function validate({ config, roles }) {
  const problems = [];
  if (!config.environment?.baseUrl) problems.push('environment.baseUrl is missing.');
  if (!roles.length) problems.push('No roles/personas listed in `roles`.');
  const tag = config.identity.tag;
  if (!/swarm-test/.test(tag)) problems.push(`identity.tag "${tag}" must contain "swarm-test" so cleanup can find everything.`);
  for (const r of roles) {
    const p = r.persona || {};
    const name = r.role;
    if (!Array.isArray(p.steps) || !p.steps.length) { problems.push(`${name}: persona has no \`steps\` list.`); continue; }
    const actions = p.actions || {};
    const mix = r.mix || config.swarm.mix;
    for (const b of Object.keys(mix)) {
      const plan = (p.behaviours || {})[b];
      if (!plan && b !== 'complete' && mix[b] > 0) problems.push(`${name}: behaviour "${b}" is in the mix but not in persona.behaviours.`);
      if (plan?.through && !p.steps.includes(plan.through)) problems.push(`${name}: behaviour "${b}" stops after "${plan.through}", which is not a step.`);
      for (const extra of plan?.then || []) if (!actions[extra]) problems.push(`${name}: behaviour "${b}" runs "${extra}" afterwards, but there is no action with that name.`);
    }
    for (const s of p.steps) if (typeof actions[s] !== 'function') problems.push(`${name}: step "${s}" has no function in persona.actions.`);
  }
  config.checks.forEach((ch, i) => {
    if (!ch.label) problems.push(`checks[${i}] has no label.`);
    if (typeof ch.expected !== 'function' || typeof ch.actual !== 'function') problems.push(`checks[${i}] (${ch.label}) needs both expected() and actual() functions.`);
  });
  return problems;
}

// The steps a user with this behaviour will perform, in order.
export function planFor(persona, behaviour) {
  const steps = persona.steps;
  const b = (persona.behaviours || {})[behaviour] || { through: steps[steps.length - 1] };
  const end = b.through ? steps.indexOf(b.through) : steps.length - 1;
  return [...steps.slice(0, end + 1), ...(b.then || [])];
}

// The object every config hook (verify, fastForward, checks, cleanup) receives.
export function makeContext(project, { scope, since = {}, run, log = console.log } = {}) {
  const { config, dir } = project;
  const guard = makeGuard(config);
  const api = createHttp({ baseUrl: config.environment.baseUrl, guard, timeoutMs: config.swarm.requestTimeoutMs });
  const ctx = {
    project: { name: project.name, dir },
    config,
    tag: config.identity.tag,
    run,
    env: process.env,
    guard,
    api,
    http: (baseUrl) => createHttp({ baseUrl, guard, timeoutMs: config.swarm.requestTimeoutMs }),
    log: (...a) => log('   ', ...a),
    hoursFromNow: (h) => new Date(Date.now() + h * 3600e3).toISOString(),
    daysFromNow: (d) => new Date(Date.now() + d * 86400e3).toISOString(),
    hoursAgo: (h) => new Date(Date.now() - h * 3600e3),
    daysAgo: (d) => new Date(Date.now() - d * 86400e3),
    // Run a shell command (e.g. `docker compose exec api node jobs/abandoned-cart.js`).
    shell(cmd, opts = {}) {
      log(`    $ ${cmd}`);
      return execSync(cmd, { cwd: opts.cwd ? path.resolve(dir, opts.cwd) : dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    },
    // Import a package installed in the PROJECT folder (e.g. mongodb, pg, playwright).
    async import(pkg) {
      const req = createRequire(path.join(dir, 'package.json'));
      return import(pathToFileURL(req.resolve(pkg)).href);
    },
  };
  const readerScope = scope || (() => true);
  for (const ch of ['email', 'sms', 'push', ...Object.keys(config.notifications).filter((k) => !['email', 'sms', 'push'].includes(k))]) {
    ctx[ch] = makeReader(ch, config.notifications[ch], guard, ctx, readerScope, since[ch]);
  }
  return ctx;
}

export function runsDir(project) { return path.join(project.dir, 'runs'); }

export function resolveRun(project, runId) {
  const base = runsDir(project);
  if (runId && runId !== true) {
    const d = path.join(base, runId);
    if (!fs.existsSync(d)) throw new Error(`Run "${runId}" not found in ${base}.`);
    return { id: runId, dir: d, meta: readJson(path.join(d, 'run.json'), {}) };
  }
  const all = fs.existsSync(base) ? fs.readdirSync(base).filter((n) => fs.existsSync(path.join(base, n, 'run.json'))).sort() : [];
  if (!all.length) throw new Error('No runs yet. Start one with `swarm.mjs run <project> --users 1`.');
  const id = all[all.length - 1];
  return { id, dir: path.join(base, id), meta: readJson(path.join(base, id, 'run.json'), {}) };
}

export function allRunDirs(project) {
  const base = runsDir(project);
  return fs.existsSync(base) ? fs.readdirSync(base).map((n) => path.join(base, n)).filter((d) => fs.existsSync(path.join(d, 'ledger.jsonl'))) : [];
}
