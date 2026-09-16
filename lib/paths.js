'use strict';
// Locations of Claude Code's real config + our own data, plus the only atomic-IO
// implementation in the project. swap.js and store.js both route through here.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..');

/**
 * Whether we are running inside a container, which changes what this app can honestly claim.
 *
 * Two signals, and both are needed. SWAPPER_IN_CONTAINER is set by our own Dockerfile and is the
 * reliable one; /.dockerenv catches an image someone built by hand without it. Podman and some
 * Kubernetes runtimes create neither, which is exactly why the env var exists - a wrong answer
 * here makes the panel report "Claude Code is not running" when what it means is "I cannot see".
 */
function inContainer() {
  if (process.env.SWAPPER_IN_CONTAINER === '1') return true;
  try { return fs.existsSync('/.dockerenv'); } catch { return false; }
}

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// NOTE: .claude.json is a SIBLING of the .claude directory, not inside it.
// When CLAUDE_CONFIG_DIR is set, Claude Code keeps .claude.json inside it instead.
function claudeJsonPath() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

const credentialsPath = () => path.join(claudeHome(), '.credentials.json');
const appRoot = () => APP_ROOT;
const dataDir = () => path.join(APP_ROOT, 'data');
const backupsDir = () => path.join(dataDir(), 'backups');
const accountsPath = () => path.join(dataDir(), 'accounts.json');

/**
 * data/ holds live OAuth tokens. chmod 0600 is close to a no-op on Windows - Node only
 * maps the read-only bit - so lock the directory down with a real NTFS ACL instead and
 * let new files inherit it. Runs once; a marker file keeps it off the hot path.
 */
function hardenDataDir(dir) {
  if (process.platform !== 'win32') return;
  const marker = path.join(dir, '.acl-applied');
  if (fs.existsSync(marker)) return;

  let outcome;
  try {
    if (!process.env.USERNAME) throw new Error('USERNAME no está definido');
    const domain = process.env.USERDOMAIN || process.env.COMPUTERNAME;
    const user = (domain ? domain + '\\' : '') + process.env.USERNAME;
    // icacls is not always on PATH for a spawned process; address it absolutely.
    const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    if (!fs.existsSync(icacls)) throw new Error(`no se encontró ${icacls}`);
    require('node:child_process').execFileSync(
      icacls, [dir, '/inheritance:r', '/grant:r', user + ':(OI)(CI)F'],
      { stdio: 'ignore', timeout: 10000, windowsHide: true },
    );
    outcome = 'ACL restricted to the current user\n';
  } catch (err) {
    // Not fatal: the app still works, the folder is just protected only by the user
    // profile. It has to be said out loud, though - a security downgrade nobody is told
    // about is the worst kind. Fails on exFAT/FAT32 sticks and on mapped network drives,
    // where /inheritance:r does not apply.
    outcome = `ACL NOT applied: ${err.message}\n`;
    console.warn('  aviso: no se pudo restringir la ACL de data/ - queda protegida solo por tu perfil de usuario');
  }
  // The marker is written either way. ensureDirs() runs on every store read and write, so
  // without it a failing icacls would be re-spawned on each one, for ever.
  try { fs.writeFileSync(marker, outcome); } catch { /* best effort */ }
}

function ensureDirs() {
  const dir = dataDir();
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(backupsDir(), { recursive: true });
  if (fresh || !fs.existsSync(path.join(dir, '.acl-applied'))) hardenDataDir(dir);
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Throws a message naming the file, so a corrupt config is diagnosable. */
function readJsonFile(p) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error(`File not found: ${p}`);
      e.code = 'ENOENT';
      throw e;
    }
    throw new Error(`Cannot read ${p}: ${err.message}`);
  }
  const clean = stripBom(text).trim();
  if (!clean) throw new Error(`${p} is empty - refusing to treat that as valid JSON`);
  try {
    return JSON.parse(clean);
  } catch (err) {
    throw new Error(`${p} is not valid JSON (${err.message}). Refusing to overwrite it.`);
  }
}

function readJsonIfExists(p, fallback = null) {
  try {
    return readJsonFile(p);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// ponytail: Windows antivirus/indexers briefly lock a file mid-rename. A few short
// retries turn a hard failure into a non-event; anything past that is a real problem.
function renameWithRetry(from, to, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const transient = err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY';
      if (!transient || i === attempts - 1) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1));
    }
  }
}

/**
 * A file bind-mounted into a container (docker: -v ~/.claude.json:/home/node/.claude.json) is a
 * mount point, so it sits on a different device than the directory around it. Nothing else
 * that this app writes ever does.
 */
function isMountedFile(p) {
  try { return fs.statSync(p).dev !== fs.statSync(path.dirname(p)).dev; } catch { return false; }
}

/**
 * On a Linux host the mount pins the INODE, not the path. Claude Code rewrites ~/.claude.json
 * by writing a new file and renaming it over the old one, so a minute after it starts the host
 * path points at a new inode and the container still holds the old, now unlinked one: link
 * count zero. Reads there are stale and writes go nowhere the host can see. Docker Desktop
 * (Windows, macOS) resolves the share by path, so the count stays at one and this never fires.
 */
function isDetachedMount(p) {
  try { return fs.statSync(p).nlink === 0; } catch { return false; }
}

/** The one message for it, thrown by every path that would otherwise write into the void. */
function assertMountAttached(p) {
  if (isDetachedMount(p)) {
    throw new Error(`${p} montado en el contenedor ya no es el fichero que ve el host (Claude Code lo reemplazó): reinicia el contenedor, o monta el directorio en vez del fichero (README, Docker)`);
  }
}

/** Open, write, fsync, close. Shared by the tmp file and the in-place path below. */
function writeSynced(file, body, mode) {
  let fd;
  try {
    fd = fs.openSync(file, 'w', mode);
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Write JSON via tmp-in-same-directory + fsync + rename, so a crash can never leave
 * a half-written config. Preserves the existing file mode when the target exists.
 *
 * One place the rename can never work: a file bind-mounted into a container
 * (docker: -v ~/.claude.json:/home/node/.claude.json). The target is a mount point,
 * and Linux refuses rename() over a mount point with EBUSY - every time, not
 * transiently. There the file is rewritten in place instead: not atomic, but the swap
 * has already backed the file up, and without it neither the swap nor its rollback
 * could ever succeed inside the container. Recognised up front by the device check,
 * with the EBUSY/EXDEV fallback after the rename as the net under it.
 */
function writeJsonAtomic(p, obj, mode) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });

  let finalMode = mode;
  if (finalMode === undefined) {
    try {
      finalMode = fs.statSync(p).mode & 0o777;
    } catch {
      finalMode = 0o600;
    }
  }

  const tmp = path.join(dir, `${path.basename(p)}.${process.pid}.tmp`);
  const body = JSON.stringify(obj, null, 2);
  // Sanity gate: never let a serialisation bug truncate a real config to "{}".
  if (!body || body.length < 2) throw new Error(`Refusing to write empty JSON to ${p}`);

  // Checked before either path: a name that resolves to an inode with no links is only ever
  // the detached mount described above, and writing there is a swap the host never sees.
  assertMountAttached(p);
  if (isMountedFile(p)) {
    writeSynced(p, body, finalMode);
  } else {
    writeSynced(tmp, body, finalMode);
    try {
      renameWithRetry(tmp, p);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      if (err.code !== 'EBUSY' && err.code !== 'EXDEV') throw err;
      writeSynced(p, body, finalMode);
    }
  }
  try { fs.chmodSync(p, finalMode); } catch { /* not supported everywhere */ }
}

module.exports = {
  inContainer, isMountedFile, isDetachedMount, assertMountAttached,
  appRoot, claudeHome, claudeJsonPath, credentialsPath,
  dataDir, backupsDir, accountsPath, ensureDirs, hardenDataDir,
  readJsonFile, readJsonIfExists, writeJsonAtomic, stripBom,
};
