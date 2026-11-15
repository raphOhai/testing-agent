// The staging guard. Every command that touches the app passes through here first,
// and every HTTP request the swarm makes is checked against the allow-list.
//
// The rule it enforces: never run against production. If we can't show the target is
// staging, we stop and explain why, instead of guessing.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnvText } from './util.mjs';

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|[a-z0-9-]+\.(local|localhost|test|internal|lan))$/i;
const PRIVATE_IP = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;
const STAGING_WORD = /(^|[.-])(staging|stage|stg|test|testing|sandbox|dev|develop|qa|uat|preview|demo)([.-]|\d|$)/i;

// Secrets that must never be present on the target when we create payments.
const LIVE_KEY_PATTERNS = [
  { re: /\b(sk|rk|pk)_live_[A-Za-z0-9]{6,}/, what: 'a live Stripe/Paystack key' },
  { re: /\bFLWSECK-[A-Za-z0-9]{10,}/, what: 'a live Flutterwave secret key' },
  { re: /\bFLWPUBK-[A-Za-z0-9]{10,}/, what: 'a live Flutterwave public key' },
  { re: /\brzp_live_[A-Za-z0-9]+/, what: 'a live Razorpay key' },
  { re: /^\s*PAYPAL_(MODE|ENV|ENVIRONMENT)\s*=\s*["']?(live|production)/im, what: 'PayPal set to live mode' },
  { re: /^\s*BRAINTREE_ENV(IRONMENT)?\s*=\s*["']?production/im, what: 'Braintree set to production' },
  { re: /^\s*MONNIFY_(BASE_URL|ENV)\s*=\s*["']?https?:\/\/api\.monnify\.com/im, what: 'Monnify pointed at the live API' },
];

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function matchHost(host, pattern) {
  pattern = String(pattern).toLowerCase();
  if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
  return host === pattern;
}

function isProductionHost(host, productionHosts = []) {
  return productionHosts.some((p) => {
    p = String(p).toLowerCase();
    if (p.startsWith('*.')) return matchHost(host, p);
    return host === p || host === `www.${p}`;
  });
}

export function looksLocal(host) {
  return LOCAL_HOST.test(host) || PRIVATE_IP.test(host);
}

export function looksStaging(host) {
  return looksLocal(host) || STAGING_WORD.test(host);
}

// Hosts the swarm may talk to: the app, plus the catchers/sinks it reads from.
export function allowedHosts(config) {
  const env = config.environment || {};
  const hosts = new Set((env.allowHosts || []).map((h) => String(h).toLowerCase()));
  for (const ch of Object.values(config.notifications || {})) {
    const h = ch?.url && hostOf(ch.url);
    if (h && looksLocal(h)) hosts.add(h);
  }
  return [...hosts];
}

export function makeGuard(config) {
  const env = config.environment || {};
  const allow = allowedHosts(config);
  const prod = env.productionHosts || [];
  return {
    allow,
    assertUrl(url) {
      const host = hostOf(url);
      if (!host) throw new Error(`Blocked: "${url}" is not a valid URL.`);
      if (isProductionHost(host, prod)) {
        throw new Error(`Blocked: ${host} is listed as PRODUCTION. The swarm never talks to production.`);
      }
      if (!allow.some((p) => matchHost(host, p))) {
        throw new Error(`Blocked: ${host} is not on the staging allow-list (environment.allowHosts). Add it only after confirming it is staging.`);
      }
    },
  };
}

// Full pre-flight safety check. Returns { ok, problems[], warnings[], facts[] }.
// `ctx` is optional; when given, the project's own verify() hook is run against the live target.
export async function checkSafety(project, ctx) {
  const { config, dir } = project;
  const env = config.environment || {};
  const problems = [];
  const warnings = [];
  const facts = [];
  const host = hostOf(env.baseUrl);

  if (!host) {
    problems.push(`environment.baseUrl is missing or not a valid URL (got "${env.baseUrl}").`);
    return { ok: false, problems, warnings, facts };
  }
  facts.push(`Target: ${env.baseUrl}`);

  if (isProductionHost(host, env.productionHosts)) {
    problems.push(`${host} is in environment.productionHosts. Refusing: the swarm never runs against production.`);
  }
  const allow = allowedHosts(config);
  if (!allow.some((p) => matchHost(host, p))) {
    problems.push(`${host} is not in environment.allowHosts. Add it only after the user confirms it is staging.`);
  }
  if (!(env.productionHosts || []).length) {
    warnings.push('environment.productionHosts is empty. List the real production domains so they are always blocked.');
  }
  const overlap = (env.allowHosts || []).filter((h) => isProductionHost(String(h).toLowerCase(), env.productionHosts));
  if (overlap.length) problems.push(`These hosts are in BOTH allowHosts and productionHosts: ${overlap.join(', ')}.`);

  // The user has to have said "yes, this is staging" for this exact host.
  const conf = env.confirmed;
  if (!conf || !conf.by || !conf.on) {
    problems.push('No staging confirmation recorded. Ask the user to confirm this is staging, then set environment.confirmed = { host, by, on }.');
  } else if (String(conf.host || '').toLowerCase() !== host) {
    problems.push(`The staging confirmation is for "${conf.host}", but the target is "${host}". Ask the user to confirm the new host.`);
  } else {
    facts.push(`Confirmed as staging by ${conf.by} on ${conf.on}${conf.note ? ` (${conf.note})` : ''}`);
  }
  if (looksLocal(host)) facts.push(`${host} is a local/private address, so it can't be the public production site.`);
  else if (!looksStaging(host)) warnings.push(`${host} does not look like a staging name (no "staging", "dev", "test"...). Double-check with the user.`);

  // Live proof from the app itself (e.g. a health endpoint that says "staging").
  if (typeof env.verify === 'function') {
    if (ctx) {
      try {
        const res = await env.verify(ctx);
        if (res === true) facts.push('The app itself reports it is a staging/test environment.');
        else problems.push(`The app's own check did not confirm staging: ${typeof res === 'string' ? res : JSON.stringify(res)}`);
      } catch (e) {
        problems.push(`Could not reach the app to verify it is staging: ${e.message}`);
      }
    }
  } else {
    warnings.push('No environment.verify() hook, so there is no live proof from the app that it is staging.');
  }

  // Databases the harness connects to directly (checks/cleanup) must be safe too.
  for (const raw of config.safety?.databaseUrls || []) {
    if (!raw) continue;
    const dbHost = dbHostOf(raw);
    if (!dbHost) { warnings.push('A database URL in safety.databaseUrls could not be parsed.'); continue; }
    if (isProductionHost(dbHost, env.productionHosts)) problems.push(`A database URL points at a production host (${dbHost}).`);
    else if (!looksLocal(dbHost) && !allow.some((p) => matchHost(dbHost, p)) && !(config.safety?.allowDbHosts || []).some((p) => matchHost(dbHost, p))) {
      problems.push(`A database URL points at ${dbHost}, which is not local and not in allowHosts/safety.allowDbHosts.`);
    } else facts.push(`Database host ${dbHost} is allowed.`);
  }

  // Payments must be in test mode. Scan env files for live keys (names only are reported).
  const scanned = [];
  for (const rel of config.safety?.scanEnvFiles || []) {
    const file = path.resolve(dir, rel);
    if (!fs.existsSync(file)) { warnings.push(`Env file to scan not found: ${rel}`); continue; }
    const text = fs.readFileSync(file, 'utf8');
    scanned.push(rel);
    for (const { re, what } of LIVE_KEY_PATTERNS) {
      for (const line of text.split(/\r?\n/)) {
        if (/^\s*#/.test(line)) continue;
        if (re.test(line)) {
          const name = (line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=/) || [])[1] || '(unnamed)';
          problems.push(`${rel} has ${what} in ${name}. Payments must use test keys only.`);
        }
      }
    }
    const vars = parseEnvText(text);
    for (const name of config.safety?.requireTestKeys || []) {
      if (vars[name] !== undefined && !/test/i.test(vars[name])) problems.push(`${rel}: ${name} does not look like a TEST key.`);
    }
  }
  for (const name of config.safety?.requireTestKeys || []) {
    const v = process.env[name];
    if (v !== undefined && !/test/i.test(v)) problems.push(`Environment variable ${name} does not look like a TEST key.`);
  }
  if (scanned.length) facts.push(`Scanned ${scanned.length} env file(s) for live payment keys.`);
  if (config.payments?.mode && config.payments.mode !== 'test') problems.push(`payments.mode is "${config.payments.mode}". Only "test" is allowed.`);

  return { ok: problems.length === 0, problems, warnings, facts };
}

function dbHostOf(uri) {
  const m = String(uri).match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/:,?]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export function printSafety(result, say = console.log) {
  say(result.ok ? '🛡  Safety check: PASSED' : '🛑 Safety check: FAILED, nothing was sent');
  for (const f of result.facts) say(`   ✓ ${f}`);
  for (const w of result.warnings) say(`   ⚠ ${w}`);
  for (const p of result.problems) say(`   ✗ ${p}`);
}
