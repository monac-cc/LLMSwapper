<div align="center">

# LLMSwapper

**Switch the active AI-subscription account with one click - and see how much quota each one has left before you do.**

<sub><b>Today it swaps Claude Code accounts, and only those.</b> The name is a plan, not a claim.
<a href="#other-providers">What is coming</a>.</sub>

[![test](https://github.com/monac-cc/LLMSwapper/actions/workflows/test.yml/badge.svg)](https://github.com/monac-cc/LLMSwapper/actions/workflows/test.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](#install)
[![platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-lightgrey)](#install)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<img src="docs/screenshot.png" alt="The LLMSwapper panel: environment tabs, four accounts and their session and weekly quota meters" width="100%">
<sub>Accounts and quota figures above are fictional.</sub>

</div>

---

## Install

Node 18+ and Claude Code. No `npm install`, no build step.

```bash
git clone https://github.com/monac-cc/LLMSwapper.git
cd LLMSwapper
node server.js          # opens http://127.0.0.1:7373
```

<details>
<summary><b>Windows · macOS · Linux</b> - identical, plus one note each</summary>

| | |
|---|---|
| **Windows** | Also detects your WSL distros and swaps inside them, from the same screen. |
| **macOS** | Credentials usually live in the login Keychain - item `Claude Code-credentials`, account `claude-code-user` - and the app reads and writes that item through `security`; a plain `~/.claude/.credentials.json` is used when that item does not exist. With `CLAUDE_CONFIG_DIR` set it addresses that directory's own item, as Claude Code does. |
| **Linux** | Nothing special. This is the host the Docker image is really for. |

</details>

<details>
<summary><b>Docker</b> - one Linux image, any host, with two things it cannot do</summary>

```bash
docker compose up -d          # http://127.0.0.1:7373
git pull && docker compose up -d   # update: compose rebuilds the image on every up
```

By hand, on a port of your choice:

```bash
docker build -t llmswapper .
docker run -d --name llmswapper -p 127.0.0.1:7373:7373 \
  -v "$PWD/data:/app/data" \
  -v "$HOME:/home/node" \
  llmswapper
```

- **Publish on `127.0.0.1` only.** Inside the container the server must listen on `0.0.0.0`, so the loopback guarantee has to be imposed here.
- **Mount the `data/` you already use.** A named volume gives the container a separate, empty account store.
- **Never run the container and `node server.js` together.** The rate floor is per process; two instances rate-limit each other.
- **Windows:** set `$env:CLAUDE_HOME = $env:USERPROFILE` first. **macOS:** swapping needs credentials in a file, not the Keychain. **Linux:** add `--user "$(id -u):$(id -g)"` if the mounts belong to another uid.
- **Update with `git pull && docker compose up -d`.** The compose file rebuilds on every `up`; with `docker run` you have to `docker build` again yourself. The container banner shows the build stamp, so a stale container is visible at a glance.
- **Mount your home directory, not `~/.claude` and `~/.claude.json` separately.** Claude Code rewrites `~/.claude.json` by renaming a new file over it, and a single-file bind mount on a Linux host keeps the *old* inode: the container reads a frozen copy and its writes never reach the host. With the home directory mounted, the rename happens inside the mount and every write stays atomic. The container sees your whole home; it already held your Claude credentials, which is the valuable part.
- **Docker Desktop (Windows, macOS) resolves the share by path**, so there the narrower pair `-v "$HOME/.claude:/home/node/.claude" -v "$HOME/.claude.json:/home/node/.claude.json"` also works. On a file mount the server writes in place (a mount point cannot be replaced by rename), and if the mount ever detaches it refuses to swap and says so in a banner, rather than pretending.
- A container **cannot** see host processes or reach WSL. The panel says so on screen rather than reporting "not running" for what it cannot see.

</details>

Another port: `PORT=7400 node server.js`. It never hops to the next free one - the rate floor is
per process, so a second instance would rate-limit both.

<details>
<summary><b>Always on (Windows)</b> - start with your session, restart if it dies</summary>

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

Registers a per-user scheduled task (no admin) that launches the panel hidden at logon, restarts
it up to three times if it crashes (a clean exit, such as the port being busy, is left alone), and
never kills it on a time limit. It also starts it right away - unless something already listens on
7373, in which case stop that first and run `Start-ScheduledTask LLMSwapper`. Output goes to `data\server.log`. Remove with `-Uninstall`. Don't combine it with running
`node server.js` by hand - same rule as Docker, one instance only.

</details>

---

> **Status: Claude Code only.** Every account you can add today is an Anthropic one. The problem is
> not specific to Claude - any coding tool backed by a personal subscription holds one account at a
> time - but nothing else is wired up yet. [Other providers](#other-providers) is a list of
> criteria, not of dates.

## What it does

Claude Code holds one account at a time; using another means `/login` and a browser round trip,
every time. LLMSwapper stores each account once and makes the change a click - on your machine and
inside your WSL distros - and shows what each has left of its 5-hour and weekly windows, so it
answers the real question: **which account should I switch to right now.**

The interface is bilingual (**ES / EN**) with light and dark themes, both remembered.
Server-side error text is still Spanish only - a known gap, since translating it needs the API to
return codes rather than sentences.

## Adding accounts

Two ways in. The choice decides one thing: whether the account can identify itself.

**Paste a long-lived token** - recommended. Run `claude setup-token`, approve in the browser, paste
what it prints. Lasts a year, no renewal. The form has an **open a terminal for me** link that runs
the command for you.

- Grants one scope, `user:inference`, so it has no email, plan or organisation - it shows the name you give it.
- **Quota meters still work**, from a different source. See below.

**Import a live session** - `claude` then `/login`, then press **import**. Full scope, so it
identifies itself and reads quota for free.

- Costs one login per account, and its refresh token dies after ~29 days without opening the panel.
- **Shift + click** imports from a `CLAUDE_CONFIG_DIR=/tmp/other claude` session without disturbing yours.

Adding the same account twice updates it in place.

## Usage meters

Refreshed every 5 minutes and on demand. Where the numbers come from, and what they cost:

| Account | Source | Cost per reading |
|---|---|---|
| Imported | `/api/oauth/usage` | **0 tokens** |
| `setup-token` | `anthropic-ratelimit-unified-*` headers | **8 in + 1 out** |

- An inference-only token is answered `403` by the usage endpoint forever, so the panel never asks.
- The free endpoints carry no rate-limit headers, so the probe spends the floor: Haiku, `max_tokens: 1`, a one-character prompt. About **2,600 tokens a day** per account, against a window measured in hundreds of thousands.
- When it cannot refresh, it shows the last reading marked stale. Switching is unaffected.

## Switching

Press **swap**:

1. Warns if Claude Code is open - the change lands on **new** sessions.
2. Backs up credentials and `~/.claude.json` to `data/backups/` (last 20).
3. Refreshes the token if it is about to expire.
4. Rewrites **only** `claudeAiOauth` and `oauthAccount`. Projects, history and `mcpOAuth` are untouched.
5. Verifies against the API and **rolls both files back** if the token is rejected (401/403). A rate limit or a network failure keeps the swap and says it could not be confirmed.

## Environments

The tabs are the places a swap can write: the host, named after its OS, and every WSL distro.
Nothing to configure - it runs `wsl.exe -l -q --running` and takes what comes back.

- Lists only distros that are **running** - a scan must not boot the stopped ones - and skips system distros (`docker-desktop`) and any distro where Claude Code has never run, checked by resolving `$HOME` and looking for `~/.claude.json` over the share.
- Detection is cached 30 s. The **↻** beside the tabs re-scans past it, and says when nothing changed.
- A dot means Claude Code is running there. Each environment tracks its own active account.
- WSL is a Windows feature; elsewhere there is one tab.

## Slash commands (Claude Code skills)

Three skills drive the panel from inside any Claude Code session, so you can check quota or
switch account without leaving the terminal. They talk to the running panel over
`127.0.0.1:7373`; nothing works unless `node server.js` is up (`PORT` if you moved it).

| Command | What you type | What it does |
|---|---|---|
| `/swapper-usage` | `/swapper-usage` | One line per account with its 5-hour and weekly quota; marks the one in use (and when its session resets) and the freest one to switch to. Read-only. |
| `/swapper <name>` | `/swapper Manuel` · `/swapper devs@…` | Switches the host's active account to the one named (label or email), then shows what it has left. |
| `/swapper-auto` | `/swapper-auto on` · `off` · `status` | Turns **automatic rotation** on or off, and shows the whole rotation queue: the account in use, which is next, and any excluded one with the reason. |

`/swapper-usage` prints one aligned line per account — `●` in use, `→` the freest to switch to:

```
  Swapper · host                   5h     7d

  ● Cyberxia                      31%    53%   en uso · reset 4h 12m
  → Castillo · carloscastilloazr   0%    48%   más libre
    Manuel Cordero                 0%     0%
    Castillo · ccastillo          81%    71%   casi
    CTO                          100%    68%   tope
```

Two accounts sharing a label are told apart by the email's local part. `/swapper-auto` uses the
same shape: `●` the account in use, `→ siguiente` the one it would rotate to, and `excluida · why`
on any it will skip.

`/swapper Manuel` matches by name or email — if it is ambiguous (two accounts labelled the same)
it lists them and asks for the email rather than guessing. The change lands on **new** Claude Code
sessions; one already open keeps its token.

**Automatic rotation** (`/swapper-auto on`). The server then watches the active account and, the
moment its 5-hour session reaches **90%**, swaps to the freshest account that still has room — so
your next `claude` launch lands on capacity you have not spent. It only rotates into an account
below the threshold in both windows; if none qualifies it stays put. State is on disk, so it
survives a restart, and it is the same audited swap (backup, verify, roll back) as a manual one.
Turn it off with `/swapper-auto off`. An account whose token is rejected is left out of the queue, and a rotation that fails waits out the same cooldown as one that succeeds, so a dead credential is never retried every three minutes.

### Install

Copy the three skill folders into your user skills folder, once:

```bash
# macOS / Linux / Git Bash
cp -r skills/swapper skills/swapper-usage skills/swapper-auto ~/.claude/skills/
```

```powershell
# Windows PowerShell
Copy-Item skills\swapper,skills\swapper-usage,skills\swapper-auto $env:USERPROFILE\.claude\skills\ -Recurse
```

Each skill is self-contained — a `SKILL.md` and a small `swapper.mjs` — and needs only Node and
the running panel. They work from **any** Claude Code session, not just one opened in this repo.

## Other providers

Claude Code ships today. The rest are candidates, in rough order of fit.

| Provider | Tool | Status |
|---|---|---|
| **Anthropic** | Claude Code | **Shipping** - host and WSL, token or import |
| **OpenAI** | Codex CLI | Coming soon - credentials in `~/.codex/auth.json` |
| **GitHub** | Copilot | Considering - `~/.config/github-copilot/` |
| **Google** | Gemini CLI | Considering - `~/.gemini/` |
| **Cursor / Windsurf** | editor sign-in | Investigating - held by the editor, not a file this tool can rewrite |

A provider fits when its credentials live in **a file this app can rewrite**, the account is
identifiable enough to label, and swapping does not require killing a running session. One that
keeps its session in an OS keychain, or pinned to a process, needs a different mechanism. If a tool
you use fits, an issue naming it and where it stores credentials is the most useful thing to send.

## Security

- **Loopback only** by default, plus a required header on every API call. DNS rebinding is rejected by validating the `Host` hostname.
- **Reaching it from another device is opt-in and unauthenticated.** `SWAPPER_BIND=0.0.0.0` widens the socket and `SWAPPER_ALLOWED_HOSTS=192.168.1.10,my-pc` widens the `Host` allowlist - both, or it stays closed. Only the hosts you name are let in; every other one, rebinding included, is still refused. There is no login, so anyone who can route to that address can swap, rename and delete your accounts. A tunnel or a private mesh is the better answer; this is for a network you trust.
- Tokens live in `data/` (real NTFS ACL on Windows) and **never leave the process**. Anything matching `sk-ant-*` is scrubbed from logs and responses; a test fails the build if a token literal appears in any source file.
- **No OAuth flow in the panel.** You mint tokens in your own terminal and paste them.
- A pasted token is a **year-long** secret. The field is a password input, emptied when the form closes.
- Every swap is preceded by a backup and rolls back on failure.

## Limitations

- **`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` outrank the credentials file.** While one is set, swapping is a silent no-op. The panel detects this and says so.
- **Token accounts have no identity** - no email, plan or organisation. Nothing to read, so nothing is invented. Name one with its real email and `/status` reads as before.
- **Remote Control does not work with `setup-token` accounts.** Anthropic documents it. The `Remote Control disconnected - /login` line is not a broken session; silence it with `"disableRemoteControl": true`.
- **The usage endpoint allows ~5 requests per 5 minutes** for the whole app, hence the hard floor and the persisted, escalating cooldown.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Swapping "works" but Claude Code keeps the old account | An overriding environment variable. |
| `Remote Control disconnected - /login` | Expected with `setup-token` accounts. |
| `Not logged in - Please run /login` | The credentials blob has no `scopes`. |
| Meters empty and marked stale | Rate-limited. Recovers on its own. |
| `Ya hay algo escuchando en…` at start-up | Another instance. The port never hops. |

## Development

```bash
node test.js        # 52 checks, ~2 s, no external network
```

Every `fetch` is stubbed, so a run never spends the usage endpoint's budget. Each module has its
own self-check (`node lib/swap.js`). Internals are in [ARCHITECTURE.md](ARCHITECTURE.md).

## License

[MIT](LICENSE)
