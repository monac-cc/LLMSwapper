# LLMswapper

One compact panel that shows the LLMswapper accounts of every paired Paseo host and lets you switch the active Claude account on any of them, without leaving Paseo.

- Each account is one row: its name, and right beside it two thin bars, the 5-hour window on top and the 7-day window below, each with the percentage used and when it resets. The short vertical mark on a bar is how much of that window's time has passed, so an account spending faster than time passes stands out in orange. Red means it is at its limit. The account in use is marked with the accent colour and the environments it is active in.
- Press a row to choose the environment (the host OS or a WSL distro) where that account should be used. Choosing is the confirmation.
- Open sessions follow the switch. Claude Code keeps its token in memory, so after a switch on the host's own environment the plugin reloads that machine's Paseo Claude agents: idle ones at once, busy ones when their turn ends. Paseo restarts the Claude Code process and resumes the same conversation, which then runs on the new account. Changes made outside the panel (LLMswapper's own page, its `/swapper` skills, its automatic rotation) are picked up within 30 seconds. Claude Code opened outside Paseo keeps the old account until it is restarted (`claude -c` continues the conversation).
- Usage comes from LLMswapper's own cache and is never force-refreshed, so the panel does not spend the usage API budget.

## Setup

- LLMswapper running on each device you want to see (default `http://127.0.0.1:7373`).
- The device that has the plugin installed is read through the plugin's own server code.
- Other devices do not need the plugin. Enable each one explicitly from the panel. The panel then opens a short-lived terminal in one of that device's workspaces and runs `node` with a small script that only talks to that device's `127.0.0.1`. A tab named "LLMswapper" can appear briefly in that workspace. The device needs `node` on the Paseo daemon's PATH (or an absolute path in Settings) and at least one workspace.

## What it reads and sends

- Only whitelisted public fields of LLMswapper (labels, active accounts, usage percentages). Tokens never leave a device.
- Requires `daemon.manage` on the plugin's host, as every plugin does, and terminal rights (`workspace.read` and `workspace.write`) on the other devices.
