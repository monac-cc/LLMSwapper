'use strict';
// Terminal `codex` sessions run against a shared background server ("Server: Local background server"
// in /status): one long-lived app-server that read auth.json when it started and never looks again,
// so after a swap even a NEW terminal session got the old account.
//
// The panel hands that server the account itself, the way a host app does: through
// `codex app-server proxy` (stdio to the server's control socket, JSON-RPC over WebSocket) it logs
// the server in with the access token of the live auth.json (`account/login/start`, type
// chatgptAuthTokens). The server switches at once, for every session in it, mid-answer included:
// the request in flight finishes on the old account and the next one goes out on the new. Nothing
// is restarted or stopped.
//
// That login lives in the server's memory and Codex does not renew it ("token refresh must be
// handled by the external host app"), so the panel keeps feeding it: whenever auth.json holds a
// newer access token for that account (Codex or the panel renewed it), the server gets it too, and
// one close to its exp is renewed first. Without a background server this does nothing.
//
// A WSL distro whose ~/.codex/auth.json links to the Windows file (codex/targets.js) shares that
// login, and its own background server gets the same treatment, reached through
// `wsl.exe -d <distro> --exec .../codex app-server proxy` - only while the distro is running.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { scrub } = require('../oauth');
const claudeTargets = require('../targets');
const auth = require('./auth');
const codexTargets = require('./targets');

const EXTERNAL = 'chatgptAuthTokens';     // the server's authMethod once the panel logged it in
const TIMEOUT = 'timeout';                // a server that did not answer in time, unlike no server at all
const RECHECK_MS = 5 * 60 * 1000;         // a full check even when auth.json has not moved
const RETRY_MS = 30 * 1000;               // after a failure: soon, without a proxy every 5 s
const RENEW_UNDER_MS = 24 * 60 * 60 * 1000; // a fed token is renewed with under a day of life

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

/** The host's server: [binary], or null when there is none. */
const hostCmd = () => { const b = managedBin(); return b ? [b] : null; };

/** A linked distro's server, run inside it. */
const wslCmd = (d) => [claudeTargets.WSL, '-d', d.distro, '--exec', `${d.home}/.codex/packages/app-server-daemon/current/bin/codex`];

/**
 * One JSON-RPC conversation with a background server: the handshake the TUI does (with the
 * experimental API, which the token login needs), then `fn(call)`. `cmd` is the command that runs
 * `codex` (a binary path, or argv). Resolves what fn returns, null when no server answers, or
 * TIMEOUT when one did not answer in time.
 */
function session(fn, cmd = hostCmd(), timeoutMs = 10000) {
  const argv = typeof cmd === 'string' ? [cmd] : cmd;
  if (!argv) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(argv[0], [...argv.slice(1), 'app-server', 'proxy'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => finish(TIMEOUT), timeoutMs);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    // A proxy that dies between two writes must not take the panel down with an unhandled EPIPE.
    child.stdin.on('error', () => finish(null));
    let buf = Buffer.alloc(0);
    let open = false;
    let id = 0;
    const waiters = new Map();
    const call = (method, params) => new Promise((res) => {
      if (done) return res({ error: { message: 'closed' } });
      const n = ++id;
      waiters.set(n, res);
      child.stdin.write(encodeFrame(JSON.stringify({ id: n, method, params })));
    });
    child.stdout.on('data', (d) => {
      if (done) return;
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
      const init = await call('initialize', { clientInfo: { name: 'llmswapper', version: '1' }, capabilities: { experimentalApi: true } });
      if (init.error) return null;
      child.stdin.write(encodeFrame(JSON.stringify({ method: 'initialized' })));
      return fn(call);
    }
    child.stdin.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}

const routedId = (read) => (read.result && read.result.workspaceRouting && read.result.workspaceRouting.chatgptAccountId) || null;

/** The server's account, how it holds it (authMethod) and its access token; null or TIMEOUT otherwise. */
function query(cmd, timeoutMs) {
  return session(async (call) => {
    const acc = await call('account/read', {});
    const st = await call('getAuthStatus', { includeToken: true, refreshToken: false });
    const s = st.result || {};
    return {
      accountId: routedId(acc),
      email: (acc.result && acc.result.account && acc.result.account.email) || null,
      mode: s.authMethod || null,
      token: s.authToken || null,
    };
  }, cmd, timeoutMs);
}

/** Logs the server in with `live`'s access token, in memory. Resolves whether it now reports that account. */
async function login(live, cmd, timeoutMs) {
  const id = await session(async (call) => {
    const r = await call('account/login/start', { type: EXTERNAL, accessToken: live.accessToken, chatgptAccountId: live.accountId, chatgptPlanType: live.plan || null });
    return r.error ? null : routedId(await call('account/read', {}));
  }, cmd, timeoutMs);
  return id === live.accountId;
}

/** The ChatGPT login in the live auth.json: { accountId, accessToken, plan, email }, or null. */
function liveTokens() {
  try {
    const live = auth.readAuth(auth.authPath(auth.codexHome()));
    const t = live && live.tokens;
    if (!t || !t.access_token || !t.account_id || (live.auth_mode && !/^chatgpt/i.test(live.auth_mode))) return null;
    const who = auth.identity(t);
    return { accountId: t.account_id, accessToken: t.access_token, plan: who.plan, email: who.email };
  } catch {
    return null; // unreadable for now: the next check
  }
}

const expOf = (jwt) => ((auth.decodeJwt(jwt) || {}).exp || 0) * 1000;

// Set by swap.js, which owns refreshing (one refresh token, one holder at a time).
let renewHook = async () => undefined;
const setRenew = (fn) => { renewHook = fn; };

function createSync(deps = {}) {
  const q = deps.query || query;
  const push = deps.login || login;
  const live = deps.liveTokens || liveTokens;
  const renew = deps.renew || ((accountId) => renewHook(accountId));
  const now = deps.now || Date.now;
  const log = deps.log || ((m) => console.log(m));
  const where = deps.where || ''; // ' en <distro>' for a WSL server
  let last = { at: 0, token: null };
  let running = null;
  // A failure is checked again in RETRY_MS, not RECHECK_MS: meanwhile the terminals sit on the old account.
  const retrySoon = () => { last.at = now() - RECHECK_MS + RETRY_MS; };

  /** Puts the server on the account and token auth.json holds. */
  async function sync() {
    const l = live();
    last = { at: now(), token: l && l.accessToken };
    if (!l) return { state: 'none' };
    const s = await q();
    if (s === TIMEOUT) {
      retrySoon();
      log(`  Codex: el servidor en segundo plano${where} no contestó; se reintenta en ${RETRY_MS / 1000} s`);
      return { state: 'failed' };
    }
    if (!s) return { state: 'none' }; // no background server: nothing to do
    const same = s.accountId ? s.accountId === l.accountId : s.email === l.email;
    if (!same) {
      const ok = await push(l);
      if (!ok) retrySoon();
      log(ok ? `  Codex: el servidor en segundo plano${where} usa ya ${l.email || l.accountId}`
        : `  Codex: no se pudo pasar ${l.email || l.accountId} al servidor en segundo plano${where}; se reintenta en ${RETRY_MS / 1000} s`);
      return { state: ok ? 'switched' : 'failed' };
    }
    // A server on its own login renews it itself; one the panel logged in is the panel's to feed.
    if (s.mode !== EXTERNAL) return { state: 'current' };
    if (s.token !== l.accessToken && expOf(l.accessToken) >= expOf(s.token)) {
      const ok = await push(l);
      if (!ok) { retrySoon(); log(`  Codex: no se pudo pasar el token renovado al servidor en segundo plano${where}`); }
      return { state: ok ? 'fed' : 'failed' };
    }
    if (expOf(l.accessToken) - now() < RENEW_UNDER_MS) {
      try { await renew(l.accountId); } catch (err) { log(`  Codex: no se pudo renovar el token del servidor en segundo plano: ${scrub((err && err.message) || err)}`); }
      return { state: 'renewing' }; // the renewed token lands in auth.json, and the next check feeds it
    }
    return { state: 'current' };
  }

  // One check at a time.
  function run() {
    if (!running) running = sync().finally(() => { running = null; });
    return running;
  }

  /** After a swap: a check that starts after it wrote auth.json, not one already under way. */
  async function afterSwap() {
    if (running) await running.catch(() => undefined);
    return run();
  }

  /** Every few seconds: a check when auth.json moved, and every few minutes anyway. */
  function tick() {
    const l = live();
    if ((l && l.accessToken) === last.token && now() - last.at < RECHECK_MS) return Promise.resolve({ state: 'idle' });
    return run();
  }

  return { afterSwap, tick };
}

const host = createSync();

// One sync per linked distro, built as they are found and dropped when they stop being linked.
const distros = new Map(); // distro -> its sync
function wslSyncs() {
  const linkedNow = codexTargets.linkedDistros();
  for (const name of distros.keys()) if (!linkedNow.some((d) => d.distro === name)) distros.delete(name);
  for (const d of linkedNow) {
    if (distros.has(d.distro)) continue;
    const cmd = wslCmd(d);
    // Never `wsl -d` a stopped distro: that boots it, and a stopped one has no server to switch.
    const up = () => claudeTargets.listDistros().includes(d.distro);
    distros.set(d.distro, createSync({ query: async () => (up() ? query(cmd) : null), login: (l) => login(l, cmd), where: ` en ${d.distro}` }));
  }
  return [...distros].map(([distro, s]) => ({ distro, s }));
}

/** After a swap on the host: its server, then each linked distro's. `wsl` lists the latter. */
async function afterSwap() {
  const r = await host.afterSwap();
  const wsl = [];
  for (const { distro, s } of wslSyncs()) wsl.push({ distro, ...(await s.afterSwap()) });
  return { ...r, wsl };
}

async function tick() {
  const r = await host.tick();
  for (const { s } of wslSyncs()) await s.tick().catch(() => undefined);
  return r;
}

module.exports = { EXTERNAL, TIMEOUT, managedBin, wslCmd, encodeFrame, decodeFrames, session, query, login, liveTokens, setRenew, createSync, afterSwap, tick };

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
    // Fake JWTs carrying only an exp: the sync decides on account ids and token lifetimes.
    let t = 1e12;
    const jwt = (expMs) => ['e30', Buffer.from(JSON.stringify({ exp: expMs / 1000 })).toString('base64url'), 'sig'].join('.');
    const DAY = 24 * 60 * 60 * 1000;
    const A = { accountId: 'acct-a', accessToken: jwt(t + 9 * DAY), email: 'a@x' };
    const B = { accountId: 'acct-b', accessToken: jwt(t + 9 * DAY), email: 'b@x' };
    let srv = { accountId: 'acct-a', email: 'a@x', mode: 'chatgpt', token: A.accessToken };
    let file = A;
    const pushes = [];
    const renewed = [];
    const s = createSync({
      now: () => t,
      liveTokens: () => file,
      query: async () => srv,
      login: async (l) => { pushes.push(l.accountId); srv = { accountId: l.accountId, email: l.email, mode: EXTERNAL, token: l.accessToken }; return true; },
      renew: async (id) => { renewed.push(id); },
      log: () => {},
    });
    assert.deepStrictEqual(await s.afterSwap(), { state: 'current' }, 'same account on its own login: left alone');
    assert.deepStrictEqual(await s.tick(), { state: 'idle' }, 'auth.json unchanged: no check');
    file = B;
    assert.deepStrictEqual(await s.afterSwap(), { state: 'switched' }, 'a swap reaches the server at once');
    assert.deepStrictEqual(pushes, ['acct-b']);
    assert.deepStrictEqual(await s.tick(), { state: 'idle' });
    file = { ...B, accessToken: jwt(t + 10 * DAY) };
    assert.deepStrictEqual(await s.tick(), { state: 'fed' }, 'a renewed token in auth.json is fed to it');
    assert.strictEqual(srv.token, file.accessToken);
    file = { ...B, accessToken: jwt(t + 8 * DAY) };
    assert.deepStrictEqual(await s.tick(), { state: 'current' }, 'never an older token over a newer one');
    file = { ...B, accessToken: srv.token };
    t += 9.5 * DAY;
    assert.deepStrictEqual(await s.tick(), { state: 'renewing' }, 'a fed token near its exp is renewed');
    assert.deepStrictEqual(renewed, ['acct-b']);
    srv = { accountId: 'acct-b', email: 'b@x', mode: 'chatgpt', token: 'other' };
    t += RECHECK_MS;
    assert.deepStrictEqual(await s.tick(), { state: 'current' }, 'a server on its own login renews itself');
    assert.strictEqual(pushes.length, 2);
    const none = createSync({ liveTokens: () => A, query: async () => null, login: async () => { throw new Error('must not log in'); } });
    assert.deepStrictEqual(await none.afterSwap(), { state: 'none' }, 'no background server: nothing to do');
    const failing = createSync({ liveTokens: () => B, query: async () => ({ accountId: 'acct-a', mode: 'chatgpt' }), login: async () => false, log: () => {} });
    assert.deepStrictEqual(await failing.afterSwap(), { state: 'failed' }, 'a refused login is reported');
    let tt = 0;
    let answer = TIMEOUT;
    const slow = createSync({ now: () => tt, liveTokens: () => B, query: async () => answer, login: async () => true, log: () => {} });
    assert.deepStrictEqual(await slow.afterSwap(), { state: 'failed' }, 'a server that did not answer is a failure, not "no server"');
    tt += 5000;
    assert.deepStrictEqual(await slow.tick(), { state: 'idle' }, 'not asked again every 5 s');
    tt += RETRY_MS;
    answer = { accountId: 'acct-a', mode: 'chatgpt' };
    assert.deepStrictEqual(await slow.tick(), { state: 'switched' }, 'asked again within the minute, not in five');
    assert.deepStrictEqual(wslCmd({ distro: 'Ubuntu', home: '/home/u' }).slice(1), ['-d', 'Ubuntu', '--exec', '/home/u/.codex/packages/app-server-daemon/current/bin/codex']);
    console.log('codex/daemon.js self-check OK' + (managedBin() ? ' (servidor en segundo plano instalado)' : ''));
  })().catch((err) => { console.error(err); process.exit(1); });
}
