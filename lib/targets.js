'use strict';
// A "target" is WHERE a swap writes: the host machine, or a WSL distro reached over its
// UNC share (\\wsl.localhost\<distro>\...). The OAuth tokens are identical everywhere, so
// the account store is shared; only which account is active - and which files the swap
// touches - differ per target. WSL is always the plain-file backend (no macOS Keychain).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const P = require('./paths');

const HOST_ID = 'host';

// wsl.exe is not always on the PATH a spawned Node process sees (Git Bash resolves it, a
// bare execFile does not), so address it absolutely. On 32-bit Node under 64-bit Windows,
// System32 redirects to SysWOW64 which has no wsl.exe - Sysnative reaches the real one.
function wslExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  for (const dir of ['System32', 'Sysnative']) {
    const p = path.join(root, dir, 'wsl.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'wsl.exe'; // last resort: let PATH resolution try
}
const WSL = wslExe();

// The host tab is named after the operating system, because that is what the user is choosing
// between: "Windows" next to "Ubuntu" reads as two places to switch an account in. "host" next to
// "Ubuntu" reads as a category error.
const HOST_LABELS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** The machine the server runs on. Uses whatever credentials backend this platform has. */
function hostTarget() {
  return {
    id: HOST_ID,
    kind: 'host',
    label: HOST_LABELS[process.platform] || process.platform,
    claudeJsonPath: P.claudeJsonPath(),
    credentialsPath: P.credentialsPath(),
    fileBackend: false, // host goes through lib/credentials (Keychain on macOS)
  };
}

// A WSL distro's Linux $HOME is /home/<user>; over the share that is
// \\wsl.localhost\<distro>\home\<user>. Older Windows exposes it as \\wsl$\<distro>.
function uncBaseCandidates(distro) {
  return [`\\\\wsl.localhost\\${distro}`, `\\\\wsl$\\${distro}`];
}

function wslPath(base, posixHome, ...rest) {
  return base + posixHome.replace(/\//g, '\\') + '\\' + rest.join('\\');
}

function runWsl(args, timeout = 6000) {
  // WSL prints UTF-16LE with stray NULs and CRs; strip them to get clean ASCII lines.
  const out = execFileSync(WSL, args, { encoding: 'utf8', timeout, windowsHide: true });
  return out.replace(/\0/g, '').replace(/\r/g, '');
}

/**
 * Names of the distros that are RUNNING. Plain `-l -q` lists the stopped ones too, and the
 * `wsl -d` that resolveDistro runs next boots each of them - so every scan (each poll, each
 * click on the re-scan button) was starting every installed distro on the machine. A distro
 * the user starts later shows up on the next scan; that is what the button is for.
 * Empty (never throws) if WSL is absent.
 */
function listDistros() {
  try {
    return runWsl(['-l', '-q', '--running'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// System distros ship no Claude and no user home worth touching.
const SKIP_DISTROS = new Set(['docker-desktop', 'docker-desktop-data']);

/**
 * Resolve one distro to a target, or null if it has no reachable ~/.claude.json. Reachable
 * is the real test: it proves the distro is running, the share works, AND Claude lives there.
 */
function resolveDistro(distro) {
  if (SKIP_DISTROS.has(distro)) return null;
  let home;
  try {
    home = runWsl(['-d', distro, 'sh', '-c', 'printf %s "$HOME"']).trim();
  } catch {
    return null;
  }
  if (!home || home[0] !== '/') return null;

  for (const base of uncBaseCandidates(distro)) {
    const claudeJsonPath = wslPath(base, home, '.claude.json');
    try {
      if (fs.statSync(claudeJsonPath).isFile()) {
        return {
          id: `wsl:${distro}`,
          kind: 'wsl',
          // Just the distro name: it is a tab label sitting beside "Windows", and the "WSL ·"
          // prefix was there to disambiguate stacked sections that no longer exist.
          label: distro,
          distro,
          home,
          claudeJsonPath,
          credentialsPath: wslPath(base, home, '.claude', '.credentials.json'),
          fileBackend: true,
        };
      }
    } catch { /* try next UNC base */ }
  }
  return null;
}

// Detection spawns several wsl.exe calls, so cache it briefly - /api/targets can be polled.
let cache = { at: 0, targets: null };
const CACHE_MS = 30 * 1000;

function list({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.targets && now - cache.at < CACHE_MS) return cache.targets;

  const targets = [hostTarget()];
  if (process.platform === 'win32') {
    for (const distro of listDistros()) {
      const t = resolveDistro(distro);
      if (t) targets.push(t);
    }
  }
  cache = { at: now, targets };
  return targets;
}

const resolve = (id) => list().find((t) => t.id === (id || HOST_ID)) || null;

/** Whether Claude Code is running in this target. Best-effort; never throws. */
function detectRunning(target) {
  if (!target || target.kind === 'host') return require('./swap').detectClaudeProcesses();
  try {
    // -x claude would miss the node-launched CLI; match the command line instead, and
    // drop our own probe. If pgrep finds nothing it exits 1 -> caught -> not running.
    const out = runWsl(['-d', target.distro, 'sh', '-c', 'pgrep -fl claude || true']);
    const pids = out.split('\n').map((l) => l.trim()).filter(Boolean)
      .filter((l) => !/pgrep/.test(l))
      .map((l) => Number(l.split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n));
    return { running: pids.length > 0, pids };
  } catch {
    return { running: false, pids: [] };
  }
}

module.exports = { HOST_ID, hostTarget, list, resolve, detectRunning, listDistros, resolveDistro };

if (require.main === module) {
  const assert = require('node:assert');
  const t = hostTarget();
  assert.strictEqual(t.id, 'host');
  assert.strictEqual(t.fileBackend, false);
  assert.ok(t.claudeJsonPath && t.credentialsPath);

  // WSL path assembly is pure string work - verify it without a live distro.
  const base = '\\\\wsl.localhost\\Ubuntu';
  assert.strictEqual(wslPath(base, '/home/mnt0x', '.claude.json'),
    '\\\\wsl.localhost\\Ubuntu\\home\\mnt0x\\.claude.json');
  assert.strictEqual(wslPath(base, '/home/mnt0x', '.claude', '.credentials.json'),
    '\\\\wsl.localhost\\Ubuntu\\home\\mnt0x\\.claude\\.credentials.json');

  // list() always includes host and never throws, on any platform.
  const all = list({ force: true });
  assert.ok(all.some((x) => x.id === 'host'), 'host target always present');
  assert.ok(Array.isArray(all));

  console.log('targets.js self-check OK' + (all.length > 1 ? ` (WSL detectado: ${all.filter((x) => x.kind === 'wsl').map((x) => x.distro).join(', ')})` : ' (sin WSL en esta máquina)'));
}
