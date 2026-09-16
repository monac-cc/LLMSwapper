'use strict';
// Zero-dependency local server. Binds loopback only; it holds real OAuth tokens.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const P = require('./lib/paths');
const store = require('./lib/store');
const oauth = require('./lib/oauth');
const usage = require('./lib/usage');
const swap = require('./lib/swap');
const credentials = require('./lib/credentials');
const targets = require('./lib/targets');
const terminal = require('./lib/terminal');
const auto = require('./lib/auto');

// The host the BROWSER uses, and the only one the Host-header allowlist accepts. Kept separate
// from the bind address on purpose: a container has to listen on all of its own interfaces to be
// reachable at all, but that must not widen what this server accepts as a legitimate origin.
const HOST = '127.0.0.1';
// Where the socket actually binds. Loopback everywhere except inside a container, where the
// Dockerfile sets 0.0.0.0. The loopback guarantee then moves outward, to how the port is
// published:  -p 127.0.0.1:7373:7373  - see the README.
const BIND = process.env.SWAPPER_BIND || HOST;
const BASE_PORT = Number(process.env.PORT) || 7373;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;

const deps = { store, oauth, usage, swap };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(payload);
}

const fail = (res, status, message) => send(res, status, { ok: false, error: oauth.scrub(message) });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Cuerpo de la petición demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('JSON inválido en el cuerpo')); }
    });
    req.on('error', reject);
  });
}

/**
 * Two guards against a random website in the user's browser driving this API:
 * a same-origin check, and a custom header that no cross-site form, <img> or <script>
 * can set. The header covers the whole API, GET included: read-only is not the same as
 * harmless here. /api/health spawns a process per call (a page could pin the event loop
 * with a loop of <img> tags), and /api/usage spends the app's entire request budget for
 * the whole 5-minute window.
 */
// Loopback by NAME. The port is deliberately not part of this: a container listens on 7373 and
// is published as whatever the user chose, so the Host the browser sends carries the PUBLISHED
// port, which this process has no way of knowing. Pinning the port there rejected every
// containerised request with "Host no permitido".
//
// Dropping it costs nothing, because the port was never what defended anything. The attack this
// guards against is DNS rebinding: a page on evil.com whose domain resolves to 127.0.0.1, so the
// browser really does connect to this socket. What gives it away is the Host header - it says
// "evil.com", because the browser fills it from the URL the page used. A hostname check catches
// that; the port never entered into it. An ordinary cross-origin fetch is stopped twice over,
// by the Origin check below and by the X-Swapper header a cross-site request cannot set.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** "127.0.0.1:27387" -> "127.0.0.1", "[::1]:7373" -> "[::1]". Empty when unparseable. */
function hostnameOf(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (s[0] === '[') { const end = s.indexOf(']'); return end < 0 ? '' : s.slice(0, end + 1); }
  return s.split(':')[0];
}
// SWAPPER_ALLOWED_HOSTS ensancha ese conjunto, separado por comas: "192.168.1.160,mi-pc".
// Existe para abrir el panel a otro dispositivo de la red local, viene apagado y hay que
// escribirlo a proposito, porque entrega el panel a cualquiera que sepa enrutar hasta esta
// maquina: aqui no hay login, asi que quien llegue puede cambiar, renombrar y borrar cuentas.
// Solo en una red en la que confies.
const ALLOWED_HOSTS = new Set([
  ...LOOPBACK,
  ...String(process.env.SWAPPER_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => hostnameOf(s.trim().toLowerCase()))
    .filter(Boolean),
]);
// Ya no se llama isLoopback: con SWAPPER_ALLOWED_HOSTS puesto devuelve true a proposito para una
// direccion de LAN, y un predicado cuyo nombre niega lo que hace es como se equivoca el siguiente
// que lo lea. Los nombres de host no distinguen mayusculas, de ahi el toLowerCase.
const isAllowedHost = (value) => ALLOWED_HOSTS.has(hostnameOf(String(value == null ? '' : value).toLowerCase()));

function guard(req, res, pathname) {
  if (!isAllowedHost(req.headers.host)) { fail(res, 403, 'Host no permitido'); return false; }

  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && isAllowedHost(u.host);
    } catch { ok = false; }
    if (!ok) { fail(res, 403, 'Origen no permitido'); return false; }
  }
  // Static assets are exempt: the browser loads /style.css with no say in its headers.
  if (pathname.startsWith('/api/') && req.headers['x-swapper'] !== '1') {
    fail(res, 403, 'Falta la cabecera X-Swapper'); return false;
  }
  return true;
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  // Traversal guard: the resolved path must still sit inside public/.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 403, 'Prohibido');
  fs.readFile(target, (err, data) => {
    if (err) return fail(res, 404, 'No encontrado');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/**
 * Credentials that OUTRANK the file this app writes.
 *
 * Verified by pointing Claude Code at a local server and reading the headers it sent: with any of
 * these set it never touches ~/.claude/.credentials.json, so every swap becomes a silent no-op -
 * the panel reports success, the account changes on disk, and the CLI keeps using the variable.
 * That failure is invisible from inside the app, which is exactly why it is worth naming.
 */
const OVERRIDING_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
const overridingEnv = () => OVERRIDING_ENV.filter((k) => process.env[k]);

/** Turn a set of tokens into a stored account, using the live profile as the source of truth. */
async function adoptTokens(tokenOauth, existingUserID) {
  const { email, profile } = await oauth.fetchProfile(tokenOauth.accessToken);
  return store.add({ email, oauth: tokenOauth, profile, userID: existingUserID || null });
}

const BUILD = (() => {
  try { return fs.readFileSync(path.join(__dirname, '.build'), 'utf8').trim(); } catch { return ''; }
})();

async function handleApi(req, res, url, port) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/health' && method === 'GET') {
    const procs = swap.detectClaudeProcesses();
    return send(res, 200, {
      ok: true, claudeRunning: procs.running, pids: procs.pids, node: process.version,
      platform: process.platform,
      credentialsBackend: credentials.describeBackend(),
      overridingEnv: overridingEnv(),
      // What this process genuinely cannot do from where it is running. The UI shows it rather
      // than silently degrading, because "0 procesos" and "no puedo verlos" look identical on a
      // screen and mean opposite things.
      container: P.inContainer(),
      unavailable: P.inContainer() ? ['processDetection', 'wslTargets'] : [],
      // Stamped by the Dockerfile. Lets the panel say which build is running, because a
      // `docker compose up -d` without --build keeps serving the previous image in silence.
      build: BUILD,
      // The bind-mounted ~/.claude.json no longer being the host's file (Linux hosts only).
      staleMount: P.inContainer() && P.isDetachedMount(P.claudeJsonPath()),
      paths: { claudeJson: P.claudeJsonPath(), data: P.dataDir() },
    });
  }

  // Environments a swap can target: the host, plus any WSL distro with Claude installed.
  // Each reports which account is active there and whether Claude is running in it.
  if (pathname === '/api/targets' && method === 'GET') {
    const force = url.searchParams.get('force') === '1';
    const list = targets.list({ force });
    return send(res, 200, {
      targets: list.map((t) => ({
        id: t.id,
        kind: t.kind,
        label: t.label,
        activeId: store.activeFor(t.id) || swap.detectActiveId(t.id, store),
        running: targets.detectRunning(t).running,
      })),
    });
  }

  if (pathname === '/api/accounts' && method === 'GET') {
    const targetId = url.searchParams.get('target') || 'host';
    const view = store.publicView(targetId);
    // If we have never swapped on this target, show its REAL current account as in-use by
    // reading that environment's live config. A display hint only; nothing is written.
    if (!view.activeId) {
      const det = swap.detectActiveId(targetId, store);
      if (det) { view.activeId = det; for (const a of view.accounts) a.isActive = a.id === det; }
    }
    return send(res, 200, view);
  }

  if (pathname === '/api/usage/all' && method === 'GET') {
    const force = url.searchParams.get('force') === '1';
    return send(res, 200, await usage.fetchAll(store.list(), { force }));
  }

  if (pathname === '/api/usage' && method === 'GET') {
    const account = store.get(url.searchParams.get('id'));
    if (!account) return fail(res, 404, 'Cuenta no encontrada');
    return send(res, 200, await usage.fetchFor(account, { force: url.searchParams.get('force') === '1' }));
  }

  if (pathname === '/api/swap' && method === 'POST') {
    const { id, target } = await readBody(req);
    if (!id) return fail(res, 400, 'Falta el id de cuenta');
    try {
      return send(res, 200, await swap.swapTo(id, deps, target));
    } catch (err) {
      return fail(res, 500, err.message);
    }
  }

  if (pathname === '/api/swap/dryrun' && method === 'POST') {
    const { id, target } = await readBody(req);
    try { return send(res, 200, await swap.dryRun(id, deps, target)); }
    catch (err) { return fail(res, 400, err.message); }
  }

  if (pathname === '/api/accounts/import' && method === 'POST') {
    const { configDir, target } = await readBody(req);
    const tgId = target || 'host';
    const identity = swap.readCurrentIdentity(configDir, tgId);
    if (!identity) {
      const tg = targets.resolve(tgId);
      const where = tg && tg.kind === 'wsl' ? ` en ${tg.label}` : '';
      return fail(res, 400, configDir
        ? `No se encontró ninguna sesión en ${configDir}`
        : `No hay ninguna sesión de Claude Code activa que importar${where}. Ejecuta "claude", haz /login y vuelve a pulsar import.`);
    }
    try {
      const account = await adoptTokens(identity.oauth, identity.userID);
      // The live config of that target reflects the account actually in use there.
      if (!configDir) store.setActive(account.id, tgId);
      return send(res, 200, { ok: true, account: store.publicAccount(account.id, tgId) });
    } catch (err) {
      return fail(res, 502, `No se pudo verificar la cuenta actual: ${err.message}`);
    }
  }

  /**
   * Add an account by PASTING a long-lived token, with no login and nothing imported.
   *
   * `claude setup-token` mints a token that is valid for a year but carries only user:inference,
   * so it can never tell us who it belongs to. probeToken sorts that out without spending
   * inference and without touching the rate-limited usage endpoint:
   *   403 + scope complaint -> a real setup-token. Stored with honest scopes; no usage meters.
   *   200                   -> a full-scope token. We fetch the profile and it behaves like an
   *                            imported account, except it can never be renewed.
   *   401                   -> rejected, and nothing is written.
   */
  if (pathname === '/api/accounts/token' && method === 'POST') {
    const body = await readBody(req);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
    if (!token) return fail(res, 400, 'Pega un token para añadir la cuenta');

    try {
      const probe = await oauth.probeToken(token);

      let email = null;
      let profile = null;
      let scopes = oauth.INFERENCE_ONLY_SCOPES;
      if (probe.kind === 'full') {
        const who = await oauth.fetchProfile(token);
        email = who.email;
        profile = who.profile;
        scopes = oauth.SCOPES;
      }

      // Pasting over an account that could renew itself is a real downgrade, and it happens
      // silently inside store.add. Detect it BEFORE the write so the answer can say so.
      const priorId = profile || email ? store.idFor(profile, email) : store.idForToken(token);
      const prior = store.get(priorId);
      const losesRenewal = !!(prior && prior.oauth && prior.oauth.refreshToken);

      const account = store.add({
        label: label || null,
        email,
        profile,
        oauth: {
          accessToken: token,
          // Never '' - Claude Code reads an empty refreshToken as a dead-token sentinel.
          refreshToken: null,
          // Optimistic by construction: we stamp a year from NOW because the token itself does
          // not say when it was minted. A token pasted late in its life will therefore look
          // healthier than it is; the swap's own verification is what actually catches a dead
          // one, by rolling back on a 401.
          expiresAt: Date.now() + oauth.LONG_LIVED_MS,
          refreshTokenExpiresAt: null,
          scopes,
          subscriptionType: null,
          rateLimitTier: null,
        },
      });

      const warnings = [];
      if (probe.kind === 'inference') {
        warnings.push('Token solo de inferencia: el swap funciona, pero esta cuenta no puede mostrar consumo.');
      }
      if (losesRenewal) {
        warnings.push('Esta cuenta ya estaba guardada con un token renovable; el token pegado lo sustituye y ya no se renovará sola.');
      }
      return send(res, 200, { ok: true, kind: probe.kind, warnings, account: store.publicAccount(account.id) });
    } catch (err) {
      const status = err.malformed ? 400 : err.status === 401 ? 401 : 502;
      return fail(res, status, err.message);
    }
  }

  /**
   * Abrir una terminal con `claude setup-token`, para no obligar a buscar una y teclearlo.
   *
   * No recibe NADA del cliente: el comando es una constante en lib/terminal.js y viaja como argv,
   * nunca como una cadena que un shell tenga que reinterpretar. El cuerpo de la peticion se
   * ignora a proposito - no hay ningun parametro que un atacante pudiera doblar.
   *
   * Las dos negativas se dan antes de lanzar nada, porque una ventana que parpadea y muere
   * enseñando "command not found" es peor que un mensaje claro.
   */
  if (pathname === '/api/token/terminal' && method === 'POST') {
    if (P.inContainer()) {
      return fail(res, 409, 'Dentro de un contenedor no hay terminal que abrir. '
        + 'Ejecuta "claude setup-token" en tu máquina y pega el token aquí.');
    }
    if (!terminal.claudeInstalled()) {
      return fail(res, 409, 'No encuentro el comando "claude" en el PATH de este proceso. '
        + 'Instala Claude Code, o ejecuta "claude setup-token" donde lo tengas y pega el token.');
    }
    try {
      return send(res, 200, { ok: true, how: terminal.openSetupToken() });
    } catch (err) {
      return fail(res, 500, err.message);
    }
  }

  // Automatic rotation: on/off + status. GET reports current + next account without
  // spending any API budget (cached readings only); POST toggles it and the same status.
  if (pathname === '/api/auto' && method === 'GET') {
    return send(res, 200, await auto.status(deps));
  }
  if (pathname === '/api/auto' && method === 'POST') {
    const body = await readBody(req);
    const patch = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.target === 'string' && body.target) patch.target = body.target;
    if (Number.isFinite(body.threshold)) patch.threshold = body.threshold;
    auto.set(patch);
    return send(res, 200, await auto.status(deps));
  }

  const idMatch = pathname.match(/^\/api\/accounts\/([A-Za-z0-9_]+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.label === 'string' && body.label.trim()) patch.label = body.label.trim().slice(0, 60);
      if (typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color)) patch.color = body.color;
      if (!Object.keys(patch).length) return fail(res, 400, 'Nada que actualizar');
      const updated = store.update(id, patch);
      if (!updated) return fail(res, 404, 'Cuenta no encontrada');
      return send(res, 200, { ok: true, account: store.publicAccount(id) });
    }
    if (method === 'DELETE') {
      usage.invalidate(id);
      return store.remove(id) ? send(res, 200, { ok: true }) : fail(res, 404, 'Cuenta no encontrada');
    }
  }

  return fail(res, 404, 'Endpoint desconocido');
}

/**
 * The whole point of this app is never logging in again. Access tokens last ~8h and
 * refresh tokens ~29 days, rotating on each use - so an account left untouched for a
 * month would die and need a real login. This keeps every stored account alive in the
 * background, whether or not you ever swap to it.
 * Uses the token endpoint, NOT the rate-limited usage endpoint.
 */
const KEEPALIVE_EVERY_MS = 6 * 60 * 60 * 1000;   // every 6h
const REFRESH_WHEN_UNDER_MS = 24 * 60 * 60 * 1000; // renew if under a day of life left
// How often the auto-rotation monitor looks. The active-account usage read is cache-gated
// (a real call only every ~15 min), so a 3-minute look is cheap and reacts promptly.
const AUTO_EVERY_MS = 3 * 60 * 1000;

async function keepTokensAlive() {
  // First, pick up a rotation Claude Code performed on its own. Renewing with a token it
  // already replaced would fail with invalid_grant and strand the account behind a login.
  const healed = swap.adoptLiveTokens(store);
  if (healed) {
    const who = (store.get(healed) || {}).email || healed;
    console.log(`  sesión viva adoptada: ${who} (Claude Code había rotado su token)`);
  }
  for (const account of store.list()) {
    const o = account.oauth;
    if (!o || !o.refreshToken) continue;
    const life = (o.expiresAt || 0) - Date.now();
    if (life > REFRESH_WHEN_UNDER_MS) continue;
    try {
      const fresh = oauth.toStoredOauth(await oauth.refresh(o.refreshToken), o);
      store.update(account.id, { oauth: fresh });
      // Refreshing ROTATES the refresh token and kills the old one, so the live session
      // may now be holding a dead token. syncLiveCredentials decides whether it is this
      // account's session to update, and writes through the credentials BACKEND - on
      // macOS that is the Keychain, and a path-based write would land in a file Claude
      // Code never reads, leaving it with the dead token for real.
      const synced = swap.syncLiveCredentials(o.refreshToken, fresh);
      console.log(`  token renovado: ${account.email}${synced ? ' (y sincronizado con Claude Code)' : ''}`);
    } catch (err) {
      // Do not delete anything - a transient network failure must not cost an account.
      // invalid_grant is the one case that is not transient and that the user can act on:
      // something rotated this account's tokens outside the store (Claude Code renews its
      // own session too), so the stored refresh token is dead and only a re-import fixes it.
      const dead = /invalid_grant/.test(err.message);
      console.warn(`  no se pudo renovar ${account.email}: ${dead
        ? 'el refresh token guardado ya no vale. Entra con esa cuenta (claude, /login) y pulsa import.'
        : oauth.scrub(err.message)}`);
    }
  }
}

// store.list() reads accounts.json, which can throw on a corrupt or briefly locked file -
// outside the try above, and in a promise nobody awaits. Unhandled, that kills the process
// and with it the only thing keeping the stored accounts from expiring.
const keepAliveTick = () => keepTokensAlive().catch((err) => {
  console.warn(`  keep-alive: ${oauth.scrub((err && err.message) || err)}`);
});

function createServer(port) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}:${port}`);
    } catch {
      return fail(res, 400, 'URL inválida');
    }
    try {
      if (!guard(req, res, url.pathname)) return;
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, port);
      if (req.method !== 'GET') return fail(res, 405, 'Método no permitido');
      return serveStatic(res, url.pathname);
    } catch (err) {
      if (!res.headersSent) fail(res, 500, err && err.message ? err.message : 'Error interno');
    }
  });
}

function listen(port) {
  const server = createServer(port);
  server.on('error', (err) => {
    // Deliberately NOT hopping to the next free port. The rate floor that keeps this app
    // inside the usage endpoint's budget is per process, so a second instance quietly
    // running on 7374 would double the outbound rate and rate-limit both of them.
    if (err.code === 'EADDRINUSE') {
      const url = `http://${HOST}:${port}`;
      console.log(`\n  Ya hay algo escuchando en ${url} - probablemente otro LLMSwapper.`);
      console.log(`  Ábrelo ahí, o arranca en otro puerto:  PORT=7400 node server.js\n`);
      if (!process.env.NO_OPEN) oauth.openBrowser(url);
      process.exit(0);
    }
    console.error(`No se pudo abrir el puerto ${port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, BIND, () => {
    const url = `http://${HOST}:${port}`;
    console.log(`\n  LLMSwapper  ->  ${url}`);
    console.log(`  datos: ${P.dataDir()}`);
    // Inherited from the shell, this silently redirects every read and write to a throwaway
    // config - and the README teaches people to set it for an isolated login.
    if (P.inContainer()) {
      console.log(`  contenedor: sin detección de procesos ni targets WSL (frontera del contenedor)${BUILD ? ` · build ${BUILD}` : ''}`);
    }
    if (BIND !== HOST) {
      console.log(`  AVISO: escuchando en ${BIND}, no solo en el loopback.`);
      console.log('         Publica el puerto solo en 127.0.0.1 del host, o lo expones a tu red.');
    }
    if (ALLOWED_HOSTS.size > LOOPBACK.size) {
      const extra = [...ALLOWED_HOSTS].filter((h) => !LOOPBACK.has(h));
      console.log(`  AVISO: el panel acepta tambien ${extra.join(', ')}, no solo el loopback.`);
      console.log('         No hay login: quien llegue a esa direccion maneja tus cuentas.');
    }
    const overriding = overridingEnv();
    if (overriding.length) {
      console.log(`  AVISO: ${overriding.join(', ')} está definido y GANA al fichero de credenciales.`);
      console.log('         Mientras siga así, los swaps no tendrán efecto en Claude Code.');
    }
    if (process.env.CLAUDE_CONFIG_DIR) {
      console.log(`  AVISO: CLAUDE_CONFIG_DIR está definido, se opera sobre ${P.claudeJsonPath()}`);
    }
    console.log('  Ctrl+C para salir\n');
    if (!process.env.NO_OPEN) oauth.openBrowser(url);
    keepAliveTick();
    setInterval(keepAliveTick, KEEPALIVE_EVERY_MS).unref();

    // Auto-rotation monitor. Cheap when idle (reads the active account's cached usage);
    // only swaps when it has genuinely crossed the threshold. Off unless the user enabled it.
    const autoState = auto.load();
    if (autoState.enabled) console.log(`  rotación automática: ON (${autoState.target}, umbral ${autoState.threshold}%)`);
    const autoTick = () => auto.tick(deps).then((r) => {
      if (r && r.rotated) console.log(`  rotación automática: ${r.from} -> ${r.to} (sesión ${r.at}% en ${r.target})`);
    }).catch((err) => console.warn(`  rotación automática: ${oauth.scrub((err && err.message) || err)}`));
    setInterval(autoTick, AUTO_EVERY_MS).unref();
  });
  const bye = () => { server.close(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  return server;
}

if (require.main === module) {
  P.ensureDirs();
  listen(BASE_PORT);
}

module.exports = { createServer, listen };
