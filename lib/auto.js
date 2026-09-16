'use strict';
// Automatic account rotation. When ON, it watches the active account of one target and,
// as soon as that account's 5-hour session hits a threshold (default 90%), swaps to the
// freshest healthy account — so your NEXT `claude` launch lands on capacity you have not
// spent yet. State lives on disk so it survives a restart. The swap itself is the same
// audited path as a manual one (backup, verify, roll back); this only decides WHEN.
const P = require('./paths');

const DEFAULTS = { enabled: false, target: 'host', threshold: 90 };
// After a rotation, ignore the threshold for a bit: the account we just left is still the
// one on disk for a moment, and usage readings lag, so without this it could swap twice.
const COOLDOWN_MS = 3 * 60 * 1000;

const statePath = () => require('node:path').join(P.dataDir(), 'auto.json');

function load() {
  const raw = P.readJsonIfExists(statePath(), null);
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS, lastSwapAt: 0 };
  return {
    enabled: !!raw.enabled,
    target: typeof raw.target === 'string' ? raw.target : DEFAULTS.target,
    threshold: Number.isFinite(raw.threshold) ? Math.min(100, Math.max(1, raw.threshold)) : DEFAULTS.threshold,
    lastSwapAt: Number(raw.lastSwapAt) || 0,
  };
}

function save(state) {
  try { P.writeJsonAtomic(statePath(), state, 0o600); } catch { /* best effort */ }
  return state;
}

function set({ enabled, target, threshold } = {}) {
  const state = load();
  if (enabled !== undefined) state.enabled = !!enabled;
  if (typeof target === 'string' && target) state.target = target;
  if (Number.isFinite(threshold)) state.threshold = Math.min(100, Math.max(1, threshold));
  return save(state);
}

// A session reading, from cache when fresh. Only shapes with a real percentage count.
function sessionPct(usage, account) {
  const u = usage.cachedFor ? usage.cachedFor(account.id) : null;
  const r = u && u.ok ? u : null;
  return r && r.session && typeof r.session.percent === 'number' ? r.session : null;
}

/**
 * The freshest account worth switching to: swappable (has a token, not expired), not the
 * one we are leaving, and — crucially — below the threshold in BOTH windows, so we never
 * rotate into another nearly-exhausted account. Ranked by 5-hour session, lowest first.
 * Needs a usage map (id -> reading); accounts without one sort last so a known-good low
 * account always wins over an unknown.
 */
/**
 * Every account other than the current one, in rotation order, each saying whether it
 * could be rotated into and — if not — why. Eligible ones first, freshest 5-hour session
 * first among them; an account with no reading sorts last of the eligible (known-good beats
 * unknown). This is what the panel and /swapper-auto show as the queue, so the user can
 * see the whole line, not just its head.
 */
function rank(store, usageMap, excludeId, threshold) {
  const rows = [];
  for (const a of store.list()) {
    if (a.id === excludeId) continue;
    const u = usageMap[a.id];
    const ok = u && u.ok ? u : null;
    const s = ok && ok.session ? ok.session.percent : null;
    const w = ok && ok.weekly ? ok.weekly.percent : null;
    let reason = null;
    if (!a.oauth || !a.oauth.accessToken) reason = 'sin token';
    else if (a.oauth.expiresAt && a.oauth.expiresAt <= Date.now()) reason = 'token caducado';
    // If we know its usage, it must have real headroom in both windows.
    else if (s != null && s >= threshold) reason = `sesión ${s}% ≥ ${threshold}%`;
    else if (w != null && w >= threshold) reason = `semana ${w}% ≥ ${threshold}%`;
    rows.push({ account: a, usage: ok, eligible: !reason, reason, sort: s == null ? 999 : s });
  }
  rows.sort((x, y) => (x.eligible === y.eligible ? x.sort - y.sort : (x.eligible ? -1 : 1)));
  return rows;
}

function pickNext(store, usageMap, targetId, excludeId, threshold) {
  const first = rank(store, usageMap, excludeId, threshold).find((r) => r.eligible);
  return first ? first.account : null;
}

/** What the skill/UI shows: on/off, target, the current account, the next, and the queue. */
async function status(deps) {
  const { store, usage } = deps;
  const state = load();
  const currentId = store.activeFor(state.target);
  const current = currentId ? store.get(currentId) : null;

  // Cheap: cached readings only, no forced API calls, so asking for status never spends budget.
  const usageMap = {};
  for (const a of store.list()) {
    const u = usage.cachedFor ? usage.cachedFor(a.id) : null;
    if (u) usageMap[a.id] = u;
  }
  const curU = current ? usageMap[current.id] : null;
  const ranked = rank(store, usageMap, currentId, state.threshold);
  const nextRow = ranked.find((r) => r.eligible) || null;
  const next = nextRow ? nextRow.account : null;

  const brief = (acc, u) => acc && {
    id: acc.id,
    label: acc.label,
    email: acc.email || null,
    sessionPercent: u && u.ok && u.session ? u.session.percent : null,
    weeklyPercent: u && u.ok && u.weekly ? u.weekly.percent : null,
    sessionResetsAt: u && u.ok && u.session ? (u.session.resetsAt || null) : null,
    weeklyResetsAt: u && u.ok && u.weekly ? (u.weekly.resetsAt || null) : null,
  };

  return {
    enabled: state.enabled,
    target: state.target,
    threshold: state.threshold,
    current: brief(current, curU),
    next: brief(next, next ? usageMap[next.id] : null),
    queue: ranked.map((r) => ({
      ...brief(r.account, usageMap[r.account.id]),
      eligible: r.eligible,
      reason: r.reason,
      role: next && r.account.id === next.id ? 'next' : '',
    })),
  };
}

/**
 * One rotation check. Cheap when nothing is due: it reads the active account's usage
 * (cache-gated, so a real API call only every ~15 min) and returns early unless it has
 * genuinely crossed the threshold. Only when it swaps does it spend more — a sweep to rank
 * the candidates. Returns a description of what it did, or null.
 */
async function tick(deps) {
  const { store, usage, swap } = deps;
  const state = load();
  if (!state.enabled) return null;
  if (Date.now() - state.lastSwapAt < COOLDOWN_MS) return null;
  // A detached file mount (paths.js) cannot be written: without this every tick would spend
  // usage calls ranking a successor only to be refused, 3 minutes apart, until a restart.
  const tg = swap.asTarget ? swap.asTarget(state.target) : null;
  if (tg && P.isDetachedMount(tg.claudeJsonPath)) return { rotated: false, reason: 'montaje desprendido: reinicia el contenedor' };

  const currentId = store.activeFor(state.target);
  if (!currentId) return null;
  const current = store.get(currentId);
  if (!current || !current.oauth) return null;

  let reading;
  try {
    reading = await usage.fetchFor(current, {});
  } catch {
    return null; // network/rate trouble: try again next tick
  }
  if (!reading || !reading.ok || !reading.session || typeof reading.session.percent !== 'number') return null;
  if (reading.session.percent < state.threshold) return null;

  // Threshold crossed. Now (and only now) rank the others against fresh readings.
  const others = store.list().filter((a) => a.id !== currentId);
  const usageMap = {};
  try {
    const all = await usage.fetchAll(others, {});
    for (const [id, u] of Object.entries(all)) usageMap[id] = u;
  } catch { /* fall back to whatever cache we have */ }
  for (const a of others) {
    if (!usageMap[a.id] && usage.cachedFor) { const c = usage.cachedFor(a.id); if (c) usageMap[a.id] = c; }
  }

  const next = pickNext(store, usageMap, state.target, currentId, state.threshold);
  if (!next) return { rotated: false, reason: 'sin cuenta con margen bajo el umbral' };
  if (next.id === currentId) return null;

  await swap.swapTo(next.id, deps, state.target);
  state.lastSwapAt = Date.now();
  save(state);
  return { rotated: true, from: current.label, to: next.label, at: reading.session.percent, target: state.target };
}

module.exports = { DEFAULTS, COOLDOWN_MS, load, save, set, pickNext, status, tick };

if (require.main === module) {
  const assert = require('node:assert');

  // pickNext: lowest session wins, threshold-full and expired excluded, current excluded.
  const fakeStore = {
    _a: [
      { id: 'cur', oauth: { accessToken: 't', expiresAt: Date.now() + 1e6 } },
      { id: 'full', oauth: { accessToken: 't', expiresAt: Date.now() + 1e6 } },
      { id: 'low', oauth: { accessToken: 't', expiresAt: Date.now() + 1e6 } },
      { id: 'mid', oauth: { accessToken: 't', expiresAt: Date.now() + 1e6 } },
      { id: 'dead', oauth: { accessToken: 't', expiresAt: Date.now() - 1 } },
      { id: 'weekfull', oauth: { accessToken: 't', expiresAt: Date.now() + 1e6 } },
    ],
    list() { return this._a; },
  };
  const um = {
    cur: { ok: true, session: { percent: 95 }, weekly: { percent: 10 } },
    full: { ok: true, session: { percent: 92 }, weekly: { percent: 10 } },
    low: { ok: true, session: { percent: 5 }, weekly: { percent: 20 } },
    mid: { ok: true, session: { percent: 40 }, weekly: { percent: 20 } },
    dead: { ok: true, session: { percent: 1 }, weekly: { percent: 1 } },
    weekfull: { ok: true, session: { percent: 3 }, weekly: { percent: 96 } },
  };
  const next = pickNext(fakeStore, um, 'host', 'cur', 90);
  assert.strictEqual(next.id, 'low', 'picks the lowest-session healthy account');

  // An account with no reading still qualifies (sorts last) when nothing better is known.
  const next2 = pickNext({ list: () => [
    { id: 'cur', oauth: { accessToken: 't' } },
    { id: 'unknown', oauth: { accessToken: 't' } },
  ] }, {}, 'host', 'cur', 90);
  assert.strictEqual(next2.id, 'unknown');

  // rank(): the whole queue, eligible first (freshest session first), then the excluded
  // ones each naming why — that is what /swapper-auto lists.
  const ranked = rank(fakeStore, um, 'cur', 90);
  // The excluded keep the same session ordering among themselves (dead 1%, weekfull 3%,
  // full 92%), so the list reads as one ladder rather than two.
  assert.deepStrictEqual(ranked.map((r) => r.account.id), ['low', 'mid', 'dead', 'weekfull', 'full'],
    'eligible by session asc, then the excluded by session asc');
  const why = Object.fromEntries(ranked.map((r) => [r.account.id, r.reason]));
  assert.strictEqual(why.low, null);
  assert.match(why.full, /sesión 92% ≥ 90%/);
  assert.strictEqual(why.dead, 'token caducado');
  assert.match(why.weekfull, /semana 96% ≥ 90%/);
  assert.ok(!ranked.some((r) => r.account.id === 'cur'), 'the current account is not in its own queue');

  // Everyone full -> nothing to rotate into.
  const none = pickNext(fakeStore, { cur: um.cur, full: um.full, low: { ok: true, session: { percent: 91 }, weekly: { percent: 10 } }, mid: { ok: true, session: { percent: 90 }, weekly: { percent: 10 } }, dead: um.dead, weekfull: um.weekfull }, 'host', 'cur', 90);
  assert.strictEqual(none, null, 'no account below threshold -> null');

  console.log('auto.js self-check OK');
}
