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

// Distros whose ~/.codex/auth.json is a link to a Windows file (ln -s /mnt/c/.../.codex/auth.json).
// They share the host's login instead of holding their own - the one way to have one Codex account
// in Windows and WSL at once, since there is then a single file and Codex coordinates its refreshes
// through it. So they are not a target of their own: a swap there would replace the link with a
// copy (a write over the share renames), and the host's swap already reaches them.
const linked = new Set();
const isLinked = (id) => linked.has(id);

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
  // Its own argv, no shell: wsl.exe mangles nested quotes inside an `sh -c` string.
  let real = '';
  try { real = claudeTargets.runWsl(['-d', distro, 'readlink', '-f', `${home}/.codex/auth.json`]).trim(); } catch { /* no file, or no readlink */ }
  if (real.startsWith('/mnt/')) { linked.add(`wsl:${distro}`); return null; }
  linked.delete(`wsl:${distro}`);
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
        // Not /T: a server or watcher the agent started keeps running; only the app-server goes.
        execFileSync(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(p.pid), '/F'], { stdio: 'ignore', timeout: 10000, windowsHide: true });
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

/* ---------------- restart only when nothing is working ----------------
 *
 * Restarting an app-server while its agent is mid-turn cuts that turn: Paseo reports
 * "[System Error] Codex app-server exited", and the turn's shells die with it. Paseo says so only
 * when a turn is active (handleUnexpectedTermination); an idle agent just reconnects on its next
 * message. Codex cannot tell an outsider whether it is busy - a model can think for minutes without
 * logging a line - but Paseo can: every agent is a ~/.paseo/agents/<project>/<id>.json carrying its
 * provider and lastStatus. So a swap leaves the restart pending, and it runs once no Codex agent is
 * busy.
 */
const BUSY = new Set(['running', 'initializing']);
// A crashed Paseo can leave "running" on disk for ever; past this, the record is not believed.
const STALE_STATUS_MS = 20 * 60 * 1000;

/** How many Paseo Codex agents are working right now. 0 when Paseo is not installed. */
function busyCodexAgents(dir = path.join(require('node:os').homedir(), '.paseo', 'agents'), now = Date.now()) {
  let busy = 0;
  let projects;
  try { projects = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return 0; }
  for (const p of projects) {
    let files;
    try { files = fs.readdirSync(path.join(dir, p.name)).filter((f) => f.endsWith('.json') && !f.startsWith('.')); } catch { continue; }
    for (const f of files) {
      let a;
      try { a = JSON.parse(fs.readFileSync(path.join(dir, p.name, f), 'utf8')); } catch { continue; } // mid-write: next tick
      const at = Date.parse(a.lastActivityAt || a.updatedAt || '');
      if (a.provider === 'codex' && BUSY.has(a.lastStatus) && now - at < STALE_STATUS_MS) busy++;
    }
  }
  return busy;
}

// target id -> { target, since }. In memory: a panel restart forgets it, and the next swap asks again.
const pending = new Map();
const PENDING_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * One check, every few seconds from server.js and once right after a swap. Returns what it did for
 * each pending target: { id, waiting } while Codex agents work, or the restartAppServers() result.
 */
function restartTick(deps = {}) {
  const busyNow = deps.busy || busyCodexAgents;
  const restart = deps.restart || module.exports.restartAppServers;
  const out = [];
  for (const [id, p] of pending) {
    if (Date.now() - p.since > PENDING_MAX_MS) { pending.delete(id); continue; }
    const waiting = busyNow();
    if (waiting) { out.push({ id, waiting }); continue; }
    pending.delete(id);
    out.push({ id, ...restart(p.target) });
    // A linked distro shares the host's auth.json, so the host's swap is its swap too.
    if (p.target.kind === 'host') {
      for (const lid of linked) out.push({ id: lid, ...restart({ id: lid, kind: 'wsl', distro: lid.slice(4) }) });
    }
  }
  return out;
}

/** Leave a restart pending for a target, and try it at once. */
function requestRestart(target, deps) {
  if (!target || (target.kind !== 'host' && target.kind !== 'wsl') || P.inContainer()) return { id: target && target.id, skipped: true };
  pending.set(target.id, { target, since: Date.now() });
  return restartTick(deps).find((r) => r.id === target.id) || { id: target.id, waiting: 0 };
}

module.exports = {
  hostTarget, resolveDistro, list, resolve, detectRunning, restartAppServers, isCliAppServer, isDesktopCodex, daemonBin,
  busyCodexAgents, requestRestart, restartTick, isLinked,
};

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

    // Paseo's agent records: only a Codex agent that is busy, and recently so, holds the restart.
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-agents-'));
    fs.mkdirSync(path.join(dir, 'proj'));
    const now = Date.parse('2026-10-15T18:40:00Z');
    const put = (name, rec) => fs.writeFileSync(path.join(dir, 'proj', name), JSON.stringify(rec));
    put('a.json', { provider: 'codex', lastStatus: 'running', lastActivityAt: '2026-10-15T18:39:00Z' });
    put('b.json', { provider: 'codex', lastStatus: 'idle', lastActivityAt: '2026-10-15T18:39:00Z' });
    put('c.json', { provider: 'claude', lastStatus: 'running', lastActivityAt: '2026-10-15T18:39:00Z' });
    put('d.json', { provider: 'codex', lastStatus: 'running', lastActivityAt: '2026-10-14T10:00:00Z' });
    fs.writeFileSync(path.join(dir, 'proj', 'e.json'), '{"provider":"codex","lastSta');
    assert.strictEqual(busyCodexAgents(dir, now), 1, 'one busy Codex agent: not the idle one, not Claude, not a day-old "running", not a half-written file');
    assert.strictEqual(busyCodexAgents(path.join(dir, 'nope'), now), 0, 'no Paseo, nobody to wait for');
    fs.rmSync(dir, { recursive: true, force: true });

    let busyNow = 1;
    const restarted = [];
    const deps = { busy: () => busyNow, restart: (t) => { restarted.push(t.id); return { restarted: [1], desktop: false, daemon: false }; } };
    const host = { id: 'host-test', kind: 'host' };
    assert.deepStrictEqual(requestRestart(host, deps), { id: 'host-test', waiting: 1 }, 'an agent at work: pending, nothing killed');
    assert.deepStrictEqual(restarted, []);
    busyNow = 0;
    restartTick(deps);
    // The host first; then any distro linked to it on this machine, which shares its auth.json.
    assert.strictEqual(restarted[0], 'host-test', 'restarted once everything is idle');
    assert.deepStrictEqual(restarted.slice(1), [...linked], 'and the distros that follow the host');
    const n = restarted.length;
    restartTick(deps);
    assert.strictEqual(restarted.length, n, 'and only once');
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
