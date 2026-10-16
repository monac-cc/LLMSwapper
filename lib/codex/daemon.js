'use strict';
// Terminal `codex` sessions run against a shared background server ("Server: Local background server"
// in /status): one long-lived app-server that loaded auth.json when it started and never looks again,
// so after a swap even a NEW terminal session got the old account. Codex's own answer is to restart
// that server - its TUI offers "Restart background server? ... Codex will reconnect automatically" -
// and the sessions reconnect on their own, now on the new account.
//
// The panel does that for you, but never mid-answer. It talks to the server the way the TUI does:
// `codex app-server proxy` pipes stdio to the server's control socket, which speaks JSON-RPC over
// WebSocket. It reads the server's account and the status of every loaded thread, and restarts only
// when the account differs from auth.json and no thread is "active". Until then it asks again every
// few seconds. Without a background server this does nothing.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const auth = require('./auth');

/** The binary the managed background server runs from, or null when there is none. */
function managedBin(home = auth.codexHome(), platform = process.platform, exists = fs.existsSync) {
  const p = path.join(home, 'packages', 'app-server-daemon', 'current', 'bin', platform === 'win32' ? 'codex.exe' : 'codex');
  return exists(p) ? p : null;
}

/* ---- the smallest WebSocket client the control socket needs: masked text frames out, text in ---- */
function encodeFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  const body = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

/** Splits complete frames off `buf`. Returns { texts, rest }. Server frames are not masked. */
function decodeFrames(buf) {
  const texts = [];
  let rest = buf;
  for (;;) {
    if (rest.length < 2) break;
    let len = rest[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (rest.length < 4) break; len = rest.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (rest.length < 10) break; len = Number(rest.readBigUInt64BE(2)); off = 10; }
    if (rest.length < off + len) break;
    if ((rest[0] & 0x0f) === 1) texts.push(rest.slice(off, off + len).toString('utf8'));
    rest = rest.slice(off + len);
  }
  return { texts, rest };
}

/**
 * The server's account email and the status of each loaded thread, or null when no server answers.
 * Read-only: initialize, account/read, thread/loaded/list, thread/read.
 */
function query(bin = managedBin(), timeoutMs = 10000) {
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(bin, ['app-server', 'proxy'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    let buf = Buffer.alloc(0);
    let open = false;
    let id = 0;
    const waiters = new Map();
    const call = (method, params) => new Promise((res) => { const n = ++id; waiters.set(n, res); child.stdin.write(encodeFrame(JSON.stringify({ id: n, method, params }))); });
    child.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        if (!/^HTTP\/1\.1 101/.test(buf.slice(0, i).toString())) return finish(null);
        buf = buf.slice(i + 4);
        open = true;
        run().then(finish, () => finish(null));
      }
      const { texts, rest } = decodeFrames(buf);
      buf = rest;
      for (const t of texts) {
        let m;
        try { m = JSON.parse(t); } catch { continue; }
        if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
      }
    });
    async function run() {
      const init = await call('initialize', { clientInfo: { name: 'llmswapper', version: '1' } });
      if (init.error) return null;
      child.stdin.write(encodeFrame(JSON.stringify({ method: 'initialized' })));
      const acc = await call('account/read', {});
      const account = (acc.result && acc.result.account && acc.result.account.email) || null;
      const loaded = await call('thread/loaded/list', {});
      const threads = [];
      for (const threadId of (loaded.result && loaded.result.data) || []) {
        const r = await call('thread/read', { threadId });
        const th = r.result && (r.result.thread || r.result);
        threads.push({ id: threadId, status: (th && th.status && th.status.type) || 'unknown' });
      }
      return { account, threads };
    }
    child.stdin.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}

/** Codex's own command: the server stops and starts again, and connected sessions reconnect. */
function restart(bin = managedBin()) {
  return new Promise((resolve) => {
    if (!bin) return resolve(false);
    execFile(bin, ['app-server', 'daemon', 'restart'], { timeout: 60000, windowsHide: true }, (err) => resolve(!err));
  });
}

/** The account the live auth.json holds, by email; null when it cannot be read. */
function liveEmail() {
  try {
    const live = auth.readAuth(auth.authPath(auth.codexHome()));
    return (live && live.tokens && auth.identity(live.tokens).email) || null;
  } catch {
    return null;
  }
}

// shortcut: one pending flag for the host's server; per-server state if several Codex homes ever matter.
function createSync(deps = {}) {
  const q = deps.query || query;
  const r = deps.restart || restart;
  const want = deps.liveEmail || liveEmail;
  const log = deps.log || ((m) => console.log(m));
  let pending = false;

  /** One check: restart the server when it is on another account and nothing is answering. */
  async function tick() {
    if (!pending) return { state: 'none' };
    const s = await q();
    if (!s) { pending = false; return { state: 'none' }; } // no background server: nothing to do
    const target = want();
    if (!target || !s.account || s.account === target) { pending = false; return { state: 'current' }; }
    const busy = s.threads.filter((t) => t.status === 'active').length;
    if (busy) return { state: 'waiting', busy };
    pending = false;
    const ok = await r();
    log(ok ? `  Codex: servidor en segundo plano reiniciado con ${target}; las sesiones de terminal se reconectan solas`
      : '  Codex: no se pudo reiniciar el servidor en segundo plano (codex app-server daemon restart)');
    return { state: ok ? 'restarted' : 'failed' };
  }

  /** After a Codex swap on this machine: check at once, keep checking while something answers. */
  function afterSwap() { pending = true; return tick(); }

  return { afterSwap, tick, isPending: () => pending };
}

const sync = createSync();

module.exports = { managedBin, encodeFrame, decodeFrames, query, restart, createSync, afterSwap: sync.afterSwap, tick: sync.tick };

if (require.main === module) {
  const assert = require('node:assert');
  // Frames: what we send decodes back once unmasked; what the server sends (unmasked) decodes as is.
  const unmask = (f) => { const len = f[1] & 0x7f; const off = len === 126 ? 4 : 2; const m = f.slice(off, off + 4); return Buffer.from(f.slice(off + 4).map((b, i) => b ^ m[i % 4])).toString(); };
  assert.strictEqual(unmask(encodeFrame('{"id":1}')), '{"id":1}');
  assert.strictEqual(unmask(encodeFrame('x'.repeat(300))), 'x'.repeat(300), 'the 16-bit length form');
  const server = (t) => { const p = Buffer.from(t); return Buffer.concat([Buffer.from([0x81, p.length]), p]); };
  const two = Buffer.concat([server('{"a":1}'), server('{"b":2}'), Buffer.from([0x81, 0x05, 0x7b])]);
  const d = decodeFrames(two);
  assert.deepStrictEqual(d.texts, ['{"a":1}', '{"b":2}'], 'complete frames out');
  assert.strictEqual(d.rest.length, 3, 'a partial frame waits for more bytes');
  assert.strictEqual(managedBin(path.join(os.tmpdir(), 'no-such-codex-home')), null, 'no server installed: nothing to do');

  (async () => {
    let state = { account: 'old@x', threads: [{ id: 't', status: 'active' }] };
    const restarts = [];
    const s = createSync({ query: async () => state, restart: async () => { restarts.push(1); return true; }, liveEmail: () => 'new@x', log: () => {} });
    assert.deepStrictEqual(await s.afterSwap(), { state: 'waiting', busy: 1 }, 'answering: never restarted');
    assert.deepStrictEqual(restarts, []);
    state = { account: 'old@x', threads: [{ id: 't', status: 'idle' }, { id: 'u', status: 'systemError' }] };
    assert.deepStrictEqual(await s.tick(), { state: 'restarted' }, 'idle: restarted on the new account');
    assert.deepStrictEqual(await s.tick(), { state: 'none' }, 'and only once');
    state = { account: 'new@x', threads: [] };
    assert.deepStrictEqual(await s.afterSwap(), { state: 'current' }, 'already on the right account: left alone');
    const none = createSync({ query: async () => null, restart: async () => { throw new Error('must not restart'); } });
    assert.deepStrictEqual(await none.afterSwap(), { state: 'none' }, 'no background server: nothing to do');
    assert.strictEqual(restarts.length, 1);
    console.log('codex/daemon.js self-check OK' + (managedBin() ? ' (servidor en segundo plano instalado)' : ''));
  })().catch((err) => { console.error(err); process.exit(1); });
}
