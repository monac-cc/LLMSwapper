'use strict';
// Reads the same endpoint Claude Code's /usage command uses, and flattens it into
// one shape the UI can render without knowing anything about Anthropic's API.
const { API_HEADERS, scrub } = require('./oauth');
// Only for canReadUsage. The rule lives in store.js so swap.js, usage.js and the HTTP layer
// cannot drift apart about which accounts may be asked; a duplicated predicate is how two of
// them end up disagreeing six months from now.
const store = require('./store');
const P = require('./paths');
const path = require('node:path');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Measured against the live endpoint: the FIFTH request in quick succession returns 429
// with Retry-After: 300, and the penalty escalates to ~3600s if you keep hitting it.
// So the budget is roughly 5 requests per 5 minutes for the whole app, regardless of how
// many accounts are configured.
//
// Tuning frequency alone cannot hold that: a sweep of N accounts costs N requests, so
// enough accounts blows the budget on a single refresh. Instead there is one hard floor
// on the outbound rate, below, and everything else degrades to cached values around it.
const CACHE_MS = 4 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

// The gap between ANY two outbound calls. What matters is not the average rate but how
// many calls fit in the endpoint's 5-minute window: with a gap of g that is
// floor(300/g) + 1, so the old 70s allowed 0/70/140/210/280 - five calls, exactly the
// fifth one the endpoint punishes. It needs 4*g >= 300s; 80s leaves four per window
// with room to spare. This is the single mechanism that bounds our request rate.
const MIN_GAP_MS = 80 * 1000;
let lastRequestAt = 0;
let consecutive429 = 0;

// Last KNOWN-GOOD reading per account. Deliberately never cleared on error: when the
// endpoint rate-limits us it is far better to show slightly old numbers marked as stale
// than to blank the row and lose the only thing the dashboard exists to display.
const cache = new Map(); // id -> { at, value }
// When each account last ATTEMPTED a call, successful or not. cache.at only advances on
// success, so an account with a dead token would sit at 0 for ever, win the stalest-first
// ordering in every sweep, and starve every healthy account of the single available slot.
const lastTry = new Map(); // id -> ms
// The 429 is account-independent (it is our IP/token hitting the endpoint too often),
// so the cooldown is global. While it holds, we do not call the API at all.
let cooldownUntil = 0;

// Percentages only - no tokens - so this is safe to keep on disk. Persisting it means a
// restart during a rate-limit window still shows numbers instead of empty rows, and the
// cooldown itself rides along: kept only in memory, closing the window and reopening it
// walked straight back into the 429, and the escalating backoff never got past its first
// step. Account ids are `acc_<hex>`, so `__rate` cannot collide with one.
const cachePath = () => path.join(P.dataDir(), 'usage-cache.json');
const RATE_KEY = '__rate';

function loadCache() {
  const raw = P.readJsonIfExists(cachePath(), null);
  if (!raw || typeof raw !== 'object') return;
  for (const [id, entry] of Object.entries(raw)) {
    if (id === RATE_KEY) {
      if (entry && typeof entry === 'object') {
        cooldownUntil = Number(entry.cooldownUntil) || 0;
        consecutive429 = Number(entry.consecutive429) || 0;
        // A timestamp in the future (clock change, edited file) would gate every request
        // until it passed, so it is not allowed to be newer than now.
        lastRequestAt = Math.min(Number(entry.lastRequestAt) || 0, Date.now());
      }
      continue;
    }
    if (entry && entry.at && entry.value) cache.set(id, entry);
  }
}

function persistCache() {
  try {
    P.writeJsonAtomic(cachePath(), {
      ...Object.fromEntries(cache),
      [RATE_KEY]: { cooldownUntil, consecutive429, lastRequestAt },
    }, 0o600);
  } catch { /* a cache that cannot be written is not worth failing a request over */ }
}

try { loadCache(); } catch { /* corrupt cache file: start cold rather than crash */ }

/** The 429 penalty escalates with repeat offences, so the backoff doubles with it. */
function armCooldown(retryAfterMs) {
  consecutive429 += 1;
  const escalated = DEFAULT_COOLDOWN_MS * Math.pow(2, consecutive429 - 1);
  cooldownUntil = Date.now() + Math.min(MAX_COOLDOWN_MS, Math.max(retryAfterMs || 0, escalated));
  persistCache();
}

/**
 * Every outbound call to the usage endpoint goes through here, so this is where the rate
 * floor and the cooldown are BOOKKEPT - not in fetchFor. The swap verifies a new token by
 * calling fetchRaw directly (it must not be served a cached reading), and while that call
 * was uncounted a handful of swaps could spend the whole budget invisibly, and a 429 they
 * provoked never armed the cooldown. fetchRaw still never blocks: the swap has to be able
 * to verify a token even mid-cooldown. It just stops being free.
 */
async function fetchRaw(accessToken) {
  lastRequestAt = Date.now();
  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, ...API_HEADERS },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const e = new Error(`No se pudo contactar con la API de uso: ${scrub(err.message)}`);
    e.status = 0;
    throw e;
  }
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(res.status === 429
      ? 'La API de uso está limitando las peticiones (429)'
      : `La API de uso devolvió ${res.status}: ${scrub(text).slice(0, 200)}`);
    e.status = res.status;
    const retryAfter = Number(res.headers.get('retry-after'));
    e.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
    if (res.status === 429) armCooldown(e.retryAfterMs);
    throw e;
  }
  consecutive429 = 0;
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error('La API de uso devolvió una respuesta que no es JSON');
    e.status = res.status;
    throw e;
  }
}

/* ---------------- second source: quota out of the rate-limit headers ----------------
 *
 * An inference-only token (what `claude setup-token` mints) is answered 403 by
 * /api/oauth/usage for ever, so for those accounts the quota has to come from somewhere else.
 * Anthropic reports it on every /v1/messages response, in the anthropic-ratelimit-unified-*
 * headers - and those do not care about scopes, because the call IS inference.
 *
 * Measured, endpoint by endpoint, before settling on this one:
 *
 *     POST /v1/messages/count_tokens   200, no rate-limit headers
 *     GET  /v1/models                  200, no rate-limit headers
 *     POST /v1/messages                200, and the full set
 *
 * The free ones say nothing about quota, so something has to be spent. The floor is Haiku,
 * max_tokens 1 and a one-character prompt: 8 input tokens and 1 output token per probe. That
 * is not zero - unlike the profile-endpoint route, which costs literally nothing - but against
 * a five-hour window it is noise. It is stated plainly rather than hidden because it is the
 * user's own subscription being spent.
 */
const PROBE_URL = 'https://api.anthropic.com/v1/messages';
const PROBE_MODEL = 'claude-haiku-4-5-20251001';
// A different endpoint with its own, far looser limit than /api/oauth/usage, so it does NOT
// share MIN_GAP_MS - routing it through that floor would make probe accounts and usage-endpoint
// accounts fight over the same four slots per five minutes for no reason. A short gap is still
// kept so a sweep of many accounts goes out as a trickle rather than a burst.
const PROBE_GAP_MS = 2000;
let lastProbeAt = 0;

/**
 * The unified rate-limit headers, or null when the response carried none.
 * utilization arrives as a fraction (0.87), reset as unix SECONDS - both are converted to the
 * shapes the rest of this file already speaks: percent 0-100, and an ISO timestamp.
 */
function readUnifiedHeaders(h) {
  if (!h || h.get('anthropic-ratelimit-unified-status') === null) return null;
  const num = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const iso = (secs) => (secs === null ? null : new Date(secs * 1000).toISOString());

  const windows = {};
  // The headers say 5h and 7d; everything else in this project says session and weekly.
  for (const [header, name] of [['5h', 'session'], ['7d', 'weekly']]) {
    const util = num(h.get(`anthropic-ratelimit-unified-${header}-utilization`));
    const reset = num(h.get(`anthropic-ratelimit-unified-${header}-reset`));
    if (util === null && reset === null) continue;
    windows[name] = { percent: util === null ? null : util * 100, resetsAt: iso(reset) };
  }
  return {
    status: h.get('anthropic-ratelimit-unified-status'),
    windows,
    representative: h.get('anthropic-ratelimit-unified-representative-claim'),
  };
}

/**
 * One probe. Throws on network trouble or a dead credential; a thrown 401/403 means the token
 * itself is finished, which is a different thing from being out of quota and must not be
 * reported as "at 100%".
 */
async function probeRaw(accessToken) {
  const wait = PROBE_GAP_MS - (Date.now() - lastProbeAt);
  if (lastProbeAt && wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastProbeAt = Date.now();

  let res;
  try {
    res = await fetch(PROBE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const e = new Error(`No se pudo sondear la cuota: ${scrub(err.message)}`);
    e.status = 0;
    throw e;
  }

  if (res.status === 401 || res.status === 403) {
    const e = new Error('Anthropic rechaza este token - no es que esté sin cuota, es que ya no vale');
    e.status = res.status;
    throw e;
  }

  // A 429 IS the answer, not a failure: the headers on it still describe the windows. Only fall
  // over when there is nothing to read.
  const info = readUnifiedHeaders(res.headers);
  if (info === null) {
    const e = new Error(`La respuesta no traía cabeceras de cuota (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return info;
}

/** Header info -> the exact shape normalize() produces, so the UI cannot tell the two apart. */
function normalizeProbe(info, id) {
  const win = (name) => {
    const w = info.windows[name];
    return w ? meter(w.percent, w.resetsAt) : meter(null, null);
  };
  return {
    id,
    ok: true,
    fetchedAt: Date.now(),
    session: win('session'),
    weekly: win('weekly'),
    scoped: [],
    opus: null,
    extraUsage: null,
    // Deliberately never set from the probe. The only non-healthy value these headers carry is
    // "rejected", which means the window is spent - exactly what the meter beside it already
    // shows as 100%, and saying it twice in worse words helps nobody. The usage endpoint's real
    // locked_reason (imported accounts) still comes through normalize().
    locked: null,
    // Lets the UI say where the numbers came from, and that they cost a token or two.
    viaProbe: true,
  };
}

// Computed here rather than trusting the server string, so the API and the CSS agree.
function severityFor(percent) {
  if (percent == null) return 'unknown';
  if (percent >= 95) return 'critical';
  if (percent >= 80) return 'high';
  if (percent >= 50) return 'medium';
  return 'normal';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 10) / 10)) : null;
}

function meter(percent, resetsAt) {
  const p = num(percent);
  return { percent: p == null ? 0 : p, resetsAt: resetsAt || null, severity: severityFor(p) };
}

function fromLegacy(block) {
  if (!block || typeof block !== 'object') return null;
  return meter(block.utilization, block.resets_at);
}

/**
 * limits[] is the source of truth; the top-level five_hour/seven_day keys are legacy
 * mirrors kept as a fallback so an account on an older API shape still renders.
 */
function normalize(raw, id) {
  const limits = Array.isArray(raw && raw.limits) ? raw.limits : [];
  const byKind = (kind) => limits.find((l) => l && l.kind === kind) || null;

  const sessionLimit = byKind('session');
  const weeklyLimit = byKind('weekly_all');

  const session = sessionLimit
    ? meter(sessionLimit.percent, sessionLimit.resets_at)
    : fromLegacy(raw && raw.five_hour) || meter(null, null);

  const weekly = weeklyLimit
    ? meter(weeklyLimit.percent, weeklyLimit.resets_at)
    : fromLegacy(raw && raw.seven_day) || meter(null, null);

  const scoped = limits
    .filter((l) => l && l.kind === 'weekly_scoped')
    .map((l) => {
      const s = l.scope || {};
      const label = (s.model && s.model.display_name) || s.surface || 'Otro';
      return { label, percent: num(l.percent) ?? 0, resetsAt: l.resets_at || null, severity: severityFor(num(l.percent)) };
    });

  const opus = fromLegacy(raw && raw.seven_day_opus);

  const eu = (raw && raw.extra_usage) || null;
  const extraUsage = eu ? { enabled: !!eu.is_enabled, percent: num(eu.utilization) ?? 0 } : null;

  const locked =
    (sessionLimit && sessionLimit.locked_reason) ||
    (raw && raw.five_hour && raw.five_hour.locked_reason) ||
    null;

  return { id, ok: true, fetchedAt: Date.now(), session, weekly, scoped, opus, extraUsage, locked };
}

/** Last good reading, re-labelled as stale so the UI can show it honestly. */
function staleOf(hit, reason) {
  return { ...hit.value, stale: true, staleSince: hit.at, staleReason: reason };
}

/** Never throws - a dead account renders as an error row, it does not break the page. */
// Accounts a FORCED refresh wanted but the rate floor turned away. They keep that intent
// across sweeps: the next sweep skips their cache and fetches them, then drops them here.
// Without this a manual refresh only ever renewed ONE account (the floor lets one call
// through per sweep) and the rest sat stale until the 10-minute poll — with four accounts,
// forty minutes to see fresh numbers on all of them. The frontend chains a re-poll after
// the floor lifts (retryInS below), and this set is what makes that chain converge: it
// ends exactly when nothing is pending, and never re-fetches an account already fresh.
const pendingForce = new Set();

async function fetchFor(account, { force = false } = {}) {
  const id = account.id;

  const hit = cache.get(id);
  const wantsFresh = force || pendingForce.has(id);
  if (hit && !wantsFresh && Date.now() - hit.at < CACHE_MS) return hit.value;
  // Fetched within the last floor window: refetching would spend a call to learn nothing.
  if (hit && wantsFresh && Date.now() - hit.at < MIN_GAP_MS) { pendingForce.delete(id); return hit.value; }

  const token = account.oauth && account.oauth.accessToken;
  if (!token) {
    return { id, ok: false, error: 'Esta cuenta no tiene token guardado', status: 0, needsRelogin: true };
  }

  // TWO SOURCES, and which one applies is a property of the token, not a preference.
  //
  // store.canReadUsage is true only when the scopes explicitly include user:profile, or when
  // there are no scopes at all - an account stored before this mattered, which came from a full
  // interactive login. Nothing is guessed in the direction that would hurt: a pasted token is
  // always stored WITH its scopes.
  //
  // An inference-only token must NEVER be sent to /api/oauth/usage. That endpoint answers it 403
  // permanently, not transiently; a 403 is not a 429, so armCooldown never fires and nothing
  // absorbs it, and the request would repeat on every sweep - spending the shared budget of
  // roughly five calls per five minutes on a guaranteed failure and starving the accounts that
  // CAN answer. It goes to the header probe instead, on a different endpoint with its own limit.
  if (!store.canReadUsage(account)) {
    lastTry.set(id, Date.now());
    try {
      const value = normalizeProbe(await probeRaw(token), id);
      cache.set(id, { at: Date.now(), value });
      pendingForce.delete(id);
      persistCache();
      return value;
    } catch (err) {
      const status = err.status || 0;
      // Same rule as the other source: stale numbers beat no numbers, unless the token is dead.
      if (hit && status !== 401 && status !== 403) return staleOf(hit, scrub(err.message));
      return { id, ok: false, error: scrub(err.message), status, needsRelogin: status === 401 || status === 403 };
    }
  }

  // Hard rate floor. Even a user hammering refresh cannot exceed it: callers get the
  // cached value, or a "waiting its turn" marker, instead of another outbound request.
  const sinceLast = Date.now() - lastRequestAt;
  if (lastRequestAt && sinceLast < MIN_GAP_MS && Date.now() >= cooldownUntil) {
    const waitS = Math.ceil((MIN_GAP_MS - sinceLast) / 1000);
    if (hit) {
      // Queued WITH a cached value: hand back the old numbers, but carry retryInS so the
      // frontend re-polls once the floor lifts, and remember the intent so that poll fetches.
      if (wantsFresh) pendingForce.add(id);
      return { ...staleOf(hit, `en cola, turno en ${waitS}s`), queued: true, retryInS: waitS };
    }
    return {
      id, ok: false, status: 0, needsRelogin: false, throttled: true, retryInS: waitS,
      error: `En cola para consultar el uso (${waitS}s). El swap sigue funcionando.`,
    };
  }

  // Under an active cooldown, do not touch the API - that is what caused the 429.
  if (Date.now() < cooldownUntil) {
    const waitS = Math.ceil((cooldownUntil - Date.now()) / 1000);
    const pretty = waitS >= 90 ? `${Math.ceil(waitS / 60)} min` : `${waitS}s`;
    // No retryInS here on purpose: a 429 is never auto-chained. The intent survives, so the
    // first poll after the cooldown fetches it.
    if (wantsFresh) pendingForce.add(id);
    if (hit) return staleOf(hit, `rate limit, reintento en ${pretty}`);
    return {
      id, ok: false, status: 429, needsRelogin: false, retryInS: waitS, rateLimited: true,
      error: `Uso no disponible: la API limita las consultas. Reintento en ${pretty}. El swap sigue funcionando.`,
    };
  }

  // Claiming the turn BEFORE the call, so a failure still counts as this account's go.
  // fetchRaw owns lastRequestAt and the cooldown; this map only decides whose turn is next.
  lastTry.set(id, Date.now());
  try {
    const value = normalize(await fetchRaw(token), id);
    cache.set(id, { at: Date.now(), value });
    pendingForce.delete(id);
    persistCache();
    return value;
  } catch (err) {
    const status = err.status || 0;
    // Stale numbers beat no numbers, except when the token itself is dead.
    if (hit && status !== 401 && status !== 403) return staleOf(hit, scrub(err.message));
    return { id, ok: false, error: scrub(err.message), status, needsRelogin: status === 401 || status === 403 };
  }
}

/**
 * Sequential on purpose: N accounts firing at once is a burst this endpoint punishes.
 * Stalest first, because the rate floor means only one or two calls actually get through
 * per sweep - the slot must go to whichever account needs it most, or a fixed list order
 * would refresh the first account forever and starve the rest.
 *
 * "Stalest" counts the last ATTEMPT, not the last success. Ranking by success alone let a
 * single account with a dead token stay at zero and win every sweep for ever, so the
 * healthy accounts never got a reading at all.
 */
const lastSeenAt = (id) => Math.max(((cache.get(id) || {}).at) || 0, lastTry.get(id) || 0);

async function fetchAll(accounts, opts) {
  const list = [...(accounts || [])].sort((a, b) => lastSeenAt(a.id) - lastSeenAt(b.id));
  const settled = [];
  for (const a of list) {
    settled.push(await fetchFor(a, opts).then((v) => ({ status: 'fulfilled', value: v }),
      (e) => ({ status: 'rejected', reason: e })));
  }
  const out = {};
  settled.forEach((r, i) => {
    const id = list[i].id;
    out[id] = r.status === 'fulfilled'
      ? r.value
      : { id, ok: false, error: scrub(r.reason && r.reason.message) || 'Fallo desconocido', status: 0, needsRelogin: false };
  });
  return out;
}

function invalidate(id) {
  if (id) { cache.delete(id); lastTry.delete(id); pendingForce.delete(id); return; }
  cache.clear();
  lastTry.clear();
  pendingForce.clear();
  lastProbeAt = 0;
}

/**
 * Donate a reading someone else already paid an API call for (the swap fetches usage
 * to verify the new token). Without this the UI would immediately spend a second call
 * for data it was just handed - request amplification is what triggers the 429.
 */
// `at` lets a caller stamp the reading with a specific time; tests use it to age a cache
// past the rate floor without waiting 80 real seconds.
function prime(id, value, at = Date.now()) {
  if (!value || !value.ok) return value;
  cache.set(id, { at, value });
  persistCache();
  return value;
}
const cooldownRemainingMs = () => Math.max(0, cooldownUntil - Date.now());
// Persists too: the cooldown now lives on disk, so clearing it only in memory would leave
// a stale one behind for the next process (and for the next test run).
const resetCooldown = () => { cooldownUntil = 0; consecutive429 = 0; lastRequestAt = 0; persistCache(); };

// Peek the last known reading for an account WITHOUT touching the API — for callers that
// want to rank on what is already known (auto-rotation) without spending the rate budget.
const cachedFor = (id) => { const hit = cache.get(id); return hit ? hit.value : null; };

module.exports = {
  USAGE_URL, CACHE_MS, fetchRaw, normalize, fetchFor, fetchAll,
  PROBE_URL, PROBE_MODEL, probeRaw, readUnifiedHeaders, normalizeProbe,
  invalidate, prime, severityFor, cooldownRemainingMs, resetCooldown, MIN_GAP_MS, cachedFor,
  // Reused by lib/codex/usage.js, so both providers render with the same meters.
  meter, num,
};

if (require.main === module) {
  const assert = require('node:assert');

  const verified = {
    five_hour: { utilization: 90.0, resets_at: '2026-08-31T15:00:00Z', locked_reason: null },
    seven_day: { utilization: 28.0, resets_at: '2026-09-06T16:00:00Z' },
    seven_day_opus: null,
    extra_usage: { is_enabled: false },
    limits: [
      { kind: 'session', group: 'session', percent: 90, severity: 'critical', resets_at: '2026-08-31T15:00:00Z', scope: null, is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 28, severity: 'normal', resets_at: '2026-09-06T16:00:00Z', scope: null, is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 18, severity: 'normal', resets_at: '2026-09-06T16:00:00Z', scope: { model: { id: null, display_name: 'Fable' } } },
    ],
  };
  const a = normalize(verified, 'x');
  assert.strictEqual(a.session.percent, 90);
  assert.strictEqual(a.session.severity, 'high');
  assert.strictEqual(a.weekly.percent, 28);
  assert.strictEqual(a.weekly.severity, 'normal');
  assert.strictEqual(a.scoped.length, 1);
  assert.strictEqual(a.scoped[0].label, 'Fable');

  // Legacy shape: no limits[], data only in the top-level mirrors.
  const b = normalize({ five_hour: { utilization: 55, resets_at: 'T' }, seven_day: { utilization: 96, resets_at: 'T2' }, limits: [] }, 'y');
  assert.strictEqual(b.session.percent, 55);
  assert.strictEqual(b.session.severity, 'medium');
  assert.strictEqual(b.weekly.severity, 'critical');

  // Nothing at all must still render as zeros, never NaN.
  const c = normalize({ five_hour: null, seven_day: null, limits: null, extra_usage: null }, 'z');
  assert.strictEqual(c.session.percent, 0);
  assert.strictEqual(c.weekly.percent, 0);
  assert.deepStrictEqual(c.scoped, []);
  assert.strictEqual(c.extraUsage, null);

  // Threshold boundaries land on the documented side.
  assert.strictEqual(severityFor(49.9), 'normal');
  assert.strictEqual(severityFor(50), 'medium');
  assert.strictEqual(severityFor(79.9), 'medium');
  assert.strictEqual(severityFor(80), 'high');
  assert.strictEqual(severityFor(94.9), 'high');
  assert.strictEqual(severityFor(95), 'critical');

  console.log('usage.js self-check OK');
}
