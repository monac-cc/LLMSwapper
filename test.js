'use strict';
// One runnable check for the whole project: `node test.js`.
// Runs each module's own self-check, then asserts the cross-module invariants that
// matter - no token ever leaves the process, and the swap never eats a config key.
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('\nLLMSwapper self-check\n');

for (const mod of ['lib/paths.js', 'lib/store.js', 'lib/usage.js', 'lib/swap.js', 'lib/credentials.js', 'lib/targets.js', 'lib/terminal.js', 'lib/auto.js',
  'lib/codex/auth.js', 'lib/codex/store.js', 'lib/codex/targets.js', 'lib/codex/usage.js', 'lib/codex/swap.js', 'lib/codex/routes.js']) {
  check(`${mod} module self-check`, () => {
    execFileSync(process.execPath, [path.join(__dirname, mod)], { stdio: 'pipe', timeout: 30000 });
  });
}

const P = require('./lib/paths');
const usage = require('./lib/usage');
const swapLib = require('./lib/swap');
const oauth = require('./lib/oauth');

// The usage cache is written to disk, so without this the suite would trample the real
// data/usage-cache.json - including, now that it is persisted, the rate-limit cooldown.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-data-'));
P.dataDir = () => SANDBOX;
P.backupsDir = () => path.join(SANDBOX, 'backups');
P.accountsPath = () => path.join(SANDBOX, 'accounts.json');

check('atomic write survives a corrupt-target refusal', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-t-'));
  const f = path.join(tmp, 'x.json');
  P.writeJsonAtomic(f, { a: 1 });
  assert.deepStrictEqual(P.readJsonFile(f), { a: 1 });
  fs.writeFileSync(f, '{ broken');
  assert.throws(() => P.readJsonFile(f), /valid JSON/);
  assert.strictEqual(fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp')).length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('un ~/.claude.json montado como fichero en Docker (rename = EBUSY) se reescribe en el sitio', () => {
  // docker-compose monta ~/.claude.json como bind mount de UN fichero: es un punto de montaje y
  // rename() encima devuelve EBUSY siempre. Antes eso tumbaba el swap Y su rollback.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-ebusy-'));
  const f = path.join(tmp, 'claude.json');
  fs.writeFileSync(f, JSON.stringify({ userID: 'KEEP', oauthAccount: { emailAddress: 'old@x' } }));
  const realRename = fs.renameSync;
  let renames = 0;
  fs.renameSync = () => { renames++; throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
  try {
    P.writeJsonAtomic(f, { userID: 'KEEP', oauthAccount: { emailAddress: 'new@x' } });
  } finally {
    fs.renameSync = realRename;
  }
  assert.ok(renames > 1, 'primero reintenta el rename');
  assert.deepStrictEqual(P.readJsonFile(f), { userID: 'KEEP', oauthAccount: { emailAddress: 'new@x' } });
  assert.strictEqual(fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp')).length, 0, 'sin restos .tmp');

  // Cualquier otro fallo del rename sigue siendo fatal: no se pisa el fichero a ciegas.
  fs.renameSync = () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
  try {
    assert.throws(() => P.writeJsonAtomic(f, { userID: 'OTHER' }), /ENOSPC/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.strictEqual(P.readJsonFile(f).userID, 'KEEP');
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('un fichero montado (otro device que su directorio) se escribe en el sitio, sin rename', () => {
  // Es lo que ve el servidor dentro de Docker: /home/node/.claude.json en un device y
  // /home/node en otro. Ahí el rename nunca va a funcionar, así que ni se intenta.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-mount-'));
  const f = path.join(tmp, 'claude.json');
  fs.writeFileSync(f, JSON.stringify({ userID: 'KEEP', oauthAccount: { emailAddress: 'old@x' } }));
  const realStat = fs.statSync;
  const realRename = fs.renameSync;
  let renames = 0;
  const fakeMount = (nlink) => (p, ...rest) => {
    const st = realStat(p, ...rest);
    if (path.resolve(p) === path.resolve(f)) return Object.assign(st, { dev: st.dev + 1, nlink });
    return st;
  };
  fs.renameSync = (...a) => { renames++; return realRename(...a); };
  try {
    fs.statSync = fakeMount(1);
    assert.strictEqual(P.isMountedFile(f), true);
    assert.strictEqual(P.isDetachedMount(f), false);
    P.writeJsonAtomic(f, { userID: 'KEEP', oauthAccount: { emailAddress: 'new@x' } });
    assert.strictEqual(renames, 0, 'sin rename');
    fs.statSync = realStat;
    assert.deepStrictEqual(P.readJsonFile(f), { userID: 'KEEP', oauthAccount: { emailAddress: 'new@x' } });
    assert.strictEqual(fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp')).length, 0, 'sin restos .tmp');

    // Host Linux: Claude Code renombró un fichero nuevo encima y el contenedor se quedó con el
    // inode viejo (nlink 0). Escribir ahí sería un swap "correcto" que el host nunca vería.
    fs.statSync = fakeMount(0);
    assert.strictEqual(P.isDetachedMount(f), true);
    assert.throws(() => P.writeJsonAtomic(f, { userID: 'LOST' }), /reinicia el contenedor/);
    fs.statSync = realStat;
    assert.strictEqual(P.readJsonFile(f).userID, 'KEEP', 'no se toca el fichero');
    assert.strictEqual(renames, 0);
  } finally {
    fs.statSync = realStat;
    fs.renameSync = realRename;
  }
  assert.strictEqual(P.isMountedFile(f), false, 'un fichero normal no es un punto de montaje');
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('writeJsonAtomic refuses to write a non-object as a whole config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-t-'));
  assert.throws(() => P.writeJsonAtomic(path.join(tmp, 'y.json'), undefined), /empty JSON/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('scrub() removes tokens from anything headed for a log or a response', () => {
  // Assembled at runtime so this fixture cannot trip the "no hardcoded token" scan below.
  const dirty = `error: token sk-ant-${'oat'}01-AbC_dEf_1234567890 rejected`;
  assert.ok(!oauth.scrub(dirty).includes('AbC_dEf'));
  assert.ok(oauth.scrub(dirty).includes('sk-ant-***'));
  assert.strictEqual(oauth.scrub(null), '');
});

check('scrub() also redacts OpenAI JWTs and refresh tokens', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'RS256' })}.${b64({ email: 'x@y.z' })}.${'s'.repeat(40)}`;
  const rt = `rt.A.${'q'.repeat(120)}`;
  const out = oauth.scrub(`bad ${jwt} and ${rt} end`);
  assert.ok(!out.includes(jwt) && !out.includes(rt), out);
  assert.match(out, /eyJ\*\*\*/);
  assert.strictEqual(oauth.scrub('sk-ant-oat01-abc'), 'sk-ant-***', 'Claude behaviour unchanged');
});

check('lib/usage y lib/targets exportan lo que reutiliza lib/codex', () => {
  const targets = require('./lib/targets');
  assert.deepStrictEqual(usage.meter(12, 'T'), { percent: 12, resetsAt: 'T', severity: 'normal' });
  assert.strictEqual(usage.num('7.25'), 7.3);
  for (const fn of ['runWsl', 'wslPath', 'uncBaseCandidates']) assert.strictEqual(typeof targets[fn], 'function', fn);
});

check('expires_in seconds becomes an absolute ms epoch', () => {
  const before = Date.now();
  const stored = oauth.toStoredOauth({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'x y' });
  assert.ok(stored.expiresAt > before + 3500 * 1000, 'expiresAt must be ms in the future');
  assert.ok(stored.expiresAt < before + 3700 * 1000, 'expiresAt must not be seconds-as-ms');
  assert.deepStrictEqual(stored.scopes, ['x', 'y']);
});

check('normalize() handles the verified payload, legacy-only, and all-null', () => {
  const live = usage.normalize({
    limits: [
      { kind: 'session', percent: 90, resets_at: 'A' },
      { kind: 'weekly_all', percent: 28, resets_at: 'B' },
    ],
  }, 'i');
  assert.strictEqual(live.session.percent, 90);
  assert.strictEqual(live.weekly.percent, 28);

  const legacy = usage.normalize({ five_hour: { utilization: 12 }, seven_day: { utilization: 99 }, limits: [] }, 'i');
  assert.strictEqual(legacy.session.percent, 12);
  assert.strictEqual(legacy.weekly.severity, 'critical');

  const nothing = usage.normalize({}, 'i');
  assert.strictEqual(nothing.session.percent, 0);
  assert.ok(!Number.isNaN(nothing.weekly.percent));
});

check('swap preserves every unrelated key in a realistic .claude.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-cfg-'));
  const cj = path.join(tmp, '.claude.json');
  const original = {
    numStartups: 7,
    projects: { '/x': { allowedTools: [], history: ['a', 'b'] } },
    mcpServers: { s: { command: 'c', args: ['--x'] } },
    tipsHistory: { t: 3 },
    plugins: { installed: ['p1'] },
    userID: 'INSTALL-ID',
    machineID: 'MACHINE',
    oauthAccount: { emailAddress: 'old@x', accountUuid: 'u-old' },
    modelAccessCache: [1],
    hasAvailableSubscription: true,
  };
  fs.writeFileSync(cj, JSON.stringify(original, null, 2));

  swapLib.writeClaudeJson(cj, { accountUuid: 'u-new', emailAddress: 'new@x', displayName: 'N' });
  const after = JSON.parse(fs.readFileSync(cj, 'utf8'));

  for (const key of ['numStartups', 'projects', 'mcpServers', 'tipsHistory', 'plugins', 'userID', 'machineID']) {
    assert.deepStrictEqual(after[key], original[key], `${key} must survive the swap untouched`);
  }
  assert.strictEqual(after.oauthAccount.emailAddress, 'new@x');
  assert.ok(!('modelAccessCache' in after), 'stale cache must be dropped');
  assert.ok(!('hasAvailableSubscription' in after), 'stale cache must be dropped');
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('swap refuses to touch a config it cannot parse', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-bad-'));
  const bad = path.join(tmp, '.claude.json');
  fs.writeFileSync(bad, 'not json at all');
  assert.throws(() => swapLib.writeClaudeJson(bad, { accountUuid: 'x' }));
  assert.strictEqual(fs.readFileSync(bad, 'utf8'), 'not json at all', 'the bad file must be left alone');
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('credentials round-trip through the file backend', () => {
  // CLAUDE_CONFIG_DIR redirects paths.credentialsPath() and, on macOS, names a Keychain item
  // that cannot exist (lib/credentials suffixes the service with a hash of the directory, as
  // Claude Code does), so this never touches the real credentials on any platform.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-cred-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    delete require.cache[require.resolve('./lib/credentials')];
    const credentials = require('./lib/credentials');

    assert.strictEqual(credentials.read(), null, 'nothing stored yet');

    const blob = {
      mcpOAuth: { 'srv|1': { serverName: 'srv', accessToken: 'keep' } },
      claudeAiOauth: { accessToken: 'A', refreshToken: 'R', expiresAt: 1, scopes: [] },
    };
    credentials.write(blob);

    const back = credentials.read();
    assert.deepStrictEqual(back, blob, 'what goes in must come out');
    assert.ok(back.mcpOAuth, 'mcpOAuth must survive a round-trip');

    // The swap mutation must preserve mcpOAuth when going through the backend.
    swapLib.writeCredentials(null, { accessToken: 'B', refreshToken: 'R2', expiresAt: 2, scopes: ['s'] });
    const after = credentials.read();
    assert.strictEqual(after.claudeAiOauth.accessToken, 'B');
    assert.strictEqual(after.mcpOAuth['srv|1'].accessToken, 'keep', 'mcpOAuth must not be clobbered');

    const backend = credentials.describeBackend();
    assert.ok(backend.kind === 'file' || backend.kind === 'keychain');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    delete require.cache[require.resolve('./lib/credentials')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('the macOS branch degrades to the file backend, and a throwaway CLAUDE_CONFIG_DIR keeps it off the real Keychain', () => {
  // Forces the darwin path on whatever this really is. Where `security` does not exist
  // (or holds no item) the Keychain read must fail soft and fall back to the file -
  // this is the closest thing to macOS coverage without a Mac.
  //
  // Regresión con víctima (PR #1): el Keychain es global y write() lo prefería en cuanto
  // encontraba el item, así que en un Mac esta suite pisó las credenciales reales con tokens
  // de fixture. Claude Code nombra el item por CLAUDE_CONFIG_DIR (sufijo sha256) y ahora
  // nosotros también, de modo que un directorio de usar y tirar apunta a un item que no
  // existe. No basta con mirar qué backend sale elegido: se interceptan las llamadas a
  // `security` y se exige que todas lleven el sufijo, la cuenta de Claude Code, y que
  // ninguna escriba.
  const cp = require('node:child_process');
  const realExec = cp.execFileSync;
  const invoked = [];
  cp.execFileSync = (file, args, ...rest) => { invoked.push({ file, args }); return realExec(file, args, ...rest); };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-darwin-'));
  const realPlatform = process.platform;
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    delete require.cache[require.resolve('./lib/credentials')];
    const credentials = require('./lib/credentials');
    const suffix = require('node:crypto').createHash('sha256').update(tmp).digest('hex').slice(0, 8);
    assert.strictEqual(credentials.SERVICE, `Claude Code-credentials-${suffix}`, 'el item lleva el sufijo del config dir');
    assert.strictEqual(credentials.ACCOUNTS[0], 'claude-code-user', 'la cuenta que usa Claude Code 2.1+');

    assert.strictEqual(credentials.isMac(), true, 'must take the mac branch');
    assert.strictEqual(credentials.read(), null, 'no keychain and no file -> null, not a throw');

    const blob = { mcpOAuth: { a: 1 }, claudeAiOauth: { accessToken: 'X' } };
    assert.strictEqual(credentials.write(blob).kind, 'file', 'must fall back to the file');
    assert.deepStrictEqual(credentials.read(), blob);
    assert.ok(['file', 'keychain'].includes(credentials.describeBackend().kind));

    const sec = invoked.filter((c) => c.file === 'security');
    assert.ok(sec.length > 0, 'the mac branch must have asked the Keychain');
    for (const c of sec) {
      assert.strictEqual(c.args[0], 'find-generic-password', 'nunca escribe en el Keychain con un CLAUDE_CONFIG_DIR de usar y tirar');
      assert.ok(c.args.includes(`Claude Code-credentials-${suffix}`), 'cada lectura apunta al item con sufijo, nunca al real');
    }
  } finally {
    cp.execFileSync = realExec;
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    delete require.cache[require.resolve('./lib/credentials')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('el keep-alive solo sincroniza la sesión viva si sigue siendo de esa cuenta', () => {
  // Regresión: el keep-alive escribía por RUTA (saltándose el Keychain en macOS) y decidía
  // por activeId, que durante un swap va por detrás de la realidad varios segundos.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-sync-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    delete require.cache[require.resolve('./lib/credentials')];
    const credentials = require('./lib/credentials');
    credentials.write({
      mcpOAuth: { 'srv|1': { accessToken: 'keep' } },
      claudeAiOauth: { accessToken: 'A-acc', refreshToken: 'A-ref', expiresAt: 1, scopes: [] },
    });

    // Otra cuenta se ha adueñado de la sesión viva (un swap, o un /login a mano).
    const foreign = swapLib.syncLiveCredentials('B-ref', { accessToken: 'B2', refreshToken: 'B2r', expiresAt: 2 });
    assert.strictEqual(foreign, false, 'no debe escribir sobre una sesión que ya no es suya');
    assert.strictEqual(credentials.read().claudeAiOauth.accessToken, 'A-acc');

    // La sesión viva sigue siendo de A: el par rotado sí tiene que entrar, o el refresh
    // token que acaba de morir se queda como el único que conoce Claude Code.
    const own = swapLib.syncLiveCredentials('A-ref', {
      accessToken: 'A2-acc', refreshToken: 'A2-ref', expiresAt: 2, scopes: [],
    });
    assert.strictEqual(own, true);
    const after = credentials.read();
    assert.strictEqual(after.claudeAiOauth.accessToken, 'A2-acc');
    assert.strictEqual(after.claudeAiOauth.refreshToken, 'A2-ref');
    assert.strictEqual(after.mcpOAuth['srv|1'].accessToken, 'keep', 'mcpOAuth debe sobrevivir');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    delete require.cache[require.resolve('./lib/credentials')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('el store adopta el par que Claude Code rotó por su cuenta, y solo si sabe de quién es', () => {
  // Claude Code renueva su propia sesión y el refresh rota: el par vivo avanza y la copia
  // del store muere. Sin esto, semanas después el keep-alive fallaba con invalid_grant y
  // la cuenta solo se recuperaba con un login, que es justo lo que la app evita.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-adopt-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const store = require('./lib/store');
  try {
    const profile = { accountUuid: 'uuid-live', emailAddress: 'live@x.com', displayName: 'Live' };
    const account = store.add({
      email: 'live@x.com', profile,
      oauth: { accessToken: 'VIEJO', refreshToken: 'R-VIEJO', expiresAt: 1, subscriptionType: 'max' },
    });
    store.setActive(account.id);
    const writeLive = (refreshToken) => P.writeJsonAtomic(P.credentialsPath(), {
      claudeAiOauth: { accessToken: 'NUEVO', refreshToken, expiresAt: 2, scopes: [] },
    }, 0o600);
    const claudeJson = (accountUuid) => P.writeJsonAtomic(P.claudeJsonPath(), { oauthAccount: { accountUuid } });

    // Sin deriva: el par vivo es el que ya tiene guardado, no hay nada que adoptar.
    writeLive('R-VIEJO');
    claudeJson('uuid-live');
    assert.strictEqual(swapLib.adoptLiveTokens(store), null, 'sin deriva no debe tocar nada');

    // Deriva, pero ~/.claude.json dice que la sesión es de OTRA cuenta: no se sabe de quién
    // es el par, así que no se escribe. Adoptarlo metería tokens ajenos en esta cuenta.
    writeLive('R-NUEVO');
    claudeJson('uuid-de-otro');
    assert.strictEqual(swapLib.adoptLiveTokens(store), null, 'identidad no corroborada: no adoptar');
    assert.strictEqual(store.get(account.id).oauth.refreshToken, 'R-VIEJO');

    // Deriva y las dos fuentes coinciden: solo se movieron los tokens. Se adopta.
    claudeJson('uuid-live');
    assert.strictEqual(swapLib.adoptLiveTokens(store), account.id);
    const after = store.get(account.id).oauth;
    assert.strictEqual(after.refreshToken, 'R-NUEVO');
    assert.strictEqual(after.accessToken, 'NUEVO');
    assert.strictEqual(after.subscriptionType, 'max', 'lo que el store sabía de más debe sobrevivir');

    // Mount desprendido (Linux, ver paths.js): ~/.claude.json es una copia congelada que dirá
    // "uuid-live" para siempre, mientras el host puede haber hecho login con OTRA cuenta. No se
    // adopta nada: injertaría el par de esa otra cuenta en esta y perdería el suyo.
    writeLive('R-DE-OTRO-LOGIN');
    const realStat = fs.statSync;
    fs.statSync = (p, ...rest) => {
      const st = realStat(p, ...rest);
      return path.resolve(p) === path.resolve(P.claudeJsonPath()) ? Object.assign(st, { nlink: 0 }) : st;
    };
    try {
      assert.strictEqual(swapLib.adoptLiveTokens(store), null, 'copia congelada: no adoptar');
    } finally {
      fs.statSync = realStat;
    }
    assert.strictEqual(store.get(account.id).oauth.refreshToken, 'R-NUEVO', 'el par guardado no se toca');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(P.accountsPath(), { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('la rotación automática persiste su estado y clampa el umbral', () => {
  const auto = require('./lib/auto');
  try {
    auto.set({ enabled: true, threshold: 85 });
    let s = auto.load();
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.threshold, 85);
    auto.set({ threshold: 999 });          // fuera de rango -> clamp a 100
    assert.strictEqual(auto.load().threshold, 100);
    auto.set({ enabled: false });
    assert.strictEqual(auto.load().enabled, false, 'apagar debe persistir');
  } finally {
    auto.set({ enabled: false, threshold: 90 }); // no dejar el sandbox con auto encendido
  }
});

check('un swap a un target de fichero (WSL) escribe en SUS ficheros, no en los del host', () => {
  // Un target WSL es exactamente esto: fileBackend + dos rutas propias. Simulado con un
  // directorio temporal - misma mecánica que las rutas UNC \\wsl.localhost\... reales.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-wsl-'));
  const target = {
    id: 'wsl:test', kind: 'wsl', label: 'WSL · test',
    claudeJsonPath: path.join(tmp, '.claude.json'),
    credentialsPath: path.join(tmp, '.claude', '.credentials.json'),
    fileBackend: true,
  };
  fs.mkdirSync(path.join(tmp, '.claude'));
  fs.writeFileSync(target.credentialsPath, JSON.stringify({
    mcpOAuth: { 'srv|1': { accessToken: 'keep' } },
    claudeAiOauth: { accessToken: 'OLD', refreshToken: 'OLDR', expiresAt: 1, scopes: [] },
  }, null, 2));
  fs.writeFileSync(target.claudeJsonPath, JSON.stringify({
    userID: 'WSL-INSTALL-ID', projects: { '/x': { history: [1] } },
    oauthAccount: { emailAddress: 'old@wsl', accountUuid: 'old-uuid' },
    modelAccessCache: [1],
  }, null, 2));

  swapLib.writeCredentials(target, { accessToken: 'NEW', refreshToken: 'NEWR', expiresAt: 2, scopes: ['s'], subscriptionType: 'max' });
  swapLib.writeClaudeJson(target.claudeJsonPath, { accountUuid: 'new-uuid', emailAddress: 'new@wsl', displayName: 'N' });

  const cred = JSON.parse(fs.readFileSync(target.credentialsPath, 'utf8'));
  assert.strictEqual(cred.claudeAiOauth.accessToken, 'NEW', 'la credencial del target se actualiza');
  assert.strictEqual(cred.mcpOAuth['srv|1'].accessToken, 'keep', 'mcpOAuth del target sobrevive');
  const cj = JSON.parse(fs.readFileSync(target.claudeJsonPath, 'utf8'));
  assert.strictEqual(cj.oauthAccount.emailAddress, 'new@wsl');
  assert.strictEqual(cj.userID, 'WSL-INSTALL-ID', 'userID del target intacto');
  assert.ok(!('modelAccessCache' in cj), 'caché stale del target descartada');

  // Backup + restore contra ese mismo target vuelve a dejarlo como estaba.
  const backup = swapLib.backupNow('acc_x', target);
  swapLib.writeClaudeJson(target.claudeJsonPath, { accountUuid: 'z', emailAddress: 'z@z', displayName: 'Z' });
  swapLib.restoreFrom(backup.dir, target);
  const back = JSON.parse(fs.readFileSync(target.claudeJsonPath, 'utf8'));
  assert.strictEqual(back.oauthAccount.emailAddress, 'new@wsl', 'restore del target vuelve al estado respaldado');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(backup.dir, { recursive: true, force: true });
});

check('un target que no resuelve no cae en silencio al host', () => {
  // swap.js tomaba `targets.resolve(t) || hostTarget()`: un distro parado, o un id mal escrito
  // desde una skill, reescribía las credenciales del HOST y devolvía ok.
  assert.throws(() => swapLib.asTarget('wsl:no-existe'), /Target desconocido/);
  assert.strictEqual(swapLib.asTarget('host').id, 'host');
  assert.strictEqual(swapLib.asTarget(undefined).id, 'host');
});

check('el rollback restaura ~/.claude.json con escritura atómica, no copyFileSync', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-rb-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    const backupDir = path.join(tmp, 'backup');
    fs.mkdirSync(backupDir);
    const original = { userID: 'KEEP', projects: { '/x': { history: [1] } }, oauthAccount: { emailAddress: 'old@x' } };
    fs.writeFileSync(path.join(backupDir, 'claude.json'), JSON.stringify(original, null, 2));
    fs.writeFileSync(P.claudeJsonPath(), '{"oauthAccount":{"emailAddress":"new@x"}}');

    const restored = swapLib.restoreFrom(backupDir);
    assert.ok(restored.includes(P.claudeJsonPath()));
    assert.deepStrictEqual(P.readJsonFile(P.claudeJsonPath()), original);
    assert.strictEqual(fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp')).length, 0, 'sin restos .tmp');

    // Si la config viva sigue siendo byte a byte el backup (la escritura se rechazó antes de
    // tocarla), no hay nada que restaurar: ni se escribe ni se dice que falló la restauración.
    fs.copyFileSync(path.join(backupDir, 'claude.json'), P.claudeJsonPath());
    const realWrite = P.writeJsonAtomic;
    P.writeJsonAtomic = (p) => { throw new Error(`no debería escribir ${p}`); };
    try {
      assert.deepStrictEqual(swapLib.restoreFrom(backupDir), []);
    } finally {
      P.writeJsonAtomic = realWrite;
    }

    // Y un backup corrupto no puede llevarse por delante la configuración viva: la ruta
    // atómica lo rechaza antes de abrir el destino. copyFileSync lo habría copiado encima,
    // que es la misma ventana por la que un fallo a mitad de copia dejaba un fragmento.
    const live = fs.readFileSync(P.claudeJsonPath(), 'utf8');
    fs.writeFileSync(path.join(backupDir, 'claude.json'), '{ roto');
    assert.throws(() => swapLib.restoreFrom(backupDir), /JSON/);
    assert.strictEqual(fs.readFileSync(P.claudeJsonPath(), 'utf8'), live, 'la config viva debe quedar intacta');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('el suelo de ritmo deja como mucho 4 peticiones en la ventana de 300 s', () => {
  // Lo que importa no es la tasa media sino cuántas caben en la ventana del endpoint:
  // con un hueco g son floor(300/g)+1, y la quinta es la que devuelve 429.
  const perWindow = Math.floor((300 * 1000) / usage.MIN_GAP_MS) + 1;
  assert.ok(perWindow <= 4, `MIN_GAP_MS=${usage.MIN_GAP_MS}ms permite ${perWindow} peticiones por ventana`);
});

check('hardenDataDir deja constancia aunque icacls falle', () => {
  // ponytail: fuera de Windows la función no hace nada, así que no hay nada que probar.
  if (process.platform !== 'win32') return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-acl-'));
  const realRoot = process.env.SystemRoot;
  process.env.SystemRoot = path.join(tmp, 'no-such-windows');
  try {
    P.hardenDataDir(tmp);
    const marker = path.join(tmp, '.acl-applied');
    assert.ok(fs.existsSync(marker), 'sin marcador, ensureDirs() relanza icacls en cada lectura');
    assert.match(fs.readFileSync(marker, 'utf8'), /NOT applied/, 'el fallo debe quedar escrito');
  } finally {
    if (realRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = realRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('detectClaudeProcesses never throws', () => {
  const r = swapLib.detectClaudeProcesses();
  assert.strictEqual(typeof r.running, 'boolean');
  assert.ok(Array.isArray(r.pids));
});

check('[hidden] beats any class rule that sets display', () => {
  // Regression: a .modal-backdrop{display:grid} rule outranked the UA [hidden] rule,
  // leaving the empty state and the banners permanently visible.
  const css = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'style.css must force [hidden] to none');
});

check('no source file hardcodes a token', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name === 'node_modules' || d.name === 'data' || d.name === '.git') return [];
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full) : /\.(js|mjs|html|css|md)$/.test(d.name) ? [full] : [];
  });
  for (const file of walk(__dirname)) {
    const text = fs.readFileSync(file, 'utf8');
    const hit = text.match(/sk-ant-(oat|ort)01-[A-Za-z0-9_-]{10,}/)
      // An OpenAI access or id token (Codex). Fixtures build theirs at runtime.
      || text.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
    assert.ok(!hit, `${path.relative(__dirname, file)} contains what looks like a real token`);
  }
});

check('las tres skills llevan el mismo swapper.mjs', () => {
  // Se editan en bloque (seis de los últimos quince commits tocaron las tres) y nada lo garantizaba.
  const [a, b, c] = ['swapper', 'swapper-usage', 'swapper-auto']
    .map((sk) => fs.readFileSync(path.join(__dirname, 'skills', sk, 'swapper.mjs'), 'utf8'));
  assert.strictEqual(a, b, 'swapper-usage/swapper.mjs difiere de swapper/swapper.mjs');
  assert.strictEqual(a, c, 'swapper-auto/swapper.mjs difiere de swapper/swapper.mjs');
});

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

(async () => {
  await checkAsync('con el mount desprendido, swapTo rechaza ANTES de hacer backup o tocar credenciales', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-detached-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmp;
    delete require.cache[require.resolve('./lib/credentials')];
    const store = require('./lib/store');
    try {
      fs.writeFileSync(P.credentialsPath(), '{"claudeAiOauth":{"accessToken":"HOST","refreshToken":"R-HOST"}}');
      fs.writeFileSync(P.claudeJsonPath(), '{"oauthAccount":{"accountUuid":"uuid-host"}}');
      const account = store.add({
        email: 'next@x.com', profile: { accountUuid: 'uuid-next', emailAddress: 'next@x.com' },
        oauth: { accessToken: 'NEXT', refreshToken: 'R-NEXT', expiresAt: Date.now() + 3600e3 },
      });
      const backupsBefore = fs.existsSync(P.backupsDir()) ? fs.readdirSync(P.backupsDir()).length : 0;
      const credsBefore = fs.readFileSync(P.credentialsPath());
      const realStat = fs.statSync;
      fs.statSync = (p, ...rest) => {
        const st = realStat(p, ...rest);
        return path.resolve(p) === path.resolve(P.claudeJsonPath()) ? Object.assign(st, { nlink: 0 }) : st;
      };
      try {
        await assert.rejects(swapLib.swapTo(account.id, { store, oauth: {}, usage: {} }), (err) => {
          assert.match(err.message, /reinicia el contenedor/);
          assert.doesNotMatch(err.message, /RESTAURACI/, 'no hubo nada que restaurar, y no debe decir lo contrario');
          return true;
        });
      } finally {
        fs.statSync = realStat;
      }
      const backupsAfter = fs.existsSync(P.backupsDir()) ? fs.readdirSync(P.backupsDir()).length : 0;
      assert.strictEqual(backupsAfter, backupsBefore, 'sin backup nuevo');
      assert.ok(fs.readFileSync(P.credentialsPath()).equals(credsBefore), 'credenciales intactas');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      delete require.cache[require.resolve('./lib/credentials')];
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('dos swaps a la vez: el segundo se rechaza en vez de entrelazarse con el primero', async () => {
    // El monitor de rotación y un swap manual pueden coincidir; sin esto ambos hacían
    // backup/escritura/verificación/rollback sobre los mismos dos ficheros.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-lock-'));
    const target = {
      id: 'host', kind: 'host', label: 'test',
      claudeJsonPath: path.join(tmp, '.claude.json'),
      credentialsPath: path.join(tmp, '.credentials.json'),
      fileBackend: true,
    };
    fs.writeFileSync(target.credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'OLD', refreshToken: 'R', expiresAt: 1, scopes: ['s'] } }));
    fs.writeFileSync(target.claudeJsonPath, JSON.stringify({ oauthAccount: { accountUuid: 'old' } }));
    const account = {
      id: 'acc_lock', label: 'Lock', email: null,
      oauth: { accessToken: 'NEW', refreshToken: null, expiresAt: Date.now() + 1e9, scopes: ['user:inference'] },
    };
    const store = { get: (id) => (id === account.id ? account : null), setActive() {}, canReadUsage: () => false, publicAccount: (x) => ({ id: x.id, label: x.label }) };
    let release;
    const gate = new Promise((r) => { release = r; });
    const deps = {
      store,
      usage: { invalidate() {}, prime: (_, v) => v, normalize: (raw) => raw, fetchRaw: async () => ({}) },
      oauth: { probeToken: async () => { await gate; return { kind: 'inference' }; } },
    };
    try {
      const first = swapLib.swapTo(account.id, deps, target);
      // The lock is taken synchronously, so the second call is refused even with the gate
      // already open - and it has to be open: without the lock the second swap would park on
      // it and the suite would hang instead of failing.
      release();
      await assert.rejects(swapLib.swapTo(account.id, deps, target), /en curso/);
      assert.strictEqual((await first).ok, true);
      // Y una vez terminado, el siguiente vuelve a entrar.
      assert.strictEqual((await swapLib.swapTo(account.id, deps, target)).ok, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('la rotación automática excluye un token rechazado y no reintenta cada tick un swap fallido', async () => {
    const auto = require('./lib/auto');
    auto.save({ enabled: true, target: 'host', threshold: 90, lastSwapAt: 0 });
    const live = { accessToken: 't', expiresAt: Date.now() + 1e6 };
    const accounts = [
      { id: 'cur', label: 'Cur', oauth: { ...live } },
      { id: 'dead', label: 'Dead', oauth: { ...live } },
      { id: 'sana', label: 'Sana', oauth: { ...live } },
    ];
    const readings = {
      cur: { ok: true, session: { percent: 95 }, weekly: { percent: 10 } },
      // 401 al leer su uso: credencial muerta. Antes contaba como "uso desconocido" y era
      // elegible, así que el monitor rotaba a ella, el verify fallaba, y vuelta a empezar.
      dead: { ok: false, status: 401, needsRelogin: true },
      sana: { ok: true, session: { percent: 5 }, weekly: { percent: 5 } },
    };
    const store = { list: () => accounts, get: (id) => accounts.find((a) => a.id === id) || null, activeFor: () => 'cur' };
    const usage = {
      fetchFor: async (a) => readings[a.id],
      fetchAll: async (list) => Object.fromEntries(list.map((a) => [a.id, readings[a.id]])),
      cachedFor: (id) => readings[id],
    };
    const calls = [];
    const swap = {
      asTarget: () => ({ claudeJsonPath: path.join(SANDBOX, 'no-existe.json') }),
      swapTo: async (id) => { calls.push(id); throw new Error('verify falló'); },
    };
    try {
      // Only a dead account to rotate into: nothing is tried, swapTo is not even called.
      const onlyDead = { ...store, list: () => accounts.filter((a) => a.id !== 'sana') };
      const r = await auto.tick({ store: onlyDead, usage, swap });
      assert.strictEqual(r && r.rotated, false, 'un token rechazado no es candidato');
      assert.deepStrictEqual(calls, [], 'ni siquiera se intenta el swap');

      await assert.rejects(auto.tick({ store, usage, swap }), /verify falló/);
      assert.deepStrictEqual(calls, ['sana'], 'rota a la cuenta sana, nunca a la del token rechazado');
      assert.strictEqual(await auto.tick({ store, usage, swap }), null, 'un swap fallido arma el cooldown igual');
      assert.strictEqual(calls.length, 1, 'no se reintenta en el tick siguiente');
      assert.ok(auto.load().lastSwapAt > 0);
    } finally {
      auto.save({ enabled: false, target: 'host', threshold: 90, lastSwapAt: 0 });
    }
  });

  await checkAsync('codex: con el puerto del login ocupado o reservado, se detecta y el alta pasa al código de dispositivo', async () => {
    // Windows puede reservar el 1455 (rango dinámico que empieza en 1024 + Hyper-V/WSL): codex login
    // falla entonces con os error 10013. El panel lo comprueba antes de abrir la terminal.
    const terminal = require('./lib/terminal');
    const holder = require('node:net').createServer();
    await new Promise((r) => holder.listen({ host: '127.0.0.1', port: 0 }, r));
    const { port } = holder.address();
    try {
      assert.strictEqual(await terminal.loginPortFree(port), false, 'un puerto ocupado no está libre');
    } finally {
      await new Promise((r) => holder.close(r));
    }
    assert.strictEqual(await terminal.loginPortFree(port), true, 'liberado, vuelve a estar libre');
  });

  await checkAsync('la cabecera X-Swapper es obligatoria en toda la API, GET incluido', async () => {
    // Un <img src="http://127.0.0.1:7373/api/health"> desde cualquier web pasaba las tres
    // guardas: sin Origin, método GET, y Host correcto. Cada llamada lanza un tasklist.
    const server = require('./server');
    const PORT = 7999;
    const s = server.createServer(PORT);
    await new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(PORT, '127.0.0.1', resolve);
    });
    try {
      const base = `http://127.0.0.1:${PORT}`;
      assert.strictEqual((await fetch(`${base}/api/health`)).status, 403, 'GET a la API sin cabecera');
      assert.strictEqual((await fetch(`${base}/api/accounts`)).status, 403, 'GET a la API sin cabecera');
      assert.strictEqual((await fetch(`${base}/api/health`, { headers: { 'X-Swapper': '1' } })).status, 200);
      assert.strictEqual((await fetch(`${base}/style.css`)).status, 200, 'los estáticos no pueden exigirla');
    } finally {
      await new Promise((resolve) => s.close(resolve));
    }
  });

  await checkAsync('el cooldown de un 429 sobrevive a reiniciar el servidor', async () => {
    const realFetch = global.fetch;
    const account = { id: 'rst1', oauth: { accessToken: 'tok' } };
    try {
      usage.invalidate();
      usage.resetCooldown();
      global.fetch = async () => ({
        ok: false, status: 429,
        headers: { get: (h) => (h === 'retry-after' ? '300' : null) },
        text: async () => '{"error":{"type":"rate_limit_error"}}',
      });
      await usage.fetchFor(account, { force: true });
      assert.ok(usage.cooldownRemainingMs() > 0, 'el 429 arma el cooldown');

      // Reiniciar el proceso = cargar el módulo desde cero. Antes, eso lo olvidaba todo y
      // el arranque siguiente volvía derecho al endpoint que seguía castigando.
      delete require.cache[require.resolve('./lib/usage')];
      const restarted = require('./lib/usage');
      assert.ok(restarted.cooldownRemainingMs() > 0, 'el cooldown debe sobrevivir al reinicio');

      let called = false;
      global.fetch = async () => { called = true; throw new Error('must not be called'); };
      await restarted.fetchFor(account, { force: true });
      assert.strictEqual(called, false, 'tras reiniciar no debe volver a golpear el endpoint');
      restarted.resetCooldown();
    } finally {
      global.fetch = realFetch;
      delete require.cache[require.resolve('./lib/usage')];
      usage.resetCooldown();
      usage.invalidate();
    }
  });

  await checkAsync('una cuenta con el token muerto no monopoliza el turno', async () => {
    // cache.at solo avanza al triunfar, así que una cuenta con 401 se quedaba en 0 y ganaba
    // el orden "más desactualizada primero" en TODOS los barridos, para siempre.
    const accounts = ['broken', 'good1', 'good2'].map((n) => ({ id: `st-${n}`, oauth: { accessToken: n } }));
    const realFetch = global.fetch;
    const asked = [];
    try {
      usage.invalidate();
      usage.resetCooldown();
      global.fetch = async (url, opts) => {
        const who = String(opts.headers.Authorization).replace('Bearer ', '');
        asked.push(who);
        if (who === 'broken') {
          return { ok: false, status: 401, headers: { get: () => null }, text: async () => 'unauthorized' };
        }
        return {
          ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify({ limits: [{ kind: 'session', percent: 5 }] }),
        };
      };
      // Tres barridos. resetCooldown entre ellos solo levanta el suelo de 80 s, que si no
      // haría del test una espera de cuatro minutos; el orden de turnos no se toca.
      for (let i = 0; i < 3; i++) {
        await usage.fetchAll(accounts, { force: true });
        usage.resetCooldown();
      }
      assert.strictEqual(asked.length, 3, `un barrido, una petición (${asked.join(', ')})`);
      assert.strictEqual(asked[0], 'broken', 'la primera vez sí gana la más desactualizada');
      assert.ok(!asked.slice(1).includes('broken'), `la cuenta muerta repitió turno: ${asked.join(', ')}`);
    } finally {
      global.fetch = realFetch;
      usage.invalidate();
      usage.resetCooldown();
    }
  });

  await checkAsync('un refresh forzado encadena hasta refrescar TODAS las cuentas, y solo una vez cada una', async () => {
    // Regresión: el tope de 80 s deja pasar UNA llamada por barrido. Las demás volvían como
    // stale sin retryInS, el frontend no reintentaba, y con 4 cuentas tardaban 40 min en
    // estar frescas. Ahora vuelven `queued` con retryInS y quedan pendientes: el siguiente
    // barrido (sin force) las refresca saltando la caché, y la cadena acaba cuando no queda
    // ninguna pendiente — sin volver a pedir una cuenta recién refrescada.
    const accounts = ['a', 'b', 'c'].map((n) => ({ id: `chain-${n}`, oauth: { accessToken: n, scopes: ['user:profile'] } }));
    const realFetch = global.fetch;
    const asked = [];
    const body = JSON.stringify({ limits: [{ kind: 'session', percent: 5 }, { kind: 'weekly_all', percent: 5 }] });
    try {
      usage.invalidate();
      usage.resetCooldown();
      global.fetch = async (url, opts) => {
        asked.push(String(opts.headers.Authorization).replace('Bearer ', ''));
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
      };
      // Precalentar: las tres con caché (cada una en su turno)… y luego envejecerla más allá
      // del suelo de 80 s, que es el estado real de un usuario pulsando refresh: caché vieja
      // pero no caducada. Recién pedidas, un force las devolvería tal cual sin llamar.
      for (let i = 0; i < 3; i++) { await usage.fetchAll(accounts, { force: true }); usage.resetCooldown(); }
      for (const a of accounts) usage.prime(a.id, usage.cachedFor(a.id), Date.now() - 2 * usage.MIN_GAP_MS);
      asked.length = 0;

      // Barrido FORZADO: una entra, dos quedan en cola con retryInS.
      const r1 = await usage.fetchAll(accounts, { force: true });
      const queued = Object.values(r1).filter((u) => u.queued);
      assert.strictEqual(asked.length, 1, 'el tope deja pasar una sola llamada');
      assert.strictEqual(queued.length, 2, 'las otras dos vuelven en cola');
      assert.ok(queued.every((u) => Number.isFinite(u.retryInS) && u.retryInS > 0), 'con retryInS para encadenar');

      // Cadena: barridos SIN force (como hace el frontend) hasta que no quede nada en cola.
      let rounds = 0;
      let last = r1;
      while (Object.values(last).some((u) => u.queued) && rounds < 5) {
        usage.resetCooldown(); // levanta el suelo de 80 s; no es un test de esperar
        last = await usage.fetchAll(accounts, {});
        rounds++;
      }
      assert.strictEqual(asked.length, 3, `tres cuentas, tres llamadas en total (${asked.join(',')})`);
      assert.strictEqual(new Set(asked).size, 3, 'cada cuenta exactamente una vez, ninguna repetida');
      assert.ok(!Object.values(last).some((u) => u.queued), 'la cadena termina sin nada en cola');

      // Y un barrido más SIN force no gasta nada: todas frescas.
      usage.resetCooldown();
      await usage.fetchAll(accounts, {});
      assert.strictEqual(asked.length, 3, 'nada pendiente, nada que pedir');
    } finally {
      global.fetch = realFetch;
      usage.invalidate();
      usage.resetCooldown();
    }
  });

  await checkAsync('a 429 serves the last good reading instead of blanking the row', async () => {
    const account = { id: 'rl1', oauth: { accessToken: 'tok' } };
    const realFetch = global.fetch;
    const body = JSON.stringify({ limits: [
      { kind: 'session', percent: 42, resets_at: 'A' },
      { kind: 'weekly_all', percent: 11, resets_at: 'B' }] });

    try {
      global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body });
      const good = await usage.fetchFor(account, { force: true });
      assert.strictEqual(good.session.percent, 42);
      assert.ok(!good.stale);

      // Clear the rate floor: otherwise the next call is throttled locally and never
      // reaches the API, so no 429 could come back. And age the cache past the floor: a
      // reading fetched seconds ago is handed back as-is on a forced refresh (nothing to
      // learn from re-asking), which would also keep the 429 from ever happening.
      usage.resetCooldown();
      usage.prime(account.id, good, Date.now() - 2 * usage.MIN_GAP_MS);
      global.fetch = async () => ({
        ok: false, status: 429,
        headers: { get: (h) => (h === 'retry-after' ? '5' : null) },
        text: async () => '{"error":{"type":"rate_limit_error"}}',
      });
      const stale = await usage.fetchFor(account, { force: true });
      assert.strictEqual(stale.ok, true, 'a 429 must not blank the row');
      assert.strictEqual(stale.stale, true, 'the reading must be flagged stale');
      assert.strictEqual(stale.session.percent, 42, 'last good numbers are kept');
      assert.ok(usage.cooldownRemainingMs() > 0, 'retry-after must arm the cooldown');

      let called = false;
      global.fetch = async () => { called = true; throw new Error('must not be called'); };
      await usage.fetchFor(account, { force: true });
      assert.strictEqual(called, false, 'the cooldown must suppress the API call entirely');

      // A genuinely dead token must never hide behind stale numbers.
      usage.resetCooldown();
      global.fetch = async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => 'unauthorized' });
      const dead = await usage.fetchFor(account, { force: true });
      assert.strictEqual(dead.ok, false, '401 must surface, not be masked by stale data');
      assert.strictEqual(dead.needsRelogin, true);
    } finally {
      global.fetch = realFetch;
      usage.resetCooldown();
      usage.invalidate();
    }
  });

  await checkAsync('a primed reading spares the API a second call', async () => {
    // The swap fetches usage to verify the new token and donates it via prime(); the UI
    // must then read it from cache. Request amplification is what trips the 429.
    const account = { id: 'pr1', oauth: { accessToken: 'tok' } };
    const realFetch = global.fetch;
    try {
      usage.invalidate();
      usage.resetCooldown();
      usage.prime(account.id, usage.normalize({ limits: [
        { kind: 'session', percent: 7, resets_at: 'A' },
        { kind: 'weekly_all', percent: 8, resets_at: 'B' }] }, account.id));

      let called = false;
      global.fetch = async () => { called = true; throw new Error('must not be called'); };
      const got = await usage.fetchFor(account);
      assert.strictEqual(called, false, 'a primed reading must not hit the network');
      assert.strictEqual(got.session.percent, 7);

      // A failed reading is worthless as a cache entry and must be refused.
      assert.strictEqual(usage.prime('pr2', { ok: false, error: 'x' }).ok, false);
    } finally {
      global.fetch = realFetch;
      usage.invalidate();
    }
  });

  await checkAsync('the rate floor caps outbound calls no matter how hard the UI pushes', async () => {
    // Measured against the live endpoint: the 5th rapid request returns 429 with
    // Retry-After 300, escalating on repeat. So the floor, not the poll interval, is
    // what has to hold - a user mashing refresh must not be able to spend the budget.
    const accounts = [1, 2, 3, 4].map((n) => ({ id: `gap${n}`, oauth: { accessToken: 't' } }));
    const realFetch = global.fetch;
    let calls = 0;
    try {
      usage.invalidate();
      usage.resetCooldown();
      global.fetch = async () => {
        calls++;
        return {
          ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify({ limits: [{ kind: 'session', percent: 3 }] }),
        };
      };
      // Four accounts swept three times over, every call forced.
      for (let i = 0; i < 3; i++) await usage.fetchAll(accounts, { force: true });
      assert.strictEqual(calls, 1, `the floor should allow exactly 1 call, saw ${calls}`);

      // The starved accounts must still render something rather than break.
      const out = await usage.fetchAll(accounts, { force: true });
      assert.strictEqual(Object.keys(out).length, 4);
      const throttled = Object.values(out).filter((v) => v.throttled);
      assert.ok(throttled.length >= 1, 'starved accounts report throttled, not a hard error');
      assert.ok(throttled.every((v) => v.needsRelogin === false), 'throttling is not a token problem');
    } finally {
      global.fetch = realFetch;
      usage.invalidate();
      usage.resetCooldown();
    }
  });

  await checkAsync('fetchAll queries accounts one at a time, not as a burst', async () => {
    const accounts = [1, 2, 3].map((n) => ({ id: `seq${n}`, oauth: { accessToken: 't' } }));
    const realFetch = global.fetch;
    let inFlight = 0;
    let maxInFlight = 0;
    try {
      usage.invalidate();
      usage.resetCooldown();
      global.fetch = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return {
          ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify({ limits: [{ kind: 'session', percent: 1 }] }),
        };
      };
      const out = await usage.fetchAll(accounts, { force: true });
      assert.strictEqual(Object.keys(out).length, 3);
      assert.strictEqual(maxInFlight, 1, `expected serial requests, saw ${maxInFlight} at once`);
    } finally {
      global.fetch = realFetch;
      usage.invalidate();
    }
  });

  /* ---------------- tokens de larga duración (claude setup-token) ---------------- */

  // Ensamblado en tiempo de ejecución a propósito: escrito entero dispararía el propio check
  // "no source file hardcodes a token" de este mismo fichero.
  const FAKE_TOKEN = ['sk', 'ant', 'oat01', 'A'.repeat(24)].join('-');
  const store = require('./lib/store');

  await checkAsync('un token con forma inválida se rechaza sin tocar la red', async () => {
    const realFetch = global.fetch;
    let called = false;
    try {
      global.fetch = async () => { called = true; throw new Error('no debería llamarse'); };
      await assert.rejects(() => oauth.probeToken('esto-no-es-un-token'), (e) => e.malformed === true);
      await assert.rejects(() => oauth.probeToken(''), (e) => e.malformed === true);
      await assert.rejects(() => oauth.probeToken(null), (e) => e.malformed === true);
      assert.strictEqual(called, false, 'la validación de forma es local: no debe gastar una petición');
    } finally { global.fetch = realFetch; }
  });

  await checkAsync('un 403 por scope IDENTIFICA un token de solo inferencia, no lo rechaza', async () => {
    const realFetch = global.fetch;
    try {
      global.fetch = async () => ({
        ok: false, status: 403, headers: { get: () => null },
        text: async () => JSON.stringify({ error: { message: 'OAuth token does not meet scope requirement user:profile' } }),
      });
      // Anthropic solo comprueba scopes en un token que YA autenticó, así que este 403 prueba que
      // el token es real. Tratarlo como fallo dejaría fuera justo el caso que buscamos.
      assert.strictEqual((await oauth.probeToken(FAKE_TOKEN)).kind, 'inference');
    } finally { global.fetch = realFetch; }
  });

  await checkAsync('un 401 rechaza el token', async () => {
    const realFetch = global.fetch;
    try {
      global.fetch = async () => ({
        ok: false, status: 401, headers: { get: () => null },
        text: async () => JSON.stringify({ error: { message: 'OAuth access token is invalid.' } }),
      });
      await assert.rejects(() => oauth.probeToken(FAKE_TOKEN), (e) => e.status === 401);
    } finally { global.fetch = realFetch; }
  });

  await checkAsync('un 200 identifica un token de scope completo', async () => {
    const realFetch = global.fetch;
    try {
      global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' });
      assert.strictEqual((await oauth.probeToken(FAKE_TOKEN)).kind, 'full');
    } finally { global.fetch = realFetch; }
  });

  // Cabeceras como las que devuelve /v1/messages, para las sondas de cuota.
  const cabeceras = (map) => ({ get: (k) => (k.toLowerCase() in map ? map[k.toLowerCase()] : null) });
  const RESET_5H = Math.floor(Date.now() / 1000) + 3600;
  const RESET_7D = Math.floor(Date.now() / 1000) + 86400;
  const CABECERAS_OK = {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-representative-claim': '5h',
    'anthropic-ratelimit-unified-5h-utilization': '0.42',
    'anthropic-ratelimit-unified-5h-reset': String(RESET_5H),
    'anthropic-ratelimit-unified-7d-utilization': '0.87',
    'anthropic-ratelimit-unified-7d-reset': String(RESET_7D),
  };

  await checkAsync('una cuenta de solo inferencia saca la cuota de las cabeceras, sin tocar el endpoint de uso', async () => {
    const realFetch = global.fetch;
    const urls = [];
    try {
      usage.invalidate(); usage.resetCooldown();
      global.fetch = async (url) => {
        urls.push(String(url));
        return { ok: true, status: 200, headers: cabeceras(CABECERAS_OK), text: async () => '{}' };
      };
      const r = await usage.fetchFor({ id: 'inf1', oauth: { accessToken: 't', scopes: ['user:inference'] } });

      // Lo que NO puede pasar: /api/oauth/usage responde 403 permanente a este token, y el cupo
      // es de ~5 peticiones por 5 minutos para TODA la app. Gastarlo ahí sería un fallo seguro
      // que además deja sin datos a las cuentas que sí pueden responder.
      assert.ok(!urls.some((u) => u.includes('/api/oauth/usage')), 'no debe tocar el endpoint de uso');
      assert.ok(urls.some((u) => u === usage.PROBE_URL), 'debe sondear /v1/messages');

      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.viaProbe, true, 'debe marcar de dónde salió el número');
      // utilization llega como fracción (0.42) y sale como porcentaje.
      assert.strictEqual(r.session.percent, 42);
      assert.strictEqual(r.weekly.percent, 87);
      assert.strictEqual(r.weekly.severity, 'high');
      // reset llega en segundos epoch y sale en ISO, que es lo que sabe leer la cuenta atrás.
      assert.strictEqual(r.session.resetsAt, new Date(RESET_5H * 1000).toISOString());
    } finally { global.fetch = realFetch; usage.invalidate(); usage.resetCooldown(); }
  });

  await checkAsync('la sonda envía lo mínimo: Haiku, max_tokens 1 y un carácter', async () => {
    const realFetch = global.fetch;
    let enviado = null;
    let cabecerasEnviadas = null;
    try {
      usage.invalidate(); usage.resetCooldown();
      global.fetch = async (url, opts) => {
        enviado = JSON.parse(opts.body);
        cabecerasEnviadas = opts.headers;
        return { ok: true, status: 200, headers: cabeceras(CABECERAS_OK), text: async () => '{}' };
      };
      await usage.fetchFor({ id: 'inf2', oauth: { accessToken: 'tok', scopes: ['user:inference'] } });
      // Los endpoints gratuitos (count_tokens, /v1/models) no traen cabeceras de límite, así que
      // hay que gastar algo. Esto es el suelo medido: 8 tokens de entrada y 1 de salida.
      assert.strictEqual(enviado.model, usage.PROBE_MODEL);
      assert.strictEqual(enviado.max_tokens, 1);
      assert.strictEqual(enviado.messages[0].content, '.');
      assert.strictEqual(cabecerasEnviadas['anthropic-beta'], 'oauth-2025-04-20',
        'un token OAuth de suscripción necesita esta beta');
    } finally { global.fetch = realFetch; usage.invalidate(); usage.resetCooldown(); }
  });

  await checkAsync('un token rechazado en la sonda es una credencial muerta, no una cuenta sin cuota', async () => {
    const realFetch = global.fetch;
    try {
      usage.invalidate(); usage.resetCooldown();
      global.fetch = async () => ({ ok: false, status: 401, headers: cabeceras({}), text: async () => 'nope' });
      const r = await usage.fetchFor({ id: 'inf3', oauth: { accessToken: 't', scopes: ['user:inference'] } });
      // Confundir las dos cosas es el fallo que el panel del servidor documentaba: una cuenta
      // apartada hora y media por "cuota" teniendo la ventana al 0%.
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.needsRelogin, true);
      assert.strictEqual(r.session, undefined, 'una credencial muerta no debe traer medidores inventados');
      assert.ok(!JSON.stringify(r).includes('sk-ant-'), 'el error no debe llevar el token');
    } finally { global.fetch = realFetch; usage.invalidate(); usage.resetCooldown(); }
  });

  check('writeCredentials no escribe el centinela de token muerto ni deja los scopes vacíos', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-tok-'));
    try {
      const f = path.join(tmp, '.credentials.json');
      fs.writeFileSync(f, JSON.stringify({ mcpOAuth: { keep: 1 } }));

      swapLib.writeCredentials(f, { accessToken: 'A', expiresAt: 1, scopes: ['user:inference'] });
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      // Claude Code lee refreshToken === "" como "este token ya está muerto" y ni lo intenta.
      assert.strictEqual(c.claudeAiOauth.refreshToken, null);
      assert.notStrictEqual(c.claudeAiOauth.refreshToken, '');
      assert.deepStrictEqual(c.claudeAiOauth.scopes, ['user:inference']);
      assert.deepStrictEqual(c.mcpOAuth, { keep: 1 }, 'mcpOAuth debe sobrevivir');

      // Sin scopes, Claude Code imprime "Not logged in - Please run /login" y sale con 1.
      swapLib.writeCredentials(f, { accessToken: 'B', expiresAt: 1 });
      const c2 = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.ok(c2.claudeAiOauth.scopes.includes('user:inference'), 'unos scopes vacíos dejan la sesión sin login');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  check('clearClaudeJsonIdentity borra la identidad anterior y respeta todo lo demás', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-cid-'));
    try {
      const f = path.join(tmp, '.claude.json');
      fs.writeFileSync(f, JSON.stringify({
        numStartups: 7, userID: 'INSTALL-ID', projects: { '/a': { history: [1] } },
        mcpServers: { x: { command: 'y' } },
        oauthAccount: { emailAddress: 'anterior@x.com', accountUuid: 'u1' },
        modelAccessCache: [], somethingElse: { deep: true },
      }));
      const r = swapLib.clearClaudeJsonIdentity(f);
      const cj = JSON.parse(fs.readFileSync(f, 'utf8'));
      // Dejarla haría que Claude Code siguiera nombrando la cuenta de la que acabas de salir.
      assert.ok(!('oauthAccount' in cj));
      assert.strictEqual(r.clearedIdentity, true);
      assert.ok(!('modelAccessCache' in cj), 'las cachés de la cuenta anterior también se van');
      assert.strictEqual(cj.userID, 'INSTALL-ID', 'userID es del instalador, no de la cuenta');
      assert.strictEqual(cj.numStartups, 7);
      assert.deepStrictEqual(cj.projects, { '/a': { history: [1] } });
      assert.deepStrictEqual(cj.mcpServers, { x: { command: 'y' } });
      assert.deepStrictEqual(cj.somethingElse, { deep: true });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  check('una cuenta creada desde un token pegado se identifica sola, se deduplica y no filtra nada', () => {
    const before = store.list().length;
    const blob = { accessToken: FAKE_TOKEN, refreshToken: null, expiresAt: Date.now() + 60000, scopes: ['user:inference'] };
    const a = store.add({ label: null, email: null, profile: null, oauth: blob });
    try {
      // Sin accountUuid ni email, el propio token es la única identidad estable disponible.
      assert.strictEqual(store.idForToken(FAKE_TOKEN), a.id);
      assert.strictEqual(store.add({ label: null, email: null, profile: null, oauth: blob }).id, a.id,
        'pegar el mismo token dos veces debe actualizar, no duplicar');
      assert.strictEqual(store.list().length, before + 1);

      const view = store.publicView().accounts.find((x) => x.id === a.id);
      assert.strictEqual(view.canReadUsage, false);
      assert.strictEqual(view.renewable, false);
      assert.strictEqual(view.plan, null, 'no debe inventar un plan que nunca ha visto');
      assert.ok(!JSON.stringify(store.publicView()).includes('sk-ant-'), 'publicView filtró un token');
    } finally { store.remove(a.id); }
  });

  check('volver a pegar un token aplica el nombre nuevo, pero un import sin nombre no lo pisa', () => {
    const blob = { accessToken: FAKE_TOKEN, refreshToken: null, expiresAt: Date.now() + 60000, scopes: ['user:inference'] };
    const a = store.add({ label: null, email: null, profile: null, oauth: blob });
    try {
      // Sin nombre, la etiqueta es el propio id: legible, pero no dice nada.
      assert.match(a.label, /^token /, 'sin nombre debe caer en la etiqueta derivada del id');

      // Volver a pegar el MISMO token con nombre es la única forma de renombrar desde el panel,
      // y además es la vía por la que se sustituye un token de un año que no se puede refrescar.
      const renamed = store.add({ label: 'Trabajo', email: null, profile: null, oauth: blob });
      assert.strictEqual(renamed.id, a.id, 'debe seguir siendo la misma cuenta');
      assert.strictEqual(store.get(a.id).label, 'Trabajo', 'el nombre tecleado no puede descartarse en silencio');

      // Pero un caller que no opina sobre el nombre (el import lo pasa null) no debe pisarlo.
      store.add({ label: null, email: null, profile: null, oauth: blob });
      assert.strictEqual(store.get(a.id).label, 'Trabajo', 'un import sin nombre debe respetar el que puso el usuario');
    } finally { store.remove(a.id); }
  });

  check('una cuenta sin perfil escribe su nombre como identidad, en el campo que /status muestra', () => {
    const blob = { accessToken: FAKE_TOKEN, refreshToken: null, expiresAt: Date.now() + 60000, scopes: ['user:inference'] };
    const a = store.add({ label: 'Equipo', email: null, profile: null, oauth: blob });
    try {
      const ident = swapLib.identityFromLabel(store.get(a.id));
      // /status renderiza Email y Organization; displayName lo ignora por completo (verificado
      // contra la TUI real). Poner el nombre solo en displayName dejaría /status en blanco.
      assert.strictEqual(ident.emailAddress, 'Equipo', 'el nombre debe ir donde /status mira');
      assert.strictEqual(ident.displayName, 'Equipo');
      // Lo que NO sabemos de un token de solo inferencia se queda en null: nada inventado.
      assert.strictEqual(ident.accountUuid, null, 'no se puede inventar un accountUuid');
      // Nombrar el panel, en vez de dejarlo vacío: si se deja null, Claude Code se inventa
      // "<nombre>'s Organization", que se lee como una organización real a la que perteneces.
      assert.strictEqual(ident.organizationName, 'LLMSwapper');
      assert.strictEqual(ident.organizationUuid, null, 'no se puede inventar un uuid de organización');
    } finally { store.remove(a.id); }
  });

  check('el swap escribe esa identidad en ~/.claude.json y respeta el resto del fichero', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-ident-'));
    try {
      const f = path.join(tmp, '.claude.json');
      fs.writeFileSync(f, JSON.stringify({
        numStartups: 3, userID: 'INSTALL-ID', projects: { '/x': { history: [7] } },
        oauthAccount: { emailAddress: 'anterior@x.com', accountUuid: 'viejo' },
        modelAccessCache: [],
      }));
      swapLib.writeClaudeJson(f, swapLib.identityFromLabel({ label: 'Trabajo' }));
      const cj = JSON.parse(fs.readFileSync(f, 'utf8'));
      // Sustituye a la anterior, no la deja: mostrar la cuenta de la que saliste es el peor caso.
      assert.strictEqual(cj.oauthAccount.emailAddress, 'Trabajo');
      assert.strictEqual(cj.oauthAccount.accountUuid, null);
      assert.ok(cj.oauthAccount.profileFetchedAt, 'writeClaudeJson sella la marca de tiempo');
      assert.ok(!('modelAccessCache' in cj), 'las cachés de la cuenta anterior se van');
      assert.strictEqual(cj.userID, 'INSTALL-ID', 'userID es del instalador, no de la cuenta');
      assert.deepStrictEqual(cj.projects, { '/x': { history: [7] } });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  check('en un contenedor, "no veo los procesos" no se reporta como "no hay procesos"', () => {
    const antes = process.env.SWAPPER_IN_CONTAINER;
    try {
      process.env.SWAPPER_IN_CONTAINER = '1';
      assert.strictEqual(P.inContainer(), true);
      const r = swapLib.detectClaudeProcesses();
      // running:false a secas sería una mentira con cara de certeza: el panel diría que Claude
      // Code está cerrado mientras corre en el host, al otro lado de la frontera del contenedor.
      assert.strictEqual(r.unknown, true, 'debe admitir que no puede saberlo');
      assert.deepStrictEqual(r.pids, []);
    } finally {
      if (antes === undefined) delete process.env.SWAPPER_IN_CONTAINER;
      else process.env.SWAPPER_IN_CONTAINER = antes;
    }
  });

  check('fuera de un contenedor la detección sigue siendo real', () => {
    const antes = process.env.SWAPPER_IN_CONTAINER;
    try {
      delete process.env.SWAPPER_IN_CONTAINER;
      assert.strictEqual(P.inContainer(), false, 'sin la variable y sin /.dockerenv');
      const r = swapLib.detectClaudeProcesses();
      assert.strictEqual(r.unknown, undefined, 'aquí sí se puede mirar, así que no hay excusa');
      assert.ok(Array.isArray(r.pids));
    } finally {
      if (antes !== undefined) process.env.SWAPPER_IN_CONTAINER = antes;
    }
  });

  await checkAsync('el guard valida el HOSTNAME, no el puerto: rebinding fuera, contenedor dentro', async () => {
    const realFetch = global.fetch;
    const server = require('./server').createServer(7996);
    try {
      await new Promise((r) => server.listen(7996, '127.0.0.1', r));
      // http.request y no fetch: Host es un "forbidden header name", así que fetch lo ignora en
      // silencio y el test pasaría sin haber probado nada. Esto lo descubrió el propio test
      // fallando al revés - pedía un 403 y recibía un 200 porque su Host nunca salió.
      const http = require('node:http');
      const pedir = (headers) => new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port: 7996, path: '/api/health', method: 'GET',
          headers: { 'X-Swapper': '1', ...headers },
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end();
      });

      // Un dominio que resuelve a 127.0.0.1 hace que el navegador SÍ conecte con este socket;
      // lo que le delata es que la cabecera Host lleva su dominio, no el loopback.
      assert.strictEqual(await pedir({ Host: 'evil.example' }), 403, 'DNS rebinding debe caer');
      assert.strictEqual(await pedir({ Host: 'llmswapper.local' }), 403);

      // El puerto NO se valida: al publicar el contenedor con -p el navegador manda el puerto
      // externo, que este proceso no puede conocer. Exigirlo rechazaba todo uso en Docker.
      assert.strictEqual(await pedir({ Host: '127.0.0.1:27387' }), 200, 'otro puerto es legítimo');
      assert.strictEqual(await pedir({ Host: 'localhost:9999' }), 200);

      // Un Origin de otro sitio sigue fuera, aunque el Host esté bien.
      assert.strictEqual(await pedir({ Origin: 'http://evil.example' }), 403, 'origen ajeno fuera');
      assert.strictEqual(await pedir({ Origin: 'http://127.0.0.1:27387' }), 200);
    } finally {
      global.fetch = realFetch;
      await new Promise((r) => server.close(r));
    }
  });

  await checkAsync('SWAPPER_ALLOWED_HOSTS abre el guard a una IP de LAN, y solo a esa', async () => {
    // La lista se calcula al cargar el modulo, asi que no basta con poner la variable: hay que
    // sacar server.js de la cache y volver a pedirlo. Es justo lo que hace un arranque real.
    const http = require('node:http');
    const antes = process.env.SWAPPER_ALLOWED_HOSTS;
    const realFetch = global.fetch;
    let server;
    try {
      process.env.SWAPPER_ALLOWED_HOSTS = '192.168.9.9, MI-PC';
      delete require.cache[require.resolve('./server')];
      server = require('./server').createServer(7994);
      await new Promise((r) => server.listen(7994, '127.0.0.1', r));

      // http.request y no fetch: Host es un "forbidden header name" y fetch lo descarta callando.
      const pedir = (headers) => new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port: 7994, path: '/api/health', method: 'GET',
          headers: { 'X-Swapper': '1', ...headers },
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end();
      });

      assert.strictEqual(await pedir({ Host: '192.168.9.9:7373' }), 200, 'la IP permitida entra');
      assert.strictEqual(await pedir({ Host: 'mi-pc' }), 200, 'los nombres de host no distinguen mayúsculas');
      assert.strictEqual(await pedir({ Host: '127.0.0.1' }), 200, 'el loopback nunca se pierde');

      // Lo que importa: ensanchar la lista NO la abre a cualquiera. Una IP vecina de la misma
      // red sigue fuera, y el rebinding tambien, que era el ataque que el guard existe para parar.
      assert.strictEqual(await pedir({ Host: '192.168.9.10:7373' }), 403, 'otra IP de la misma red, fuera');
      assert.strictEqual(await pedir({ Host: 'evil.example' }), 403, 'DNS rebinding sigue cayendo');
      assert.strictEqual(await pedir({ Origin: 'http://evil.example' }), 403, 'origen ajeno sigue fuera');
      assert.strictEqual(await pedir({ Origin: 'http://192.168.9.9:7373' }), 200, 'origen permitido entra');
    } finally {
      if (server) await new Promise((r) => server.close(r));
      if (antes === undefined) delete process.env.SWAPPER_ALLOWED_HOSTS;
      else process.env.SWAPPER_ALLOWED_HOSTS = antes;
      // Devolver el modulo a su estado normal para los tests que vengan detras.
      delete require.cache[require.resolve('./server')];
      require('./server');
      global.fetch = realFetch;
    }
  });

  await checkAsync('POST /api/accounts/token rechaza un token inválido sin crear nada', async () => {
    const realFetch = global.fetch;
    const server = require('./server').createServer(7998);
    const before = store.list().length;
    try {
      await new Promise((r) => server.listen(7998, '127.0.0.1', r));
      const post = async (body) => {
        const res = await realFetch('http://127.0.0.1:7998/api/accounts/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Swapper': '1' },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      };

      // Forma inválida: se corta antes de salir a la red.
      global.fetch = async () => { throw new Error('no debería llamarse'); };
      assert.strictEqual((await post({ token: 'no-es-un-token' })).status, 400);

      global.fetch = async () => ({
        ok: false, status: 401, headers: { get: () => null },
        text: async () => JSON.stringify({ error: { message: 'OAuth access token is invalid.' } }),
      });
      const rejected = await post({ token: FAKE_TOKEN });
      assert.strictEqual(rejected.status, 401);
      assert.ok(!JSON.stringify(rejected.body).includes(FAKE_TOKEN), 'el error no debe devolver el token');
      assert.strictEqual(store.list().length, before, 'un token rechazado no debe dejar una cuenta a medias');
    } finally {
      global.fetch = realFetch;
      await new Promise((r) => server.close(r));
    }
  });

  await checkAsync('en contenedor, "abre una terminal" se niega ANTES de lanzar nada', async () => {
    const realFetch = global.fetch;
    const server = require('./server').createServer(7995);
    const antes = process.env.SWAPPER_IN_CONTAINER;
    // Si el endpoint llegase a spawn, la suite abriría ventanas en la máquina de quien la corre.
    // Envolver child_process aquí es lo que convierte "creo que no lo llama" en "no lo llama".
    const cp = require('node:child_process');
    const spawnReal = cp.spawn;
    let lanzo = false;
    try {
      process.env.SWAPPER_IN_CONTAINER = '1';
      cp.spawn = (...a) => { lanzo = true; return spawnReal(...a); };
      await new Promise((r) => server.listen(7995, '127.0.0.1', r));

      const res = await realFetch('http://127.0.0.1:7995/api/token/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Swapper': '1' },
        body: '{}',
      });
      const body = await res.json();

      assert.strictEqual(res.status, 409, 'no es un fallo del servidor: es que ahí no aplica');
      assert.strictEqual(lanzo, false, 'no debe intentar abrir nada dentro de un contenedor');
      assert.match(body.error, /contenedor/i, 'el motivo debe decir por qué, no solo que no');
    } finally {
      cp.spawn = spawnReal;
      if (antes === undefined) delete process.env.SWAPPER_IN_CONTAINER;
      else process.env.SWAPPER_IN_CONTAINER = antes;
      await new Promise((r) => server.close(r));
    }
  });

  check('el comando de la terminal es constante: nada de fuera entra en el argv', () => {
    const src = fs.readFileSync(path.join(__dirname, 'lib', 'terminal.js'), 'utf8');
    // La inyeccion solo es posible si algo de la peticion llega hasta aquí. No hay parametros:
    // openSetupToken no los acepta, y eso es lo que hace irrelevante el resto de la discusión.
    assert.strictEqual(require('./lib/terminal').openSetupToken.length, 0,
      'openSetupToken no debe aceptar argumentos');
    assert.ok(!/req\.|request|body|query|params/.test(src),
      'lib/terminal.js no debe saber nada de HTTP');
    // Y el comando viaja como argv, no como una cadena para que un shell la reinterprete.
    assert.ok(src.includes("const CLI = 'claude'") && src.includes("const ARG = 'setup-token'"),
      'el comando debe estar en constantes');
  });

  check('el login de Codex lleva el directorio una sola vez, y bien entrecomillado en cada plataforma', () => {
    const terminal = require('./lib/terminal');
    assert.strictEqual(typeof terminal.codexInstalled(), 'boolean');
    const dir = "/tmp/panel data/it's here";
    // Windows: through the environment, so there is nothing for cmd.exe to re-parse.
    const win = terminal.codexLoginCommand('win32', dir);
    assert.ok(win.args.every((a) => typeof a === 'string'));
    assert.strictEqual(win.env.CODEX_HOME, dir);
    assert.ok(!win.args.some((a) => a.includes(dir)), 'the directory never reaches the command line');
    assert.ok(win.args.includes('codex login'));
    // macOS and Linux: one shell line, the directory single-quoted exactly once.
    for (const platform of ['darwin', 'linux']) {
      const cmd = terminal.codexLoginCommand(platform, dir);
      assert.ok(cmd.args.every((a) => typeof a === 'string'), `${platform}: argv of strings`);
      assert.strictEqual(cmd.sh.split(terminal.shQuote(dir)).length - 1, 1, `${platform}: the directory exactly once`);
      assert.match(cmd.sh, /^CODEX_HOME='.*' codex login/);
    }
    // AppleScript gets that same line back once its own escaping is undone.
    const mac = terminal.codexLoginCommand('darwin', dir);
    const script = mac.args[1].match(/do script "((?:[^"\\]|\\.)*)"$/);
    assert.ok(script, mac.args[1]);
    assert.strictEqual(script[1].replace(/\\(.)/g, '$1'), mac.sh);
    // The shell quoting round-trips, where there is a shell to ask.
    if (terminal.existeEnPath('sh')) {
      const out = execFileSync('sh', ['-c', `printf %s ${terminal.shQuote(dir)}`], { encoding: 'utf8' });
      assert.strictEqual(out, dir);
    }
  });

  await checkAsync('PATCH /api/accounts/:id renombra, y rechaza lo que no es un nombre', async () => {
    const realFetch = global.fetch;
    const server = require('./server').createServer(7997);
    const blob = { accessToken: FAKE_TOKEN, refreshToken: null, expiresAt: Date.now() + 60000, scopes: ['user:inference'] };
    const a = store.add({ label: null, email: null, profile: null, oauth: blob });
    try {
      await new Promise((r) => server.listen(7997, '127.0.0.1', r));
      const patch = async (id, body) => {
        const res = await realFetch(`http://127.0.0.1:7997/api/accounts/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-Swapper': '1' },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      };

      const ok = await patch(a.id, { label: '  Trabajo  ' });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(store.get(a.id).label, 'Trabajo', 'debe recortar los espacios');
      assert.strictEqual(ok.body.account.label, 'Trabajo');
      // La respuesta viaja por publicAccount, así que sigue sin llevar el token.
      assert.ok(!JSON.stringify(ok.body).includes('sk-ant-'), 'la respuesta del PATCH filtró un token');

      // Un nombre en blanco no es un nombre: debe rechazarse, no borrar el que había.
      assert.strictEqual((await patch(a.id, { label: '   ' })).status, 400);
      assert.strictEqual(store.get(a.id).label, 'Trabajo', 'un nombre vacío no debe pisar el bueno');

      assert.strictEqual((await patch('acc_nolaexiste', { label: 'X' })).status, 404);
    } finally {
      global.fetch = realFetch;
      store.remove(a.id);
      await new Promise((r) => server.close(r));
    }
  });

  /* ---------------- Codex ---------------- */

  // Nothing here may read or write the real ~/.codex or a WSL one: CODEX_HOME points at a temp
  // dir, and target discovery is replaced by that host alone (the real list() would find the
  // WSL distros). Every JWT is built at runtime, and every network call is a stub.
  const CODEX_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-codex-'));
  const realFetchForTests = global.fetch;
  process.env.CODEX_HOME = path.join(CODEX_TMP, 'host-home');
  const codexAuth = require('./lib/codex/auth');
  const codexStore = require('./lib/codex/store');
  const codexTargets = require('./lib/codex/targets');
  const codexUsage = require('./lib/codex/usage');
  let codexTargetList = [codexTargets.hostTarget()];
  codexTargets.list = () => codexTargetList;

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const fakeJwt = (payload) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.${'s'.repeat(43)}`;
  const AUTH_CLAIM = 'https://api.openai.com/auth';
  let rtSeq = 0;
  /** An auth.json `tokens` block for a ChatGPT workspace, as Codex would write it. */
  const codexTokens = (accountId, { email = `${accountId}@x.test`, expSecs = 240 * 3600, rt } = {}) => {
    const claim = { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus', chatgpt_user_id: `user-${accountId}` };
    return {
      id_token: fakeJwt({ email, [AUTH_CLAIM]: claim }),
      access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + expSecs, n: ++rtSeq, [AUTH_CLAIM]: claim }),
      refresh_token: rt || `rt.a.${accountId}-${rtSeq}`,
      account_id: accountId,
    };
  };
  const addCodexAccount = (accountId, opts) => {
    const tokens = codexTokens(accountId, opts);
    const who = codexAuth.identity(tokens);
    return codexStore.add({ accountId, email: who.email, plan: who.plan, oauth: codexAuth.toStored(tokens, new Date().toISOString()) });
  };
  const codexTarget = (name) => {
    const home = path.join(CODEX_TMP, name);
    return { id: `dir:${name}`, kind: 'dir', label: name, home, authPath: path.join(home, 'auth.json') };
  };
  const res = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const nowS = () => Math.floor(Date.now() / 1000);
  const FIVE_H = { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: nowS() + 3600 };
  const WEEK = { used_percent: 2, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: nowS() + 86400 };
  const whamBody = (primary, secondary) => ({ plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false, primary_window: primary, secondary_window: secondary } });

  await checkAsync('codex: el uso se mapea por la longitud de la ventana, 401 pide login y un 429 sirve la última lectura', async () => {
    const realFetch = global.fetch;
    const calls = [];
    try {
      codexUsage.invalidate();
      codexUsage.resetCooldown();
      const acc = addCodexAccount('acct-usage');
      global.fetch = async (url, opts) => { calls.push({ url: String(url), headers: opts.headers }); return res(200, whamBody(FIVE_H, WEEK)); };
      const r = await codexUsage.fetchFor(acc, { force: true });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.session.percent, 12);
      assert.strictEqual(r.weekly.percent, 2);
      assert.strictEqual(r.session.resetsAt, new Date(FIVE_H.reset_at * 1000).toISOString());
      assert.strictEqual(calls[0].url, codexUsage.USAGE_URL);
      assert.strictEqual(calls[0].headers.Authorization, `Bearer ${acc.oauth.accessToken}`);
      assert.strictEqual(calls[0].headers['ChatGPT-Account-ID'], 'acct-usage');
      assert.strictEqual(calls[0].headers.originator, 'codex_cli_rs');

      // Order does not decide: a weekly window reported first is still the weekly meter.
      const swapped = codexUsage.normalize(whamBody(WEEK, FIVE_H), 'x');
      assert.strictEqual(swapped.session.percent, 12);
      assert.strictEqual(swapped.weekly.percent, 2);
      // With no window lengths at all, fall back to position.
      const bare = codexUsage.normalize(whamBody({ used_percent: 5 }, { used_percent: 6 }), 'x');
      assert.deepStrictEqual([bare.session.percent, bare.weekly.percent], [5, 6]);

      // A cached reading is served without a call.
      assert.strictEqual((await codexUsage.fetchFor(acc)).session.percent, 12);
      assert.strictEqual(calls.length, 1);

      // 429 after a good read: the good numbers, flagged stale, and a backoff that holds.
      codexUsage.resetCooldown();
      global.fetch = async () => { calls.push(1); return res(429, 'slow down'); };
      const stale = await codexUsage.fetchFor(acc, { force: true });
      assert.strictEqual(stale.ok, true);
      assert.strictEqual(stale.stale, true);
      assert.strictEqual(stale.staleReason, 'rate-limited');
      assert.strictEqual(stale.session.percent, 12);
      const before = calls.length;
      const again = await codexUsage.fetchFor(acc, { force: true });
      assert.strictEqual(calls.length, before, 'no call inside the backoff');
      assert.strictEqual(again.stale, true);

      // 401: the token is dead, never hidden behind stale numbers.
      codexUsage.resetCooldown();
      global.fetch = async () => res(401, { error: { message: `bad token ${acc.oauth.accessToken}` } });
      const dead = await codexUsage.fetchFor(acc, { force: true });
      assert.strictEqual(dead.ok, false);
      assert.strictEqual(dead.needsRelogin, true);
      assert.ok(!JSON.stringify(dead).includes(acc.oauth.accessToken), 'the error must not carry the token');
      assert.match(dead.error, /eyJ\*\*\*/, 'scrubbed, not dropped');

      // A Cloudflare challenge is a 403 with an HTML page: about the client, not the token. It must
      // not mark the account "sign in again".
      codexUsage.resetCooldown();
      global.fetch = async () => res(403, '<!DOCTYPE html><html><title>Just a moment...</title></html>');
      const challenged = await codexUsage.fetchFor(acc, { force: true });
      assert.notStrictEqual(challenged.needsRelogin, true, 'a bot challenge is not a dead token');
      assert.strictEqual(challenged.stale, true, 'the last good reading is served, flagged stale');
      assert.match(challenged.error || challenged.staleReason || '', /Cloudflare/);
    } finally {
      global.fetch = realFetch;
      codexUsage.invalidate();
      codexUsage.resetCooldown();
    }
  });

  const codexSwap = require('./lib/codex/swap');
  // The usage endpoint answering `status` (default 200) and the token endpoint failing loudly: a
  // swap test that reaches auth.openai.com without asking for it is a bug in the test.
  const stubCodexNet = (status = 200) => async (url) => {
    if (String(url) === codexUsage.USAGE_URL) return status === 200 ? res(200, whamBody(FIVE_H, WEEK)) : res(status, 'nope');
    throw new Error(`unexpected call to ${url}`);
  };
  /** Runs fn with a clean store, fresh targets and stubbed network, then puts everything back. */
  const withCodex = async (targetNames, fn, net = stubCodexNet()) => {
    const realFetch = global.fetch;
    const realDetect = codexTargets.detectRunning;
    const tgs = targetNames.map(codexTarget);
    codexTargetList = tgs;
    fs.rmSync(path.join(SANDBOX, 'codex'), { recursive: true, force: true });
    for (const t of tgs) fs.rmSync(t.home, { recursive: true, force: true });
    codexUsage.invalidate();
    codexUsage.resetCooldown();
    global.fetch = net;
    try {
      await fn(...tgs);
    } finally {
      global.fetch = realFetch;
      codexTargets.detectRunning = realDetect;
      codexTargetList = [codexTargets.hostTarget()];
    }
  };
  const writeLive = (t, tokens, extra = {}) => {
    fs.mkdirSync(t.home, { recursive: true });
    fs.writeFileSync(t.authPath, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens, last_refresh: new Date().toISOString(), ...extra }, null, 2));
  };
  const readLive = (t) => JSON.parse(fs.readFileSync(t.authPath, 'utf8'));

  await checkAsync('codex swap: crea auth.json en un entorno vacío y conserva las claves ajenas', async () => {
    await withCodex(['empty'], async (t) => {
      const a = addCodexAccount('acct-a');
      const b = addCodexAccount('acct-b');
      const r = await codexSwap.swapTo(a.id, t);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.verified, true);
      assert.strictEqual(r.target, t.id);
      let live = readLive(t);
      assert.strictEqual(live.auth_mode, 'chatgpt');
      assert.strictEqual(live.tokens.account_id, 'acct-a');
      assert.strictEqual(live.tokens.access_token, a.oauth.accessToken);
      assert.ok(live.last_refresh, 'last_refresh is mandatory');
      assert.strictEqual(codexStore.activeFor(t.id), a.id);
      assert.ok(!JSON.stringify(r).includes(a.oauth.accessToken) && !JSON.stringify(r).includes(a.oauth.refreshToken), 'no token in the answer');
      assert.strictEqual(codexUsage.cachedFor(a.id).session.percent, 12, 'the verify reading primes the cache');

      fs.writeFileSync(t.authPath, JSON.stringify({ ...live, agent_identity: { keep: true } }));
      await codexSwap.swapTo(b.id, t);
      live = readLive(t);
      assert.strictEqual(live.tokens.account_id, 'acct-b');
      assert.deepStrictEqual(live.agent_identity, { keep: true }, 'a key the swap does not own survives');
      assert.strictEqual(codexStore.activeFor(t.id), b.id);
    });
  });

  await checkAsync('codex swap: un 401 al verificar deja auth.json como estaba, byte a byte, o sin crear', async () => {
    await withCodex(['had', 'none'], async (had, none) => {
      const a = addCodexAccount('acct-a');
      const b = addCodexAccount('acct-b');
      // The stored pair is what is live: same access token, so nothing to adopt.
      writeLive(had, codexAuth.toTokens(a.oauth), { extra: 1 });
      const before = fs.readFileSync(had.authPath);
      await assert.rejects(codexSwap.swapTo(b.id, had), /401[\s\S]*restaurado/);
      assert.ok(fs.readFileSync(had.authPath).equals(before), 'previous bytes restored');
      assert.strictEqual(codexStore.activeFor(had.id), a.id, 'active is what the restored file holds, not b');

      await assert.rejects(codexSwap.swapTo(b.id, none), /restaurado/);
      assert.strictEqual(fs.existsSync(none.authPath), false, 'a target that had no auth.json is left with none');
    }, stubCodexNet(401));
  });

  await checkAsync('codex swap: con Codex abierto avisa, y el store se queda el par rotado de la cuenta saliente', async () => {
    await withCodex(['live'], async (t) => {
      const a = addCodexAccount('acct-a');
      const b = addCodexAccount('acct-b');
      // Codex refreshed on its own: same account, new pair.
      const rotated = codexTokens('acct-a');
      writeLive(t, rotated);
      codexTargets.detectRunning = () => ({ running: true, pids: [4242] });
      const r = await codexSwap.swapTo(b.id, t);
      assert.strictEqual(r.ok, true, 'an open Codex never blocks the swap');
      assert.ok(r.warnings.some((w) => /abierto/.test(w) && /NUEVAS/.test(w)), r.warnings.join(' | '));
      assert.strictEqual(codexStore.get(a.id).oauth.refreshToken, rotated.refresh_token, 'outgoing pair adopted');
      assert.strictEqual(codexStore.get(a.id).oauth.accessToken, rotated.access_token);
    });
  });

  await checkAsync('codex swap: una sesión viva que el store no conoce se importa antes de sobrescribirla', async () => {
    await withCodex(['unknown'], async (t) => {
      const b = addCodexAccount('acct-b');
      writeLive(t, codexTokens('acct-stranger', { email: 'stranger@x.test' }));
      const r = await codexSwap.swapTo(b.id, t);
      const imported = codexStore.get(codexStore.idFor('acct-stranger'));
      assert.ok(imported, 'the live session must not survive only in a backup');
      assert.strictEqual(imported.email, 'stranger@x.test');
      assert.ok(r.warnings.some((w) => /stranger@x\.test/.test(w)), 'and the answer says so');
    });
  });

  await checkAsync('codex swap: una cuenta activa en un entorno se niega en otro (409)', async () => {
    await withCodex(['x', 'y'], async (x, y) => {
      const a = addCodexAccount('acct-a');
      await codexSwap.swapTo(a.id, x);
      await assert.rejects(codexSwap.swapTo(a.id, y), (e) => e.status === 409 && /x/.test(e.message));
      assert.strictEqual(fs.existsSync(y.authPath), false, 'nothing written');
      // Stale store evidence is not a conflict: x now holds another account.
      writeLive(x, codexTokens('acct-other'));
      assert.strictEqual((await codexSwap.swapTo(a.id, y)).ok, true);
    });
  });

  await checkAsync('codex swap: almacenamiento en llavero se niega (409) sin escribir nada', async () => {
    await withCodex(['kr'], async (t) => {
      const a = addCodexAccount('acct-a');
      fs.mkdirSync(t.home, { recursive: true });
      fs.writeFileSync(path.join(t.home, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
      await assert.rejects(codexSwap.swapTo(a.id, t), (e) => e.status === 409 && /file/.test(e.message));
      assert.strictEqual(fs.existsSync(t.authPath), false);
      assert.strictEqual(fs.existsSync(path.join(SANDBOX, 'codex', 'backups')), false, 'not even a backup');
    });
  });

  await checkAsync('codex swap: un auth.json a medio escribir se niega y no se pisa', async () => {
    await withCodex(['half'], async (t) => {
      const a = addCodexAccount('acct-a');
      fs.mkdirSync(t.home, { recursive: true });
      fs.writeFileSync(t.authPath, '{"auth_mode":"chatgpt","tok');
      await assert.rejects(codexSwap.swapTo(a.id, t), /ilegible/);
      assert.strictEqual(fs.readFileSync(t.authPath, 'utf8'), '{"auth_mode":"chatgpt","tok');
    });
  });

  await checkAsync('codex swap: 400 entorno desconocido, 404 cuenta desconocida, 409 si ya hay uno en curso', async () => {
    await withCodex(['lock'], async (t) => {
      const a = addCodexAccount('acct-a');
      await assert.rejects(codexSwap.swapTo(a.id, 'wsl:no-existe'), (e) => e.status === 400);
      await assert.rejects(codexSwap.swapTo('cdx_000000', t), (e) => e.status === 404);
      const first = codexSwap.swapTo(a.id, t);
      await assert.rejects(codexSwap.swapTo(a.id, t), (e) => e.status === 409 && /en curso/.test(e.message));
      assert.strictEqual((await first).ok, true);
      assert.strictEqual((await codexSwap.swapTo(a.id, t)).ok, true, 'the lock is released afterwards');
    });
  });

  await checkAsync('codex swap: los backups van a data/codex/backups, se podan a 20 y nunca tocan data/backups', async () => {
    await withCodex(['bk'], async (t) => {
      const a = addCodexAccount('acct-a');
      const b = addCodexAccount('acct-b');
      const claudeBackups = path.join(SANDBOX, 'backups');
      fs.mkdirSync(claudeBackups, { recursive: true });
      // More than MAX_BACKUPS of them: a pruner that also pruned data/backups would show here.
      for (let i = 0; i < 25; i++) fs.mkdirSync(path.join(claudeBackups, `2020-01-01-claude-${String(i).padStart(2, '0')}`), { recursive: true });
      const claudeBefore = fs.readdirSync(claudeBackups).sort();
      for (let i = 0; i < 25; i++) await codexSwap.swapTo(i % 2 ? a.id : b.id, t);
      const codexBackups = fs.readdirSync(path.join(SANDBOX, 'codex', 'backups'));
      assert.strictEqual(codexBackups.length, 20);
      assert.deepStrictEqual(fs.readdirSync(claudeBackups).sort(), claudeBefore, 'Claude backups untouched');
      assert.ok(fs.existsSync(path.join(SANDBOX, 'codex', 'backups', codexBackups.sort()[19], 'auth.json')));
    });
  });

  await checkAsync('codex import: desde staging guarda la cuenta y borra el auth.json de staging; una clave de API se rechaza', async () => {
    await withCodex([], async () => {
      const staging = codexSwap.stagingDir();
      assert.strictEqual(staging, path.join(SANDBOX, 'codex', 'login'));
      await assert.rejects(codexSwap.importFrom({ staging: true }), (e) => e.status === 404);
      writeLive({ home: staging, authPath: path.join(staging, 'auth.json') }, codexTokens('acct-new', { email: 'new@x.test' }));
      const acc = await codexSwap.importFrom({ staging: true });
      assert.strictEqual(acc.email, 'new@x.test');
      assert.strictEqual(acc.plan, 'plus');
      assert.strictEqual(fs.existsSync(path.join(staging, 'auth.json')), false, 'staging file deleted');
      assert.strictEqual(codexStore.activeTargetsOf(acc.id).length, 0, 'a staging import is not live anywhere');

      const other = path.join(CODEX_TMP, 'apikey-home');
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(other, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'x' }));
      await assert.rejects(codexSwap.importFrom({ configDir: other }), (e) => e.status === 400 && /clave de API/.test(e.message));
    });
  });

  await checkAsync('codex import: la sesión viva de un entorno se importa y queda activa ahí', async () => {
    await withCodex(['imp'], async (t) => {
      writeLive(t, codexTokens('acct-live'));
      const acc = await codexSwap.importFrom({ target: t });
      assert.strictEqual(codexStore.activeFor(t.id), acc.id);
      assert.strictEqual(codexSwap.detectActiveId(t.id), acc.id);
      assert.ok(fs.existsSync(t.authPath), 'a live import never deletes the live file');
    });
  });

  await checkAsync('codex refresh: un token caducado se renueva, se guarda y se devuelve al auth.json que tenía el viejo', async () => {
    const posted = [];
    let fresh;
    const net = async (url, opts) => {
      if (String(url) === codexAuth.TOKEN_URL) {
        posted.push(JSON.parse(opts.body));
        fresh = codexTokens('acct-a');
        return res(200, { id_token: fresh.id_token, access_token: fresh.access_token, refresh_token: fresh.refresh_token });
      }
      return stubCodexNet()(url);
    };
    await withCodex(['holder'], async (t) => {
      // 60 s left and live in t: the Codex there refreshes at this same margin, so the panel
      // must not race it for the refresh token.
      const soon = addCodexAccount('acct-soon', { expSecs: 60 });
      writeLive(t, codexAuth.toTokens(soon.oauth));
      assert.strictEqual((await codexSwap.ensureFresh(codexStore.get(soon.id))).oauth.refreshToken, soon.oauth.refreshToken);
      assert.strictEqual(posted.length, 0, 'a live account with time left is not refreshed');

      // Past exp: that Codex is not refreshing it, so the panel does and hands the pair back.
      const a = addCodexAccount('acct-a', { expSecs: -60 });
      writeLive(t, codexAuth.toTokens(a.oauth), { agent_identity: { keep: 1 } });
      const out = await codexSwap.ensureFresh(codexStore.get(a.id));
      assert.deepStrictEqual(posted, [{ client_id: codexAuth.CLIENT_ID, grant_type: 'refresh_token', refresh_token: a.oauth.refreshToken }]);
      assert.strictEqual(out.oauth.refreshToken, fresh.refresh_token);
      assert.strictEqual(codexStore.get(a.id).oauth.refreshToken, fresh.refresh_token, 'stored before anything else');
      const live = readLive(t);
      assert.strictEqual(live.tokens.refresh_token, fresh.refresh_token, 'handed back to the file that held the old one');
      assert.strictEqual(live.tokens.account_id, 'acct-a', 'account_id kept although the endpoint does not return it');
      assert.deepStrictEqual(live.agent_identity, { keep: 1 });
      // Not due: no call at all.
      await codexSwap.ensureFresh(codexStore.get(a.id));
      assert.strictEqual(posted.length, 1);
    }, net);
  });

  await checkAsync('codex refresh: un refresh token rechazado marca la cuenta como muerta y el keep-alive no la reintenta', async () => {
    let calls = 0;
    const net = async (url) => {
      if (String(url) === codexAuth.TOKEN_URL) { calls++; return res(400, { error: { code: 'refresh_token_reused' } }); }
      return stubCodexNet()(url);
    };
    await withCodex(['kd'], async (t) => {
      const a = addCodexAccount('acct-a', { expSecs: 60 });
      await assert.rejects(codexSwap.ensureFresh(a), (e) => e.permanent === true);
      assert.ok(codexStore.get(a.id).dead, 'marked dead');
      assert.strictEqual(codexStore.publicAccount(a.id).tokenExpired, true);
      const u = await codexUsage.fetchFor(codexStore.get(a.id), { force: true });
      assert.strictEqual(u.needsRelogin, true);

      // Dead with days of access token left (the keep-alive marks them under 2 days), and a
      // good reading cached: the row still says "sign in again", and it cannot be swapped in.
      const d = addCodexAccount('acct-d');
      codexUsage.prime(d.id, codexUsage.normalize(whamBody(FIVE_H, WEEK), d.id));
      codexStore.update(d.id, { dead: 'refresh_token_reused' });
      const du = await codexUsage.fetchFor(codexStore.get(d.id));
      assert.strictEqual(du.ok, false);
      assert.strictEqual(du.needsRelogin, true, 'not the cached reading');
      await assert.rejects(codexSwap.swapTo(d.id, t), (e) => e.status === 409);
      assert.strictEqual(fs.existsSync(t.authPath), false, 'nothing written');
      const r = await codexSwap.keepAliveTick();
      assert.strictEqual(calls, 1, 'a dead account is never retried');
      assert.deepStrictEqual(r.refreshed, []);
      assert.deepStrictEqual(r.failed, [], 'skipped, not tried and failed');
    }, net);
  });

  await checkAsync('codex keep-alive: adopta el par vivo, renueva solo las cuentas ociosas cerca de caducar', async () => {
    const refreshedWith = [];
    const net = async (url, opts) => {
      if (String(url) === codexAuth.TOKEN_URL) {
        refreshedWith.push(JSON.parse(opts.body).refresh_token);
        const f = codexTokens('acct-idle');
        return res(200, { id_token: f.id_token, access_token: f.access_token, refresh_token: f.refresh_token });
      }
      return stubCodexNet()(url);
    };
    await withCodex(['ka'], async (t) => {
      const live = addCodexAccount('acct-live', { expSecs: 3600 });
      const idle = addCodexAccount('acct-idle', { expSecs: 3600 });
      const healthy = addCodexAccount('acct-healthy');
      const rotated = codexTokens('acct-live', { expSecs: 3600 });
      writeLive(t, rotated);
      const r = await codexSwap.keepAliveTick();
      assert.deepStrictEqual(refreshedWith, [idle.oauth.refreshToken], 'only the idle, near-expiry account');
      assert.strictEqual(codexStore.get(live.id).oauth.refreshToken, rotated.refresh_token, 'live pair adopted, not refreshed');
      assert.strictEqual(r.refreshed.length, 1);
      assert.strictEqual(codexStore.get(healthy.id).oauth.refreshToken, healthy.oauth.refreshToken);
    }, net);
  });

  // A token endpoint that answers a fresh pair for `accountId`, recording the refresh tokens spent.
  const tokenEndpoint = (accountId, spent, before) => async (url, opts) => {
    if (String(url) === codexAuth.TOKEN_URL) {
      spent.push(JSON.parse(opts.body).refresh_token);
      if (before) await before();
      const f = codexTokens(accountId);
      return res(200, { id_token: f.id_token, access_token: f.access_token, refresh_token: f.refresh_token });
    }
    return stubCodexNet()(url);
  };

  await checkAsync('codex refresh: lecturas de uso y keep-alive a la vez gastan el refresh token una sola vez', async () => {
    const spent = [];
    await withCodex([], async () => {
      const a = addCodexAccount('acct-a', { expSecs: 60 });
      const [r1, r2, ka] = await Promise.all([
        codexUsage.fetchFor(a, { force: true }), codexUsage.fetchFor(a, { force: true }), codexSwap.keepAliveTick(),
      ]);
      assert.deepStrictEqual(spent, [a.oauth.refreshToken], 'one POST, one refresh token');
      assert.ok(r1.ok && r2.ok, `${r1.error || ''} ${r2.error || ''}`);
      assert.deepStrictEqual(ka.failed, []);
      assert.strictEqual(codexStore.get(a.id).dead, null);
    }, tokenEndpoint('acct-a', spent, () => new Promise((r) => setTimeout(r, 20))));
  });

  await checkAsync('codex: una cuenta adoptada en un WSL que luego se para sigue contando como activa ahí (409)', async () => {
    await withCodex(['wsl', 'hostx'], async (wsl, host) => {
      const a = addCodexAccount('acct-a');
      // The user logged in natively inside that distro: a newer pair of the same account.
      writeLive(wsl, codexTokens('acct-a', { expSecs: 241 * 3600 }));
      await codexSwap.keepAliveTick();
      assert.deepStrictEqual(codexStore.activeTargetsOf(a.id), [wsl.id], 'adopting records where it is live');
      codexTargetList = [host]; // the distro stopped when idle: off the list, its file unseen
      await assert.rejects(codexSwap.swapTo(a.id, host), (e) => e.status === 409 && e.message.includes(wsl.id));
      assert.strictEqual(fs.existsSync(host.authPath), false, 'nothing written');
      // Back, and holding another account: the record follows the file.
      codexTargetList = [wsl, host];
      writeLive(wsl, codexTokens('acct-other'));
      assert.strictEqual(codexSwap.detectActiveId(wsl.id), null);
      assert.strictEqual((await codexSwap.swapTo(a.id, host)).ok, true);
    });
  });

  await checkAsync('codex swap: si Codex rota el par saliente mientras se renueva el entrante, el store se queda el nuevo', async () => {
    const spent = [];
    let t;
    let rotated;
    // What the Codex open there does during the incoming account's refresh: rotate the outgoing one.
    const codexRotates = async () => { rotated = codexTokens('acct-a', { expSecs: 241 * 3600 }); writeLive(t, rotated); };
    await withCodex(['rot'], async (tg) => {
      t = tg;
      const a = addCodexAccount('acct-a');
      const b = addCodexAccount('acct-b', { expSecs: 60 });
      writeLive(t, codexAuth.toTokens(a.oauth));
      assert.strictEqual((await codexSwap.swapTo(b.id, t)).ok, true);
      assert.deepStrictEqual(spent, [b.oauth.refreshToken]);
      assert.strictEqual(codexStore.get(a.id).oauth.refreshToken, rotated.refresh_token, 'not only in the backup');
      assert.strictEqual(readLive(t).tokens.account_id, 'acct-b');
    }, tokenEndpoint('acct-b', spent, codexRotates));
  });

  await checkAsync('codex: un auth.json que se quedó atrás tras un refresh recibe el par del store, salvo si la cuenta vive en otro sitio', async () => {
    await withCodex(['lag', 'other'], async (t, other) => {
      const a = addCodexAccount('acct-a', { expSecs: 200 * 3600 });
      writeLive(t, codexAuth.toTokens(a.oauth), { agent_identity: { keep: 1 } });
      // The panel refreshed, and handing the pair back to t failed.
      const newer = codexTokens('acct-a');
      codexStore.update(a.id, { oauth: codexAuth.toStored(newer, 'LR') });
      await codexSwap.keepAliveTick();
      const live = readLive(t);
      assert.strictEqual(live.tokens.refresh_token, newer.refresh_token, 'caught up');
      assert.deepStrictEqual(live.agent_identity, { keep: 1 });

      // Live in another environment too: a second holder of that pair would be worse than a lag.
      writeLive(t, codexAuth.toTokens(a.oauth));
      writeLive(other, newer);
      await codexSwap.keepAliveTick();
      assert.strictEqual(readLive(t).tokens.refresh_token, a.oauth.refreshToken);
    });
  });

  await checkAsync('codex: un par guardado que OpenAI rechazó no protege contra uno más antiguo pero válido', async () => {
    await withCodex(['old'], async (t) => {
      const a = addCodexAccount('acct-a');
      codexStore.update(a.id, { dead: 'refresh_token_reused' });
      const older = codexTokens('acct-a', { expSecs: 100 * 3600 });
      writeLive(t, older);
      codexSwap.adoptLive(t);
      assert.strictEqual(codexStore.get(a.id).oauth.refreshToken, older.refresh_token, 'adopted');
      assert.strictEqual(codexStore.get(a.id).dead, null);

      codexStore.update(a.id, { dead: 'refresh_token_reused', oauth: codexAuth.toStored(codexTokens('acct-a'), 'LR') });
      const dir = path.join(CODEX_TMP, 'older-home');
      fs.rmSync(dir, { recursive: true, force: true });
      const older2 = codexTokens('acct-a', { expSecs: 50 * 3600 });
      writeLive({ home: dir, authPath: path.join(dir, 'auth.json') }, older2);
      await codexSwap.importFrom({ configDir: dir });
      assert.strictEqual(codexStore.get(a.id).oauth.refreshToken, older2.refresh_token, 'imported');

      // A pair that still works stays protected from an older copy.
      const newest = codexTokens('acct-a', { expSecs: 300 * 3600 });
      codexStore.update(a.id, { oauth: codexAuth.toStored(newest, 'LR') });
      await codexSwap.importFrom({ configDir: dir });
      assert.strictEqual(codexStore.get(a.id).oauth.refreshToken, newest.refresh_token, 'kept');
    });
  });

  await checkAsync('codex swap: con backups de fecha futura el rollback restaura igual, y sin marca de ausencia no borra', async () => {
    await withCodex(['future'], async (t) => {
      const a = addCodexAccount('acct-a');
      const b = addCodexAccount('acct-b');
      // A clock that ran ahead once: 20 backups that sort after anything taken today.
      for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(codexSwap.backupsDir(), `2099-01-01T00-00-00-000Z-${String(i).padStart(4, '0')}-cdx_ffffff`), { recursive: true });
      writeLive(t, codexAuth.toTokens(a.oauth), { extra: 1 });
      const before = fs.readFileSync(t.authPath);
      await assert.rejects(codexSwap.swapTo(b.id, t), /restaurado/);
      assert.ok(fs.existsSync(t.authPath) && fs.readFileSync(t.authPath).equals(before), 'restored, not deleted');
      assert.strictEqual(fs.readdirSync(codexSwap.backupsDir()).length, 20);

      const hollow = path.join(CODEX_TMP, 'hollow-backup');
      fs.mkdirSync(hollow, { recursive: true });
      assert.throws(() => codexSwap.restoreFrom(hollow, t), /ausencia/);
      assert.ok(fs.readFileSync(t.authPath).equals(before), 'no auth.json and no marker is no proof of absence');
    }, stubCodexNet(401));
  });

  await checkAsync('codex rollback: reintenta un EPERM pasajero y no deja el .restore.tmp con tokens si falla', async () => {
    await withCodex(['perm'], async (t) => {
      const a = addCodexAccount('acct-a');
      writeLive(t, codexAuth.toTokens(a.oauth));
      const backup = codexSwap.backupNow(a.id, t);
      fs.writeFileSync(t.authPath, '{}');
      const realRename = fs.renameSync;
      const eperm = () => Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
      let fails = 1;
      fs.renameSync = (...x) => { if (fails-- > 0) throw eperm(); return realRename(...x); };
      try {
        codexSwap.restoreFrom(backup.dir, t);
        assert.strictEqual(readLive(t).tokens.account_id, 'acct-a', 'a transient lock is retried');
        fs.writeFileSync(t.authPath, '{}');
        fs.renameSync = () => { throw eperm(); };
        assert.throws(() => codexSwap.restoreFrom(backup.dir, t), /EPERM/);
      } finally {
        fs.renameSync = realRename;
      }
      assert.deepStrictEqual(fs.readdirSync(t.home).filter((n) => n.endsWith('.tmp')), [], 'no token copy left behind');
    });
  });

  await checkAsync('/api/codex/*: X-Swapper obligatoria, 400/404 donde toca, y ninguna respuesta lleva un token', async () => {
    const server = require('./server').createServer(7993);
    const cp = require('node:child_process');
    const spawnReal = cp.spawn;
    const antes = process.env.SWAPPER_IN_CONTAINER;
    let lanzo = false;
    await withCodex(['http'], async (t) => {
      try {
        await new Promise((r) => server.listen(7993, '127.0.0.1', r));
        const bodies = [];
        const call = async (method, p, body, headers = { 'X-Swapper': '1' }) => {
          const r = await fetch(`http://127.0.0.1:7993${p}`, {
            method, headers: { 'Content-Type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const text = await r.text();
          bodies.push(text);
          return { status: r.status, body: JSON.parse(text) };
        };
        // The server's own fetch goes to the stubbed network; the test's goes to the socket.
        const stub = global.fetch;
        const real = realFetchForTests;
        global.fetch = (url, opts) => (String(url).startsWith('http://127.0.0.1:7993') ? real(url, opts) : stub(url, opts));

        codexTargetList = [t, codexTargets.hostTarget()];
        const a = addCodexAccount('acct-http');
        const b = addCodexAccount('acct-http-b');
        assert.strictEqual((await call('GET', '/api/codex/accounts', undefined, {})).status, 403, 'no X-Swapper, no answer');
        const list = await call('GET', `/api/codex/accounts?target=${encodeURIComponent(t.id)}`);
        assert.strictEqual(list.status, 200);
        assert.ok('activeId' in list.body && Array.isArray(list.body.accounts));
        assert.strictEqual(list.body.accounts.length, 2);

        assert.strictEqual((await call('POST', '/api/codex/swap', { id: a.id, target: 'wsl:no-existe' })).status, 400);
        assert.strictEqual((await call('POST', '/api/codex/swap', { target: t.id })).status, 400, 'no id');
        assert.strictEqual((await call('POST', '/api/codex/swap', { id: 'cdx_000000', target: t.id })).status, 404);
        assert.strictEqual((await call('GET', '/api/codex/nope')).status, 404);
        assert.strictEqual((await call('DELETE', '/api/codex/accounts/acc_123456')).status, 404, 'a Claude id is not a Codex route');

        const swapped = await call('POST', '/api/codex/swap', { id: a.id, target: t.id });
        assert.strictEqual(swapped.status, 200);
        assert.strictEqual(swapped.body.target, t.id);
        assert.strictEqual(swapped.body.account.isActive, true);
        const targetsRes = await call('GET', '/api/codex/targets');
        assert.strictEqual(targetsRes.body.targets[0].activeId, a.id);
        assert.strictEqual(targetsRes.body.targets[0].storeMode, 'file');
        const all = await call('GET', '/api/codex/usage/all');
        assert.strictEqual(all.body[a.id].session.percent, 12, 'served from the reading the swap primed');
        assert.strictEqual((await call('GET', `/api/codex/usage?id=${a.id}`)).body.ok, true);
        assert.strictEqual((await call('GET', '/api/codex/usage?id=cdx_000000')).status, 404);
        assert.strictEqual((await call('POST', '/api/codex/swap', { id: a.id, target: 'host' })).status, 409, 'live in another environment');

        const renamed = await call('PATCH', `/api/codex/accounts/${b.id}`, { label: '  Equipo  ' });
        assert.strictEqual(renamed.body.account.label, 'Equipo');
        assert.strictEqual((await call('PATCH', `/api/codex/accounts/${b.id}`, { label: ' ' })).status, 400);

        const health = await call('GET', '/api/codex/health');
        assert.strictEqual(health.status, 200);
        for (const k of ['installed', 'running', 'pids', 'overridingEnv', 'softEnv', 'storeMode', 'container', 'paths']) assert.ok(k in health.body, k);
        assert.strictEqual(health.body.paths.home, process.env.CODEX_HOME);

        writeLive({ home: codexSwap.stagingDir(), authPath: path.join(codexSwap.stagingDir(), 'auth.json') }, codexTokens('acct-staged'));
        const imp = await call('POST', '/api/codex/accounts/import', { staging: true });
        assert.strictEqual(imp.status, 200);
        assert.strictEqual(imp.body.account.id, codexStore.idFor('acct-staged'));
        assert.strictEqual((await call('POST', '/api/codex/accounts/import', { staging: true })).status, 404, 'consumed');
        assert.deepStrictEqual(imp.body.warnings, []);
        // Another CODEX_HOME keeps its copy of the rotating refresh token: the answer says so.
        const otherHome = path.join(CODEX_TMP, 'http-other-home');
        writeLive({ home: otherHome, authPath: path.join(otherHome, 'auth.json') }, codexTokens('acct-dir'));
        const fromDir = await call('POST', '/api/codex/accounts/import', { configDir: otherHome });
        assert.strictEqual(fromDir.status, 200);
        assert.strictEqual(fromDir.body.warnings.length, 1);
        assert.match(fromDir.body.warnings[0], /refresh token/);

        process.env.SWAPPER_IN_CONTAINER = '1';
        cp.spawn = (...x) => { lanzo = true; return spawnReal(...x); };
        const term = await call('POST', '/api/codex/login/terminal', {});
        assert.strictEqual(term.status, 409);
        assert.strictEqual(lanzo, false, 'nothing opened inside a container');

        assert.strictEqual((await call('DELETE', `/api/codex/accounts/${b.id}`)).status, 200);
        assert.strictEqual(codexStore.get(b.id), null);

        for (const text of bodies) {
          assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(text) && !/rt\.a\./.test(text), `a response leaked a token: ${text.slice(0, 120)}`);
        }
      } finally {
        cp.spawn = spawnReal;
        if (antes === undefined) delete process.env.SWAPPER_IN_CONTAINER; else process.env.SWAPPER_IN_CONTAINER = antes;
        await new Promise((r) => server.close(r));
      }
    });
  });

  fs.rmSync(CODEX_TMP, { recursive: true, force: true });
  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
