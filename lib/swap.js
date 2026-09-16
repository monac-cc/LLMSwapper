'use strict';
// The dangerous file. It rewrites the user's real ~/.claude.json (a large file full of
// irreplaceable state) and ~/.claude/.credentials.json (paid account tokens).
// Rules: back up before the first write, mutate in place rather than rebuild, verify
// against the live API afterwards, and roll back on any failure past that first write.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const P = require('./paths');
const credentials = require('./credentials');
const targets = require('./targets');

const MAX_BACKUPS = 20;

// Shown as the Organization line in /status for an account that has no profile of its own.
// See identityFromLabel for why this is named rather than left empty.
const PANEL_ORG = 'LLMSwapper';

/**
 * Every swap now names a TARGET - the host, or a WSL distro reached over its share. The
 * only differences a target introduces are the two file paths and whether credentials go
 * through the platform backend (host: Keychain on macOS) or a plain file (WSL is Linux).
 * Everything else - backup, in-place mutation, verify, rollback - is identical.
 */
function asTarget(t) {
  if (!t) return targets.hostTarget();
  if (typeof t === 'string') {
    // An id that does not resolve - a distro that has stopped, a typo from a skill - must not
    // quietly become the host: that rewrites the wrong machine's credentials and reports ok.
    const tg = targets.resolve(t);
    if (!tg) { const e = new Error(`Target desconocido: ${t}`); e.status = 400; throw e; }
    return tg;
  }
  return t;
}

// Read/write the credentials blob for a target. A bare string is treated as an explicit
// file path (the self-check uses that); host uses the backend; WSL is always a file.
function credIO(target) {
  if (typeof target === 'string') {
    return { read: () => P.readJsonIfExists(target, {}), write: (b) => P.writeJsonAtomic(target, b, 0o600) };
  }
  if (target && target.fileBackend) {
    return { read: () => P.readJsonIfExists(target.credentialsPath, {}), write: (b) => P.writeJsonAtomic(target.credentialsPath, b, 0o600) };
  }
  return { read: () => credentials.read(), write: (b) => credentials.write(b) };
}

// Per-account caches Claude Code keeps in .claude.json. Left behind they describe the
// PREVIOUS account, so we drop them and let Claude Code refetch for the new identity.
const STALE_CACHE_KEYS = [
  'overageCreditGrantCache',
  'modelAccessCache',
  'orgModelDefaultCache',
  'passesEligibilityCache',
  'cachedExtraUsageDisabledReason',
  'hasAvailableSubscription',
  'clientDataCacheSlots',
  'additionalModelOptionsCache',
  'additionalModelCostsCache',
  'passesLastSeenRemaining',
];

// ponytail: userID is an install/telemetry id, not an account identity - it does not
// derive from accountUuid (verified). Leaving it alone removes a whole class of risk.

function detectClaudeProcesses() {
  // Inside a container the process namespace is the container's, so pgrep sees this server and
  // nothing else. Reporting running:false there would be a lie with a confident face - the panel
  // would tell you Claude Code is closed while it runs on the host. `unknown` lets the UI say
  // "cannot tell from in here", which is the truth.
  if (P.inContainer()) return { running: false, pids: [], unknown: true };
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      const pids = out.split(/\r?\n/)
        .map((l) => (l.match(/^"claude\.exe","(\d+)"/i) || [])[1])
        .filter(Boolean)
        .map(Number);
      return { running: pids.length > 0, pids };
    }
    // -l gives "<pid> <command>" so we can drop false positives: this very server, and
    // anything running out of the LLMSwapper directory, whose path contains "claude".
    const out = execFileSync('pgrep', ['-fl', 'claude'], { encoding: 'utf8', timeout: 5000 });
    const pids = out.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/llmswapper|server\.js/i.test(line))
      .map((line) => Number(line.split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n) && n !== process.pid && n !== process.ppid);
    return { running: pids.length > 0, pids };
  } catch {
    return { running: false, pids: [] };
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function pruneBackups() {
  try {
    const dirs = fs.readdirSync(P.backupsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const name of dirs.slice(0, Math.max(0, dirs.length - MAX_BACKUPS))) {
      fs.rmSync(path.join(P.backupsDir(), name), { recursive: true, force: true });
    }
  } catch { /* pruning is best effort; never block a swap on it */ }
}

/**
 * Snapshots both credentials and .claude.json. Credentials go through the abstraction
 * and are written out AS a file, so a macOS Keychain backup restores just as easily.
 * Throws on failure - a swap without a backup must not proceed.
 */
function backupNow(tag, target) {
  const tg = asTarget(target);
  P.ensureDirs();
  const dir = path.join(P.backupsDir(), `${stamp()}${tag ? '-' + tag : ''}`);
  fs.mkdirSync(dir, { recursive: true });

  const saved = [];
  const creds = credIO(tg).read();
  if (creds && Object.keys(creds).length) {
    P.writeJsonAtomic(path.join(dir, 'credentials.json'), creds, 0o600);
    saved.push('credentials.json');
  }
  if (fs.existsSync(tg.claudeJsonPath)) {
    fs.copyFileSync(tg.claudeJsonPath, path.join(dir, 'claude.json'));
    saved.push('claude.json');
  }
  if (saved.length === 0) throw new Error('No se encontró ninguna config de Claude que respaldar - swap abortado');
  pruneBackups();
  // Remember which target this backup belongs to, so a restore lands in the right place.
  try { P.writeJsonAtomic(path.join(dir, 'target.json'), { id: tg.id, claudeJsonPath: tg.claudeJsonPath }, 0o600); } catch { /* best effort */ }
  return { dir, saved };
}

function sameBytes(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

function restoreFrom(dir, target) {
  const tg = asTarget(target);
  const restored = [];
  const credBackup = path.join(dir, 'credentials.json');
  if (fs.existsSync(credBackup)) {
    // Back to whichever store the target uses - Keychain on macOS host, file on WSL/others.
    credIO(tg).write(P.readJsonFile(credBackup));
    restored.push('credentials');
  }
  const jsonBackup = path.join(dir, 'claude.json');
  if (fs.existsSync(jsonBackup) && !sameBytes(tg.claudeJsonPath, jsonBackup)) {
    // Atomic, like every other write to a live config. copyFileSync truncates the target
    // first, so a failure partway through would leave the real ~/.claude.json - 130 KB of
    // projects, history and mcpServers - as an unparseable fragment. This is the last line
    // of defence; it is the one place that must not be able to fail halfway.
    // Skipped when the live file is still byte-for-byte the backup: the swap was refused
    // before it touched it, and a second refused write would turn "nothing changed" into
    // "LA RESTAURACIÓN FALLÓ, restaura a mano" - which is not true.
    P.writeJsonAtomic(tg.claudeJsonPath, P.readJsonFile(jsonBackup));
    restored.push(tg.claudeJsonPath);
  }
  return restored;
}

/**
 * Push a freshly rotated pair into the LIVE session, but only if that session is still
 * this account's. Refreshing kills the previous refresh token, so leaving the live file
 * holding it would log the user out of their CLI - but writing it blindly is worse: a
 * swap, or a manual `claude /login`, can hand the live session to a different account
 * while the refresh is in flight, and the sync would then silently drag it back.
 *
 * The token comparison is what proves ownership. `activeId` cannot: a swap writes the new
 * credentials and only calls setActive() at the very end, after a network round trip, so
 * for seconds at a time the live session and activeId disagree by design.
 * Returns true when it actually wrote.
 */
function syncLiveCredentials(previousRefreshToken, fresh) {
  if (!previousRefreshToken) return false;
  let live;
  try {
    live = credentials.read();
  } catch {
    return false; // cannot read the live session -> certainly do not overwrite it
  }
  if (!live || !live.claudeAiOauth) return false;
  if (live.claudeAiOauth.refreshToken !== previousRefreshToken) return false;
  writeCredentials(null, fresh);
  return true;
}

// --- the two surgical mutations, split out so the self-check can drive them ---

/**
 * Replaces ONLY claudeAiOauth. mcpOAuth and anything else survives untouched.
 * Pass a path to operate on a specific file (the self-check does); omit it to use
 * whatever backend this platform really uses.
 */
function writeCredentials(target, oauth) {
  const io = credIO(target); // null -> host backend; string -> file path; target -> per kind
  const current = io.read() || {};
  current.claudeAiOauth = {
    accessToken: oauth.accessToken,
    // null, never ''. Claude Code reads an EMPTY-STRING refreshToken as its "this token is
    // dead, I already cleared it" sentinel, so writing '' would hand it a credential it
    // refuses before trying. An absent or null one is simply "nothing to renew with", which
    // is the truth for a pasted token, and it uses the access token directly. (Verified in
    // claude.exe 2.1.258: the refresh routine returns "no_refresh_token" and the client is
    // built with the access token anyway.)
    refreshToken: oauth.refreshToken || null,
    expiresAt: oauth.expiresAt,
    refreshTokenExpiresAt: oauth.refreshTokenExpiresAt ?? null,
    // NEVER an empty array. A credentials blob whose scopes are missing or empty makes Claude
    // Code print "Not logged in - Please run /login" and exit 1 - verified live. user:inference
    // is the floor that still authenticates, so an account that somehow lost its scopes
    // degrades to a working session rather than to a locked-out one.
    scopes: (Array.isArray(oauth.scopes) && oauth.scopes.length) ? oauth.scopes : ['user:inference'],
    subscriptionType: oauth.subscriptionType || 'max',
    rateLimitTier: oauth.rateLimitTier || null,
  };
  io.write(current);
  return current;
}

/** Sets oauthAccount and drops stale per-account caches. Every other key is untouched. */
function writeClaudeJson(claudeJsonPath, profile) {
  const current = P.readJsonIfExists(claudeJsonPath, null);
  if (!current || typeof current !== 'object') {
    throw new Error(`${claudeJsonPath} no existe o no es un objeto JSON - swap abortado`);
  }
  const before = Object.keys(current).length;
  current.oauthAccount = { ...profile, profileFetchedAt: Date.now() };
  const dropped = STALE_CACHE_KEYS.filter((k) => k in current);
  for (const k of dropped) delete current[k];

  // Guard against a mutation bug silently gutting a 132KB config.
  const after = Object.keys(current).length;
  if (after < before - dropped.length) {
    throw new Error(`Comprobación de integridad fallida: ${before} claves antes, ${after} después - swap abortado`);
  }
  P.writeJsonAtomic(claudeJsonPath, current);
  return { dropped, keysBefore: before, keysAfter: after };
}

/**
 * The oauthAccount block to write for an account with no profile of its own.
 *
 * `claude setup-token` tokens cannot be resolved to an identity - /api/oauth/profile answers them
 * 403 - so there is no email, no accountUuid and no organization to write, and inventing one
 * would put a fake address in the user's config. What we do have is the name the user gave the
 * account in the panel, and that is what goes in.
 *
 * It lands in `emailAddress` because that is the field Claude Code actually renders: verified by
 * running /status against a synthetic block, where `Email:` and `Organization:` are shown and
 * `displayName` is ignored entirely. So writing only displayName would leave /status saying
 * "Login method: Claude Max account" and nothing else - the state this replaces.
 *
 * organizationName is pinned to "LLMSwapper" rather than left null. Not because there is such
 * an organization - there is not - but because Claude Code SYNTHESISES "<email>'s Organization"
 * from the email when the field is empty, and that invented possessive reads like a real org the
 * account belongs to. Naming the panel instead says plainly where the identity came from, which
 * is the one true thing available about it.
 *
 * The practical upshot for the user: whatever you call the account in the panel is what /status
 * shows. Name it with your real email and /status reads exactly as it did before.
 */
function identityFromLabel(account) {
  const name = (account && account.label) || null;
  return {
    accountUuid: null,
    emailAddress: name,
    displayName: name,
    fullName: name,
    organizationUuid: null,
    organizationName: PANEL_ORG,
    organizationRole: 'admin',
    workspaceRole: null,
    organizationType: null,
    organizationRateLimitTier: null,
    userRateLimitTier: null,
  };
}

/**
 * Strip the previous account's identity out of a config we are handing to an account that has
 * none of its own.
 *
 * Leaving oauthAccount behind is not harmless. Claude Code does not cross-check it against the
 * token unless the token carries user:profile (verified: with an inference-only token a
 * deliberately WRONG oauthAccount is left untouched and displayed), so the CLI would sit there
 * naming the account you just swapped AWAY from. Dropping the key leaves it with no claim about
 * identity, which is exactly what we know.
 */
function clearClaudeJsonIdentity(claudeJsonPath) {
  const current = P.readJsonIfExists(claudeJsonPath, null);
  if (!current || typeof current !== 'object') {
    throw new Error(`${claudeJsonPath} no existe o no es un objeto JSON - swap abortado`);
  }
  const before = Object.keys(current).length;
  const dropped = STALE_CACHE_KEYS.filter((k) => k in current);
  for (const k of dropped) delete current[k];
  const hadAccount = 'oauthAccount' in current;
  if (hadAccount) delete current.oauthAccount;

  const after = Object.keys(current).length;
  const expected = before - dropped.length - (hadAccount ? 1 : 0);
  if (after !== expected) {
    throw new Error(`Comprobación de integridad fallida: ${before} claves antes, ${after} después - swap abortado`);
  }
  P.writeJsonAtomic(claudeJsonPath, current);
  return { dropped, clearedIdentity: hadAccount, keysBefore: before, keysAfter: after };
}

/**
 * What a Claude config currently holds, straight off disk. Pass a configDir to read an
 * isolated login (CLAUDE_CONFIG_DIR=... claude /login) instead of the live one, so a
 * second account can be captured without disturbing the session you are using.
 */
function readCurrentIdentity(configDir, targetId) {
  // Precedence: an explicit isolated-login dir wins; otherwise read the target's live
  // files (host backend, or a WSL distro's files over its share).
  let jsonFile;
  let cred;
  if (configDir) {
    jsonFile = path.join(configDir, '.claude.json');
    cred = P.readJsonIfExists(path.join(configDir, '.credentials.json'), null);
  } else {
    const tg = asTarget(targetId);
    jsonFile = tg.claudeJsonPath;
    cred = credIO(tg).read();
  }
  const oauth = cred && cred.claudeAiOauth;
  if (!oauth || !oauth.accessToken) return null;
  const cj = P.readJsonIfExists(jsonFile, null) || {};
  return { oauth, profile: cj.oauthAccount || null, userID: cj.userID || null };
}

/**
 * The other direction of the same problem, and the one that actually bites.
 *
 * Claude Code renews its own session. Refreshing ROTATES the refresh token: the new pair
 * lands in the live credentials and the previous token dies on Anthropic's side. The copy
 * in accounts.json is now a dead token, and nothing says so until the keep-alive tries it
 * weeks later and the account can only be recovered with a login - the one thing this app
 * exists to avoid. Nothing to do with rebooting; it is what normal use looks like.
 *
 * Adopting the live pair is only safe if we know whose it is, and the tokens themselves
 * carry no identity. `oauthAccount` in ~/.claude.json names who Claude Code believes it is
 * signed in as, but it can go stale relative to the tokens, so it is trusted only when it
 * AGREES with our own activeId. Both sources naming the same account means the identity
 * never changed and only the pair moved on - exactly the case here. Any disagreement is
 * left alone: the user imports, and no account gets another one's tokens written into it.
 *
 * Returns the id it healed, or null.
 */
function adoptLiveTokens(store) {
  const activeId = store.load().activeId;
  if (!activeId) return null;
  const account = store.get(activeId);
  if (!account || !account.oauth) return null;

  let live;
  try { live = credentials.read(); } catch { return null; }
  const liveOauth = live && live.claudeAiOauth;
  if (!liveOauth || !liveOauth.refreshToken) return null;
  if (liveOauth.refreshToken === account.oauth.refreshToken) return null; // nothing drifted

  // A detached file mount (paths.js) is a frozen copy of ~/.claude.json: it would "agree" with
  // activeId for ever while the live credentials move on to whatever the host logged into,
  // and that pair would be grafted onto this account. Same gate writeJsonAtomic applies.
  const jsonPath = P.claudeJsonPath();
  if (P.isDetachedMount(jsonPath)) return null;
  const cj = P.readJsonIfExists(jsonPath, null) || {};
  const uuid = cj.oauthAccount && cj.oauthAccount.accountUuid;
  if (!uuid || store.idFor({ accountUuid: uuid }) !== activeId) return null;

  // Merge rather than replace: the live file carries the pair, the store may know more
  // about the account (subscriptionType, rateLimitTier) than a bare credentials blob does.
  store.update(activeId, { oauth: { ...account.oauth, ...liveOauth } });
  return activeId;
}

/**
 * Which stored account is live in a target RIGHT NOW, read from that target's config
 * rather than our store - so a WSL environment we have never swapped on still shows its
 * real current account as "in use". Matches by accountUuid; null if it maps to no stored
 * account (or the files are unreadable). Never persists; purely a display hint.
 */
function detectActiveId(targetId, store) {
  try {
    const tg = asTarget(targetId);
    const cj = P.readJsonIfExists(tg.claudeJsonPath, null);
    const uuid = cj && cj.oauthAccount && cj.oauthAccount.accountUuid;
    if (uuid) {
      const id = store.idFor({ accountUuid: uuid });
      if (store.get(id)) return id;
    }
    // No identity to match on - either the config belongs to a pasted inference-only token, or
    // we cleared oauthAccount when swapping one in. The live ACCESS TOKEN is then the only thing
    // that says who is in use, and comparing it against what we stored is exact: same string,
    // same account. Costs nothing and needs no network.
    const live = credIO(tg).read();
    const token = live && live.claudeAiOauth && live.claudeAiOauth.accessToken;
    if (!token) return null;
    const match = store.list().find((a) => a.oauth && a.oauth.accessToken === token);
    return match ? match.id : null;
  } catch {
    return null;
  }
}

async function ensureFreshToken(account, deps) {
  const { store, oauth: oauthLib } = deps;
  const o = account.oauth || {};
  const needsRefresh = o.expiresAt && o.expiresAt - Date.now() < 5 * 60 * 1000;
  if (!needsRefresh) return account;
  // A pasted token has no refresh token by construction and is valid for a year, so this is not
  // reached until it genuinely expires. When it does, no amount of retrying helps: the only
  // remedy is a new token, so say that rather than "vuelve a añadir esta cuenta".
  if (!o.refreshToken) {
    throw new Error('El token ha caducado y no se puede renovar (no tiene refresh token). '
      + 'Genera uno nuevo con "claude setup-token" y pégalo otra vez en el panel.');
  }

  const fresh = oauthLib.toStoredOauth(await oauthLib.refresh(o.refreshToken), o);
  // Persist BEFORE using it: a crash must not leave the live file newer than the store.
  return store.update(account.id, { oauth: fresh }) || { ...account, oauth: fresh };
}

/** Steps 1-3 only. Reports what would change, writes nothing. */
async function dryRun(id, deps, targetId) {
  const tg = asTarget(targetId);
  const account = deps.store.get(id);
  if (!account) throw new Error(`Cuenta desconocida: ${id}`);
  const procs = targets.detectRunning(tg);
  const cj = P.readJsonIfExists(tg.claudeJsonPath, null) || {};
  const o = account.oauth || {};
  return {
    ok: true,
    target: tg.id,
    targetLabel: tg.label,
    account: deps.store.publicAccount(id, tg.id),
    claudeRunning: procs.running,
    pids: procs.pids,
    tokenRefreshNeeded: !!(o.expiresAt && o.expiresAt - Date.now() < 5 * 60 * 1000),
    willWrite: [tg.fileBackend ? tg.credentialsPath : credentials.describeBackend().location, tg.claudeJsonPath],
    willDropCacheKeys: STALE_CACHE_KEYS.filter((k) => k in cj),
    currentEmail: (cj.oauthAccount && cj.oauthAccount.emailAddress) || null,
    targetEmail: account.email,
  };
}

// ponytail: one lock for every target; per-target locks if host and WSL swaps ever need to overlap.
let inFlight = null;

/**
 * A manual swap and the rotation monitor can land in the same second, and two swaps
 * interleaving backup/write/verify/rollback on the same two files leave activeId and the
 * files naming different accounts. The second is refused, not queued: by the time it ran,
 * the account it wanted might already be the one on disk.
 */
async function swapTo(id, deps, targetId) {
  if (inFlight) { const e = new Error('Ya hay un cambio de cuenta en curso'); e.status = 409; throw e; }
  inFlight = swapNow(id, deps, targetId).finally(() => { inFlight = null; });
  return inFlight;
}

/** The whole point of the product. Follows the 7 steps in ARCHITECTURE.md in order. */
async function swapNow(id, deps, targetId) {
  const tg = asTarget(targetId);
  const { store, oauth: oauthLib, usage } = deps;
  let account = store.get(id);
  if (!account) throw new Error(`Cuenta desconocida: ${id}`);
  if (!account.oauth || !account.oauth.accessToken) {
    throw new Error('Esta cuenta no tiene token guardado - vuelve a añadirla');
  }
  // Refuse BEFORE touching anything. The credentials sit in a directory mount and would reach
  // the host, only for the ~/.claude.json write to be refused and the rollback to write them
  // a second time - every 3 minutes, with auto-rotation on.
  P.assertMountAttached(tg.claudeJsonPath);

  const warnings = [];
  const where = tg.kind === 'host' ? '' : ` en ${tg.label}`;

  // 1. running sessions keep their in-memory token; the swap lands on new ones.
  const procs = targets.detectRunning(tg);
  if (procs.running) {
    warnings.push(`Claude Code está abierto${where} (${procs.pids.length} proceso(s)). El cambio se aplicará a sesiones NUEVAS.`);
  }

  // 2. backup first, always. (the target's own files)
  const backup = backupNow(id, tg);

  // 3. refresh if the token is about to die. (updates the shared store)
  try {
    account = await ensureFreshToken(account, deps);
  } catch (err) {
    throw new Error(`No se pudo refrescar el token: ${err.message}`);
  }

  // 4-7. from here on, any failure rolls back both files of THIS target.
  let mutation;
  try {
    writeCredentials(tg, account.oauth);

    // An identity is ALWAYS written, one way or another. Leaving the previous account's behind
    // would have Claude Code naming the account you just swapped away from - it only reconciles
    // that block against the token when the token carries user:profile. Clearing it outright was
    // the first fix and it was worse in daily use: /status then showed no account at all.
    mutation = writeClaudeJson(tg.claudeJsonPath, account.profile || identityFromLabel(account));

    // 6. prove the new token actually works. Must be fetchRaw, NOT fetchFor - the latter
    // can serve a cached reading, which would "verify" a token it never actually used.
    // The token is the same in any environment, so this check is target-independent.
    usage.invalidate(id);
    let check = null;
    try {
      if (store.canReadUsage(account)) {
        // Seed the cache with it: the UI would otherwise spend another API call on data
        // this swap just fetched, and that amplification is what trips the rate limit.
        check = usage.prime(id, usage.normalize(await usage.fetchRaw(account.oauth.accessToken), id));
      } else {
        // An inference-only token is answered 403 by the usage endpoint for ever, so asking it
        // would prove nothing and would spend one of the app's ~5 calls per 5 minutes. The
        // profile endpoint settles the same question for free: it answers 401 when the token is
        // dead and 403-with-a-scope-complaint when it is alive but limited - and Anthropic only
        // checks scopes on a token it has already authenticated, so that 403 IS the proof.
        await oauthLib.probeToken(account.oauth.accessToken);
      }
    } catch (err) {
      // 401/403 means the token is genuinely dead: roll back. A 429 or a network blip
      // says nothing about the token, so keep the swap and be explicit that we could
      // not confirm it rather than reverting a change that is probably fine.
      if (err.status === 401 || err.status === 403) {
        throw new Error(`El token de esta cuenta ya no es válido (${err.status})`);
      }
      warnings.push(`No se pudo confirmar el cambio contra la API (${err.message}). Las credenciales se han escrito igualmente.`);
    }

    // 7. only now is it official - for THIS target.
    store.setActive(id, tg.id);

    return {
      ok: true,
      target: tg.id,
      targetLabel: tg.label,
      verified: check !== null,
      warnings,
      backup: backup.dir,
      droppedCacheKeys: mutation.dropped,
      usage: check,
      account: store.publicAccount(id, tg.id),
    };
  } catch (err) {
    let rollback = 'restaurado';
    try {
      restoreFrom(backup.dir, tg);
    } catch (restoreErr) {
      rollback = `LA RESTAURACIÓN FALLÓ (${restoreErr.message}) - restaura a mano desde ${backup.dir}`;
    }
    const e = new Error(`${err.message} - config ${rollback}`);
    e.backup = backup.dir;
    throw e;
  }
}

module.exports = {
  STALE_CACHE_KEYS, MAX_BACKUPS,
  detectClaudeProcesses, backupNow, restoreFrom, restoreFromBackup: restoreFrom,
  writeCredentials, syncLiveCredentials, adoptLiveTokens, detectActiveId, writeClaudeJson,
  clearClaudeJsonIdentity, identityFromLabel,
  readCurrentIdentity, ensureFreshToken, dryRun, swapTo, asTarget,
};

if (require.main === module) {
  const assert = require('node:assert');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-swap-'));
  const credPath = path.join(tmp, '.credentials.json');
  const cjPath = path.join(tmp, '.claude.json');

  fs.writeFileSync(credPath, JSON.stringify({
    mcpOAuth: { 'srv|abc': { serverName: 'srv', accessToken: 'keepme' } },
    claudeAiOauth: { accessToken: 'sk-ant-OLD', refreshToken: 'sk-ant-OLDR', expiresAt: 1, scopes: ['a'] },
  }, null, 2));

  fs.writeFileSync(cjPath, JSON.stringify({
    numStartups: 42,
    projects: { '/a/b': { history: [1, 2, 3] } },
    mcpServers: { x: { command: 'y' } },
    tipsHistory: { tip: 1 },
    userID: 'INSTALL-ID-MUST-SURVIVE',
    oauthAccount: { emailAddress: 'old@x.com', accountUuid: 'old-uuid' },
    modelAccessCache: [],
    hasAvailableSubscription: false,
    overageCreditGrantCache: { a: 1 },
    somethingUnrelated: { deep: { nested: true } },
  }, null, 2));

  const newProfile = { accountUuid: 'new-uuid', emailAddress: 'new@x.com', displayName: 'New' };
  writeCredentials(credPath, { accessToken: 'sk-ant-NEW', refreshToken: 'sk-ant-NEWR', expiresAt: 999, scopes: ['b'], subscriptionType: 'max' });
  const res = writeClaudeJson(cjPath, newProfile);

  const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  assert.strictEqual(cred.claudeAiOauth.accessToken, 'sk-ant-NEW');
  assert.strictEqual(cred.mcpOAuth['srv|abc'].accessToken, 'keepme', 'mcpOAuth must survive');

  const cj = JSON.parse(fs.readFileSync(cjPath, 'utf8'));
  assert.strictEqual(cj.oauthAccount.emailAddress, 'new@x.com');
  assert.strictEqual(cj.userID, 'INSTALL-ID-MUST-SURVIVE', 'userID must not be touched');
  assert.strictEqual(cj.numStartups, 42);
  assert.deepStrictEqual(cj.projects, { '/a/b': { history: [1, 2, 3] } }, 'projects must survive');
  assert.deepStrictEqual(cj.mcpServers, { x: { command: 'y' } }, 'mcpServers must survive');
  assert.deepStrictEqual(cj.tipsHistory, { tip: 1 });
  assert.deepStrictEqual(cj.somethingUnrelated, { deep: { nested: true } });
  for (const k of ['modelAccessCache', 'hasAvailableSubscription', 'overageCreditGrantCache']) {
    assert.ok(!(k in cj), `stale cache key ${k} should have been dropped`);
  }
  assert.strictEqual(res.dropped.length, 3);

  assert.strictEqual(fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp')).length, 0, 'no tmp files left behind');

  // A corrupt target must abort rather than be overwritten.
  const badPath = path.join(tmp, 'bad.json');
  fs.writeFileSync(badPath, '{ not json');
  assert.throws(() => writeClaudeJson(badPath, newProfile), /no es valid|not valid|JSON/i);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('swap.js self-check OK');
}
