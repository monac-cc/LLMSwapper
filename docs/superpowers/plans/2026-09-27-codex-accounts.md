# Codex accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let LLMSwapper store, swap and meter OpenAI Codex CLI accounts, in a Codex view selected by a Claude | Codex switch, without changing anything the Claude side does.

**Architecture:** A self-contained `lib/codex/` package (auth file I/O and JWT identity, its own store, targets, usage reader, swap engine, HTTP routes) mounted on the existing server by one dispatch line. The frontend keeps its rendering code and switches its API prefix and a handful of strings per provider.

**Tech Stack:** Node >= 18, zero dependencies, no build. Tests are `node test.js` (plain `assert`, `check()`/`checkAsync()` helpers, stubbed `global.fetch`).

**Spec:** `docs/superpowers/specs/2026-09-27-codex-accounts-design.md` - read it first; it holds the verified facts every task relies on.

## Global Constraints

- Zero npm dependencies. Node built-ins only (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, global `fetch`).
- Node 18 floor: no APIs newer than Node 18 (no `fs.globSync`, no `Array.prototype.toSorted`).
- Every path under `data/` is computed at call time from `P.dataDir()` (the test suite reassigns it).
- `CODEX_HOME` is read at call time, never at `require` time.
- No token ever reaches a log, a response body or a source file. Errors go through `oauth.scrub`.
- Server-side messages are Spanish, like the existing ones. Code comments follow the file's language.
- Codex ids match `/^cdx_[a-f0-9]{6}$/`.
- Refresh: `POST https://auth.openai.com/oauth/token`, JSON `{client_id:"app_EMoamEEZ73f0CkXaXp7hrann", grant_type:"refresh_token", refresh_token}`.
- Usage: `GET https://chatgpt.com/backend-api/wham/usage`, headers `Authorization: Bearer <access>`, `ChatGPT-Account-ID: <account_id>`, `User-Agent: codex_cli_rs/0.157.1 (LLMSwapper)`, `originator: codex_cli_rs`, `Accept: application/json`.
- Writes to `auth.json` keep every key they do not own and always set `last_refresh`.
- Backups: `data/codex/backups/`, pruned to 20, never touching `data/backups/`.

## Review Focus

1. **Codex is open while swapping** (CLI or desktop app): the swap must still succeed, warn that open sessions keep the old account, and the store must hold the outgoing account's newest pair (adopted from `auth.json`) - pinned in Task 6.
2. **`auth.json` read mid-write by Codex** (truncated JSON): retried, never read as "no session" and never overwritten on that basis - pinned in Task 2.
3. **Swapping into a target with no `auth.json` yet** (fresh WSL install): the file and its directory are created; a failed verify deletes it again instead of leaving a half-configured login - pinned in Task 6.
4. **The same login imported twice** (live import and staging import): one row, label kept, tokens updated - pinned in Task 3.
5. **Switching Claude -> Codex while a Claude request is in flight**: the Codex view must never render Claude rows (responses for a provider that is no longer shown are dropped) - pinned in Task 9.

---

### Task 1: Shared seams (scrub, exports)

**Files:**
- Modify: `lib/oauth.js` (`scrub`)
- Modify: `lib/usage.js` (`module.exports`: add `meter`, `num`)
- Modify: `lib/targets.js` (`module.exports`: add `runWsl`, `wslPath`, `uncBaseCandidates`)
- Test: `test.js`

**Interfaces:**
- Produces: `oauth.scrub(text)` now also redacts `eyJ...` JWTs (`eyJ***`) and OpenAI refresh tokens (`rt***`); `usage.meter(percent, resetsAt) -> {percent, resetsAt, severity}`; `targets.runWsl(args, timeout?)`, `targets.wslPath(base, posixHome, ...rest)`, `targets.uncBaseCandidates(distro)`.

- [ ] **Step 1: Write the failing tests** (in `test.js`, next to the existing scrub check)

```js
check('scrub() also redacts OpenAI JWTs and refresh tokens', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'RS256' })}.${b64({ email: 'x@y.z' })}.${'s'.repeat(40)}`;
  const rt = `rt.A.${'q'.repeat(120)}`;
  const out = oauth.scrub(`bad ${jwt} and ${rt} end`);
  assert.ok(!out.includes(jwt) && !out.includes(rt), out);
  assert.match(out, /eyJ\*\*\*/);
  assert.strictEqual(oauth.scrub('sk-ant-oat01-abc'), 'sk-ant-***', 'Claude behaviour unchanged');
});
```

Extend the existing "no source file hardcodes a token" check so it also fails on `/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/` in any tracked `.js`/`.mjs`/`.md` file.

- [ ] **Step 2: Run** `node test.js` - expect the new scrub check to FAIL.
- [ ] **Step 3: Implement**

```js
function scrub(text) {
  return String(text == null ? '' : text)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'eyJ***')
    .replace(/\b[a-z]{2}\.[A-Za-z0-9_-]\.[A-Za-z0-9_-]{100,}/g, 'rt***');
}
```

Add the exports named above.
- [ ] **Step 4: Run** `node test.js` - all pass.

---

### Task 2: `lib/codex/auth.js`

**Files:**
- Create: `lib/codex/auth.js`
- Test: its self-check + `test.js` (add `'lib/codex/auth.js'` to the module self-check list)

**Interfaces:**
- Produces:
  - `codexHome() -> string` (`process.env.CODEX_HOME || path.join(os.homedir(), '.codex')`)
  - `authPath(home) -> string`
  - `readAuth(file) -> object|null` - null when absent; on a JSON parse error retries 3 times 50 ms apart (`Atomics.wait`), then throws `Error('auth.json ilegible ...')`.
  - `decodeJwt(token) -> object|null` (payload only, base64url, no verification)
  - `identity(tokens) -> {accountId, email, plan, userId}` from `tokens.id_token` (fallback: access token claims `https://api.openai.com/profile.email`)
  - `coherent(tokens) -> boolean` - access-token claim `["https://api.openai.com/auth"].chatgpt_account_id === tokens.account_id` (true when the claim is absent)
  - `toStored(tokens, lastRefresh) -> {accessToken, refreshToken, idToken, accountId, expiresAt, lastRefresh}` (`expiresAt` = access `exp * 1000`)
  - `toTokens(oauth) -> {id_token, access_token, refresh_token, account_id}`
  - `writeTokens(file, oauth)` - reads the existing file (tolerating absence), sets `auth_mode:'chatgpt'`, `tokens`, `last_refresh` (oauth.lastRefresh or now ISO), keeps every other key, `mkdirSync(dirname, {recursive:true})`, `P.writeJsonAtomic(file, obj, 0o600)`.
  - `refresh(refreshToken) -> Promise<{tokens, lastRefresh}>` - POST as in Global Constraints; on non-2xx throws `Error` with `.status` and `.permanent = status === 401 || /refresh_token_(reused|expired|invalidated)|invalid_grant/.test(body)`, message scrubbed; response `account_id` is not returned by the endpoint, so the caller supplies it.
  - `storeMode(home) -> 'file' | string` - reads `config.toml` if present, regex `^\s*cli_auth_credentials_store\s*=\s*"([a-z]+)"` (multiline); returns that value if not `file`; returns `'keyring'` if `secrets/codex_auth.age` exists; else `'file'`.
  - `CLIENT_ID`, `TOKEN_URL`.

- [ ] **Step 1: Self-check first** (bottom of the file, runs under `node lib/codex/auth.js`): build a JWT at runtime (`b64url(header).b64url(payload).sig`) with `email`, `exp`, and the auth claim; assert `identity`, `coherent` (true and false cases), `toStored.expiresAt === exp*1000`; write an `auth.json` with an extra key `{agent_identity:{x:1}}` into a temp dir via `writeTokens` and assert the extra key survives, `last_refresh` is set, `auth_mode === 'chatgpt'`; write `'{"trunc'` to a file and assert `readAuth` throws after retries; `storeMode` on a temp home with `config.toml` containing `cli_auth_credentials_store = "keyring"` returns `'keyring'`, and `'file'` without it.
- [ ] **Step 2: Run** `node lib/codex/auth.js` - fails (module missing).
- [ ] **Step 3: Implement** the module.
- [ ] **Step 4: Run** `node lib/codex/auth.js` then `node test.js` - pass.

---

### Task 3: `lib/codex/store.js`

**Files:**
- Create: `lib/codex/store.js`
- Test: self-check + `test.js`

**Interfaces:**
- Consumes: `P.dataDir`, `P.readJsonIfExists`, `P.writeJsonAtomic`, `store.PALETTE` from `lib/store.js`.
- Produces: `file()`, `load()`, `save(s)`, `list()`, `get(id)`, `idFor(accountId)`, `add({accountId, email, plan, oauth, label?})` (upsert by `accountId`; keeps an existing label unless `label` is given; clears `dead`), `update(id, patch)` (patchable: `label, color, oauth, email, plan, dead, lastSwappedAt`), `remove(id)` (also clears it from `active`), `setActive(id, targetId)`, `activeFor(targetId)`, `activeTargetsOf(id) -> string[]`, `publicView(targetId)`, `publicAccount(id, targetId)`.
- `publicView` rows: `{id, label, email, color, plan, org:null, addedAt, lastSwappedAt, isActive, tokenExpired: !!dead, canReadUsage:true, renewable:true, expiresAt}`; `plan` capitalised from `chatgpt_plan_type` (`plus`->`Plus`, `pro`->`Pro`, `team`->`Team`, `business`->`Business`, `enterprise`->`Enterprise`, `free`->`Free`, `edu`/`education`->`Edu`, otherwise the raw value or null).

- [ ] **Step 1: Self-check**: point `P.dataDir` at a temp dir; `add` twice with the same `accountId` (second time new tokens, no label) -> one row, label kept, tokens updated; `add` with a label renames; `setActive` + `activeTargetsOf`; `remove` clears `active`; `JSON.stringify(publicView('host'))` contains no `eyJ` and no `refreshToken`.
- [ ] **Step 2: Run** - fails. **Step 3: Implement.** **Step 4: Run** `node lib/codex/store.js`, `node test.js` - pass.

---

### Task 4: `lib/codex/targets.js`

**Files:**
- Create: `lib/codex/targets.js`
- Test: self-check

**Interfaces:**
- Consumes: `targets.listDistros/runWsl/wslPath/uncBaseCandidates` (Task 1), `auth.codexHome/authPath`, `P.inContainer`.
- Produces: `hostTarget() -> {id:'host', kind:'host', label, home, authPath}` (label: `Windows`/`macOS`/`Linux` like `lib/targets.js`), `list({force}) -> target[]` (host + each non-system WSL distro whose `<home>/.codex` directory is reachable over the share; 30 s cache; Windows only; never throws), `resolve(id) -> target|null` (`undefined`/`''` -> host), `detectRunning(target) -> {running, pids, unknown?}`.
- Detection: container -> `{running:false, pids:[], unknown:true}`; Windows host -> `tasklist /FI "IMAGENAME eq codex.exe" /FO CSV /NH`; Unix host -> `pgrep -x codex` (exit 1 = none); WSL -> `runWsl(['-d', distro, 'sh', '-c', 'pgrep -x codex || true'])`. Never throws.

- [ ] **Step 1: Self-check**: `hostTarget()` fields; `resolve('host').id === 'host'`; `resolve('wsl:nope') === null`; `list({force:true})` includes host and never throws; `detectRunning(hostTarget())` returns a boolean `running`.
- [ ] **Step 2-4:** run (fail), implement, run (pass).

---

### Task 5: `lib/codex/usage.js`

**Files:**
- Create: `lib/codex/usage.js`
- Test: self-check + `test.js`

**Interfaces:**
- Consumes: `usage.meter` (Task 1), `oauth.scrub`, `P.dataDir`.
- Produces: `USAGE_URL`, `fetchRaw(account) -> Promise<json>` (throws `Error` with `.status`), `normalize(raw, id) -> NormalizedUsage`, `fetchFor(account, {force}) -> Promise<NormalizedUsage>`, `fetchAll(accounts, {force}) -> Promise<{[id]: NormalizedUsage}>` (sequential), `cachedFor(id)`, `prime(id, value) -> value`, `invalidate(id)`.
- `normalize`: windows from `raw.rate_limit.{primary_window, secondary_window}`; a window with `limit_window_seconds <= 6*3600` is `session`, `>= 6*86400` is `weekly`; otherwise primary->session, secondary->weekly. `resetsAt = new Date(reset_at*1000).toISOString()` (or from `reset_after_seconds`). Output `{id, ok:true, fetchedAt, session:meter(...), weekly:meter(...), scoped:[], opus:null, extraUsage:null, locked: raw.rate_limit.limit_reached ? {reason:'limit_reached'} : null}`.
- Behaviour: 4-minute cache (`force` bypasses); 3 s minimum gap between outbound calls (await a timer, do not reject); 401/403 -> `{id, ok:false, status, error, needsRelogin:true}`; 429 -> 10-minute backoff (persisted), serve last good reading with `stale:true, staleReason:'rate-limited'` or `{ok:false, rateLimited:true}` without one; network error -> stale reading or `{ok:false}`. Last good readings persisted to `data/codex/usage-cache.json`.
- `fetchFor` first calls `deps.ensureFresh(account)` when provided via `setEnsureFresh(fn)` (injected by `swap.js` to avoid a require cycle), so an access token past its `exp` is refreshed or adopted before reading.

- [ ] **Step 1: Test** (`test.js`, async): stub `global.fetch` to return the verified payload (primary 18000 s at 12%, secondary 604800 s at 2%) and assert `session.percent === 12`, `weekly.percent === 2`, ISO `resetsAt`; swap the order of the windows in the payload and assert the mapping still follows `limit_window_seconds`; a 401 gives `needsRelogin:true`; a 429 after a good read serves `stale:true` and makes no further call within the backoff.
- [ ] **Step 2-4:** run (fail), implement, run (pass).

---

### Task 6: `lib/codex/swap.js`

**Files:**
- Create: `lib/codex/swap.js`
- Test: `test.js` (async checks, temp `CODEX_HOME` targets built as plain objects `{id, kind, label, home, authPath}`)

**Interfaces:**
- Consumes: Tasks 2-5.
- Produces:
  - `adoptLive(target) -> {adopted:boolean, imported:account|null, accountId|null}` - reads `target.authPath`; ignores absent files and non-chatgpt modes; requires `coherent`; known `accountId` with a different refresh token -> `store.update(id, {oauth})`; unknown `accountId` -> `store.add(...)` (returned as `imported`).
  - `ensureFresh(account) -> Promise<account>` - no-op if `expiresAt - now > 5 min`; otherwise adopt from every target where the account is live, re-check, then `auth.refresh`; on success store the new pair and write it to each live target whose file still holds the old refresh token (else adopt that file's pair); on `permanent` failure `store.update(id, {dead: message})` and throw.
  - `swapTo(id, targetOrId, deps?) -> Promise<{ok, verified, target, targetLabel, warnings, backup, account}>` - exactly the ten steps in the spec; errors carry `.status` (400/404/409/500). A target may be passed as an object (tests) or an id (routes).
  - `importFrom({target, configDir, staging}) -> account` - source file: staging -> `data/codex/login/auth.json`; configDir -> `<configDir>/auth.json`; else the target's `authPath`. Rejects absent (`404`-style message), API-key mode, incoherent tokens. Importing from the target's own live file also `setActive`s it there. Staging import deletes the staging `auth.json` afterwards.
  - `detectActiveId(targetId) -> id|null` - `idFor(identity(live).accountId)` if stored.
  - `keepAliveTick() -> Promise<{adopted, refreshed, failed}>` - `adoptLive` on every target, then refresh every account not live anywhere with `expiresAt - now < 2 days` and not `dead`.
  - `stagingDir()` -> `path.join(P.dataDir(), 'codex', 'login')`.
  - Backups: `data/codex/backups/<stamp>-<id>/auth.json` (or `absent` marker) + `target.json`; prune to 20 in that directory only.

- [ ] **Step 1: Tests** (each builds its own temp dirs and stubs `global.fetch`):
  - swap into an empty temp home creates `auth.json` with the account's tokens, `last_refresh`, `auth_mode:'chatgpt'`; an existing extra key survives a second swap;
  - verify answering 401 rolls back: the previous `auth.json` bytes are restored, and a target that had none is left with none;
  - adopt: the live file holds account A with a rotated refresh token -> after swapping to B, the store's A has the rotated token;
  - the live file holds an account the store does not know -> it is imported before being overwritten;
  - an account active in target X is refused (409) when swapped into target Y;
  - a target whose `config.toml` says keyring is refused (409) and nothing is written;
  - a second concurrent `swapTo` is refused (409);
  - staging import stores the account and deletes `data/codex/login/auth.json`;
  - Codex backups land in `data/codex/backups/` and 25 swaps leave `data/backups/` untouched.
- [ ] **Step 2-4:** run (fail), implement, run (pass).

---

### Task 7: Login terminal (`lib/terminal.js`)

**Files:**
- Modify: `lib/terminal.js`

**Interfaces:**
- Produces: `codexInstalled() -> boolean` (`existeEnPath('codex')`), `openCodexLogin(dir) -> string` (how it opened). The command is a constant; `dir` is panel-owned (`swap.stagingDir()`), created before launching, and quoted: Windows `['cmd', '/k', `set "CODEX_HOME=${dir}"&& codex login`]` through `wt.exe` or `cmd.exe /c start`; macOS `do script` with the path single-quoted for the shell and `\`/`"` escaped for AppleScript; Linux `bash -lc` with `CODEX_HOME='<dir with ' escaped>' codex login; echo; read -r -p '...'`.

- [ ] **Step 1: Self-check**: `typeof codexInstalled() === 'boolean'`; a pure helper `codexLoginCommand(platform, dir)` (exported) returns argv whose every element is a string and that contains the directory exactly once, for a directory containing a space and a single quote.
- [ ] **Step 2-4:** run (fail), implement, run (pass).

---

### Task 8: `lib/codex/routes.js` + server wiring

**Files:**
- Create: `lib/codex/routes.js`
- Modify: `server.js` (dispatch before the Claude routes; Codex keep-alive next to the Claude one; banner line if `CODEX_ACCESS_TOKEN` is set)
- Test: `test.js` (HTTP through `createServer`, like the existing X-Swapper check)

**Interfaces:**
- Produces: `handle(req, res, url, {send, fail, readBody}) -> Promise<boolean>`; every route of the spec's API table. Ids in paths match `/^\/api\/codex\/accounts\/(cdx_[a-f0-9]{6})$/`. `health.overridingEnv` = set ones of `['CODEX_ACCESS_TOKEN']`, `softEnv` = set ones of `['CODEX_API_KEY']`. `login/terminal` answers 409 in a container or when `codexInstalled()` is false; it `mkdirSync`s the staging dir first.
- server.js: `if (pathname.startsWith('/api/codex/')) { if (await codexRoutes.handle(req, res, url, { send, fail, readBody })) return; return fail(res, 404, 'Endpoint desconocido'); }` placed first in `handleApi`; `setInterval(codexKeepAlive, KEEPALIVE_EVERY_MS).unref()` plus one run at start, logging `token Codex renovado: <email>` / scrubbed failures.

- [ ] **Step 1: Tests**: `/api/codex/accounts` without `X-Swapper` -> 403; with it -> 200 and `{activeId, accounts}`; `/api/codex/swap` with an unknown target -> 400; `/api/codex/nope` -> 404; responses never contain `eyJ`.
- [ ] **Step 2-4:** run (fail), implement, run (pass).

---

### Task 9: Frontend (`public/index.html`, `public/app.js`, `public/style.css`)

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/style.css`

**Interfaces:**
- Consumes: the `/api/codex/*` contract (spec, HTTP API table). Account rows and usage have the Claude shapes.
- Produces: user-visible behaviour only.

- [ ] **Step 1:** Header `.switch#switch-provider` (`data-provider="claude"|"codex"`, `aria-pressed`, `data-i18n-aria="provider.group"`), left of the refresh button. `provider` state from `localStorage['swapper.provider']` (default `claude`); `setProvider(next)` saves it, resets `accounts`/`usageById`/`targetList`, applies i18n, toggles `document.documentElement.dataset.provider`, refetches.
- [ ] **Step 2:** `const API = () => (provider === 'codex' ? '/api/codex' : '/api')` used by every accounts/targets/usage/swap/import/health call. Claude-only calls (`/api/accounts/token`, `/api/token/terminal`) stay as they are and are unreachable from the Codex view.
- [ ] **Step 3:** Per-provider tab memory: `swapper.target` (Claude, unchanged key) and `swapper.codex.target`.
- [ ] **Step 4:** `t(key)`: when `provider === 'codex'`, look up `codex.${key}` first (current language, then Spanish), then `key`. Add `codex.*` strings (ES and EN) for: empty state title/steps/footnote, the add button and its title, import title, the directory field prefix/label/help (`CODEX_HOME`), `note.expired`, `tab.running`, the running-warning copy, env banner text (`CODEX_ACCESS_TOKEN`), keyring banner, not-installed banner, login step text ("Termina el login en el navegador y pulsa importar"), toasts for login opened / imported.
- [ ] **Step 5:** Codex view: hide `#btn-add-token`, `#token-form` and any Claude-only control; show `#btn-add-codex` ("añadir cuenta") which POSTs `login/terminal`, toasts how it opened, and reveals `#login-form` (inline, same pattern as `#dir-form`: text + **importar** + **cancelar**, Escape closes) whose submit POSTs `accounts/import {staging:true}`. Env import button: live session of that env; Shift+click: dir field with `CODEX_HOME` prefix, posting `{configDir, target}`.
- [ ] **Step 6:** Race guard: every async load captures `const p = provider` before awaiting and drops its result if `provider !== p` afterwards. Background poll and refresh button act on the visible provider only.
- [ ] **Step 7:** Health banners per provider: Claude's as today; Codex's from `/api/codex/health` (`overridingEnv`, `storeMode !== 'file'`, `installed === false`). Hide the other provider's banners on switch.
- [ ] **Step 8:** Manual check: `node server.js` on a spare port with `NO_OPEN=1 PORT=7398 SWAPPER_DATA=<temp>` is NOT available (data dir is fixed), so verify in the running panel after deploy (Task 10) - both views render, switching keeps each view's tab, keyboard shortcuts still work in the Claude view.

---

### Task 10: Docs, version, release

**Files:**
- Modify: `README.md` (Codex section: what it does, the three ways to add an account, WSL, limitations: open sessions keep the old account, one environment per account, keyring unsupported, no auto-rotation/skills yet; providers table: Codex -> **Shipping**; status line no longer "Claude Code only"; check count), `ARCHITECTURE.md` (a "Codex" section with the verified facts and decisions from the spec, and the `/api/codex/*` table), `package.json` (`1.2.0`).

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** `node test.js` - all pass; README check count matches.
- [ ] **Step 3:** Commit in logical commits, push, confirm CI green, publish release `v1.2.0`.
