'use strict';
// data/codex/accounts.json. A store of its own, apart from data/accounts.json, so nothing on the
// Claude path (store.list(), keep-alive, /api/usage/all, auto-rotation) can ever see a Codex
// account - an OpenAI token can never be sent to Anthropic, or the reverse. Holds live tokens:
// mode 0600, and publicView() is the only shape that may reach the browser.
const crypto = require('node:crypto');
const path = require('node:path');
const P = require('../paths');
const { PALETTE } = require('../store');

// Computed per call: the test suite reassigns P.dataDir.
const file = () => path.join(P.dataDir(), 'codex', 'accounts.json');

function load() {
  const raw = P.readJsonIfExists(file(), null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts)) return { version: 1, active: {}, accounts: [] };
  const active = raw.active && typeof raw.active === 'object' ? { ...raw.active } : {};
  return { version: raw.version || 1, active, accounts: raw.accounts };
}

function save(s) {
  P.writeJsonAtomic(file(), s, 0o600);
  return s;
}

const list = () => load().accounts;
const get = (id) => load().accounts.find((a) => a.id === id) || null;

// Keyed on the ChatGPT workspace, not the email: one email can own a personal and a team
// workspace, and those are two accounts with two quotas.
function idFor(accountId) {
  if (!accountId) throw new Error('No se puede identificar la cuenta: falta account_id');
  return 'cdx_' + crypto.createHash('sha256').update(String(accountId)).digest('hex').slice(0, 6);
}

function nextColor(accounts) {
  const used = new Set(accounts.map((a) => a.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[accounts.length % PALETTE.length];
}

/**
 * Upsert by accountId. Importing the same login twice (live and staging, say) updates the one
 * row: tokens and identity move on, the label the user chose stays unless a new one is given,
 * and a `dead` mark is cleared - a fresh login is exactly what fixes it.
 */
function add({ accountId, email, plan, oauth, label }) {
  const s = load();
  const id = idFor(accountId);
  const now = Date.now();
  const existing = s.accounts.find((a) => a.id === id);
  if (existing) {
    if (label) existing.label = label;
    existing.email = email || existing.email;
    existing.plan = plan || existing.plan;
    existing.oauth = oauth || existing.oauth;
    existing.dead = null;
    existing.updatedAt = now;
    save(s);
    return existing;
  }
  const account = {
    id,
    label: label || email || `Codex ${id.slice(4)}`,
    color: nextColor(s.accounts),
    email: email || null,
    plan: plan || null,
    accountId,
    oauth,
    dead: null,
    addedAt: now,
    updatedAt: now,
    lastSwappedAt: null,
  };
  s.accounts.push(account);
  save(s);
  return account;
}

const PATCHABLE = ['label', 'color', 'oauth', 'email', 'plan', 'dead', 'lastSwappedAt'];

function update(id, patch) {
  const s = load();
  const account = s.accounts.find((a) => a.id === id);
  if (!account) return null;
  for (const key of PATCHABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) account[key] = patch[key];
  }
  account.updatedAt = Date.now();
  save(s);
  return account;
}

function remove(id) {
  const s = load();
  const before = s.accounts.length;
  s.accounts = s.accounts.filter((a) => a.id !== id);
  if (s.accounts.length === before) return false;
  for (const t of Object.keys(s.active)) if (s.active[t] === id) delete s.active[t];
  save(s);
  return true;
}

function setActive(id, targetId = 'host') {
  const s = load();
  const account = s.accounts.find((a) => a.id === id);
  if (!account) return null;
  s.active[targetId] = id;
  account.lastSwappedAt = Date.now();
  save(s);
  return account;
}

/**
 * Record what a readable auth.json shows (`id`, or null for none / an account we do not store),
 * without it counting as a swap. A target that later drops off the list - a WSL distro stops
 * when idle - is then still known to hold the account. Writes only on a change.
 */
function setLive(targetId, id) {
  const s = load();
  if ((s.active[targetId] || null) === (id || null)) return;
  if (id) s.active[targetId] = id; else delete s.active[targetId];
  save(s);
}

const activeFor = (targetId = 'host') => load().active[targetId] || null;
const activeTargetsOf = (id) => Object.entries(load().active).filter(([, v]) => v === id).map(([t]) => t);

// chatgpt_plan_type as the id token spells it -> how the panel shows it.
const PLANS = { plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', free: 'Free', edu: 'Edu', education: 'Edu' };
const planLabel = (plan) => (plan ? PLANS[plan] || plan : null);

/**
 * The ONLY shape that may leave the process: the Claude row shape exactly, so the frontend
 * renders both providers with the same code, and never a token.
 */
function publicView(targetId = 'host', store) {
  const s = store || load();
  const activeId = s.active[targetId] || null;
  return {
    activeId,
    accounts: s.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      email: a.email,
      color: a.color,
      plan: planLabel(a.plan),
      org: null,
      addedAt: a.addedAt,
      lastSwappedAt: a.lastSwappedAt,
      isActive: a.id === activeId,
      // Codex access tokens last 240 h and are renewed on demand, so an old exp says nothing;
      // what the user must act on is a refresh token OpenAI has refused.
      tokenExpired: !!a.dead,
      canReadUsage: true,
      renewable: true,
      expiresAt: (a.oauth && a.oauth.expiresAt) || null,
    })),
  };
}

const publicAccount = (id, targetId = 'host') => publicView(targetId).accounts.find((a) => a.id === id) || null;

module.exports = {
  file, load, save, list, get, idFor, add, update, remove, setActive, setLive, activeFor, activeTargetsOf,
  planLabel, publicView, publicAccount,
};

if (require.main === module) {
  const assert = require('node:assert');
  const os = require('node:os');
  const fs = require('node:fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-codex-store-'));
  P.dataDir = () => tmp;
  try {
    // Assembled at runtime, like every token fixture in this project.
    const fakeJwt = ['eyJ' + 'a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)].join('.');
    const oauth = (n) => ({ accessToken: `${fakeJwt}${n}`, refreshToken: `rt.a.${n}`, idToken: fakeJwt, accountId: 'acct-1', expiresAt: 1 });

    const a1 = add({ accountId: 'acct-1', email: 'a@b.c', plan: 'plus', oauth: oauth(1) });
    assert.match(a1.id, /^cdx_[a-f0-9]{6}$/);
    assert.strictEqual(a1.label, 'a@b.c');
    update(a1.id, { label: 'Personal', dead: 'x' });
    const a2 = add({ accountId: 'acct-1', email: 'a@b.c', plan: 'plus', oauth: oauth(2) });
    assert.strictEqual(a2.id, a1.id);
    assert.strictEqual(list().length, 1, 'the same login imported twice is one row');
    assert.strictEqual(get(a1.id).label, 'Personal', 'label kept');
    assert.strictEqual(get(a1.id).oauth.refreshToken, 'rt.a.2', 'tokens updated');
    assert.strictEqual(get(a1.id).dead, null, 'a fresh import clears the dead mark');
    add({ accountId: 'acct-1', oauth: oauth(3), label: 'Trabajo' });
    assert.strictEqual(get(a1.id).label, 'Trabajo', 'a given label renames');
    assert.strictEqual(get(a1.id).email, 'a@b.c', 'a missing email does not erase the known one');

    const b = add({ accountId: 'acct-2', email: 'x@y.z', plan: 'team', oauth: oauth(4) });
    setActive(a1.id, 'host');
    setActive(b.id, 'wsl:Ubuntu');
    assert.deepStrictEqual(activeTargetsOf(a1.id), ['host']);
    assert.strictEqual(activeFor('wsl:Ubuntu'), b.id);
    assert.ok(publicView('host').accounts.find((x) => x.id === a1.id).isActive);
    assert.strictEqual(publicAccount(b.id).plan, 'Team');
    const swappedAt = get(b.id).lastSwappedAt;
    setLive('wsl:Debian', b.id);
    assert.deepStrictEqual(activeTargetsOf(b.id), ['wsl:Ubuntu', 'wsl:Debian'], 'a live file counts as active');
    assert.strictEqual(get(b.id).lastSwappedAt, swappedAt, 'but not as a swap');
    setLive('wsl:Debian', null);
    assert.strictEqual(activeFor('wsl:Debian'), null);

    const json = JSON.stringify(publicView('host'));
    assert.ok(!json.includes('eyJ') && !json.includes('refreshToken') && !json.includes('rt.a.'), 'publicView leaked a token');
    assert.deepStrictEqual(Object.keys(publicView().accounts[0]).sort(),
      ['addedAt', 'canReadUsage', 'color', 'email', 'expiresAt', 'id', 'isActive', 'label', 'lastSwappedAt', 'org', 'plan', 'renewable', 'tokenExpired'],
      'the Claude row shape, nothing more');

    assert.ok(remove(a1.id));
    assert.strictEqual(activeFor('host'), null, 'remove clears it from active');
    assert.ok(!remove(a1.id));
    assert.strictEqual(planLabel('edu'), 'Edu');
    assert.strictEqual(planLabel('weird'), 'weird');
    assert.strictEqual(planLabel(null), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('codex/store.js self-check OK');
}
