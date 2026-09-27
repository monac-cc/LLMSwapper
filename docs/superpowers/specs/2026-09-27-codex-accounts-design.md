# Codex accounts in LLMSwapper - design

Date: 2026-09-27. Status: approved by the user ("déjalo todo listo"), implementation follows.

## Goal

Swap the active **OpenAI Codex CLI** account with one click, and see each account's 5-hour and
weekly quota, exactly as the panel already does for Claude Code. A **Claude | Codex** switch at the
top of the same page selects the provider; under it, the same environment tabs (host, WSL distros).

Success: pressing *swap* on a Codex account makes the next `codex` started in that environment run
as that account; the meters show what each account has left without spending anything.

In scope (v1): store several Codex accounts, add them (import the live session, import from another
`CODEX_HOME`, or "open a terminal for me" that runs `codex login` in an isolated directory), swap per
environment (host + WSL), quota meters, keep idle tokens alive.
Out of scope (v1): automatic rotation for Codex, `/swapper*` skills for Codex, OS-keyring storage,
API-key accounts. Claude behaviour does not change.

## Verified facts this design rests on

Measured on this machine (Codex CLI 0.157.1 on Windows, 0.157.1 in WSL Ubuntu) and read from the
`openai/codex` source at the matching tag.

- **Storage.** `$CODEX_HOME/auth.json`, `CODEX_HOME` defaulting to `~/.codex` (must exist if set).
  Shape: `{auth_mode:"chatgpt", OPENAI_API_KEY:null, tokens:{id_token, access_token, refresh_token,
  account_id}, last_refresh:"<RFC3339>"}` plus optional newer keys. `last_refresh` is mandatory -
  without it Codex says "Token data is not available". Codex writes the file with truncate+write, not
  an atomic rename, so a reader can see it half-written.
- **Keyring.** `cli_auth_credentials_store = file|keyring|auto|ephemeral` in `config.toml`, default
  `file`. With keyring/auto the session leaves `auth.json` (Windows: `secrets/codex_auth.age`).
- **Refresh.** `POST https://auth.openai.com/oauth/token`, JSON body `{client_id:
  "app_EMoamEEZ73f0CkXaXp7hrann", grant_type:"refresh_token", refresh_token}`. Response carries a
  new `id_token`, `access_token` and `refresh_token`. **The refresh token rotates; reusing the old one
  fails permanently** (`refresh_token_reused`; also `_expired`, `_invalidated`). Access tokens last
  240 h. Codex refreshes when the access token is within 5 minutes of `exp`, or on a 401.
- **A running Codex does not watch `auth.json`.** It re-reads it only in a guarded reload right
  before refreshing (and on 401/login/logout): same `account_id` and changed content -> it adopts the
  file and skips its own refresh; different `account_id` -> permanent "signed in to another account"
  error. So a swap reaches **new** sessions only, and a panel that writes rotated tokens for the live
  account before Codex refreshes is adopted without a fight.
- **Usage.** `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access>`,
  `ChatGPT-Account-ID: <tokens.account_id>`, `User-Agent: codex_cli_rs/<ver> (...)`, `originator:
  codex_cli_rs`. Called live from Node: 200 in ~400 ms, no Cloudflare challenge, costs nothing.
  Body: `rate_limit.primary_window` / `secondary_window`, each `{used_percent, limit_window_seconds,
  reset_after_seconds, reset_at(unix s)}`; 18000 s = 5 h, 604800 s = weekly.
- **Identity** is offline: the `id_token` payload has `email` and
  `["https://api.openai.com/auth"].{chatgpt_account_id, chatgpt_plan_type, chatgpt_user_id}`.
- **Env overrides.** `CODEX_ACCESS_TOKEN` beats `auth.json` everywhere (TUI included).
  `CODEX_API_KEY` only in `codex exec` and some subcommands. `OPENAI_API_KEY` does not override.
- **Processes.** Native binary `codex.exe` (Windows) / `codex` (Unix), launched by a node shim; the
  Codex desktop app also runs a `codex.exe`. `codex-windows-sandbox-service.exe` is not a session.
- **Secrets format.** Access and id tokens are JWTs (`eyJ...`). The refresh token is not a JWT:
  `<2 lowercase>.<1 char>.<~206 [A-Za-z0-9_-]>`.

## Decisions

1. **Separate store.** `data/codex/accounts.json`, ids `cdx_<6 hex of sha256(account_id)>`. Nothing
   in the Claude code path (`store.list()`, keep-alive, `/api/usage/all`, auto-rotation) ever sees a
   Codex account, so no OpenAI token can be sent to Anthropic or the reverse. Identity key is
   `tokens.account_id`, not the email: one email can own a personal and a team workspace.
2. **One environment per account.** A Codex account may be active in only one target at a time.
   Two `auth.json` files holding the same rotating refresh token kill each other on the first
   refresh. Swapping an account that is live elsewhere is refused (409) with that explanation.
3. **The panel never refreshes a token a running Codex may be about to refresh without handing the
   result back.** Before every swap, and in the keep-alive, the live pair in each target's
   `auth.json` is **adopted** into the store when its `account_id` matches a stored account (and the
   JWT claim agrees with `tokens.account_id`). If the panel must refresh a live account (usage read
   on an expired token that Codex has not refreshed), it writes the new pair back to that target's
   `auth.json` only if the file still holds the old refresh token; otherwise it adopts the file's.
4. **Idle accounts are kept alive by the panel** - it is their only holder. Keep-alive every 6 h:
   refresh any account that is not live anywhere and whose access token expires within 2 days.
   A permanent refresh failure marks the account `dead` (shown as "sign in again").
5. **Refuse, don't guess, on keyring storage.** If the target's `config.toml` sets
   `cli_auth_credentials_store` to anything but `file`, or `secrets/codex_auth.age` exists, swaps and
   imports there answer 409 explaining how to switch back to file storage.
6. **The live session is never lost.** If the target's `auth.json` holds an account the store does
   not know, the swap imports it first, so it appears in the list instead of surviving only in a
   backup.
7. **Quota source is `wham/usage`**, mapped to the panel's `NormalizedUsage` by
   `limit_window_seconds` (<= 6 h -> `session`, >= 6 days -> `weekly`; fall back to primary ->
   session, secondary -> weekly). No shared rate floor with Claude: its own 3 s gap between calls,
   4-minute cache, persisted last-good reading served as `stale` on 429/network errors, 10-minute
   backoff after a 429. 401/403 -> `{ok:false, needsRelogin:true}`.
8. **Adding accounts, same three ways as Claude.** (a) *import* the target's live session;
   (b) Shift+click *import* from another `CODEX_HOME` directory; (c) *add account* opens a visible
   terminal running `codex login` with `CODEX_HOME` pointed at the panel-owned staging directory
   `data/codex/login/`, and an inline "import the new login" step reads it, stores it and deletes
   the staging `auth.json`. The user's live session is untouched by (b) and (c). There is no Codex
   equivalent of `claude setup-token`, so no paste form. API-key `auth.json` files are rejected on
   import.
9. **Scrubbing.** `oauth.scrub` also redacts JWTs and OpenAI refresh tokens, since every error body
   passes through it. The "no source file hardcodes a token" test learns the JWT pattern; test
   fixtures build their JWTs at runtime.

## Units

New, under `lib/codex/` (each with a `require.main === module` self-check):

| File | Owns |
|---|---|
| `auth.js` | `codexHome()` (env at call time), `authPath(home)`, `readAuth(path)` (null if absent; retries a half-written file, throws on persistent garbage), `writeTokens(path, oauth)` (mutates only `auth_mode`, `tokens`, `last_refresh`; keeps every other key; creates the directory; atomic, 0600), `decodeJwt`, `identity(tokens)` -> `{accountId, email, plan, userId}`, `coherent(tokens)` (claim `chatgpt_account_id` === `tokens.account_id`), `toStored(tokens, lastRefresh)` -> `oauth` block, `refresh(refreshToken)`, `storeMode(home)` -> `'file'` or the offending mode, `CLIENT_ID`, `TOKEN_URL` |
| `targets.js` | host target `{id:'host', kind:'host', label, home, authPath}`; WSL distros whose `~/.codex` directory is reachable over the share (reuses exported `targets.listDistros/runWsl/wslPath/uncBaseCandidates`), 30 s cache, `list({force})`, `resolve(id)` (null if unknown), `detectRunning(target)` -> `{running, pids, unknown?}` (`codex.exe` via tasklist on Windows, `pgrep -x codex` elsewhere and inside WSL, `unknown` in a container) |
| `store.js` | `data/codex/accounts.json` (path computed per call from `P.dataDir()`), `{version:1, active:{}, accounts:[]}`; account `{id, label, color, email, plan, accountId, oauth:{accessToken, refreshToken, idToken, accountId, expiresAt, lastRefresh}, dead, addedAt, updatedAt, lastSwappedAt}`; `list/get/add(upsert by accountId, keeps label unless given)/update/remove/setActive/activeFor/publicView/publicAccount`; `publicView` has exactly the Claude row shape (`id,label,email,color,plan,org:null,addedAt,lastSwappedAt,isActive,tokenExpired(=!!dead),canReadUsage:true,renewable:true,expiresAt`) and never a token |
| `usage.js` | `fetchRaw(account)`, `normalize(raw, id)`, `fetchFor(account, {force})`, `fetchAll(accounts, {force})` (sequential), `cachedFor(id)`, `prime`, `invalidate`; cache `data/codex/usage-cache.json` |
| `swap.js` | `adoptLive(target)`, `ensureFresh(account)`, `swapTo(id, targetId, deps)` (own lock), `importFrom({target, configDir, staging})`, `detectActiveId(targetId)`, `keepAliveTick()`, backups in `data/codex/backups/` (own pruning to 20) |
| `routes.js` | `handle(req, res, url, {send, fail, readBody})` for every `/api/codex/*` route; returns `false` when the path is not its own |

Edited: `server.js` (one dispatch line before the Claude routes, a Codex keep-alive interval, and the
Codex login-terminal guard), `lib/oauth.js` (`scrub`), `lib/usage.js` (export `meter`, `num`),
`lib/targets.js` (export `runWsl`, `wslPath`, `uncBaseCandidates`), `lib/terminal.js`
(`openCodexLogin(dir)`, `codexInstalled()`), `public/{index.html,app.js,style.css}`, `test.js`,
`README.md`, `ARCHITECTURE.md`, `package.json` (1.2.0).

## HTTP API (`/api/codex/*`, same guards as the rest of `/api/`)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/codex/health` | `{ok, installed, running, pids, unknown, overridingEnv:[...], softEnv:[...], storeMode, container, paths:{home, auth}}` |
| GET | `/api/codex/targets?force=1` | `{targets:[{id, kind, label, activeId, running, storeMode}]}` |
| GET | `/api/codex/accounts?target=` | same shape as `/api/accounts` |
| GET | `/api/codex/usage/all?force=1` | `{ "<id>": NormalizedUsage }` |
| GET | `/api/codex/usage?id=&force=1` | `NormalizedUsage` |
| POST | `/api/codex/swap` | `{id, target?}` -> `{ok, verified, target, targetLabel, warnings[], backup, account}`; 400 unknown target, 404 unknown account, 409 in flight / live elsewhere / keyring |
| POST | `/api/codex/accounts/import` | `{target?, configDir?, staging?}` -> `{ok, account}` |
| POST | `/api/codex/login/terminal` | `{}` -> `{ok, how, dir}`; 409 in a container or without the CLI |
| PATCH | `/api/codex/accounts/:id` | `{label?, color?}` -> `{ok, account}` |
| DELETE | `/api/codex/accounts/:id` | `{ok}` |

## Swap, in order

1. Lock (a second call while one is in flight -> 409).
2. Resolve the target (400); refuse keyring storage (409); load the account (404).
3. Refuse if the account is active in another target (store `active` map, or that target's live
   `auth.json` carries its `account_id`) (409).
4. Warn if Codex is running there: open sessions keep the old account; the swap reaches new ones.
5. `adoptLive(target)`: store the live pair of the outgoing account; import an unknown live account.
6. Back up the target's `auth.json` (absent -> recorded as absent) to `data/codex/backups/<stamp>-<id>/`.
7. `ensureFresh(account)`: refresh if the access token expires within 5 minutes.
8. `writeTokens(target.authPath, account.oauth)`.
9. Verify: re-read, `coherent()`, `account_id` matches; then `usage.fetchRaw` - 401/403 rolls back,
   429/network keeps the swap with a warning. Prime the usage cache with the reading.
10. `setActive(id, target.id)`.
Any failure after step 8 restores the backup (or deletes the file if there was none).

As built, step 7 runs before step 6, followed by a second `adoptLive`: when the incoming account
is already live in that target, the refresh rewrites the file, and a backup taken before it would
roll back to a refresh token that had just died. ARCHITECTURE.md documents the implemented order.

## Frontend

- Header: a `.switch#switch-provider` with **Claude** / **Codex**, `aria-pressed`, remembered in
  `localStorage['swapper.provider']`. Each provider remembers its own tab
  (`swapper.target` for Claude as today, `swapper.codex.target`).
- An `API` prefix (`/api` or `/api/codex`) for accounts, targets, usage, swap, import and health.
- `t(key)` tries `codex.<key>` first while the Codex view is on; only differing strings get a
  `codex.*` entry, in both languages.
- Codex view: the paste-token button and form are hidden; **add account** opens the login terminal
  and then shows an inline step "finish the login in the browser, then *import*" (`staging:true`).
  The env import button imports that environment's live session; Shift+click opens the directory
  field with the prefix `CODEX_HOME`. The empty state explains the three ways in. Banners:
  `CODEX_ACCESS_TOKEN` set (swaps are no-ops), keyring storage (swaps refused), not installed.
- Rows, meters, tabs, rename, remove, toasts and polling are the existing code paths, fed by the
  Codex endpoints. Switching provider re-renders and refetches; the background poll only asks for
  the visible provider.

## Error handling

Every Codex error message is Spanish like the rest of the server, scrubbed, and says what to do.
Half-written `auth.json`: retried three times 50 ms apart, then reported, never treated as "no
session". A token refresh that fails permanently marks the account `dead` and never retries it in
the keep-alive; importing it again clears the mark.

## Testing

`node test.js` gains: each `lib/codex/*` self-check; scrub redacts JWTs and refresh tokens; a swap
in a temporary `CODEX_HOME` keeps unrelated `auth.json` keys and sets `last_refresh`; rollback on a
401 verify; adopting rotated live tokens; refusing an account live in another target; refusing
keyring storage; importing from the staging directory deletes it; `publicView` carries no `eyJ`;
usage maps windows by length; Codex backups never prune `data/backups/`; `/api/codex/*` requires
`X-Swapper`. All network is stubbed; JWT fixtures are built at runtime.
