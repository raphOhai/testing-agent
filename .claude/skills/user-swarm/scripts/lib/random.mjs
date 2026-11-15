// Seeded randomness, fake identities, and the behaviour mix.
// Everything random is seeded so a run can be repeated exactly with --seed.

export function hashSeed(s) {
  let h = 1779033703 ^ String(s).length;
  for (let i = 0; i < String(s).length; i++) {
    h = Math.imul(h ^ String(s).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h >>> 0) || 1;
}

export function makeRng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    rand,
    int: (min, max) => Math.floor(rand() * (max - min + 1)) + min,
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
    chance: (p) => rand() < p,
    between: ([min, max]) => min + rand() * (max - min),
    shuffle(arr) {
      const a2 = [...arr];
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
}

// ── Behaviour mix ────────────────────────────────────────────────────────────
export const DEFAULT_MIX = {
  complete: 50,       // complete the full journey
  drop_halfway: 20,   // start but drop halfway
  abandon: 15,        // add to cart / begin, but never check out or pay
  signup_only: 10,    // sign up and never come back
  cancel_refund: 5,   // cancel or request a refund
};

export const BEHAVIOUR_LABELS = {
  complete: 'Complete the full journey',
  drop_halfway: 'Start but drop halfway',
  abandon: 'Begin but never check out / pay',
  signup_only: 'Sign up and never come back',
  cancel_refund: 'Cancel or request a refund',
};

// Split `total` into whole numbers proportional to `weights`
// (largest-remainder method, so 200 users × 15% is exactly 30).
export function apportion(total, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const sum = entries.reduce((s, [, w]) => s + w, 0);
  if (!sum) return {};
  const raw = entries.map(([k, w], i) => ({ k, i, exact: (total * w) / sum }));
  const out = Object.fromEntries(raw.map((r) => [r.k, Math.floor(r.exact)]));
  let left = total - Object.values(out).reduce((s, n) => s + n, 0);
  const byRemainder = [...raw].sort((a, b) => (b.exact % 1) - (a.exact % 1) || a.i - b.i);
  for (const r of byRemainder) { if (left-- <= 0) break; out[r.k]++; }
  return out;
}

// Like apportion, but first gives every behaviour one user (when there are enough users), so a
// small run (e.g. the 10-user stage) still exercises rare behaviours like refunds.
export function apportionAtLeastOne(total, weights) {
  const keys = Object.entries(weights).filter(([, w]) => w > 0).map(([k]) => k);
  if (total < keys.length) return apportion(total, weights);
  const rest = apportion(total - keys.length, weights);
  return Object.fromEntries(keys.map((k) => [k, (rest[k] || 0) + 1]));
}

// ── Identities ───────────────────────────────────────────────────────────────
const FIRST = ['Ada', 'Tunde', 'Chioma', 'Emeka', 'Amara', 'Kofi', 'Zainab', 'Ifeanyi', 'Ngozi', 'Bola',
  'Liam', 'Olivia', 'Noah', 'Emma', 'Mateo', 'Sofia', 'Arjun', 'Priya', 'Wei', 'Mei',
  'Yusuf', 'Fatima', 'Kwame', 'Abena', 'Diego', 'Lucia', 'Hana', 'Kenji', 'Aisha', 'Omar',
  'Grace', 'Samuel', 'Esther', 'David', 'Ruth', 'Daniel', 'Chidi', 'Funmi', 'Seun', 'Tobi'];
const LAST = ['Okafor', 'Adeyemi', 'Okonkwo', 'Balogun', 'Mensah', 'Nwosu', 'Eze', 'Bello', 'Ibrahim', 'Abubakar',
  'Smith', 'Johnson', 'Brown', 'Garcia', 'Martinez', 'Lopez', 'Patel', 'Sharma', 'Chen', 'Wang',
  'Kim', 'Tanaka', 'Silva', 'Costa', 'Rossi', 'Muller', 'Dubois', 'Novak', 'Haddad', 'Khan',
  'Owusu', 'Boateng', 'Achebe', 'Obi', 'Lawal', 'Danjuma', 'Ogunleye', 'Afolabi', 'Uche', 'Etim'];

export function makeIdentity({ runId, n, tag, emailDomain, custom }) {
  // Every (first, last) pair is unique for the first 1,600 users; after that a number is added.
  const i = n % FIRST.length;
  const block = Math.floor(n / FIRST.length);
  const first = FIRST[i];
  const last = LAST[(i + block) % LAST.length] + (block >= LAST.length ? ` ${Math.floor(block / LAST.length) + 1}` : '');
  const nn = String(n).padStart(4, '0');
  const base = {
    n,
    id: `${tag}-${runId}-u${nn}`,
    firstName: first,
    lastName: last,
    name: `${first} ${last}`,
    // The tag sits in every email so the whole swarm is easy to find and delete.
    email: `${tag}.${runId}.u${nn}@${emailDomain}`.toLowerCase(),
    // +44 7700 900xxx is reserved by Ofcom for fiction, so it can never reach a real phone.
    phone: `+447700900${String((n + (hashSeed(runId) % 1000)) % 1000).padStart(3, '0')}`,
    password: `Swarm-${runId}-${nn}!aA1`,
    pushToken: `${tag}-${runId}-device-${nn}`,
  };
  const ctx = { ...base, run: runId, tag };
  for (const key of ['email', 'phone', 'name', 'password', 'pushToken']) {
    if (typeof custom?.[key] === 'function') base[key] = custom[key](ctx);
  }
  return base;
}
