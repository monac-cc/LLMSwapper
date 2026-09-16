# LLMSwapper - internals

Notes on how Claude Code stores its session, and what LLMSwapper does with it.
Everything here was verified empirically against a live installation, not inferred.

Zero dependencies. Node >= 18 (global `fetch`). No build step.

---

## Where the session lives

| Piece | Location |
|---|---|
| Tokens | Windows/Linux: `~/.claude/.credentials.json` · macOS: login Keychain, item `Claude Code-credentials` (suffixed `-<sha256(CLAUDE_CONFIG_DIR)[:8]>` when that variable is set), account `claude-code-user` - read out of the 2.1.273 bundle; older builds filed it under the login user, which is tried as a fallback |
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

Everything else sits around that floor: a 15-minute cache, 10-minute polling, and a backoff
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
accounts that can answer. And there is no profile to write, so the swap **deletes** `oauthAccount` from
`~/.claude.json` rather than leaving the previous account's - Claude Code only reconciles that
block against the token when the token carries `user:profile`, so a stale one just sits there
naming the account you swapped away from.

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
| GET | `/api/health` | `{ok, claudeRunning, pids, node, platform, credentialsBackend, overridingEnv, paths}` |
| GET | `/api/targets` | `{targets:[{id, kind, label, activeId, running}]}` - host + each WSL distro |
| GET | `/api/accounts?target=` | `{activeId, accounts:[...]}` for that target - token fields stripped |
| GET | `/api/usage/all` | `{ "<id>": NormalizedUsage }`, sequential, failures isolated |
| GET | `/api/usage?id=` | `NormalizedUsage` |
| POST | `/api/swap` | `{id, target?}` -> `{ok, verified, target, warnings[], backup, account}` |
| POST | `/api/swap/dryrun` | `{id, target?}` -> what would change, writes nothing |
| POST | `/api/accounts/import` | `{configDir?, target?}` -> `{ok, account}` |
| POST | `/api/accounts/token` | `{token, label?}` -> `{ok, kind, warnings[], account}` - paste a long-lived token |
| POST | `/api/token/terminal` | `{}` -> `{ok, how}` - opens a terminal running `claude setup-token`; 409 in a container or without the CLI |
| PATCH | `/api/accounts/:id` | `{label?, color?}` |
| DELETE | `/api/accounts/:id` | `{ok}` |
| GET | `/api/auto` | `{enabled, target, threshold, current, next}` - cached readings only, spends nothing |
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

Guards: loopback bind, `Host` validated, cross-site `Origin` rejected, `X-Swapper: 1` required
on **every `/api/` request, GET included**, static serving confined to `public/`. Anything
matching `sk-ant-[A-Za-z0-9_-]+` is scrubbed before it can reach a log or a response body.

The `Host` check validates the **hostname only** - `127.0.0.1`, `localhost`, `::1` - and
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
