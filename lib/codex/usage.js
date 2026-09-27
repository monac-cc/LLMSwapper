'use strict';
// Codex quota: the endpoint Codex's own /status reads, flattened into the same NormalizedUsage the
// Claude meters render. Measured from Node: 200 in ~400 ms, no challenge, costs nothing. Nothing
// here shares the Claude usage module's rate floor - different endpoint, different limits.
const path = require('node:path');
const P = require('../paths');
const { scrub } = require('../oauth');
const { meter } = require('../usage');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const HEADERS = { 'User-Agent': 'codex_cli_rs/0.157.1 (LLMSwapper)', originator: 'codex_cli_rs', Accept: 'application/json' };

const CACHE_MS = 4 * 60 * 1000;
// ponytail: a fixed trickle between calls, not a budget; add one if the endpoint ever starts
// answering 429 to a sweep.
const GAP_MS = 3000;
const BACKOFF_MS = 10 * 60 * 1000;

// Last good reading per account, plus the 429 backoff. Percentages only, no tokens, so it is safe
// on disk, and persisting it means a restart during a backoff neither blanks the meters nor walks
// straight back into the 429. Loaded on first use: the path depends on P.dataDir at call time.
const cachePath = () => path.join(P.dataDir(), 'codex', 'usage-cache.json');
const RATE_KEY = '__rate';
const cache = new Map(); // id -> { at, value }
let loaded = false;
let backoffUntil = 0;
let lastRequestAt = 0;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = P.readJsonIfExists(cachePath(), null) || {};
    for (const [id, entry] of Object.entries(raw)) {
      if (id === RATE_KEY) backoffUntil = Number(entry && entry.backoffUntil) || 0;
      else if (entry && entry.at && entry.value) cache.set(id, entry);
    }
  } catch { /* a corrupt cache starts cold */ }
}

function persist() {
  try {
    P.writeJsonAtomic(cachePath(), { ...Object.fromEntries(cache), [RATE_KEY]: { backoffUntil } }, 0o600);
  } catch { /* not worth failing a reading over */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One queue for every caller, so two browser tabs sweeping at once still go out one by one.
let queue = Promise.resolve();
function waitTurn() {
  queue = queue.then(async () => {
    const wait = GAP_MS - (Date.now() - lastRequestAt);
    if (lastRequestAt && wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  return queue;
}

/**
 * One direct call, never cached - the swap verifies a new token with it. Throws an Error with
 * .status (0 on network trouble). A 429 arms the backoff even when the swap was the caller.
 */
async function fetchRaw(account) {
  ensureLoaded();
  lastRequestAt = Date.now();
  const o = account.oauth || {};
  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${o.accessToken}`, 'ChatGPT-Account-ID': o.accountId || account.accountId, ...HEADERS },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const e = new Error(`No se pudo contactar con chatgpt.com para leer el uso: ${scrub(err.message)}`);
    e.status = 0;
    throw e;
  }
  const text = await res.text();
  if (!res.ok) {
    // chatgpt.com sits behind Cloudflare, and its bot challenge is a 403 too - an HTML page about
    // the CLIENT, not the token. Read as a 403 it would mark a healthy account "sign in again" and
    // roll back a good swap, so it is reported like a network failure: stale numbers, a warning.
    const challenge = res.status === 403
      && (!!(res.headers && res.headers.get && res.headers.get('cf-mitigated')) || /^\s*</.test(text));
    const e = new Error(challenge
      ? 'chatgpt.com respondió con una verificación anti-bot (Cloudflare) en vez del uso; se reintentará'
      : res.status === 429
        ? 'chatgpt.com está limitando las consultas de uso (429)'
        : `chatgpt.com devolvió ${res.status} al leer el uso: ${scrub(text).slice(0, 200)}`);
    e.status = challenge ? 0 : res.status;
    if (res.status === 429) { backoffUntil = Date.now() + BACKOFF_MS; persist(); }
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error('chatgpt.com devolvió un uso que no es JSON');
    e.status = res.status;
    throw e;
  }
}

function resetOf(w) {
  if (Number.isFinite(Number(w.reset_at)) && w.reset_at) return new Date(Number(w.reset_at) * 1000).toISOString();
  if (Number.isFinite(Number(w.reset_after_seconds)) && w.reset_after_seconds != null) {
    return new Date(Date.now() + Number(w.reset_after_seconds) * 1000).toISOString();
  }
  return null;
}

/**
 * Windows are told apart by their length, not their slot: <= 6 h is the session, >= 6 days the
 * week. Only a window that says neither falls back to position (primary session, secondary week).
 */
function normalize(raw, id) {
  const rl = (raw && raw.rate_limit) || {};
  const wins = [rl.primary_window, rl.secondary_window].filter((w) => w && typeof w === 'object');
  const len = (w) => Number(w.limit_window_seconds);
  let session = wins.find((w) => len(w) <= 6 * 3600) || null;
  let weekly = wins.find((w) => len(w) >= 6 * 86400) || null;
  if (!session && rl.primary_window && rl.primary_window !== weekly) session = rl.primary_window;
  if (!weekly && rl.secondary_window && rl.secondary_window !== session) weekly = rl.secondary_window;
  // A window the response does not carry is unknown ('-'), not 0% - which would also rank the
  // account as the least used.
  const toMeter = (w) => (w ? meter(w.used_percent, resetOf(w)) : null);
  return {
    id,
    ok: true,
    fetchedAt: Date.now(),
    session: toMeter(session),
    weekly: toMeter(weekly),
    scoped: [],
    opus: null,
    extraUsage: null,
    locked: rl.limit_reached ? { reason: 'limit_reached' } : null,
  };
}

const staleOf = (hit, reason) => ({ ...hit.value, stale: true, staleSince: hit.at, staleReason: reason });

// Injected by swap.js (it requires this module, so requiring it back would be a cycle): refreshes
// or adopts an access token past its exp before it is sent here to fail.
let ensureFresh = null;
const setEnsureFresh = (fn) => { ensureFresh = fn; };

/** Never throws: a dead account renders as an error row, it does not break the page. */
async function fetchFor(account, { force = false } = {}) {
  ensureLoaded();
  const id = account.id;
  // A refresh token OpenAI refused outranks any cached or stale reading: the row must say "sign
  // in again". ensureFresh adopts a newer pair a Codex may hold, and throws when there is none.
  if (account.dead && ensureFresh) {
    try {
      account = await ensureFresh(account);
    } catch (err) {
      return { id, ok: false, status: err.status || 401, needsRelogin: !!err.permanent, error: scrub(err.message) };
    }
  }
  const hit = cache.get(id);
  if (hit && !force && Date.now() - hit.at < CACHE_MS) return hit.value;

  if (Date.now() < backoffUntil) {
    const waitS = Math.ceil((backoffUntil - Date.now()) / 1000);
    if (hit) return staleOf(hit, 'rate-limited');
    return {
      id, ok: false, status: 429, rateLimited: true, needsRelogin: false, retryInS: waitS,
      error: `Uso no disponible: chatgpt.com limita las consultas. Reintento en ${Math.ceil(waitS / 60)} min. El swap sigue funcionando.`,
    };
  }

  let acc = account;
  if (ensureFresh) {
    try {
      acc = await ensureFresh(account);
    } catch (err) {
      const error = scrub(err.message);
      if (err.permanent) return { id, ok: false, status: err.status || 401, needsRelogin: true, error };
      return hit ? staleOf(hit, error) : { id, ok: false, status: err.status || 0, needsRelogin: false, error };
    }
  }

  await waitTurn();
  try {
    const value = normalize(await fetchRaw(acc), id);
    cache.set(id, { at: Date.now(), value });
    persist();
    return value;
  } catch (err) {
    const status = err.status || 0;
    const error = scrub(err.message);
    if (status === 401 || status === 403) {
      return { id, ok: false, status, needsRelogin: true, error: `${error}. Vuelve a iniciar sesión con esta cuenta en Codex e impórtala.` };
    }
    if (status === 429) {
      return hit ? staleOf(hit, 'rate-limited') : { id, ok: false, status, rateLimited: true, needsRelogin: false, error };
    }
    return hit ? staleOf(hit, error) : { id, ok: false, status, needsRelogin: false, error };
  }
}

/** Sequential on purpose: a sweep is a trickle, never a burst. */
async function fetchAll(accounts, opts) {
  const out = {};
  for (const a of accounts || []) {
    try {
      out[a.id] = await fetchFor(a, opts);
    } catch (err) {
      out[a.id] = { id: a.id, ok: false, status: 0, needsRelogin: false, error: scrub(err && err.message) || 'Fallo desconocido' };
    }
  }
  return out;
}

const cachedFor = (id) => { ensureLoaded(); const hit = cache.get(id); return hit ? hit.value : null; };

/** Donate a reading the swap already paid for, so the UI does not ask again. */
function prime(id, value, at = Date.now()) {
  ensureLoaded();
  if (!value || !value.ok) return value;
  cache.set(id, { at, value });
  persist();
  return value;
}

function invalidate(id) {
  ensureLoaded();
  if (id) cache.delete(id); else cache.clear();
}

// For tests: lift the backoff and the gap without waiting for them.
const resetCooldown = () => { ensureLoaded(); backoffUntil = 0; lastRequestAt = 0; persist(); };

module.exports = {
  USAGE_URL, CACHE_MS, GAP_MS, BACKOFF_MS,
  fetchRaw, normalize, fetchFor, fetchAll, cachedFor, prime, invalidate, setEnsureFresh, resetCooldown,
};

if (require.main === module) {
  const assert = require('node:assert');
  const t = Math.floor(Date.now() / 1000);
  // The shape measured live: primary 5 h, secondary weekly.
  const verified = { plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: t + 100 },
    secondary_window: { used_percent: 97, limit_window_seconds: 604800, reset_after_seconds: 200, reset_at: t + 200 } } };
  const a = normalize(verified, 'x');
  assert.strictEqual(a.session.percent, 12);
  assert.strictEqual(a.weekly.percent, 97);
  assert.strictEqual(a.weekly.severity, 'critical');
  assert.strictEqual(a.session.resetsAt, new Date((t + 100) * 1000).toISOString());
  assert.strictEqual(a.locked, null);
  assert.deepStrictEqual(a.scoped, []);
  // reset_after_seconds alone still gives a countdown.
  const b = normalize({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 60 } } }, 'y');
  assert.ok(Math.abs(Date.parse(b.session.resetsAt) - (Date.now() + 60000)) < 2000);
  // A missing window is unknown, not 0%.
  const c = normalize({}, 'z');
  assert.strictEqual(c.session, null);
  assert.strictEqual(c.weekly, null);
  assert.strictEqual(normalize({ rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 18000 } } }, 'z').weekly, null);
  assert.deepStrictEqual(normalize({ rate_limit: { limit_reached: true } }, 'z').locked, { reason: 'limit_reached' });
  console.log('codex/usage.js self-check OK');
}
