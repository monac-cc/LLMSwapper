'use strict';
// accounts.json persistence. Holds live OAuth tokens - mode 0600, and publicView()
// is the ONLY thing the HTTP layer is allowed to serialise to the browser.
const crypto = require('node:crypto');
const P = require('./paths');

const PALETTE = [
  '#7c5cff', '#22c9a8', '#ff8f3f', '#4f9dff',
  '#ff5c8a', '#c9a227', '#41c7f0', '#9d7bff',
];

// A token pasted into the panel and an account imported from a live session differ in exactly
// two ways, and both are DERIVED from what is already stored rather than declared in a new field
// nobody would migrate. They are orthogonal: a pasted full-scope token reads usage but cannot be
// renewed, while an imported account does both.
//
//   canReadUsage  the token carries user:profile, so /api/oauth/profile and /api/oauth/usage
//                 answer it. `claude setup-token` grants ONLY user:inference, so its tokens
//                 cannot - asking anyway spends one of about five calls per five minutes for a
//                 guaranteed 403, and blanks the dashboard for every other account.
//   renewable     there is a refresh token to renew with. A pasted token never has one; it is
//                 valid for a year and then must be replaced by hand.
const SCOPE_PROFILE = 'user:profile';

function canReadUsage(account) {
  const scopes = account && account.oauth && account.oauth.scopes;
  // Accounts stored before this field mattered carry the full five-scope list from an
  // interactive login; falling back to "has a profile" keeps them working untouched.
  if (Array.isArray(scopes) && scopes.length) return scopes.includes(SCOPE_PROFILE);
  return true;
}

const renewable = (account) => !!(account && account.oauth && account.oauth.refreshToken);

// activeId is the HOST's active account (kept as-is for backward compatibility). `active`
// generalises it to one active account PER TARGET - { host: id, "wsl:Ubuntu": id } - because
// the account live in WSL is independent of the one live on the host.
const EMPTY = { version: 1, activeId: null, active: {}, accounts: [] };

function load() {
  P.ensureDirs();
  const raw = P.readJsonIfExists(P.accountsPath(), null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts)) {
    return { version: 1, activeId: null, active: {}, accounts: [] };
  }
  const active = (raw.active && typeof raw.active === 'object') ? { ...raw.active } : {};
  // Migrate an older store that only knew the host's activeId.
  if (raw.activeId && active.host === undefined) active.host = raw.activeId;
  return { version: raw.version || 1, activeId: raw.activeId ?? null, active, accounts: raw.accounts };
}

/** The account active in a given target (host by default). */
function activeFor(targetId = 'host') {
  const s = load();
  return (s.active && s.active[targetId]) ?? (targetId === 'host' ? s.activeId : null);
}

function save(store) {
  P.ensureDirs();
  P.writeJsonAtomic(P.accountsPath(), store, 0o600);
  return store;
}

const list = () => load().accounts;
const get = (id) => load().accounts.find((a) => a.id === id) || null;

// Deterministic from accountUuid so re-importing the same account UPDATES it in place
// instead of silently creating a duplicate.
function idFor(profile, email) {
  const seed = (profile && profile.accountUuid) || email || '';
  if (!seed) throw new Error('Cannot derive an account id: no accountUuid and no email');
  return 'acc_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 6);
}

/**
 * An inference-only token can never be resolved to an accountUuid or an email - /api/oauth/profile
 * answers it 403 - so the token itself is the only stable identity available. Hashing it keeps the
 * property that matters: pasting the SAME token twice updates that account in place instead of
 * quietly creating a second row for it. Two different tokens for one Anthropic account will look
 * like two accounts, which is the honest outcome given we cannot tell that they are related.
 */
function idForToken(accessToken) {
  const seed = String(accessToken == null ? '' : accessToken).trim();
  if (!seed) throw new Error('Cannot derive an account id: no token');
  return 'acc_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 6);
}

function nextColor(accounts) {
  const used = new Set(accounts.map((a) => a.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[accounts.length % PALETTE.length];
}

function add({ label, color, email, oauth, profile, userID }) {
  const store = load();
  // An account we could identify keys on that identity; a bare token keys on itself.
  const id = (profile && profile.accountUuid) || email
    ? idFor(profile, email)
    : idForToken(oauth && oauth.accessToken);
  const existing = store.accounts.find((a) => a.id === id);
  const now = Date.now();

  if (existing) {
    // Re-import: refresh the credentials and metadata, keep the user's label/colour.
    //
    // "Keep the label" means keep it against a caller that has NOTHING to say about it - the
    // import path, which passes null. A label the user actually typed into the paste form is a
    // different thing: dropping it answered 200 and left the row showing the machine-generated
    // "token a1b2c3", with no rename anywhere in the UI to undo it. Re-pasting is also the only
    // way to replace a year-long token that has no refresh token, so it is a path people land on.
    if (label) existing.label = label;
    existing.email = email || existing.email;
    existing.oauth = oauth || existing.oauth;
    existing.profile = profile || existing.profile;
    if (userID) existing.userID = userID;
    existing.updatedAt = now;
    save(store);
    return existing;
  }

  const account = {
    id,
    // A pasted inference-only token carries no name of its own, so the panel asks for one. The
    // fallback is the token's own id rather than a generic "Cuenta", so two pasted tokens are
    // still told apart in the list if the label is ever lost.
    label: label || (profile && (profile.displayName || profile.fullName)) || email || `token ${id.slice(4)}`,
    color: color || nextColor(store.accounts),
    email: email || (profile && profile.emailAddress) || null,
    oauth,
    profile: profile || null,
    userID: userID || null,
    addedAt: now,
    updatedAt: now,
    lastSwappedAt: null,
  };
  store.accounts.push(account);
  save(store);
  return account;
}

const PATCHABLE = ['label', 'color', 'oauth', 'profile', 'userID', 'lastSwappedAt', 'email'];

function update(id, patch) {
  const store = load();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return null;
  for (const key of PATCHABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) account[key] = patch[key];
  }
  account.updatedAt = Date.now();
  save(store);
  return account;
}

function remove(id) {
  const store = load();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.accounts.length === before) return false;
  // Clear it wherever it was active - host mirror and every target.
  if (store.activeId === id) store.activeId = null;
  for (const t of Object.keys(store.active)) if (store.active[t] === id) delete store.active[t];
  save(store);
  return true;
}

function setActive(id, targetId = 'host') {
  const store = load();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return null;
  if (!store.active || typeof store.active !== 'object') store.active = {};
  store.active[targetId] = id;
  if (targetId === 'host') store.activeId = id; // keep the legacy mirror in step
  account.lastSwappedAt = Date.now();
  save(store);
  return account;
}

function planLabel(account) {
  // With no profile and no subscriptionType there is nothing to report, and guessing "Claude"
  // would read as a fact. The UI renders null as a dash.
  if (!account.profile && !(account.oauth && account.oauth.subscriptionType)) return null;
  const p = account.profile || {};
  const tier = p.organizationRateLimitTier || (account.oauth && account.oauth.rateLimitTier) || '';
  if (/max_20x/.test(tier)) return 'Max 20x';
  if (/max_5x/.test(tier)) return 'Max 5x';
  if (p.organizationType === 'claude_max') return 'Max';
  if (/pro/i.test(tier) || p.organizationType === 'claude_pro') return 'Pro';
  return (account.oauth && account.oauth.subscriptionType) || 'Claude';
}

/**
 * The ONLY shape that may leave the process. No tokens, no userID. `isActive`/`activeId`
 * are relative to the given target (host by default), so the same account list reflects
 * whichever environment the UI is looking at.
 */
function publicView(targetId = 'host', store) {
  const s = store || load();
  const activeId = (s.active && s.active[targetId]) ?? (targetId === 'host' ? s.activeId : null);
  return {
    activeId,
    accounts: s.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      email: a.email,
      color: a.color,
      plan: planLabel(a),
      org: (a.profile && a.profile.organizationName) || null,
      addedAt: a.addedAt,
      lastSwappedAt: a.lastSwappedAt,
      isActive: a.id === activeId,
      tokenExpired: !!(a.oauth && a.oauth.expiresAt && a.oauth.expiresAt <= Date.now()),
      // Drives whether the row shows usage meters or says plainly that it cannot.
      canReadUsage: canReadUsage(a),
      renewable: renewable(a),
      expiresAt: (a.oauth && a.oauth.expiresAt) || null,
    })),
  };
}

const publicAccount = (id, targetId = 'host') => publicView(targetId).accounts.find((a) => a.id === id) || null;

module.exports = {
  PALETTE, load, save, list, get, add, update, remove,
  setActive, activeFor, publicView, publicAccount, idFor, idForToken, planLabel,
  canReadUsage, renewable, SCOPE_PROFILE,
};

if (require.main === module) {
  const assert = require('node:assert');
  const os = require('node:os'), fsx = require('node:fs'), pathx = require('node:path');
  const tmp = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'swapper-store-'));
  const orig = P.accountsPath;
  P.accountsPath = () => pathx.join(tmp, 'accounts.json');
  P.dataDir = () => tmp;
  P.backupsDir = () => pathx.join(tmp, 'backups');

  const profile = { accountUuid: 'uuid-1', emailAddress: 'a@b.com', displayName: 'Tester', organizationRateLimitTier: 'default_claude_max_20x' };
  const oauth = { accessToken: 'sk-ant-oat01-SECRET', refreshToken: 'sk-ant-ort01-SECRET', expiresAt: Date.now() + 60000 };
  const a1 = add({ email: 'a@b.com', oauth, profile, userID: 'uid' });
  const a2 = add({ email: 'a@b.com', oauth, profile, userID: 'uid' });
  assert.strictEqual(a1.id, a2.id, 're-import must update in place, not duplicate');
  assert.strictEqual(list().length, 1);

  update(a1.id, { label: 'Renamed' });
  assert.strictEqual(get(a1.id).label, 'Renamed');
  assert.strictEqual(planLabel(get(a1.id)), 'Max 20x');

  setActive(a1.id);
  const view = publicView();
  assert.strictEqual(view.activeId, a1.id);
  assert.ok(view.accounts[0].isActive);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('sk-ant-'), 'publicView leaked a token');
  assert.ok(!('oauth' in view.accounts[0]), 'publicView leaked the oauth object');
  assert.ok(!('userID' in view.accounts[0]), 'publicView leaked userID');

  // Per-target active: host and a WSL target point independently.
  const b1 = add({ email: 'c@d.com', oauth, profile: { accountUuid: 'uuid-2', emailAddress: 'c@d.com' } });
  setActive(a1.id, 'host');
  setActive(b1.id, 'wsl:Ubuntu');
  assert.strictEqual(activeFor('host'), a1.id, 'host active independent');
  assert.strictEqual(activeFor('wsl:Ubuntu'), b1.id, 'wsl active independent');
  assert.ok(publicView('wsl:Ubuntu').accounts.find((a) => a.id === b1.id).isActive);
  assert.ok(!publicView('wsl:Ubuntu').accounts.find((a) => a.id === a1.id).isActive);
  // Removing an account clears it from every target it was active in.
  remove(b1.id);
  assert.strictEqual(activeFor('wsl:Ubuntu'), null, 'remove clears the wsl active pointer too');

  assert.ok(remove(a1.id));
  assert.strictEqual(load().activeId, null, 'removing the active account must clear activeId');

  P.accountsPath = orig;
  fsx.rmSync(tmp, { recursive: true, force: true });
  console.log('store.js self-check OK');
}
