'use strict';
// Where a Codex swap writes: the host's $CODEX_HOME, or ~/.codex inside a running WSL distro,
// reached over the same \\wsl.localhost share lib/targets.js uses for Claude. Only the auth.json
// path differs per target; the account store is shared.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const P = require('../paths');
const claudeTargets = require('../targets');
const auth = require('./auth');

const HOST_LABELS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const SKIP_DISTROS = new Set(['docker-desktop', 'docker-desktop-data']);

function hostTarget() {
  const home = auth.codexHome();
  return { id: 'host', kind: 'host', label: HOST_LABELS[process.platform] || process.platform, home, authPath: auth.authPath(home) };
}

/** A distro counts once Codex has run there: its ~/.codex directory is reachable over the share. */
function resolveDistro(distro) {
  if (SKIP_DISTROS.has(distro)) return null;
  let home;
  try {
    home = claudeTargets.runWsl(['-d', distro, 'sh', '-c', 'printf %s "$HOME"']).trim();
  } catch {
    return null;
  }
  if (!home || home[0] !== '/') return null;
  for (const base of claudeTargets.uncBaseCandidates(distro)) {
    const dir = claudeTargets.wslPath(base, home, '.codex');
    try {
      if (fs.statSync(dir).isDirectory()) {
        return { id: `wsl:${distro}`, kind: 'wsl', label: distro, distro, home: dir, authPath: claudeTargets.wslPath(base, home, '.codex', 'auth.json') };
      }
    } catch { /* try the next UNC base */ }
  }
  return null;
}

// Detection spawns several wsl.exe calls; /api/codex/targets can be polled.
let cache = { at: 0, targets: null };
const CACHE_MS = 30 * 1000;

function list({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.targets && now - cache.at < CACHE_MS) return cache.targets;
  const targets = [hostTarget()];
  // listDistros never throws, and a Linux container has no wsl.exe to ask.
  if (process.platform === 'win32' && !P.inContainer()) {
    for (const distro of claudeTargets.listDistros()) {
      const t = resolveDistro(distro);
      if (t) targets.push(t);
    }
  }
  cache = { at: now, targets };
  return targets;
}

// Through the exports, so a test that replaces list() also redirects resolve().
const resolve = (id) => module.exports.list().find((t) => t.id === (id || 'host')) || null;

/**
 * Whether a Codex session runs in this target. The CLI is a native binary behind a node shim, so
 * the exact image name finds it; the Codex desktop app runs one too, and it is just as much an
 * open session. In a container the answer is `unknown`, never a confident false. Never throws.
 */
function detectRunning(target) {
  if (P.inContainer()) return { running: false, pids: [], unknown: true };
  const pidsOf = (out) => out.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
  try {
    if (target && target.kind === 'wsl') {
      const pids = pidsOf(claudeTargets.runWsl(['-d', target.distro, 'sh', '-c', 'pgrep -x codex || true']));
      return { running: pids.length > 0, pids };
    }
    if (!target || target.kind !== 'host') return { running: false, pids: [] };
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq codex.exe', '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      const pids = out.split(/\r?\n/).map((l) => (l.match(/^"codex\.exe","(\d+)"/i) || [])[1]).filter(Boolean).map(Number);
      return { running: pids.length > 0, pids };
    }
    const pids = pidsOf(execFileSync('pgrep', ['-x', 'codex'], { encoding: 'utf8', timeout: 5000 }));
    return { running: pids.length > 0, pids };
  } catch {
    // pgrep exits 1 when nothing matches.
    return { running: false, pids: [] };
  }
}

/* ---------------- long-lived Codex processes ----------------
 *
 * Codex reads auth.json once, when the process starts. A host that keeps one process alive across
 * many sessions never sees a swap: Paseo runs a `codex app-server` per agent and sends every new
 * message to it, so its agents went on spending the old account for days. Those are the npm CLI's
 * `codex app-server`, and Paseo recovers from losing one on its own - the agent goes to
 * "disconnected" and its next message spawns a fresh process, which reads the new auth.json.
 * The desktop app ships its own codex (...\OpenAI\Codex\bin\, Codex.app) and the app-server daemon
 * lives under ~/.codex/packages: neither is restarted from here; the desktop app is reported.
 */
const isCliAppServer = (cmd) => /(^|[\\/"'\s])codex(\.exe)?["']?\s+app-server\b/i.test(String(cmd || ''))
  && !/app-server-daemon|[\\/]OpenAI[\\/]Codex[\\/]bin[\\/]|\.app[\\/]/i.test(String(cmd || ''));
const isDesktopCodex = (cmd) => /[\\/]OpenAI[\\/]Codex[\\/]bin[\\/]|Codex\.app[\\/]/i.test(String(cmd || ''));

// The terminal `codex` talks to a managed daemon (`app-server --listen unix:// --managed-daemon`)
// that outlives each session just the same. Codex restarts it itself with `app-server daemon
// restart`; this finds the binary that daemon runs from, so no PATH is involved.
function daemonBin(cmd) {
  const c = String(cmd || '');
  if (!/app-server\s+--listen\b/.test(c) || !/--managed-daemon\b/.test(c)) return null;
  const m = c.match(/^"([^"]+)"/) || c.match(/^(\S+)/);
  return m ? m[1].replace(/^\\+\?\\/, '') : null;
}

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const parsePs = (out) => String(out).split(/\r?\n/)
  .map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
  .map((m) => ({ pid: Number(m[1]), cmd: m[2] }));

/** {pid, cmd} of the processes that might be Codex in a target. Throws if it cannot ask. */
function listProcesses(target) {
  if (target.kind === 'wsl') {
    return parsePs(claudeTargets.runWsl(['-d', target.distro, 'sh', '-c', 'ps -eo pid=,args= 2>/dev/null || true']));
  }
  if (process.platform === 'win32') {
    // tasklist has no command line; CIM does. Only at swap time, so its second of start-up is fine.
    return parsePs(execFileSync(path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }));
  }
  return parsePs(execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 5000 }));
}

/**
 * Stop every CLI `codex app-server` in a target so the next message starts one on the new account.
 * Never throws: a swap that already landed must not fail on this.
 * shortcut: it cannot read another process's CODEX_HOME, so an app-server on a different CODEX_HOME
 * is restarted too (harmlessly: it rereads its own auth.json); read the environment if that matters.
 */
function restartAppServers(target) {
  const out = { restarted: [], desktop: false, daemon: false };
  if (P.inContainer() || !target || (target.kind !== 'host' && target.kind !== 'wsl')) return out;
  let procs;
  try { procs = listProcesses(target); } catch { return out; }
  out.desktop = target.kind === 'host' && procs.some((p) => isDesktopCodex(p.cmd));
  for (const p of procs.filter((x) => isCliAppServer(x.cmd))) {
    try {
      if (target.kind === 'wsl') claudeTargets.runWsl(['-d', target.distro, 'kill', String(p.pid)]);
      else if (process.platform === 'win32') {
        execFileSync(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000, windowsHide: true });
      } else process.kill(p.pid, 'SIGTERM');
      out.restarted.push(p.pid);
    } catch { /* already gone */ }
  }
  // Only a daemon that is already running: restarting one is fine, starting one nobody asked for is not.
  const bin = procs.map((p) => daemonBin(p.cmd)).find(Boolean);
  if (bin) {
    try {
      if (target.kind === 'wsl') claudeTargets.runWsl(['-d', target.distro, bin, 'app-server', 'daemon', 'restart'], 30000);
      else execFileSync(bin, ['app-server', 'daemon', 'restart'], { stdio: 'ignore', timeout: 30000, windowsHide: true });
      out.daemon = true;
    } catch { /* it reports nothing useful when it fails; the warning simply does not claim it */ }
  }
  return out;
}

module.exports = { hostTarget, resolveDistro, list, resolve, detectRunning, restartAppServers, isCliAppServer, isDesktopCodex, daemonBin };

if (require.main === module) {
  const assert = require('node:assert');
  const path = require('node:path');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(require('node:os').tmpdir(), 'no-such-codex-home');
  try {
    const h = hostTarget();
    assert.strictEqual(h.id, 'host');
    assert.strictEqual(h.kind, 'host');
    assert.strictEqual(h.home, process.env.CODEX_HOME, 'CODEX_HOME is read at call time');
    assert.strictEqual(h.authPath, path.join(process.env.CODEX_HOME, 'auth.json'));

    const all = list({ force: true });
    assert.ok(all.some((t) => t.id === 'host'), 'host always present');
    assert.strictEqual(resolve('host').id, 'host');
    assert.strictEqual(resolve().id, 'host');
    assert.strictEqual(resolve('').id, 'host');
    assert.strictEqual(resolve('wsl:nope'), null);
    assert.strictEqual(typeof detectRunning(h).running, 'boolean');
    assert.ok(Array.isArray(detectRunning(h).pids));
    assert.deepStrictEqual(detectRunning({ id: 'x', kind: 'dir' }), { running: false, pids: [] });
    assert.deepStrictEqual(restartAppServers({ id: 'x', kind: 'dir' }), { restarted: [], desktop: false, daemon: false }, 'a plain directory has no processes to touch');

    // The command lines seen on a real Windows box with Paseo, the desktop app and the daemon open.
    const paseo = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe app-server --enable goals';
    const shim = '"node" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" app-server --enable goals';
    const desktop = 'C:\\Users\\u\\AppData\\Local\\OpenAI\\Codex\\bin\\9614f1d9b40d9c4f\\codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled';
    const daemon = '"\\\\?\\C:\\Users\\u\\.codex\\packages\\app-server-daemon\\releases\\0.162.1\\bin\\codex.exe" app-server --listen unix://';
    const linux = '/home/u/.npm-global/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex app-server';
    assert.deepStrictEqual([paseo, shim, desktop, daemon, linux, 'codex exec hi', 'codex login'].map(isCliAppServer),
      [true, false, false, false, true, false, false], 'only the CLI app-server, never the shim, the desktop app or the daemon');
    assert.strictEqual(isDesktopCodex(desktop), true);
    const managed = '"\\\\?\\C:\\Users\\u\\.codex\\packages\\app-server-daemon\\releases\\0.162.1\\bin\\codex.exe" app-server --listen unix:// --analytics-default-enabled --managed-daemon';
    const loop = '"\\\\?\\C:\\Users\\u\\.codex\\packages\\app-server-daemon\\releases\\0.162.1\\bin\\codex.exe" app-server daemon pid-update-loop';
    assert.strictEqual(daemonBin(managed), 'C:\\Users\\u\\.codex\\packages\\app-server-daemon\\releases\\0.162.1\\bin\\codex.exe', 'the daemon binary, without the \\\\?\\ prefix');
    assert.strictEqual(daemonBin(loop), null, 'the pid loop is not the daemon');
    assert.strictEqual(daemonBin(paseo), null, 'nor is a Paseo app-server');
    assert.strictEqual(daemonBin('/home/u/.codex/packages/app-server-daemon/releases/x/bin/codex app-server --listen unix:// --managed-daemon'), '/home/u/.codex/packages/app-server-daemon/releases/x/bin/codex');
    assert.strictEqual(isDesktopCodex(paseo), false);

    const wsl = all.filter((t) => t.kind === 'wsl');
    for (const t of wsl) assert.ok(t.authPath.endsWith('\\.codex\\auth.json'), t.authPath);
    console.log('codex/targets.js self-check OK' + (wsl.length ? ` (WSL con Codex: ${wsl.map((t) => t.distro).join(', ')})` : ' (sin WSL con Codex)'));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
}
