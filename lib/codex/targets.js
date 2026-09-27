'use strict';
// Where a Codex swap writes: the host's $CODEX_HOME, or ~/.codex inside a running WSL distro,
// reached over the same \\wsl.localhost share lib/targets.js uses for Claude. Only the auth.json
// path differs per target; the account store is shared.
const fs = require('node:fs');
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

module.exports = { hostTarget, resolveDistro, list, resolve, detectRunning };

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

    const wsl = all.filter((t) => t.kind === 'wsl');
    for (const t of wsl) assert.ok(t.authPath.endsWith('\\.codex\\auth.json'), t.authPath);
    console.log('codex/targets.js self-check OK' + (wsl.length ? ` (WSL con Codex: ${wsl.map((t) => t.distro).join(', ')})` : ' (sin WSL con Codex)'));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
}
