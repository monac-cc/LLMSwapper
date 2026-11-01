# LLMswapper for Paseo

A [Paseo](https://paseo.sh) plugin that puts every device's [LLMswapper](../README.md) in one compact panel: one row per account with its 5-hour and 7-day bars (only the weekly bar for Ultra accounts, which have no 5-hour limit), and a press to switch the active Claude account on any paired device. What a user sees in Paseo is in [OVERVIEW.md](OVERVIEW.md).

Requires Paseo 0.11.2 or newer and LLMswapper running on each device.

## Install

```bash
paseo plugin add git:monac-cc/LLMSwapper:paseo-plugin
```

Enable plugins first (Settings > Plugins, or `pluginsEnabled` in the daemon's `config.json`). To pin a release, add `--ref paseo-plugin-v0.1.0`. Update with `paseo plugin update llmswapper`.

Then open it with Ctrl+K > "LLMswapper: abrir panel" or `/llmswapper`, and drag its tab to the left edge of the agent pane to keep it beside the chat.

## How it works

| Device | Path |
|---|---|
| The one with the plugin | Plugin RPC. The plugin's server code calls LLMswapper on `127.0.0.1`. |
| Every other paired device | Opt-in terminal bridge. The panel runs `node -e <script>` in a short-lived terminal on that device through Paseo's relay; the script only talks to that device's `127.0.0.1` and prints whitelisted fields, base64-encoded between markers. No port is opened anywhere. |

**Switching in the current session.** A running Claude Code keeps its OAuth token in memory and only re-reads `.credentials.json` when that token is rejected (verified against Claude Code 2.1.296), which is why LLMswapper alone says a switch reaches new sessions only. After a switch on the plugin host's own environment, the plugin restarts that machine's Paseo Claude agents that have a live Claude Code process, and Paseo resumes the same conversation on the new account. An agent without a live process needs nothing: Paseo starts one at its next turn, and that one reads the new account.

A restart closes the process, so anything still running in it stops: a turn in progress, workflows and background agents (they outlive the turn that started them), background shells (every Bash/Monitor command goes through Claude Code's shell-snapshot wrapper; dev servers and watchers started from it count too). The host's setting **Sesiones con trabajo en marcha al cambiar de cuenta** decides what happens to such a session:
- **Parar y seguir con la cuenta nueva** (default): it is stopped at once, so the old account, often swapped away from because it is nearly spent, uses nothing more, and it is then told what was cut, as far as Paseo and its transcript show it (the helper checks that the message reached the conversation, and sends it again if not). Workflows resume from their journal with `resumeFromRunId`, so finished steps are neither run nor paid for again; background agents continue from their transcript with `SendMessage`; shells and an interrupted turn are picked up again. A step that was half-way is redone on the new account, so the message asks the session to check what it left half-done before redoing it. A child agent another agent delegated to (`create_agent`) finishes first, so its parent hears the real result; so does an agent still loading or without a session yet: they switch once quiet, as in «Esperar». Stopped sessions are all restarted first and told afterwards, so none keeps spending the old account while another's message is checked.
- **Esperar a que terminen**: it keeps working on the old account and is restarted as soon as it is quiet, checked at every turn end (`agent.turn_ended`) and every minute, for up to 12 hours.

A small helper next to the daemon, using the Paseo CLI's own daemon client, does the checking, restarting and messaging in one pass, reading the status last, right before a restart. Where it cannot run, nothing is restarted and the panel says so. A 30-second watch on `/api/targets` does the same for switches made outside the panel, LLMswapper's auto-rotation included.

What it cannot see from outside Paseo: in-process teammates of agent teams, remote agents and MCP monitors (Paseo tracks them but does not expose that state to plugins). In either mode, a session whose only work is of this kind looks idle and is restarted under it without a message; a session stopped for other work gets a message that cannot name these. Sessions run through WSL, docker or ssh cannot be inspected and are never stopped blind: they keep the old account until restarted, and the panel says so.

**Budget.** Usage reads go through LLMswapper's cache and are never forced; automatic refresh runs every 5 minutes by default, only while the panel is open; it can be set to 10, 15 or 30 minutes or turned off, and never runs more often than every 5 minutes.

## Development

```bash
cd paseo-plugin
npm install
npm run typecheck    # client/server config + test config
npm test             # node --test with native type stripping (Node >= 22.18)
npm run check:bundle # compiles with the installed Paseo desktop's own plugin compiler (Windows)
paseo plugin install "$PWD"          # directory install, compiled in place
paseo plugin reload llmswapper       # after each change
paseo plugin logs llmswapper --json
```

`client/`, `server/` and `shared/` follow Paseo's plugin boundaries: no Node or DOM APIs in client code.

## Copying accounts to other devices

`tools/llmswapper-accounts.mjs export` writes one self-contained file holding LLMswapper's pasted-token accounts (`claude setup-token`), encrypted with a passphrase (`--sin-cifrar` skips it). Running that file on another device with `node` adds every account to its LLMswapper through `POST /api/accounts/token`, with its plan (Free, Pro, Max or Ultra) when the exporting LLMswapper knows it. Accounts imported with `/login` are not exported: two devices refreshing the same rotating token would kill each other's copy.
