'use strict';
/**
 * The one place that knows WHERE Claude Code keeps its credentials.
 *
 * Windows / Linux: a plain file at ~/.claude/.credentials.json
 * macOS:           the login Keychain, via the `security` binary
 *
 * Everything else in this project talks to credentials through read()/write() and
 * never touches either backend directly.
 */
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const P = require('./paths');

/**
 * Claude Code's Keychain item, read out of the claude 2.1.273 bundle rather than guessed:
 *
 *   security find-generic-password -a claude-code-user -w -s "Claude Code-credentials"
 *
 * With CLAUDE_CONFIG_DIR set the service takes a suffix derived from that directory,
 * `-<sha256(dir)[:8]>`, so every config dir owns its own item. That is also what keeps the
 * test suite off the real one: a throwaway CLAUDE_CONFIG_DIR names an item that cannot exist,
 * the read answers "not found", and everything falls through to the file.
 *
 * The hashed string is the variable's raw value, NFC-normalised, not a resolved path - and
 * CLAUDE_SECURESTORAGE_CONFIG_DIR, when set, replaces it (empty means "no suffix"). All read
 * out of the same bundle and confirmed on a Mac against a live Claude Code 2.1 login: the swap
 * lands in the item Claude Code reads, and the suite leaves the real one alone.
 * SWAPPER_KEYCHAIN_SERVICE still overrides the whole name, for a build that suffixes it
 * differently (`-local-oauth`, `-custom-oauth`); `security dump-keychain | grep -i claude`
 * shows what such a build wrote.
 */
function serviceName() {
  if (process.env.SWAPPER_KEYCHAIN_SERVICE) return process.env.SWAPPER_KEYCHAIN_SERVICE;
  const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir = secure !== undefined ? secure : (process.env.CLAUDE_CONFIG_DIR || '');
  const suffix = dir ? `-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}` : '';
  return `Claude Code-credentials${suffix}`;
}
const SERVICE = serviceName();

// Current builds file the item under a fixed account name; older ones used the login user, and
// a Mac that has not run Claude Code since still holds that item. Read both, newest first, and
// write back to whichever was found. SWAPPER_KEYCHAIN_ACCOUNT pins one.
const ACCOUNTS = process.env.SWAPPER_KEYCHAIN_ACCOUNT
  ? [process.env.SWAPPER_KEYCHAIN_ACCOUNT]
  : ['claude-code-user', process.env.USER || process.env.LOGNAME || process.env.USERNAME].filter(Boolean);
let foundAccount = null;

const isMac = () => process.platform === 'darwin';

/**
 * null means "there is genuinely nothing here"; anything else THROWS.
 *
 * The distinction is not academic. Treating a denied Keychain prompt or a timeout as
 * absence made the swap read the backend twice and get two different answers: the backup
 * skipped the credentials (nothing to save, apparently) while the write, on a second
 * prompt the user did grant, overwrote the Keychain item - replacing the previous
 * account's refresh token with no copy of it anywhere. Failing loudly aborts the swap
 * before its first write instead.
 */
function keychainRead() {
  for (const account of ACCOUNTS) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
        { encoding: 'utf8', timeout: 15000 });
      const text = (out || '').trim();
      if (!text) continue;
      foundAccount = account;
      return JSON.parse(text);
    } catch (err) {
      // 44 is `security`'s "item not found" - try the next account name. ENOENT means there is
      // no `security` binary at all, so no name will do any better.
      if (err.status === 44) continue;
      // ENOENT: no `security` binary. 37/50: this account has no login keychain at all. Claude
      // Code treats both as "nothing stored" and uses the plain file, and so do we.
      if (err.code === 'ENOENT' || err.status === 37 || err.status === 50) return null;
      const e = new Error(`No se pudo leer el Keychain (${SERVICE}): ${err.message}`);
      e.keychain = true;
      throw e;
    }
  }
  return null;
}

function keychainWrite(obj) {
  // -w takes the secret on argv, which is briefly visible to `ps` on a multi-user box.
  // `security` offers no stdin path for this, and it is what other tools do too.
  execFileSync('security',
    ['add-generic-password', '-U', '-s', SERVICE, '-a', foundAccount || ACCOUNTS[0], '-w', JSON.stringify(obj)],
    { stdio: 'ignore', timeout: 15000 });
}

/** Where credentials actually live on this machine, for diagnostics and messages. */
function describeBackend() {
  if (!isMac()) return { kind: 'file', location: P.credentialsPath() };
  try {
    return keychainRead() !== null
      ? { kind: 'keychain', location: `Keychain: ${SERVICE}` }
      : { kind: 'file', location: P.credentialsPath() };
  } catch (err) {
    // Purely descriptive - /api/health must answer even when the Keychain will not.
    return { kind: 'keychain', location: `Keychain: ${SERVICE}`, error: err.message };
  }
}

/**
 * The full credentials object (including mcpOAuth and anything else), or null.
 * On macOS the Keychain wins, but a plain file is still honoured as a fallback -
 * some setups keep one, and refusing to read it would strand those users.
 */
function read() {
  if (isMac()) {
    const fromKeychain = keychainRead();
    if (fromKeychain) return fromKeychain;
  }
  return P.readJsonIfExists(P.credentialsPath(), null);
}

/**
 * Persist the full credentials object back to wherever it came from. Writing to the
 * Keychain when Claude Code reads a file (or the reverse) would silently do nothing,
 * so the destination is chosen by where credentials were actually found.
 * Throws if the Keychain cannot be read: better to fail than to guess a destination.
 */
function write(obj) {
  if (isMac() && keychainRead() !== null) {
    keychainWrite(obj);
    return { kind: 'keychain', location: `Keychain: ${SERVICE}` };
  }
  P.writeJsonAtomic(P.credentialsPath(), obj, 0o600);
  return { kind: 'file', location: P.credentialsPath() };
}

module.exports = { SERVICE, ACCOUNTS, read, write, describeBackend, isMac };

if (require.main === module) {
  const backend = describeBackend();
  const creds = read();
  console.log(`backend : ${backend.kind} (${backend.location})`);
  console.log(`legible : ${creds ? 'sí' : 'no'}`);
  if (creds) console.log(`claves  : ${Object.keys(creds).join(', ')}`);
}
