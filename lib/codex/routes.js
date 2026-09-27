'use strict';
// Every /api/codex/* route. server.js hands over anything under that prefix after its guards
// (loopback Host, same Origin, X-Swapper) have run; a path this does not own returns false and the
// server answers 404. Responses carry the Claude shapes, so the frontend renders both providers
// with the same code - and never a token: accounts leave through store.publicView/publicAccount.
const P = require('../paths');
const terminal = require('../terminal');
const auth = require('./auth');
const store = require('./store');
const targets = require('./targets');
const usage = require('./usage');
const swap = require('./swap');

// CODEX_ACCESS_TOKEN beats auth.json everywhere, the TUI included, so while it is set a swap is a
// silent no-op. CODEX_API_KEY only reaches `codex exec` and a few subcommands: worth a mention,
// not an alarm.
const OVERRIDING_ENV = ['CODEX_ACCESS_TOKEN'];
const SOFT_ENV = ['CODEX_API_KEY'];
const setEnv = (names) => names.filter((k) => process.env[k]);

const ID_ROUTE = /^\/api\/codex\/accounts\/(cdx_[a-f0-9]{6})$/;

/** The target's view, its active account being whatever its auth.json holds right now. */
function viewFor(targetId) {
  swap.detectActiveId(targetId); // records the file's answer in the store's `active` map
  return store.publicView(targetId);
}

async function handle(req, res, url, { send, fail, readBody }) {
  const { pathname } = url;
  const method = req.method;
  const force = url.searchParams.get('force') === '1';

  if (pathname === '/api/codex/health' && method === 'GET') {
    const host = targets.hostTarget();
    const procs = targets.detectRunning(host);
    send(res, 200, {
      ok: true,
      installed: terminal.codexInstalled(),
      running: procs.running,
      pids: procs.pids,
      unknown: !!procs.unknown,
      overridingEnv: setEnv(OVERRIDING_ENV),
      softEnv: setEnv(SOFT_ENV),
      storeMode: auth.storeMode(host.home),
      container: P.inContainer(),
      paths: { home: host.home, auth: host.authPath },
    });
    return true;
  }

  if (pathname === '/api/codex/targets' && method === 'GET') {
    send(res, 200, {
      targets: targets.list({ force }).map((t) => ({
        id: t.id,
        kind: t.kind,
        label: t.label,
        activeId: swap.detectActiveId(t.id),
        running: targets.detectRunning(t).running,
        storeMode: auth.storeMode(t.home),
      })),
    });
    return true;
  }

  if (pathname === '/api/codex/accounts' && method === 'GET') {
    send(res, 200, viewFor(url.searchParams.get('target') || 'host'));
    return true;
  }

  if (pathname === '/api/codex/usage/all' && method === 'GET') {
    send(res, 200, await usage.fetchAll(store.list(), { force }));
    return true;
  }

  if (pathname === '/api/codex/usage' && method === 'GET') {
    const account = store.get(url.searchParams.get('id'));
    if (!account) fail(res, 404, 'Cuenta de Codex no encontrada');
    else send(res, 200, await usage.fetchFor(account, { force }));
    return true;
  }

  if (pathname === '/api/codex/swap' && method === 'POST') {
    const { id, target } = await readBody(req);
    if (!id) { fail(res, 400, 'Falta el id de cuenta'); return true; }
    try {
      send(res, 200, await swap.swapTo(id, target || 'host'));
    } catch (err) {
      // 400 unknown target, 404 unknown account, 409 in flight / live elsewhere / keyring.
      fail(res, err.status || 500, err.message);
    }
    return true;
  }

  if (pathname === '/api/codex/accounts/import' && method === 'POST') {
    const { target, configDir, staging } = await readBody(req);
    try {
      const account = await swap.importFrom({ target: target || 'host', configDir, staging: staging === true });
      const targetId = staging || configDir ? 'host' : target || 'host';
      // The store and that directory now hold one rotating refresh token, and nothing tracks the
      // directory: the first refresh on either side kills the other copy. Said, not hidden.
      const warnings = configDir && !staging
        ? [`El panel y ${configDir} comparten ahora el refresh token de esa cuenta: en cuanto uno de los dos lo renueve, la sesión del otro deja de valer. Úsala desde el panel (swap) y no desde ese directorio.`]
        : [];
      send(res, 200, { ok: true, account: store.publicAccount(account.id, targetId), warnings });
    } catch (err) {
      fail(res, err.status || 500, err.message);
    }
    return true;
  }

  // Takes nothing from the client: the command is a constant in lib/terminal.js and the directory
  // is the panel's own staging dir.
  if (pathname === '/api/codex/login/terminal' && method === 'POST') {
    if (P.inContainer()) {
      fail(res, 409, 'Dentro de un contenedor no hay terminal que abrir. Haz "codex login" en tu máquina e importa la sesión, o impórtala desde su CODEX_HOME.');
      return true;
    }
    if (!terminal.codexInstalled()) {
      fail(res, 409, 'No encuentro el comando "codex" en el PATH de este proceso. Instala Codex CLI (npm i -g @openai/codex) y vuelve a intentarlo.');
      return true;
    }
    try {
      const dir = swap.stagingDir();
      send(res, 200, { ok: true, how: terminal.openCodexLogin(dir), dir });
    } catch (err) {
      fail(res, 500, err.message);
    }
    return true;
  }

  const idMatch = pathname.match(ID_ROUTE);
  if (idMatch && method === 'PATCH') {
    const id = idMatch[1];
    const body = await readBody(req);
    const patch = {};
    if (typeof body.label === 'string' && body.label.trim()) patch.label = body.label.trim().slice(0, 60);
    if (typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color)) patch.color = body.color;
    if (!Object.keys(patch).length) fail(res, 400, 'Nada que actualizar');
    else if (!store.update(id, patch)) fail(res, 404, 'Cuenta de Codex no encontrada');
    else send(res, 200, { ok: true, account: store.publicAccount(id) });
    return true;
  }
  if (idMatch && method === 'DELETE') {
    const id = idMatch[1];
    usage.invalidate(id);
    if (store.remove(id)) send(res, 200, { ok: true }); else fail(res, 404, 'Cuenta de Codex no encontrada');
    return true;
  }

  return false;
}

module.exports = { handle, OVERRIDING_ENV, SOFT_ENV };

if (require.main === module) {
  const assert = require('node:assert');
  // A path that is not ours is left to the server, untouched.
  const untouched = { send() { throw new Error('send'); }, fail() { throw new Error('fail'); }, readBody: async () => ({}) };
  handle({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/codex/nope'), untouched).then((handled) => {
    assert.strictEqual(handled, false);
    assert.ok(ID_ROUTE.test('/api/codex/accounts/cdx_a1b2c3'));
    assert.ok(!ID_ROUTE.test('/api/codex/accounts/acc_a1b2c3'), 'a Claude id is not ours');
    assert.ok(!ID_ROUTE.test('/api/codex/accounts/cdx_../x'));
    console.log('codex/routes.js self-check OK');
  });
}
