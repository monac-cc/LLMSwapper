# LLMSwapper - internals

Notes on how Claude Code and Codex CLI store their sessions, and what LLMSwapper does with them.
Codex has [its own section](#codex) at the end.
Everything here was verified empirically against a live installation, not inferred.

Zero dependencies. Node >= 18 (global `fetch`). No build step.

---

## Where the session lives

| Piece | Location |
|---|---|
| Tokens | Windows/Linux: `~/.claude/.credentials.json` · macOS: login Keychain, item `Claude Code-credentials` (suffixed `-<sha256(CLAUDE_CONFIG_DIR)[:8]>` when that variable is set), account `claude-code-user` - read out of the 2.1.273 bundle and verified on a Mac against a live login; older builds filed it under the login user, which is tried as a fallback |
| Identity | `~/.claude.json` -> `oauthAccount` |

`lib/credentials.js` is the only module that knows which backend applies.

`.credentials.json` shape:

    { "mcpOAuth": { ... },
      "claudeAiOauth": {
        "accessToken": "...", "refreshToken": "...",
        "expiresAt": 0, "refreshTokenExpiresAt": 0,
        "scopes": [], "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x" } }

`~/.claude.json` is large (~130 KB) and holds dozens of unrelated keys - `projects`,
`mcpServers`, plugin state, onboarding flags. Only `oauthAccount` is ours to touch:

    "oauthAccount": { accountUuid, emailAddress, organizationUuid, hasExtraUsageEnabled,
      billingType, accountCreatedAt, subscriptionCreatedAt, ccOnboardingFlags,
      claudeCodeTrialEndsAt, claudeCodeTrialDurationDays, seatTier, displayName, fullName,
      profileFetchedAt, organizationRole, workspaceRole, organizationName, organizationType,
      organizationRateLimitTier, userRateLimitTier }

**`userID` is deliberately never written.** It does not derive from `accountUuid` - five hash
hypotheses were tested and none matched - so it is an install/telemetry identifier, not an
account one. Leaving it alone removes a whole class of risk.

`~/.claude.json` can go **stale** relative to the tokens: switching accounts by hand updates
the credentials but not `oauthAccount`. So the profile endpoint, not the local file, is the
source of truth for who a token belongs to.

---

## Anthropic endpoints used

All with these headers:

    Authorization: Bearer <accessToken>
    anthropic-beta: oauth-2025-04-20
    User-Agent: claude-cli/2.0.0 (external, cli)

| Purpose | Endpoint |
|---|---|
| Usage | `GET https://api.anthropic.com/api/oauth/usage` |
| Profile | `GET https://api.anthropic.com/api/oauth/profile` |
| Token refresh | `POST https://api.anthropic.com/v1/oauth/token` |

OAuth client id: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`

Scopes: `user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload`

> The token host matters. `https://console.anthropic.com/v1/oauth/token` answers **404
> not_found**; `api.anthropic.com` answers **400 invalid_grant** for a bad refresh token, i.e.
> it actually processed the request. Probed with a deliberately invalid token to avoid
> rotating a real one.

> There is no in-app OAuth login. The client only accepts its own registered redirect URIs -
> a loopback `http://127.0.0.1:PORT/callback` is rejected with *"Redirect URI ... is not
> supported by client"*. Importing an existing session is simpler and always works.

### Usage response

`limits[]` is the source of truth; the top-level keys are legacy mirrors kept as a fallback.

    {"five_hour":{"utilization":90.0,"resets_at":"...","locked_reason":null},
     "seven_day":{"utilization":28.0,"resets_at":"..."},
     "seven_day_opus":null,
     "extra_usage":{"is_enabled":false},
     "limits":[
       {"kind":"session","group":"session","percent":90,"severity":"critical",
        "resets_at":"...","scope":null,"is_active":true},
       {"kind":"weekly_all","group":"weekly","percent":28,"resets_at":"...","scope":null},
       {"kind":"weekly_scoped","group":"weekly","percent":18,
        "scope":{"model":{"id":null,"display_name":"Fable"}}}]}

Severity is recomputed locally from the percentage rather than trusting the server string, so
the API and the CSS always agree: `<50` normal, `50-79` medium, `80-94` high, `>=95` critical.

### Rate limiting

The usage endpoint has a low sustained quota: measured against the live API, the **fifth**
request in quick succession answers 429 with `Retry-After: 300`, escalating toward ~3600s if
you keep hitting it. That is a budget of about five requests per five minutes for the whole
app, however many accounts are configured.

Tuning the poll frequency cannot hold that, because a sweep of N accounts costs N requests. So
the primary mechanism is a **hard floor of 80 s between any two outbound calls** (`MIN_GAP_MS`,
`lib/usage.js`), which nothing bypasses - not the refresh button, not a second browser tab.
The number that matters is not the average rate but how many calls fit in the endpoint's 300 s
window: with a gap of `g` that is `floor(300/g) + 1`, so `g` must satisfy `4g >= 300`. At 70 s
it was exactly five, i.e. the app rate-limited itself.

Everything else sits around that floor: a 4-minute cache, 5-minute polling, and a backoff
that starts at 10 minutes and **doubles with each consecutive 429**, capped at an hour. The
cooldown and the offence counter are persisted alongside the cache, because a restart that
forgot them walked straight back into the block and reset the escalation.

Bookkeeping lives in `fetchRaw`, not `fetchFor`: the swap verifies a new token by calling
`fetchRaw` directly, and an uncounted call is exactly the amplification that trips the limit.
`fetchRaw` still never blocks - verifying a token has to work mid-cooldown - it just is not free.

When the API cannot be reached, the last known-good reading is served as `stale` rather than
blanking the UI. A 401/403 is surfaced as a real error, since the token is dead.

Turn order is "least recently **attempted** first", not least recently succeeded: ranking by
success alone let a single account with a dead token sit at zero and win every sweep for ever,
so the healthy accounts never got a reading at all.

### Pasted long-lived tokens (`claude setup-token`)

`claude setup-token` mints a token that lasts a year, and the panel accepts one by paste. Two
properties of it drive most of the code around it, both read out of `claude.exe` v2.1.258 and
confirmed against a live CLI:

**It carries only `user:inference`.** The authorize URL is built as
`inferenceOnly ? ["user:inference"] : <the five interactive-login scopes>`. So the token can run
inference and nothing else: `/api/oauth/profile` and `/api/oauth/usage` both answer it **403**,
permanently. That has three consequences. There is no email and no `accountUuid`, so
`store.idForToken` derives the account id from a hash of the token itself - pasting the same
token twice updates in place instead of creating a second row. Usage cannot come from the usage
endpoint, so `store.canReadUsage` routes these accounts to the header probe below instead: a 403
is not a 429, nothing would absorb it, and the request would repeat every sweep and starve the
accounts that can answer. And there is no profile to write, so the swap writes an `oauthAccount` built from the
account's label (`swap.identityFromLabel`) rather than leaving the previous account's - Claude Code
only reconciles that block against the token when the token carries `user:profile`, so a stale one
just sits there naming the account you swapped away from, and an empty one leaves `/status` blank.

**It has no refresh token, and that is fine.** Claude Code's refresh routine returns early with
`"not_needed"` when `expiresAt` is more than 5 minutes out and `"no_refresh_token"` otherwise -
plain returns, never a throw - and the API client is then built with the access token anyway.
Verified live: a credentials blob of `accessToken` + `expiresAt` + `scopes:["user:inference"]`
runs a request and exits 0. Two shapes are NOT fine, and `swap.writeCredentials` guards both:
`refreshToken: ""` is Claude Code's sentinel for "this token is dead, I already cleared it", so
it writes `null`; and an empty or missing `scopes` array makes it print
`Not logged in - Please run /login` and exit 1, so the array is never allowed to be empty.

A pasted token is validated by `oauth.probeToken`, which asks `/api/oauth/profile` and reads the
status: **200** is a full-scope token (it gets a profile and working meters), **403 with a scope
complaint** is a genuine setup-token, and **401** is rejected. The 403 is a positive signal -
Anthropic only checks scopes on a token it has already authenticated - which makes this a free
validator. Proving the same thing with an inference call would cost money and still not say who
the token belongs to. It deliberately does not probe `/api/oauth/usage`: that endpoint's budget
is about five calls per five minutes for the whole app.

### Quota from the rate-limit headers

An inference-only token still has quota, and Anthropic reports it on every `/v1/messages`
response in the `anthropic-ratelimit-unified-*` headers, which do not care about scopes because
the call IS inference. Measured, endpoint by endpoint, before settling on that one:

    POST /v1/messages/count_tokens   200, no rate-limit headers
    GET  /v1/models                  200, no rate-limit headers
    POST /v1/messages                200, and the full set

The free ones say nothing, so something has to be spent. The floor is Haiku, `max_tokens: 1` and
a one-character prompt: **8 input tokens and 1 output token** per probe. That is not zero -
unlike the usage endpoint, which costs nothing at all - and it is the user's own subscription
being spent, so it is stated in the README rather than hidden. At one probe per account every
five minutes it is about 2,600 tokens a day against a window measured in hundreds of thousands.

`usage.readUnifiedHeaders` translates the header names (`5h`, `7d`) into the ones the rest of the
project speaks (`session`, `weekly`), turns a `utilization` fraction into a percentage and a
`reset` in epoch seconds into an ISO timestamp, and `normalizeProbe` emits the exact shape
`normalize` produces - so nothing downstream, the UI included, can tell the two sources apart
beyond the `viaProbe` flag.

The probe does NOT share `MIN_GAP_MS`. That floor exists for the usage endpoint's budget of about
five calls per five minutes; making probe accounts queue behind it would have the two kinds of
account fighting over four slots for no reason, since they are different endpoints with different
limits. It keeps its own 2-second gap so a sweep goes out as a trickle rather than a burst.

A 401 or 403 on a probe means the credential is **dead**, not exhausted. Those are different
things and only one of them is fixed by waiting - conflating them is what makes a panel bench a
perfectly good account for an hour and a half with its five-hour window at 0%.

### Token lifetimes (imported accounts)

Access ~8 h, refresh ~29 days, rotating on every use. A background keep-alive renews anything
with under a day of life left, every 6 hours. Because refreshing **invalidates the previous
refresh token**, renewing the account whose session is live also writes the new pair into the
live credentials - otherwise Claude Code would be left holding a dead token.

Rotation runs in both directions, and the inbound one is what actually bites: **Claude Code
renews its own session**, so the live pair moves on and the store's copy is left holding a token
Anthropic has already killed. Nothing surfaces that until the keep-alive tries it, by which
point the account needs a real login - the one thing this app exists to avoid.

So before renewing anything, `swap.adoptLiveTokens` checks whether the live refresh token still
matches the active account's, and adopts the live pair when it does not. Tokens carry no
identity, so it only adopts when `oauthAccount` in `~/.claude.json` and our own `activeId` name
the same account: agreement means the identity never changed and only the pair moved. On any
disagreement it does nothing - writing one account's tokens into another's record is far worse
than asking for an import.

"Whose session is live" is decided by comparing the pre-refresh refresh token against the one
in the credentials, not by `activeId`. `activeId` cannot answer it: a swap writes the new
credentials and only calls `setActive()` at the very end, after a network round trip, so for
seconds at a time the two disagree by design - and a manual `claude /login` changes the live
session without telling the store at all. The write goes through the credentials **backend**,
so on macOS it lands in the Keychain rather than in a file Claude Code never reads.

---

## Running in a container

The image is Linux; the host may be anything. What crosses the container boundary and what does
not is the whole of the design here, and the app is expected to say which is which rather than
degrade quietly.

`paths.inContainer()` is the switch, and it reads two signals: `SWAPPER_IN_CONTAINER=1`, set by
our own Dockerfile, and `/.dockerenv` for an image someone built by hand. Podman and some
Kubernetes runtimes create neither, which is exactly why the env var exists.

Two things stop working, and both would otherwise **lie**:

- **Process detection.** `pgrep` inside a container sees the container's namespace, so it finds
  this server and nothing else. Returning `running: false` would tell the user Claude Code is
  closed while it runs on the host, so `detectClaudeProcesses` returns `unknown: true` instead
  and the UI says it cannot tell from in here.
- **WSL targets.** `wsl.exe` does not exist in a Linux container, so `targets.list()` returns
  the host alone. It already gates that on `process.platform === 'win32'`, so nothing was needed.

On macOS there is a third: credentials live in the login Keychain, reached through the `security`
binary, which a Linux container cannot call. `credentials.read()` falls back to the plain file,
so swapping works there only if the user has one.

`SWAPPER_BIND` splits the bind address from the browser-facing host. Inside a container the socket
has to listen on `0.0.0.0` to be reachable at all, so the loopback guarantee moves outward, to
publishing the port as `127.0.0.1:<port>:7373`. The server says so on start-up when the two
differ, because a bind widened by accident is not visible from the panel.

`/app/data` is created and chowned to `node` **before** the `VOLUME` declaration. Docker
copies the image path's ownership into a named volume the first time it is populated; without that
step the volume is root-owned, the process runs as `node`, and start-up dies with
`EACCES: permission denied, mkdir '/app/data/backups'`.

---

## Targets: host and WSL

A **target** is where a swap writes. `lib/targets.js` enumerates them:

- `host` - the machine the server runs on, through its credentials backend (Keychain on
  macOS, file elsewhere).
- `wsl:<distro>` - a WSL distro that has Claude installed, reached over its file share:
  `\\wsl.localhost\<distro>\home\<user>\.claude.json` and `…\.claude\.credentials.json`.
  WSL is Linux, so it is always the plain-file backend. Detection runs `wsl.exe -l -q --running` - the stopped distros are left alone, since the `wsl -d` that follows would boot them -,
  reads each distro's `$HOME`, and includes it only if `~/.claude.json` is reachable over
  the share - which simultaneously proves the distro is running and that Claude lives there.
  Detection is cached ~30s (it spawns several `wsl.exe` calls) and only happens on Windows.

The OAuth tokens are identical in every environment, so the **account store is shared**;
what differs per target is which account is *active* (`store.active` is a map keyed by
target id, migrated from the old single `activeId`) and which files a swap rewrites. A swap
is otherwise byte-for-byte the same operation - backup, in-place mutation, verify, roll
back - pointed at the target's two paths. `wsl.exe` is addressed absolutely from
`%SystemRoot%\System32` (falling back to `Sysnative`) because it is not always on the PATH
a spawned Node process sees.

A target's active account is read from the store; if we have never swapped there, it is
detected live from that environment's `oauthAccount.accountUuid`, so a freshly-opened WSL
shows its real current account as "in use" without a write. Windows-side writes over the
share cannot carry Linux `0600` bits - the files stay inside the WSL user's own home, which
is already user-scoped.

---

## Data store: `data/accounts.json`

    { "version": 1, "activeId": "acc_ab12cd", "accounts": [ {
      "id": "acc_ab12cd", "label": "...", "color": "#7c5cff", "email": "you@example.com",
      "oauth": { ...the claudeAiOauth shape... },
      "profile": { ...the oauthAccount block... },
      "userID": null, "addedAt": 0, "lastSwappedAt": null } ] }

Ids derive from `accountUuid`, so re-importing an account updates it instead of duplicating.
Mode 0600, plus an NTFS ACL on Windows where chmod is a no-op. `store.publicView()` is the
only shape allowed to reach the browser; it strips `oauth` and `userID`.

---

## HTTP API - 127.0.0.1 only

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ok, claudeRunning, pids, node, platform, credentialsBackend, overridingEnv, paths, container, unavailable, build, staleMount}` |
| GET | `/api/targets` | `{targets:[{id, kind, label, activeId, running}]}` - host + each WSL distro |
| GET | `/api/accounts?target=` | `{activeId, accounts:[...]}` for that target - token fields stripped |
| GET | `/api/usage/all` | `{ "<id>": NormalizedUsage }`, sequential, failures isolated |
| GET | `/api/usage?id=` | `NormalizedUsage` |
| POST | `/api/swap` | `{id, target?}` -> `{ok, verified, target, warnings[], backup, account}` - 400 for a target that does not resolve, 409 while another swap is in flight |
| POST | `/api/swap/dryrun` | `{id, target?}` -> what would change, writes nothing |
| POST | `/api/accounts/import` | `{configDir?, target?}` -> `{ok, account}` |
| POST | `/api/accounts/token` | `{token, label?}` -> `{ok, kind, warnings[], account}` - paste a long-lived token |
| POST | `/api/token/terminal` | `{}` -> `{ok, how}` - opens a terminal running `claude setup-token`; 409 in a container or without the CLI |
| PATCH | `/api/accounts/:id` | `{label?, color?}` |
| DELETE | `/api/accounts/:id` | `{ok}` |
| GET | `/api/auto` | `{enabled, target, threshold, current, next, queue[]}` - cached readings only, spends nothing |
| POST | `/api/auto` | `{enabled?, target?, threshold?}` -> the same status |

`target` defaults to `host`. Usage is target-independent (the token is the same in any
environment), so `/api/usage*` take no target.

## Automatic rotation

`lib/auto.js` is an on/off monitor, off by default, its state persisted to `data/auto.json`.
When on, a 3-minute interval reads the active account's usage — cache-gated, so a real API call
only every ~4 min — and does nothing until the 5-hour session crosses the threshold (default
90%). Only then does it sweep the other accounts to rank them, and swap to the freshest one that
has room in **both** windows below the threshold; if none qualifies it stays put. A cooldown
(5 min) after any rotation stops it swapping twice while readings lag. A rotation that fails arms the same cooldown, and an account whose last reading was a 401/403 is excluded from the queue as `token rechazado`, so a dead credential is never retried every tick. Swaps are serialised: a second `swapTo` while one is in flight - a manual one overlapping the monitor - is refused with 409 rather than interleaved. The swap is the ordinary
`swap.swapTo` path — backup, verify, roll back — so "when" is the only thing this module decides;
"how" is unchanged. The three `/swapper*` skills (`skills/`) are thin clients of these endpoints.

`overridingEnv` lists any of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
`CLAUDE_CODE_OAUTH_TOKEN` that are set. Each of them outranks the credentials file this app
writes - verified by pointing Claude Code at a logging proxy and reading the headers it sent -
so while one is set every swap is a silent no-op: the panel reports success, the file changes,
and the CLI keeps using the variable. It is reported because that failure is otherwise invisible
from inside the app.

NormalizedUsage:

    { id, ok:true, fetchedAt, session:{percent,resetsAt,severity},
      weekly:{...}, scoped:[{label,percent,resetsAt}], opus, extraUsage, locked,
      stale?, staleSince?, staleReason? }
    // failure: { id, ok:false, error, status, needsRelogin }
    // from the header probe: the same shape plus viaProbe:true, scoped:[] and opus/extraUsage null
    //   - see "Quota from the rate-limit headers"

Guards: loopback bind (`SWAPPER_BIND` widens it, and `SWAPPER_ALLOWED_HOSTS` then names the extra hostnames the `Host` check lets in), `Host` validated, cross-site `Origin` rejected, `X-Swapper: 1` required
on **every `/api/` request, GET included**, static serving confined to `public/`. Anything
matching `sk-ant-[A-Za-z0-9_-]+` is scrubbed before it can reach a log or a response body.

The `Host` check validates the **hostname only** - `127.0.0.1`, `localhost`, `[::1]` - and
deliberately ignores the port. A container listens on 7373 and is published as whatever the user
chose, so the browser sends the *published* port, which this process cannot know; pinning it
rejected every containerised request with "Host no permitido". Nothing is lost by dropping it,
because the port never defended anything. The attack this guards against is DNS rebinding: a page
on `evil.com` whose domain resolves to 127.0.0.1, so the browser genuinely connects to this
socket. What gives it away is that the `Host` header then reads `evil.com`, since the browser
fills it from the URL the page used. An ordinary cross-origin fetch is stopped twice over, by the
`Origin` check and by a custom header a cross-site request cannot set without a preflight.

GET is not exempt because read-only is not the same as harmless: `/api/health` spawns a process
per call and `/api/usage` spends the app's whole request budget for the window, and neither an
`<img>` nor a cross-site form can set a custom header. Static assets stay exempt - the browser
loads `/style.css` with no say in its headers.

The port is fixed. `EADDRINUSE` reports the running instance and exits rather than hopping to
the next free port: the rate floor is per process, so a second instance would double the
outbound rate and rate-limit both.

---

## The swap

1. Detect running Claude processes - warn, never block.
2. Back up credentials and `~/.claude.json` to `data/backups/<ts>/`. Backup failure aborts.
3. Refresh the token if it expires within 5 minutes.
4. Replace **only** `claudeAiOauth`; `mcpOAuth` and everything else survives.
5. Set **only** `oauthAccount` and drop the previous account's caches, so Claude Code refetches
   them: `overageCreditGrantCache, modelAccessCache, orgModelDefaultCache,
   passesEligibilityCache, cachedExtraUsageDisabledReason, hasAvailableSubscription,
   clientDataCacheSlots, additionalModelOptionsCache, additionalModelCostsCache,
   passesLastSeenRemaining`. Every other key keeps its value.
6. Verify with a **direct** API call - never a cached reading, which would "verify" a token it
   never used. 401/403 rolls back; a 429 or network failure keeps the swap and warns that it
   could not be confirmed.
7. Mark the account active.

Both mutations parse, mutate in place and re-serialise - never rebuild from a whitelist, which
would silently drop unrelated keys. A key-count check catches that anyway. Any failure past
step 4 restores both files from the step-2 backup.

Atomic write = tmp file in the same directory, `fsync`, `rename` over the target, with retries
because Windows antivirus can briefly lock a file mid-rename. Reads tolerate a UTF-8 BOM and
refuse to overwrite a file that does not parse.

---

## Codex

Everything under `lib/codex/`, mounted by one dispatch line at the top of `handleApi` and a
second keep-alive interval in `server.js`. Facts measured against Codex CLI 0.157.1 (Windows and WSL
Ubuntu) and read from the `openai/codex` source at that tag.

| File | Owns |
|---|---|
| `auth.js` | `auth.json` I/O, JWT identity, token refresh, storage-mode check |
| `targets.js` | host + WSL targets, Codex process detection |
| `store.js` | `data/codex/accounts.json`, `publicView` |
| `usage.js` | `wham/usage` reads, cache, backoff |
| `swap.js` | adoption, refresh, swap, import, keep-alive, backups |
| `routes.js` | every `/api/codex/*` route |

### Storage and keyring

`$CODEX_HOME/auth.json`, `CODEX_HOME` defaulting to `~/.codex` (read at call time, never at
`require`):

    { "auth_mode": "chatgpt", "OPENAI_API_KEY": null,
      "tokens": { "id_token": "...", "access_token": "...", "refresh_token": "...", "account_id": "..." },
      "last_refresh": "<RFC3339>" }

plus whatever keys newer versions add. `last_refresh` is mandatory - without it Codex says "Token
data is not available". `auth.writeTokens` sets only `auth_mode`, `tokens` and `last_refresh` and
keeps every other key; the write is atomic and 0600, and creates the directory for a fresh install.

Codex itself writes the file with truncate+write, not a rename, so a reader can land on half of it.
`readAuth` retries a parse failure three times, 50 ms apart, then **throws** - it never reports "no
session", because a caller that believed that would write over the user's login.

`cli_auth_credentials_store = file|keyring|auto|ephemeral` in `config.toml`, default `file`. With
anything else the session is not in `auth.json` (on Windows it is `secrets/codex_auth.age`), so a
swap would be a no-op. `auth.storeMode` returns the offending mode, or `keyring` when that file
exists, and swap and import answer **409** with the fix rather than guessing.

The access and id tokens are JWTs; the refresh token is not (`<2 lowercase>.<1 char>.<~206
url-safe chars>`). `oauth.scrub` redacts both shapes as well as `sk-ant-*`, and the source scan in
`test.js` also fails on a JWT literal - every fixture is built at runtime.

### Refresh and rotation

`POST https://auth.openai.com/oauth/token`, JSON `{client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
grant_type: "refresh_token", refresh_token}`. The response carries a new id, access and refresh
token, and no `account_id` - the caller keeps its own. Access tokens last 240 h; Codex refreshes
within 5 minutes of `exp`, or on a 401.

**The refresh token rotates, and reusing the old one fails for good** (`refresh_token_reused`, also
`_expired` and `_invalidated`). Every rule below follows from that:

- One refresh per account at a time (`refreshAccount` shares the promise in flight): two usage
  reads spending the same token would kill the account.
- The new pair is stored **before** anything else, then written into every target whose `auth.json`
  still holds the old refresh token; a file that moved on meanwhile is adopted instead.
- A live account whose access token has not reached `exp` is left to the Codex holding it, which
  refreshes at the same 5-minute margin: racing it would spend one refresh token twice. The panel
  refreshes a live account only once its token is past `exp`, i.e. when that Codex is not doing it.
- A permanent failure (401, or one of those grant errors) first re-adopts from the live files - a
  Codex may have rotated it between our adoption and our call - and only then marks the account
  `dead`. The row shows "sign in again"; the keep-alive never retries it; importing it again clears
  the mark.
- An account live in a target that cannot be reached right now (a stopped WSL distro, recorded in
  the store's `active` map) is not refreshed: its copy there would die with our refresh.

### Guarded reload

**A running Codex does not watch `auth.json`.** It re-reads it only in a guarded reload right
before refreshing (and on 401, login and logout): same `account_id` with changed content, and it
adopts the file and skips its own refresh; a different `account_id`, and it stops with a permanent
"signed in to another account" error. Two consequences:

- A swap reaches **new** sessions only. An open one keeps its account, and will fail at its next
  refresh if the account changed under it - so the swap warns when Codex is running there.
- A panel that writes a rotated pair for the live account into the file before Codex refreshes is
  adopted without a fight. That is what makes the write-back above safe.

Inbound rotation is handled by `adoptLive(target)`: when the file's `account_id` matches a stored
account and the JWT claim agrees (`auth.coherent`), its pair replaces the store's - unless it is
older (smaller access `exp`) than a pair the store knows to be alive, in which case the file is
caught up instead. An account the store does not know is imported, so a swap never leaves the
user's session surviving only in a backup. `adoptLive` also records what the file shows in the
store's `active` map (`store.setLive`), without counting it as a swap.

### Usage

`GET https://chatgpt.com/backend-api/wham/usage`, with `Authorization: Bearer <access>`,
`ChatGPT-Account-ID: <account_id>`, `User-Agent: codex_cli_rs/0.157.1 (LLMSwapper)`, `originator:
codex_cli_rs`. Measured from Node: 200 in ~400 ms, no Cloudflare challenge, costs nothing.

    {"plan_type":"plus","rate_limit":{"allowed":true,"limit_reached":false,
      "primary_window":  {"used_percent":12,"limit_window_seconds":18000,"reset_after_seconds":...,"reset_at":<unix s>},
      "secondary_window":{"used_percent":2,"limit_window_seconds":604800,...}}}

`normalize` tells the windows apart by length, not slot: `<= 6 h` is `session`, `>= 6 days` is
`weekly`, and only a window that says neither falls back to position (primary session, secondary
weekly). A window the response lacks is `null` (shown as `-`), never 0%, which would also rank the
account as the freest. `limit_reached` becomes `locked`. The output is the same `NormalizedUsage`
the Claude meters render, with `scoped: []` and `opus`/`extraUsage` null.

It shares nothing with the Claude rate floor - different endpoint, different limits. Its own rules:
a 3 s gap between outbound calls (a queue, not a rejection), a 4-minute cache, last good readings
persisted to `data/codex/usage-cache.json` and served as `stale` on a 429 or a network error, a
10-minute backoff after a 429 (persisted too), and 401/403 -> `{ok:false, needsRelogin:true}`.
chatgpt.com sits behind Cloudflare, whose bot challenge is also a 403 - an HTML page, or a
`cf-mitigated` header - about the client rather than the token. That one is read as a network
failure (last reading served stale), never as "sign in again".
`fetchFor` runs `ensureFresh` first (injected by `swap.js` to avoid a require cycle), so a token
past its `exp` is refreshed or adopted before it is sent here to fail; a `dead` account goes
through it even with a cached reading, so the row says "sign in again" instead of looking healthy.

### Identity

Offline, from the id token: `email`, and under `https://api.openai.com/auth` the
`chatgpt_account_id`, `chatgpt_plan_type` and `chatgpt_user_id` (the access token's claims are the
fallback). The store keys on `tokens.account_id`, not the email - one email can own a personal and
a team workspace, two accounts with two quotas. Ids are `cdx_<first 6 hex of sha256(account_id)>`.
Nothing is adopted or imported unless the JWT claim agrees with `tokens.account_id`: filing one
workspace's pair under another is worse than asking for a fresh login.

### Processes and environments

`codex.exe` on Windows (`tasklist`), `codex` elsewhere (`pgrep -x`) and inside WSL (`pgrep` through
`wsl.exe -d`). The CLI is a native binary behind a node shim, and the Codex desktop app runs a
`codex.exe` too - it counts as an open session. `codex-windows-sandbox-service.exe` is not one, and
the exact image name leaves it out. In a container the answer is `unknown`, as for Claude.

WSL targets reuse `lib/targets.js` (`listDistros`, `runWsl`, `wslPath`, `uncBaseCandidates`): a
running, non-system distro whose `~/.codex` directory is reachable over the share. Cached 30 s.

### Environment overrides

`CODEX_ACCESS_TOKEN` beats `auth.json` everywhere, the TUI included - `overridingEnv` in
`/api/codex/health`, a banner, a swap warning and a start-up line. `CODEX_API_KEY` only reaches
`codex exec` and a few subcommands - `softEnv`, reported, not alarmed. `OPENAI_API_KEY` does not
override a ChatGPT login.

### The swap

1. Lock: a second swap while one runs is refused (409), not queued. One lock for every target.
2. Resolve the target (400); refuse keyring storage (409); load the account (404).
3. Refuse (409) if the account is live in another target - that target's `auth.json` holds its
   `account_id`, or the store's `active` map says so where the file cannot be read now.
4. Warn if Codex runs there, and if `CODEX_ACCESS_TOKEN` is set (host only).
5. `adoptLive(target)`: keep the outgoing account's newest pair; import an unknown one.
6. `ensureFresh(account)`: refresh if the access token expires within 5 minutes (a refused refresh
   token is 409, any other refresh failure 502).
7. `adoptLive` again - an open Codex may have rotated the outgoing pair during that await.
8. Back up `auth.json` byte for byte, or an `absent` marker, to
   `data/codex/backups/<stamp>-<seq>-<id>/` with a `target.json`. Pruned to 20, in that directory
   only; `data/backups/` is never touched. From step 7 to the write it is synchronous.
9. `writeTokens(target.authPath, account.oauth)`.
10. Verify: re-read, same `account_id` and refresh token, `coherent`; then a direct `usage.fetchRaw`.
    401/403 rolls back; a 429, a network error or a Cloudflare challenge keeps the swap with a warning. A good reading
    primes the usage cache.
11. `setActive(id, target)`.

Any failure after the backup restores it through a rename - or deletes the file when the marker
says there was none, so a failed first swap into a fresh WSL leaves no half-configured login - and
then adopts once more, in case the restored pair was refreshed meanwhile.

**The refresh comes before the backup**, unlike the Claude swap: when the account is already live
in that target, the refresh writes its new pair into the file, and a backup taken earlier would
roll the file back to a refresh token that just died.

### One environment per account

Two `auth.json` files holding the same rotating refresh token kill each other on the first refresh:
whichever refreshes second presents a dead token. So a Codex account may be active in one target at
a time, and the swap refuses the second with that explanation. Claude has no such rule: there the
panel adopts the live pair back on every renewal, while here two independent Codex processes would
each refresh on their own schedule.

The Shift+click import from another `CODEX_HOME` is the one way around the rule, since nothing
tracks that directory afterwards; the route returns a warning saying so.

### Adding accounts

- **Live session** - `importFrom({target})`: that target's `auth.json`, which also marks it active there.
- **Another directory** - `importFrom({configDir})`.
- **Login terminal** - `POST /api/codex/login/terminal` creates `data/codex/login/` and opens a
  visible terminal running the constant `codex login` with `CODEX_HOME` pointed at it. On Windows
  the directory travels in the environment of `cmd.exe /c start`, never on a command line, and
  Windows Terminal is not used: a tab opened in an existing `wt` window gets that window's
  environment, and the login would land in the real `~/.codex`. On macOS and Linux it is
  single-quoted into the shell line. `importFrom({staging:true})` then stores it and deletes the
  staging `auth.json` - the store is its only holder.

The browser login answers on `localhost:1455`. Windows can hold that port inside an excluded range
(Hyper-V, WSL and Docker reserve blocks of the dynamic range, and a dynamic range that starts at 1024
puts those blocks on low ports), and `codex login` then dies with `os error 10013`. The login route
binds 127.0.0.1:1455 first; if it cannot, it opens `codex login --device-auth`, which needs no port.

API-key files, incomplete token sets and incoherent claims are refused. An older copy of a login
does not replace a newer pair the store still trusts, unless that one is `dead`.

### Keep-alive

Every 6 h and once at start, next to the Claude one: `adoptLive` on every target (known accounts
only - a session the user never imported, or one they deleted, is theirs to import), then refresh
every account that is not `dead`, not live anywhere and whose access token expires within 2 days.
The panel is those accounts' only holder; the live ones are Codex's to refresh, and their result is
adopted.

### Data store: `data/codex/accounts.json`

    { "version": 1, "active": { "host": "cdx_ab12cd" }, "accounts": [ {
      "id": "cdx_ab12cd", "label": "...", "color": "#7c5cff", "email": "...", "plan": "plus",
      "accountId": "...", "oauth": { accessToken, refreshToken, idToken, accountId, expiresAt, lastRefresh },
      "dead": null, "addedAt": 0, "updatedAt": 0, "lastSwappedAt": null } ] }

A separate file from `data/accounts.json`, so `store.list()`, the Claude keep-alive,
`/api/usage/all` and auto-rotation can never see a Codex account. `publicView` returns exactly the
Claude row shape (`org: null`, `tokenExpired` = `dead`, `canReadUsage` and `renewable` true) and
never a token.

### HTTP API - `/api/codex/*`

Same guards as the rest of `/api/`. An unknown path under the prefix answers 404.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/codex/health` | `{ok, installed, running, pids, unknown, overridingEnv, softEnv, storeMode, container, paths:{home, auth}}` - host only |
| GET | `/api/codex/targets?force=1` | `{targets:[{id, kind, label, activeId, running, storeMode}]}` |
| GET | `/api/codex/accounts?target=` | `{activeId, accounts:[...]}`, the `/api/accounts` shape; `activeId` read from that target's `auth.json` |
| GET | `/api/codex/usage/all?force=1` | `{ "<id>": NormalizedUsage }`, sequential |
| GET | `/api/codex/usage?id=&force=1` | `NormalizedUsage` |
| POST | `/api/codex/swap` | `{id, target?}` -> `{ok, verified, target, targetLabel, warnings[], backup, account}` - 400 unknown target, 404 unknown account, 409 in flight / live elsewhere / keyring / refresh token refused, 502 other refresh failure |
| POST | `/api/codex/accounts/import` | `{target?, configDir?, staging?}` -> `{ok, account, warnings[]}` |
| POST | `/api/codex/login/terminal` | `{}` -> `{ok, how, dir}` - 409 in a container or without the CLI |
| PATCH | `/api/codex/accounts/:id` | `{label?, color?}` -> `{ok, account}` |
| DELETE | `/api/codex/accounts/:id` | `{ok}` |

`:id` matches `cdx_[a-f0-9]{6}`; a Claude id under this prefix is a 404.
