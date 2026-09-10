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
const P = require('./paths');

// Claude Code's Keychain item. Overridable because it is the one value that could not
// be confirmed from the Windows build - if a Mac disagrees, set SWAPPER_KEYCHAIN_SERVICE
// rather than editing code. `security dump-keychain | grep -i claude` reveals the truth.
const SERVICE = process.env.SWAPPER_KEYCHAIN_SERVICE || 'Claude Code-credentials';
const ACCOUNT = process.env.USER || process.env.LOGNAME || process.env.USERNAME || '';

const isMac = () => process.platform === 'darwin';

/**
 * The Keychain is a MACHINE-wide store: it knows nothing about CLAUDE_CONFIG_DIR. A caller
 * that points CLAUDE_CONFIG_DIR at a throwaway directory - an isolated login, or the test
 * suite - is asking to work somewhere that is NOT the real config, and honouring the Keychain
 * there reads (and far worse, WRITES) the live account's credentials anyway.
 *
 * That is not hypothetical: it is how `node test.js` on a Mac replaced the real item with
 * fixture tokens, on a suite whose comments state it "never touches the real credentials"
 * because on Windows and Linux redirecting the directory genuinely is enough. An explicit
 * CLAUDE_CONFIG_DIR therefore forces the file backend, on every platform.
 */
const useKeychain = () => isMac() && !process.env.CLAUDE_CONFIG_DIR;

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
  try {
    const args = ['find-generic-password', '-s', SERVICE];
    if (ACCOUNT) args.push('-a', ACCOUNT);
    args.push('-w');
    const out = execFileSync('security', args, { encoding: 'utf8', timeout: 15000 });
    const text = (out || '').trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch (err) {
    // 44 is `security`'s "item not found", and ENOENT means there is no `security` binary
    // at all - the two honest forms of "no credentials in a Keychain here".
    if (err.status === 44 || err.code === 'ENOENT') return null;
    const e = new Error(`No se pudo leer el Keychain (${SERVICE}): ${err.message}`);
    e.keychain = true;
    throw e;
  }
}

function keychainWrite(obj) {
  const args = ['add-generic-password', '-U', '-s', SERVICE];
  if (ACCOUNT) args.push('-a', ACCOUNT);
  // -w takes the secret on argv, which is briefly visible to `ps` on a multi-user box.
  // `security` offers no stdin path for this, and it is what other tools do too.
  args.push('-w', JSON.stringify(obj));
  execFileSync('security', args, { stdio: 'ignore', timeout: 15000 });
}

/** Where credentials actually live on this machine, for diagnostics and messages. */
function describeBackend() {
  if (!useKeychain()) return { kind: 'file', location: P.credentialsPath() };
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
  if (useKeychain()) {
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
  if (useKeychain() && keychainRead() !== null) {
    keychainWrite(obj);
    return { kind: 'keychain', location: `Keychain: ${SERVICE}` };
  }
  P.writeJsonAtomic(P.credentialsPath(), obj, 0o600);
  return { kind: 'file', location: P.credentialsPath() };
}

module.exports = { SERVICE, read, write, describeBackend, isMac };

if (require.main === module) {
  const backend = describeBackend();
  const creds = read();
  console.log(`backend : ${backend.kind} (${backend.location})`);
  console.log(`legible : ${creds ? 'sí' : 'no'}`);
  if (creds) console.log(`claves  : ${Object.keys(creds).join(', ')}`);
}
