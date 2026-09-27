'use strict';
// Codex CLI's session file ($CODEX_HOME/auth.json), its JWT identity, and its token refresh.
// Constants and shapes were read out of the openai/codex source at 0.157.1 and verified against
// a live login - see "Verified facts" in docs/superpowers/specs/2026-09-27-codex-accounts-design.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../paths');
const { scrub } = require('../oauth');

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';

// Read at call time, never at require time: the test suite points it at a temp dir.
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const authPath = (home) => path.join(home, 'auth.json');

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The parsed auth.json, or null when there is none. Codex writes it with truncate+write, not an
 * atomic rename, so a read can land on a half-written file: that is retried, and a file that
 * stays unparseable throws rather than reading as "no session" - a caller that took it for
 * absent would happily write over the user's login.
 */
function readAuth(file) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) sleepSync(50);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new Error(`No se pudo leer ${file}: ${err.message}`);
    }
    try {
      return JSON.parse(P.stripBom(text).trim());
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`auth.json ilegible en ${file} (${lastErr.message}). No se toca; si Codex estaba escribiéndolo, vuelve a intentarlo en unos segundos.`);
}

/** The payload of a JWT, unverified. Identity only - nothing here trusts it for access. */
function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    return part ? JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) : null;
  } catch {
    return null;
  }
}

const claimOf = (payload) => (payload && payload[AUTH_CLAIM]) || {};

/** Who a token set belongs to, offline, out of the id token (access token as a fallback). */
function identity(tokens) {
  const t = tokens || {};
  const id = decodeJwt(t.id_token) || {};
  const acc = decodeJwt(t.access_token) || {};
  const pick = (key) => claimOf(id)[key] || claimOf(acc)[key] || null;
  return {
    accountId: t.account_id || pick('chatgpt_account_id'),
    email: id.email || (acc[PROFILE_CLAIM] || {}).email || null,
    plan: pick('chatgpt_plan_type'),
    userId: pick('chatgpt_user_id'),
  };
}

/**
 * Whether the JWTs agree with tokens.account_id. A pair whose claim names another workspace
 * would be filed under the wrong account, so nothing is adopted or imported unless this holds.
 * A token without the claim is not evidence against it.
 */
function coherent(tokens) {
  if (!tokens || !tokens.account_id) return false;
  return [tokens.access_token, tokens.id_token].every((jwt) => {
    const claimed = claimOf(decodeJwt(jwt)).chatgpt_account_id;
    return !claimed || claimed === tokens.account_id;
  });
}

/** auth.json `tokens` -> the stored `oauth` block. Access tokens carry their own exp (seconds). */
function toStored(tokens, lastRefresh) {
  const exp = (decodeJwt(tokens.access_token) || {}).exp;
  return {
    accessToken: tokens.access_token || null,
    refreshToken: tokens.refresh_token || null,
    idToken: tokens.id_token || null,
    accountId: tokens.account_id || null,
    expiresAt: Number.isFinite(exp) ? exp * 1000 : null,
    lastRefresh: lastRefresh || null,
  };
}

const toTokens = (oauth) => ({
  id_token: oauth.idToken,
  access_token: oauth.accessToken,
  refresh_token: oauth.refreshToken,
  account_id: oauth.accountId,
});

/**
 * Put a stored account's tokens into an auth.json. Mutates only auth_mode, tokens and
 * last_refresh (mandatory - without it Codex says "Token data is not available") and keeps every
 * other key, including ones newer Codex versions add. An existing file that does not parse
 * throws out of readAuth, so it is never replaced blind.
 */
function writeTokens(file, oauth) {
  const next = { ...(readAuth(file) || {}) };
  if (!('OPENAI_API_KEY' in next)) next.OPENAI_API_KEY = null;
  next.auth_mode = 'chatgpt';
  next.tokens = toTokens(oauth);
  next.last_refresh = oauth.lastRefresh || new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  P.writeJsonAtomic(file, next, 0o600);
  return next;
}

/**
 * One refresh. The refresh token ROTATES and the old one dies for good, so the caller must store
 * the result before doing anything else with it. The endpoint does not echo account_id; the
 * caller supplies it. Errors carry .status and .permanent (reused/expired/invalidated grant).
 */
async function refresh(refreshToken) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const e = new Error(`No se pudo contactar con auth.openai.com para renovar el token: ${scrub(err.message)}`);
    e.status = 0;
    e.permanent = false;
    throw e;
  }
  const text = await res.text();
  if (!res.ok) {
    const permanent = res.status === 401 || /refresh_token_(reused|expired|invalidated)|invalid_grant/.test(text);
    const e = new Error(permanent
      ? `OpenAI ya no acepta el refresh token de esta cuenta (${res.status}). Vuelve a añadirla con «añadir cuenta», y para cambiar de cuenta usa el swap del panel: cerrar sesión en Codex revoca el token.`
      : `auth.openai.com devolvió ${res.status} al renovar el token: ${scrub(text).slice(0, 200)}`);
    e.status = res.status;
    e.permanent = permanent;
    throw e;
  }
  let body;
  try { body = JSON.parse(text); } catch {
    const e = new Error('auth.openai.com devolvió una respuesta que no es JSON');
    e.status = res.status;
    throw e;
  }
  return {
    tokens: { id_token: body.id_token, access_token: body.access_token, refresh_token: body.refresh_token },
    lastRefresh: new Date().toISOString(),
  };
}

/**
 * 'file', or the storage mode that takes the session out of auth.json. With keyring/auto the
 * live login lives in the OS keyring (Windows: secrets/codex_auth.age), and writing auth.json
 * there would be a swap Codex never reads - so callers refuse instead of guessing.
 */
function storeMode(home) {
  let toml = '';
  try { toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { /* absent = default */ }
  const m = toml.match(/^\s*cli_auth_credentials_store\s*=\s*["']([a-z]+)["']/m);
  if (m && m[1] !== 'file') return m[1];
  if (fs.existsSync(path.join(home, 'secrets', 'codex_auth.age'))) return 'keyring';
  return 'file';
}

module.exports = {
  CLIENT_ID, TOKEN_URL,
  codexHome, authPath, readAuth, decodeJwt, identity, coherent, toStored, toTokens, writeTokens,
  refresh, storeMode,
};

if (require.main === module) {
  const assert = require('node:assert');
  // Built at runtime: a JWT written out in a source file would trip test.js's token scan.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (payload) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.${'s'.repeat(43)}`;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const claim = { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus', chatgpt_user_id: 'user-1' };
  const tokens = {
    id_token: jwt({ email: 'a@b.c', [AUTH_CLAIM]: claim }),
    access_token: jwt({ exp, [AUTH_CLAIM]: claim }),
    refresh_token: 'rt.x.refresh',
    account_id: 'acct-1',
  };

  assert.deepStrictEqual(identity(tokens), { accountId: 'acct-1', email: 'a@b.c', plan: 'plus', userId: 'user-1' });
  assert.strictEqual(coherent(tokens), true);
  assert.strictEqual(coherent({ ...tokens, account_id: 'acct-OTHER' }), false, 'a claim naming another workspace');
  assert.strictEqual(coherent({ ...tokens, access_token: jwt({ exp }), id_token: jwt({}) }), true, 'no claim is not a contradiction');
  const stored = toStored(tokens, 'LR');
  assert.strictEqual(stored.expiresAt, exp * 1000);
  assert.deepStrictEqual(toTokens(stored), tokens);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-codex-auth-'));
  try {
    // A fresh home: directory and file are created, OPENAI_API_KEY present as null.
    const fresh = path.join(tmp, 'new-home', 'auth.json');
    writeTokens(fresh, stored);
    assert.strictEqual(readAuth(fresh).OPENAI_API_KEY, null);
    assert.strictEqual(readAuth(fresh).last_refresh, 'LR');

    // Keys this module does not own survive, last_refresh is always set.
    const file = path.join(tmp, 'auth.json');
    fs.writeFileSync(file, JSON.stringify({ auth_mode: 'apikey', agent_identity: { x: 1 } }));
    writeTokens(file, { ...stored, lastRefresh: null });
    const after = readAuth(file);
    assert.deepStrictEqual(after.agent_identity, { x: 1 });
    assert.strictEqual(after.auth_mode, 'chatgpt');
    assert.ok(!Number.isNaN(Date.parse(after.last_refresh)), 'last_refresh must be set');
    assert.strictEqual(after.tokens.account_id, 'acct-1');

    // Absent is null; half-written is retried, then refused - never "no session".
    assert.strictEqual(readAuth(path.join(tmp, 'nope.json')), null);
    fs.writeFileSync(file, '{"trunc');
    const t0 = Date.now();
    assert.throws(() => readAuth(file), /ilegible/);
    assert.ok(Date.now() - t0 >= 140, 'must have waited between retries');
    assert.throws(() => writeTokens(file, stored), /ilegible/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"trunc', 'an unreadable file is not overwritten');

    assert.strictEqual(storeMode(tmp), 'file');
    fs.writeFileSync(path.join(tmp, 'config.toml'), 'model = "x"\ncli_auth_credentials_store = "keyring"\n');
    assert.strictEqual(storeMode(tmp), 'keyring');
    fs.writeFileSync(path.join(tmp, 'config.toml'), '# cli_auth_credentials_store = "keyring"\ncli_auth_credentials_store = "file"\n');
    assert.strictEqual(storeMode(tmp), 'file');
    fs.mkdirSync(path.join(tmp, 'secrets'));
    fs.writeFileSync(path.join(tmp, 'secrets', 'codex_auth.age'), 'x');
    assert.strictEqual(storeMode(tmp), 'keyring', 'the encrypted keyring file gives it away too');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // CODEX_HOME is read at call time.
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmp;
  assert.strictEqual(codexHome(), tmp);
  if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;

  console.log('codex/auth.js self-check OK');
}
