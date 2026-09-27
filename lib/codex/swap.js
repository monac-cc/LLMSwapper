'use strict';
// The Codex swap: adopt what is live, back up, write, verify, roll back. Plus the two things that
// keep a stored account usable - adopting pairs Codex rotated on its own, and refreshing the idle
// ones nobody else will. The refresh token ROTATES and the old one dies for good, so every path
// here is about never leaving two holders with different ideas of the current pair.
const fs = require('node:fs');
const path = require('node:path');
const P = require('../paths');
const { scrub } = require('../oauth');
const auth = require('./auth');
const store = require('./store');
const targets = require('./targets');
const usage = require('./usage');

const MAX_BACKUPS = 20;
const FRESH_MS = 5 * 60 * 1000;                     // Codex's own margin before exp
const KEEPALIVE_UNDER_MS = 2 * 24 * 60 * 60 * 1000; // idle accounts: renew under 2 days of life

const stagingDir = () => path.join(P.dataDir(), 'codex', 'login');
const backupsDir = () => path.join(P.dataDir(), 'codex', 'backups');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const whereOf = (tg) => (tg.kind === 'host' ? '' : ` en ${tg.label}`);

/** The ChatGPT `tokens` of a parsed auth.json; null when there are none or it is an API key. */
function chatgptTokens(live) {
  if (!live || !live.tokens || typeof live.tokens !== 'object') return null;
  const mode = live.auth_mode || (live.OPENAI_API_KEY ? 'apikey' : 'chatgpt');
  return /^chatgpt/i.test(mode) ? live.tokens : null;
}

/** account_id live in a target, null for none. Throws when auth.json cannot be read. */
function liveAccountId(tg) {
  const tokens = chatgptTokens(auth.readAuth(tg.authPath));
  return (tokens && tokens.account_id) || null;
}

/**
 * Targets (other than `except`) where an account is live. The file is the truth when it can be
 * read; the store's `active` map is trusted only where it cannot - an unreadable auth.json, or a
 * target that is not reachable right now (a stopped WSL distro still holds its copy on disk).
 */
function liveTargetsOf(account, except) {
  const list = targets.list();
  const recorded = store.activeTargetsOf(account.id);
  const out = [];
  for (const t of list) {
    if (except && t.id === except.id) continue;
    let holder;
    try { holder = liveAccountId(t); } catch { holder = undefined; }
    if (holder === account.accountId || (holder === undefined && recorded.includes(t.id))) out.push(t);
  }
  for (const id of recorded) {
    if ((!except || id !== except.id) && !list.some((t) => t.id === id)) out.push({ id, label: id, unreachable: true });
  }
  return out;
}

// Access tokens are re-minted with a fresh exp on every refresh, so a smaller exp is an older pair.
const olderThan = (incoming, stored) => !!(stored && stored.expiresAt && incoming.expiresAt && incoming.expiresAt < stored.expiresAt);

/**
 * The file lags behind the store: a refresh whose write-back failed. Its refresh token died with
 * that refresh, so it gets the store's pair (a Codex running there adopts it in its guarded
 * reload) - unless the account is live somewhere else too, where that would make two holders.
 * Best effort: a failure here is retried by the next adoption.
 */
function catchUp(target, known) {
  if (liveTargetsOf(known, target).length) return;
  try { auth.writeTokens(target.authPath, known.oauth); } catch { /* next adoption */ }
}

/**
 * Store the pair live in a target. A known account takes the file's pair (Codex refreshes on its
 * own and the store's copy is then dead); an unknown one is imported, so a swap never leaves the
 * user's session surviving only in a backup. Incoherent tokens are left alone: filing one
 * workspace's pair under another is worse than asking for an import. Either way the store's
 * `active` map is set to what the file shows, so liveTargetsOf() still sees this target when it
 * later cannot be read.
 */
function adoptLive(target, { importUnknown = true } = {}) {
  const live = auth.readAuth(target.authPath);
  const tokens = chatgptTokens(live);
  const holderId = tokens && tokens.account_id ? store.idFor(tokens.account_id) : null;
  store.setLive(target.id, holderId && store.get(holderId) ? holderId : null);
  if (!tokens || !tokens.account_id || !tokens.refresh_token || !auth.coherent(tokens)) {
    return { adopted: false, imported: null, accountId: null };
  }
  const accountId = tokens.account_id;
  const known = store.get(holderId);
  const oauth = auth.toStored(tokens, live.last_refresh);
  const who = auth.identity(tokens);
  if (known) {
    const o = known.oauth || {};
    if (o.refreshToken === oauth.refreshToken && o.accessToken === oauth.accessToken) {
      return { adopted: false, imported: null, accountId };
    }
    // An older pair never replaces a newer one - unless the stored one is known dead.
    if (!known.dead && olderThan(oauth, o)) {
      if (o.refreshToken && o.refreshToken !== oauth.refreshToken) catchUp(target, known);
      return { adopted: false, imported: null, accountId };
    }
    store.update(known.id, { oauth, dead: null, email: who.email || known.email, plan: who.plan || known.plan });
    return { adopted: true, imported: null, accountId };
  }
  if (!importUnknown) return { adopted: false, imported: null, accountId };
  const imported = store.add({ accountId, email: who.email, plan: who.plan, oauth });
  store.setLive(target.id, imported.id);
  return { adopted: false, imported, accountId };
}

/** Readable targets whose auth.json holds this account right now. */
function holdersOf(accountId) {
  return targets.list().filter((t) => { try { return liveAccountId(t) === accountId; } catch { return false; } });
}

// One refresh per account at a time. Every caller (usage reads from two tabs, the swap, the
// keep-alive) holds the same refresh token, and the second one to spend it gets
// refresh_token_reused - which also risks OpenAI revoking the whole token family.
const refreshing = new Map(); // id -> the refresh in flight

function refreshAccount(account) {
  const id = account.id;
  if (!refreshing.has(id)) refreshing.set(id, refreshNow(account).finally(() => refreshing.delete(id)));
  return refreshing.get(id);
}

/**
 * Refresh one account and hand the new pair to every auth.json that still holds the old one.
 * The live pair is adopted first: if Codex already refreshed, spending our (dead) copy would
 * fail and brand a healthy account as dead.
 */
async function refreshNow(account) {
  const id = account.id;
  const unreachable = liveTargetsOf(account).filter((t) => t.unreachable);
  if (unreachable.length) {
    // Its copy there would die with our refresh, and that Codex would find out on its next start.
    throw Object.assign(new Error(`No se renueva ${account.label}: está activa en ${unreachable.map((t) => t.label).join(', ')}, que ahora no es accesible. Arranca ese entorno.`), { status: 0, permanent: false });
  }
  const holders = holdersOf(account.accountId);
  for (const t of holders) { try { adoptLive(t); } catch { /* unreadable right now */ } }
  const current = store.get(id) || account;
  const old = current.oauth || {};
  // After the adoption: a newer pair a Codex holds clears the mark.
  if (current.dead) {
    throw Object.assign(new Error(`${current.label} necesita volver a iniciar sesión: ${current.dead}`), { status: 401, permanent: true });
  }
  if (old.expiresAt && old.expiresAt - Date.now() > FRESH_MS && old.accessToken !== (account.oauth || {}).accessToken) return current;
  // A Codex holding it refreshes at this same margin, and racing it spends one refresh token
  // twice. Only a token already past exp - that Codex is not refreshing it - is ours to renew.
  if (holders.length && old.expiresAt && old.expiresAt > Date.now()) return current;
  if (!old.refreshToken) throw Object.assign(new Error('Esta cuenta no tiene refresh token guardado. Vuelve a importarla.'), { status: 0, permanent: true });

  let res;
  try {
    res = await auth.refresh(old.refreshToken);
  } catch (err) {
    if (err.permanent) {
      // Codex may have rotated it between our adoption and our call: its pair is then the good one.
      for (const t of holdersOf(account.accountId)) { try { adoptLive(t); } catch { /* ignore */ } }
      const again = store.get(id);
      if (again && again.oauth && again.oauth.refreshToken !== old.refreshToken) return again;
      store.update(id, { dead: scrub(err.message) });
      usage.invalidate(id); // a cached reading must not keep the row looking healthy
    }
    throw err;
  }
  const fresh = auth.toStored({
    id_token: res.tokens.id_token || old.idToken,
    access_token: res.tokens.access_token || old.accessToken,
    refresh_token: res.tokens.refresh_token || old.refreshToken,
    account_id: old.accountId || account.accountId,
  }, res.lastRefresh);
  // Persist BEFORE anything else: the old refresh token is already dead.
  const updated = store.update(id, { oauth: fresh, dead: null }) || { ...current, oauth: fresh };
  for (const t of targets.list()) {
    let tokens;
    try { tokens = chatgptTokens(auth.readAuth(t.authPath)); } catch { continue; }
    if (!tokens || tokens.account_id !== fresh.accountId) continue;
    try {
      if (tokens.refresh_token === old.refreshToken) auth.writeTokens(t.authPath, fresh);
      else adoptLive(t); // the file moved on while we refreshed: its pair wins
    } catch { /* the next adoption there sees the file lagging behind and catches it up */ }
  }
  return store.get(id) || updated;
}

/**
 * No-op while the access token has more than 5 minutes left; refreshes (or adopts) otherwise.
 * A dead account always goes through: it adopts a newer pair if a Codex holds one, and throws
 * the "sign in again" error if not - so neither a usage read nor a swap passes it as healthy.
 */
async function ensureFresh(account) {
  const o = (account && account.oauth) || {};
  if (!account.dead && (!o.expiresAt || o.expiresAt - Date.now() > FRESH_MS)) return account;
  return refreshAccount(account);
}
usage.setEnsureFresh(ensureFresh);

/* ---------------- backups ---------------- */

let seq = 0;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// By name, which starts with the date. `keep` is the backup just taken: a clock that ran ahead
// once (dual-boot RTC skew) leaves names that sort after it, and pruning it would leave the
// swap about to happen with nothing to roll back to.
function pruneBackups(keep) {
  try {
    const dirs = fs.readdirSync(backupsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== keep).map((d) => d.name).sort();
    for (const name of dirs.slice(0, Math.max(0, dirs.length - (MAX_BACKUPS - 1)))) {
      fs.rmSync(path.join(backupsDir(), name), { recursive: true, force: true });
    }
  } catch { /* best effort; never block a swap on it */ }
}

/** The target's auth.json byte for byte, or an `absent` marker. Throws: no backup, no swap. */
function backupNow(id, tg) {
  // The sequence keeps two swaps in the same millisecond apart and in order.
  const name = `${stamp()}-${String(++seq % 10000).padStart(4, '0')}-${id}`;
  const dir = path.join(backupsDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.copyFileSync(tg.authPath, path.join(dir, 'auth.json'));
  } catch (err) {
    // Only a file that is really not there is "absent": a rollback deletes on that marker.
    if (err.code !== 'ENOENT') throw err;
    fs.writeFileSync(path.join(dir, 'absent'), '');
  }
  P.writeJsonAtomic(path.join(dir, 'target.json'), { id: tg.id, authPath: tg.authPath }, 0o600);
  pruneBackups(name);
  return { dir };
}

function restoreFrom(dir, tg) {
  const saved = path.join(dir, 'auth.json');
  if (!fs.existsSync(saved)) {
    // Delete only on the marker's word: a backup that lost its copy is no proof there was none.
    if (!fs.existsSync(path.join(dir, 'absent'))) throw new Error(`el backup ${dir} no tiene auth.json ni marca de ausencia`);
    // There was no login here before: leave none, not a half-configured one.
    fs.rmSync(tg.authPath, { force: true });
    return;
  }
  // Byte for byte, through a rename: a failure halfway must not leave a fragment behind.
  const tmp = `${tg.authPath}.${process.pid}.restore.tmp`;
  fs.copyFileSync(saved, tmp);
  try {
    P.renameWithRetry(tmp, tg.authPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true }); // it holds tokens: never leave it in the user's .codex
    throw err;
  }
}

/* ---------------- swap ---------------- */

function keyringError(tg, mode) {
  return httpError(409, `Codex${whereOf(tg)} guarda la sesión en el llavero del sistema (almacenamiento "${mode}"), no en auth.json, así que un swap no tendría efecto. `
    + `Para usar el panel ahí, pon cli_auth_credentials_store = "file" en ${path.join(tg.home, 'config.toml')}, borra secrets/codex_auth.age si existe y vuelve a hacer "codex login".`);
}

function resolveTarget(targetOrId) {
  const tg = targetOrId && typeof targetOrId === 'object' ? targetOrId : targets.resolve(targetOrId);
  if (!tg) throw httpError(400, `Entorno desconocido: ${targetOrId}`);
  return tg;
}

// ponytail: one lock for every target, like the Claude swap; per-target locks if host and WSL
// swaps ever need to overlap.
let inFlight = null;

/** A second swap while one runs is refused, not queued: by then the target may have moved on. */
function swapTo(id, targetOrId) {
  if (inFlight) return Promise.reject(httpError(409, 'Ya hay un cambio de cuenta de Codex en curso'));
  inFlight = swapNow(id, targetOrId).finally(() => { inFlight = null; });
  return inFlight;
}

async function swapNow(id, targetOrId) {
  const tg = resolveTarget(targetOrId);
  const mode = auth.storeMode(tg.home);
  if (mode !== 'file') throw keyringError(tg, mode);
  let account = store.get(id);
  if (!account) throw httpError(404, `Cuenta de Codex desconocida: ${id}`);

  // One environment per account: two auth.json files with the same rotating refresh token kill
  // each other on the first refresh.
  const elsewhere = liveTargetsOf(account, tg);
  if (elsewhere.length) {
    throw httpError(409, `${account.label} ya está activa en ${elsewhere.map((t) => t.label).join(', ')}. Una cuenta de Codex solo puede estar en un entorno a la vez: `
      + 'las dos copias comparten un refresh token que rota, y el primer refresh de una deja muerta a la otra. Cambia antes ese entorno a otra cuenta.');
  }

  const warnings = [];
  const where = whereOf(tg);
  const procs = targets.detectRunning(tg);
  if (procs.running) {
    warnings.push(`Codex está abierto${where} (${procs.pids.length} proceso(s)). Las sesiones abiertas siguen con la cuenta anterior; el cambio se aplica a las NUEVAS.`);
  }
  if (tg.kind === 'host' && process.env.CODEX_ACCESS_TOKEN) {
    warnings.push('CODEX_ACCESS_TOKEN está definido y gana a auth.json: mientras siga así, Codex no verá este cambio.');
  }

  // Keep the outgoing account's newest pair, and never lose a session the store does not know.
  // Throws on an unreadable auth.json - before anything has been written, or refreshed.
  const adopt = () => {
    const r = adoptLive(tg);
    if (r.imported) warnings.push(`La sesión que había${where} (${r.imported.email || r.imported.label}) no estaba guardada: se ha añadido a la lista.`);
  };
  adopt();

  // Refreshed BEFORE the backup, unlike the Claude swap: if this account is already live here,
  // the refresh writes its new pair into the file, and a backup taken earlier would roll the
  // file back to a refresh token that just died.
  try {
    account = await ensureFresh(store.get(id) || account);
  } catch (err) {
    throw httpError(err.permanent ? 409 : 502, `No se pudo renovar el token: ${scrub(err.message)}`);
  }

  // Again: a Codex open here may have rotated the outgoing pair during that await, and the
  // backup keeps a copy nobody would ever read back. From here to writeTokens it is synchronous.
  adopt();
  account = store.get(id) || account;
  const backup = backupNow(id, tg);
  try {
    auth.writeTokens(tg.authPath, account.oauth);

    const back = chatgptTokens(auth.readAuth(tg.authPath));
    if (!back || back.account_id !== account.accountId || back.refresh_token !== account.oauth.refreshToken || !auth.coherent(back)) {
      throw new Error('auth.json no quedó como se escribió');
    }
    // A direct call, never a cached reading: that would "verify" a token it never used.
    usage.invalidate(id);
    let check = null;
    try {
      check = usage.prime(id, usage.normalize(await usage.fetchRaw(account), id));
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        if (err.revoked) store.update(id, { dead: usage.REVOKED });
        throw new Error(err.revoked ? usage.REVOKED : `OpenAI rechaza el token de esta cuenta (${err.status}). ${usage.RELOGIN}`);
      }
      warnings.push(`No se pudo confirmar el cambio contra chatgpt.com (${scrub(err.message)}). El auth.json se ha escrito igualmente.`);
    }

    store.setActive(id, tg.id);
    return {
      ok: true, verified: check !== null, target: tg.id, targetLabel: tg.label, warnings,
      backup: backup.dir, account: store.publicAccount(id, tg.id),
    };
  } catch (err) {
    let rollback = 'restaurado';
    try { restoreFrom(backup.dir, tg); } catch (e) { rollback = `LA RESTAURACIÓN FALLÓ (${scrub(e.message)}) - restaura a mano desde ${backup.dir}`; }
    // The restored pair may have been refreshed by the keep-alive or a usage read meanwhile:
    // adopting catches the file up to the store, and puts `active` back on what it holds.
    try { adoptLive(tg); } catch { /* the next adoption */ }
    const e = new Error(`${scrub(err.message)} - auth.json ${rollback}`);
    e.backup = backup.dir;
    throw e;
  }
}

/* ---------------- import, detection, keep-alive ---------------- */

/**
 * Store a login from one of three places: the panel's staging directory (the "add account"
 * terminal), another CODEX_HOME, or a target's live session - which then also counts as active
 * there. A staging import deletes the staging auth.json: the store is its only holder now.
 */
async function importFrom({ target, configDir, staging } = {}) {
  let tg = null;
  let home;
  if (staging) home = stagingDir();
  else if (configDir) {
    if (typeof configDir !== 'string') throw httpError(400, 'configDir debe ser una ruta');
    home = configDir;
  } else {
    tg = resolveTarget(target);
    home = tg.home;
  }
  const file = tg ? tg.authPath : auth.authPath(home);
  const mode = auth.storeMode(home);
  if (mode !== 'file') throw keyringError(tg || { kind: 'host', home }, mode);

  let live;
  try { live = auth.readAuth(file); } catch (err) { throw httpError(409, err.message); }
  if (!live) {
    throw httpError(404, staging
      ? 'Todavía no hay ningún login nuevo que importar. Termina el login en la ventana de Codex (se abre el navegador) y vuelve a pulsar importar.'
      : tg ? `No hay ninguna sesión de Codex${whereOf(tg)} que importar. Ejecuta "codex login" ahí y vuelve a pulsar importar.`
        : `No hay ningún auth.json en ${configDir}`);
  }
  const tokens = chatgptTokens(live);
  if (!tokens) throw httpError(400, 'Ese auth.json es de una clave de API, no de una cuenta de ChatGPT: el panel solo guarda cuentas de ChatGPT.');
  if (!tokens.access_token || !tokens.refresh_token || !tokens.account_id) {
    throw httpError(400, 'Ese auth.json está incompleto (faltan tokens o account_id). Vuelve a hacer "codex login".');
  }
  if (!auth.coherent(tokens)) throw httpError(400, 'Los tokens de ese auth.json no corresponden a su account_id. Vuelve a hacer "codex login".');

  const who = auth.identity(tokens);
  const oauth = auth.toStored(tokens, live.last_refresh);
  const existing = store.get(store.idFor(tokens.account_id));
  // An older copy of a login (a stale CODEX_HOME) must not replace the pair that still works -
  // but a pair OpenAI has refused does not "still work", and the import is how to replace it.
  const keepStored = existing && !existing.dead && olderThan(oauth, existing.oauth);
  const account = store.add({ accountId: tokens.account_id, email: who.email, plan: who.plan, oauth: keepStored ? undefined : oauth });
  usage.invalidate(account.id);
  if (tg) store.setActive(account.id, tg.id);
  if (staging) fs.rmSync(file, { force: true });
  return account;
}

/**
 * Which stored account is live in a target right now. From its auth.json when it can be read -
 * and then recorded, like adoptLive() does - and from the store's `active` map when it cannot
 * (an unreadable file, or a WSL distro that is not running). Never throws.
 */
function detectActiveId(targetId) {
  const tg = targets.resolve(targetId);
  let accountId;
  try {
    if (!tg) throw new Error('unknown');
    accountId = liveAccountId(tg);
  } catch {
    return store.activeFor(targetId);
  }
  const id = accountId ? store.idFor(accountId) : null;
  const known = id && store.get(id) ? id : null;
  store.setLive(tg.id, known);
  return known;
}

/**
 * Every 6 h from server.js. Adopts what Codex rotated in each target (known accounts only - a
 * session the user never imported is theirs to import, and one they deleted stays deleted), then
 * renews each idle account close to expiry: the panel is its only holder. Dead ones are skipped.
 */
async function keepAliveTick() {
  const out = { adopted: [], refreshed: [], failed: [] };
  for (const t of targets.list()) {
    try {
      const r = adoptLive(t, { importUnknown: false });
      if (r.adopted) { const a = store.get(store.idFor(r.accountId)); out.adopted.push((a && (a.email || a.label)) || r.accountId); }
    } catch (err) {
      out.failed.push({ target: t.id, error: scrub(err.message) });
    }
  }
  for (const a of store.list()) {
    const o = a.oauth || {};
    if (a.dead || !o.refreshToken || !o.expiresAt || o.expiresAt - Date.now() > KEEPALIVE_UNDER_MS) continue;
    if (liveTargetsOf(a).length) continue; // Codex refreshes those itself; we adopt the result
    try {
      await refreshAccount(a);
      out.refreshed.push(a.email || a.label);
    } catch (err) {
      out.failed.push({ id: a.id, email: a.email || a.label, error: scrub(err.message) });
    }
  }
  return out;
}

module.exports = {
  MAX_BACKUPS, stagingDir, backupsDir,
  adoptLive, ensureFresh, swapTo, importFrom, detectActiveId, keepAliveTick,
  backupNow, restoreFrom,
};

if (require.main === module) {
  // Everything in a temp dir: data, CODEX_HOME and the one target. Network stubbed.
  const assert = require('node:assert');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-codex-swap-'));
  P.dataDir = () => path.join(tmp, 'data');
  process.env.CODEX_HOME = path.join(tmp, 'home');
  const tg = { id: 'dir:t', kind: 'dir', label: 't', home: path.join(tmp, 't'), authPath: path.join(tmp, 't', 'auth.json') };
  targets.list = () => [tg];
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (p) => `${b64({ alg: 'RS256' })}.${b64(p)}.${'s'.repeat(43)}`;
  const claim = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'pro' } };
  const tokens = {
    id_token: jwt({ email: 'a@b.c', ...claim }),
    access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, ...claim }),
    refresh_token: 'rt.a.one',
    account_id: 'acct-1',
  };
  let status = 401;
  global.fetch = async (url) => {
    if (String(url) !== usage.USAGE_URL) throw new Error(`unexpected ${url}`);
    return { ok: status === 200, status, headers: { get: () => null }, text: async () => JSON.stringify({ rate_limit: {} }) };
  };
  const account = store.add({ accountId: 'acct-1', email: 'a@b.c', plan: 'pro', oauth: auth.toStored(tokens, 'LR') });
  (async () => {
    try {
      await assert.rejects(swapTo(account.id, tg), /restaurado/);
      assert.strictEqual(fs.existsSync(tg.authPath), false, 'a failed verify leaves no login behind');
      status = 200;
      const r = await swapTo(account.id, tg);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(auth.readAuth(tg.authPath).tokens.account_id, 'acct-1');
      assert.strictEqual(detectActiveId('dir:t'), account.id);
      assert.strictEqual(fs.readdirSync(backupsDir()).length, 2);
      console.log('codex/swap.js self-check OK');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })().catch((err) => { console.error(err); process.exit(1); });
}
