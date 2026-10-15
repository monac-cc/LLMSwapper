'use strict';
// Codex reads auth.json only when its process starts, so a swap reaches a running Codex session only
// if that session is restarted. Paseo can do that cleanly for its own agents: `paseo agent reload`
// restarts the agent's Codex process and resumes the SAME conversation, now on the new account. So
// after a Codex swap: idle agents (the one that ran out of quota among them) are reloaded at once;
// one still answering is reloaded as soon as that answer ends - never mid-turn, so nothing is cut.
// Without Paseo installed this does nothing, and the swap stays a plain `codex login`.
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_RE = /^codex(?:\/|$)/i;
const RELOAD_NOW = new Set(['idle', 'error']);
const BUSY = new Set(['running', 'initializing']);
// shortcut: an agent that never finishes its turn is given up on after a day; Paseo state would be needed to do better.
const PENDING_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * How to run the Paseo CLI, or null. The desktop app runs it the way its own resources/bin/paseo does
 * (the app binary as Node, ELECTRON_RUN_AS_NODE); an npm install puts `paseo` on PATH.
 */
function resolveCli(platform = process.platform, exists = fs.existsSync) {
  const apps = platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Paseo', 'Paseo.exe')]
    : platform === 'darwin' ? ['/Applications/Paseo.app/Contents/MacOS/Paseo'] : [];
  for (const bin of apps) {
    const resources = platform === 'darwin' ? path.join(path.dirname(bin), '..', 'Resources') : path.join(path.dirname(bin), 'resources');
    const runner = path.join(resources, 'app.asar.unpacked', 'dist', 'daemon', 'node-entrypoint-runner.js');
    const cli = path.join(resources, 'app.asar', 'node_modules', '@getpaseo', 'cli', 'dist', 'index.js');
    if (exists(bin) && exists(runner)) {
      return { command: bin, prefix: ['--disable-warning=DEP0040', runner, 'node-script', cli], env: { ELECTRON_RUN_AS_NODE: '1', PASEO_NODE_ENV: 'production' } };
    }
  }
  if (platform === 'win32') return null;
  try { execFileSync('which', ['paseo'], { stdio: 'ignore', timeout: 4000 }); } catch { return null; }
  return { command: 'paseo', prefix: [], env: {} };
}

let cliCache;
const cli = () => (cliCache === undefined ? (cliCache = resolveCli()) : cliCache);

/** Runs the Paseo CLI. Resolves {code, stdout}; never rejects. */
function run(args, timeout = 30000) {
  const c = cli();
  if (!c) return Promise.resolve({ code: -1, stdout: '' });
  return new Promise((resolve) => {
    execFile(c.command, [...c.prefix, ...args], { env: { ...process.env, ...c.env }, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '') }));
  });
}

/** `paseo agent ls --global --json` -> the Codex agents, [{id, status}]. Tolerant, never throws. */
function parseCodexAgents(stdout) {
  let raw;
  try { raw = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.filter((a) => a && typeof a.id === 'string' && AGENT_ID_RE.test(a.id)
    && typeof a.provider === 'string' && CODEX_RE.test(a.provider) && typeof a.status === 'string')
    .map((a) => ({ id: a.id, status: a.status }));
}

function createReloader(deps = {}) {
  const exec = deps.run || run;
  const now = deps.now || Date.now;
  const log = deps.log || ((m) => console.log(m));
  const pending = new Map(); // agent id -> since
  let queue = Promise.resolve();
  const queued = new Set();

  // One reload at a time: each restarts a Codex process.
  function reload(id) {
    if (queued.has(id)) return;
    queued.add(id);
    queue = queue.then(async () => {
      queued.delete(id);
      const r = await exec(['agent', 'reload', id, '--json'], 120000);
      log(r.code === 0 ? `  Codex: sesión de Paseo ${id.slice(0, 8)} recargada con la cuenta nueva` : `  Codex: no se pudo recargar la sesión de Paseo ${id.slice(0, 8)} (código ${r.code})`);
    }).catch(() => undefined);
  }

  /** After a Codex swap on this machine. Resolves {paseo, reloading, waiting}. */
  async function afterSwap() {
    const r = await exec(['agent', 'ls', '--global', '--json']);
    if (r.code !== 0) return { paseo: false, reloading: 0, waiting: 0 };
    let reloading = 0;
    for (const a of parseCodexAgents(r.stdout)) {
      if (BUSY.has(a.status)) { pending.set(a.id, now()); continue; }
      pending.delete(a.id);
      if (RELOAD_NOW.has(a.status)) { reload(a.id); reloading++; }
    }
    return { paseo: true, reloading, waiting: pending.size };
  }

  /** Every few seconds while something waits: reload each agent whose answer has ended. */
  async function tick() {
    if (!pending.size) return;
    const r = await exec(['agent', 'ls', '--global', '--json']);
    if (r.code !== 0) return;
    const status = new Map(parseCodexAgents(r.stdout).map((a) => [a.id, a.status]));
    for (const [id, since] of pending) {
      const s = status.get(id);
      if (now() - since > PENDING_MAX_MS || s === undefined || s === 'closed') { pending.delete(id); continue; }
      if (BUSY.has(s)) continue;
      pending.delete(id);
      reload(id);
    }
  }

  return { afterSwap, tick, pendingAgents: () => [...pending.keys()], idle: () => queue };
}

const reloader = createReloader();

module.exports = { resolveCli, parseCodexAgents, createReloader, afterSwap: reloader.afterSwap, tick: reloader.tick };

if (require.main === module) {
  const assert = require('node:assert');
  const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';

  // Only Codex agents with a valid id and status survive the parse.
  const listed = JSON.stringify([
    { id: A, provider: 'codex/gpt-6-astra', status: 'idle' },
    { id: B, provider: 'codex/gpt-6.1-sol', status: 'running' },
    { id: C, provider: 'claude/opus', status: 'idle' },
    { id: D, provider: 'codex', status: 'closed' },
    { id: 'nope', provider: 'codex', status: 'idle' },
  ]);
  assert.deepStrictEqual(parseCodexAgents(listed).map((a) => a.id), [A, B, D]);
  assert.deepStrictEqual(parseCodexAgents('not json'), []);

  // The desktop app's CLI is found by path, not PATH; nothing found -> null on Windows.
  assert.strictEqual(resolveCli('win32', () => false), null);
  const found = resolveCli('win32', () => true);
  assert.ok(found && found.env.ELECTRON_RUN_AS_NODE === '1' && found.prefix.includes('node-script'));

  (async () => {
    let list = listed;
    const calls = [];
    const r = createReloader({ run: async (args) => { calls.push(args.join(' ')); return { code: 0, stdout: args[1] === 'ls' ? list : '{}' }; }, log: () => {} });
    const res = await r.afterSwap();
    await r.idle();
    assert.deepStrictEqual(res, { paseo: true, reloading: 1, waiting: 1 }, 'the idle one now, the busy one later, Claude and closed ones never');
    assert.ok(calls.includes(`agent reload ${A} --json`));
    assert.ok(!calls.some((c) => c.includes(B) || c.includes(C) || c.includes(D)), 'nothing mid-turn, nothing that is not Codex');

    await r.tick();
    await r.idle();
    assert.ok(!calls.some((c) => c.includes(`reload ${B}`)), 'still answering: still waiting');
    list = JSON.stringify([{ id: B, provider: 'codex/gpt-6.1-sol', status: 'idle' }]);
    await r.tick();
    await r.idle();
    assert.ok(calls.includes(`agent reload ${B} --json`), 'reloaded as soon as its answer ended');
    assert.deepStrictEqual(r.pendingAgents(), []);

    const none = await createReloader({ run: async () => ({ code: -1, stdout: '' }) }).afterSwap();
    assert.deepStrictEqual(none, { paseo: false, reloading: 0, waiting: 0 }, 'no Paseo: a plain codex login');
    console.log('codex/paseo.js self-check OK' + (cli() ? ' (Paseo encontrado)' : ' (sin Paseo)'));
  })().catch((err) => { console.error(err); process.exit(1); });
}
