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

for (const mod of ['lib/paths.js', 'lib/store.js', 'lib/usage.js', 'lib/swap.js', 'lib/credentials.js', 'lib/targets.js', 'lib/terminal.js', 'lib/auto.js']) {
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
  // CLAUDE_CONFIG_DIR redirects paths.credentialsPath(), so this never touches the
  // real credentials. On macOS the Keychain path is preferred but falls back to the
  // file when no Keychain item exists - which is exactly this situation.
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

check('the macOS branch degrades to the file backend instead of crashing', () => {
  // Forces the darwin path on whatever this really is. Where `security` does not exist
  // (or holds no item) the Keychain read must fail soft and fall back to the file -
  // this is the closest thing to macOS coverage without a Mac.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swapper-darwin-'));
  const realPlatform = process.platform;
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    delete require.cache[require.resolve('./lib/credentials')];
    const credentials = require('./lib/credentials');

    assert.strictEqual(credentials.isMac(), true, 'must take the mac branch');
    assert.strictEqual(credentials.read(), null, 'no keychain and no file -> null, not a throw');

    const blob = { mcpOAuth: { a: 1 }, claudeAiOauth: { accessToken: 'X' } };
    assert.strictEqual(credentials.write(blob).kind, 'file', 'must fall back to the file');
    assert.deepStrictEqual(credentials.read(), blob);
    assert.ok(['file', 'keychain'].includes(credentials.describeBackend().kind));
  } finally {
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
    return d.isDirectory() ? walk(full) : /\.(js|html|css|md)$/.test(d.name) ? [full] : [];
  });
  for (const file of walk(__dirname)) {
    const text = fs.readFileSync(file, 'utf8');
    const hit = text.match(/sk-ant-(oat|ort)01-[A-Za-z0-9_-]{10,}/);
    assert.ok(!hit, `${path.relative(__dirname, file)} contains what looks like a real token`);
  }
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

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
