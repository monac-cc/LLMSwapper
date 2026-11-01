import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createQuietRunner } from "../server/quiet-helper.ts";
import { type Proc, parsePsOutput, parseWinProcs, sessionWork } from "../server/quiet-rules.ts";

const SID = "5e55a0b1-7c2d-4e8f-9a01-23456789abcd";
const OTHER = "11111111-2222-4333-8444-555555555555";
const T0 = Date.parse("2026-11-01T10:00:00Z");
const at = (s: number) => T0 + s * 1000;
const p = (pid: number, ppid: number, name: string, args: string, startS: number): Proc => ({ pid, ppid, name, args, startedAt: at(startS) });
const SNAP = "source /c/Users/u/.claude/shell-snapshots/snapshot-bash-1791411214586-pf5wo6.sh";

// The helper (pid 900) runs under the plugin process (800), under the Paseo daemon (700).
const PASEO = [p(1, 0, "launchd", "/sbin/launchd", -9999), p(700, 1, "Paseo", "/Applications/Paseo.app/Contents/MacOS/Paseo", -500), p(800, 700, "Paseo", "plugin-process.js", -400), p(900, 800, "Paseo", "helper", 1000)];
const pids = (l: readonly Proc[]) => l.map((x) => x.pid);

test("ps output: etime in every shape, names from the executable path, junk skipped", () => {
  const now = at(0);
  const text = [
    "  101     1      05:03 /usr/local/bin/claude --resume=x",
    "  102   101   01:02:03 /bin/bash -c sleep 600",
    "  103   101 2-01:02:03 node /home/u/.npm/claude-code/cli.js",
    "garbage line",
    "  104   101   abc /bin/true",
  ].join("\n");
  const r = parsePsOutput(text, now);
  assert.deepEqual(r.map((x) => [x.pid, x.ppid, x.name, (now - x.startedAt) / 1000]), [
    [101, 1, "claude", 303], [102, 101, "bash", 3723], [103, 101, "node", 2 * 86400 + 3723],
  ]);
  assert.equal(r[0].args, "/usr/local/bin/claude --resume=x");
});

test("Windows process JSON: array or single object, rows without a start date skipped", () => {
  const one = parseWinProcs(JSON.stringify({ p: 5, pp: 4, n: "claude.exe", s: "2026-11-01T10:00:00.0000000Z", c: "claude.exe --resume=x" }));
  assert.deepEqual(one, [{ pid: 5, ppid: 4, name: "claude.exe", args: "claude.exe --resume=x", startedAt: T0 }]);
  const many = parseWinProcs(JSON.stringify([{ p: 4, pp: 0, n: "System", s: null, c: null }, { p: 6, pp: 5, n: "bash.exe", s: "2026-11-01T10:05:00Z", c: null }]));
  assert.deepEqual(many.map((x) => [x.pid, x.args]), [[6, ""]]);
  assert.deepEqual(parseWinProcs("not json"), []);
  assert.deepEqual(parseWinProcs(""), []);
});

test("background work: anything run through Claude Code's shell wrapper counts at any age; MCP, LSP and console hosts do not", () => {
  const session = [...PASEO,
    p(10, 700, "claude.exe", `"C:\\Users\\u\\.local\\bin\\claude.exe" --resume=${SID} --output-format stream-json`, 0),
    p(11, 10, "conhost.exe", "conhost", 0),
    p(12, 10, "node.exe", "node mcp-server.js", 3), // MCP server, part of the startup
    p(13, 10, "cmd.exe", "cmd.exe /c npx -y some-mcp", 2), // MCP server through cmd, also startup
    p(14, 10, "node.exe", "node typescript-language-server --stdio", 400), // LSP started later: lives as long as the session
    p(15, 10, "conhost.exe", "conhost --headless", 400),
  ];
  assert.deepEqual(sessionWork(session, SID, [SID], 900), { roots: [10], owned: true, late: [], foreign: false }, "idle session: quiet");
  const busy = [...session,
    p(16, 10, "bash.exe", `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${SNAP} && npm run dev"`, 5), // 5 s in: the wrapper says it all
    p(17, 16, "node.exe", "node vite", 6),
    p(18, 16, "conhost.exe", "conhost", 5),
    p(19, 10, "pwsh.exe", "pwsh -NoProfile -Command Start-Job", 30), // a shell without the wrapper, after the startup
  ];
  assert.deepEqual(pids(sessionWork(busy, SID, [SID], 900).late), [16, 19, 17], "the shells and what they started");
});

test("a reused pid does not adopt older processes, and a nested claude is the session's work, not another session", () => {
  const procs = [...PASEO,
    p(10, 700, "claude.exe", `claude.exe --resume=${SID}`, 0),
    p(20, 10, "svchost.exe", "svchost", -300), // its real parent died; pid 10 was reused by claude
    p(21, 20, "bash.exe", SNAP, 500),
    p(30, 10, "bash.exe", `bash -c "${SNAP} && claude -p hi"`, 200),
    p(31, 30, "claude.exe", `claude.exe -p hi --resume=${SID}`, 201),
  ];
  const r = sessionWork(procs, SID, [SID], 900);
  assert.deepEqual(r.roots, [10]);
  assert.deepEqual(pids(r.late), [30, 31]);
});

test("Claude Code run by Node (npm install) is recognised, with spaces in the Node path", () => {
  const procs = [...PASEO,
    p(10, 700, "node.exe", `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --resume ${SID}`, 0),
    p(11, 10, "bash.exe", SNAP, 30),
  ];
  assert.deepEqual(sessionWork(procs, SID, [SID], 900), { roots: [10], owned: true, late: [procs.at(-1)], foreign: false });
});

test("whose process is it: own id, else every Paseo process no live agent claims (new agents, ids changed in flight)", () => {
  const procs = [...PASEO,
    p(10, 700, "claude", "/Users/u/.local/share/claude/versions/2.1.296 --output-format stream-json", 0), // a new agent's first process: no id
    p(11, 10, "zsh", `/bin/zsh -c -l ${SNAP} && sleep 900`, 3),
    p(40, 700, "claude", `/Users/u/.local/share/claude/versions/2.1.296 --resume ${OTHER}`, 0), // OTHER's own process
    p(41, 40, "zsh", `/bin/zsh -c -l ${SNAP} && make watch`, 300),
    p(50, 60, "claude", "claude", 0), // a terminal claude outside Paseo: not a child of the daemon
    p(51, 50, "bash", SNAP, 300),
    p(70, 700, "claude", "/Users/u/.local/share/claude/versions/2.1.296 --resume 99999999-0000-4000-8000-000000000000", 0), // its agent moved to a new id
  ];
  const claimed = [SID, OTHER];
  assert.deepEqual(sessionWork(procs, SID, claimed, 900), { roots: [10, 70], owned: false, late: [procs[PASEO.length + 1]], foreign: false }, "no process of its own: the unclaimed ones stand in");
  assert.deepEqual(sessionWork(procs, OTHER, claimed, 900), { roots: [40], owned: true, late: [procs[PASEO.length + 3]], foreign: false }, "its own process only");
  const calm = procs.filter((x) => x.pid !== 11);
  assert.deepEqual(sessionWork(calm, SID, claimed, 900).late, [], "neither OTHER's shell nor the terminal claude count");
  assert.deepEqual(sessionWork([...PASEO, procs[PASEO.length + 2]], SID, claimed, 900), { roots: [], owned: false, late: [], foreign: false }, "no live process at all");
});

test("Claude Code's PowerShell tool counts at any age, like its Bash wrapper", () => {
  const procs = [...PASEO,
    p(10, 700, "claude.exe", `claude.exe --resume=${SID}`, 0),
    p(11, 10, "cmd.exe", `cmd.exe /d /s /c ""chcp.com" 65001 >nul & "powershell.exe" -NoProfile -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; & $__claudeCodeScript""`, 4),
    p(12, 11, "powershell.exe", "powershell.exe -NoProfile -Command Start-Job { npm run dev }", 4),
  ];
  assert.deepEqual(pids(sessionWork(procs, SID, [SID], 900).late), [11, 12]);
});

test("an npm install on Windows: claude.cmd runs through cmd.exe, and the session is found behind it", () => {
  const procs = [...PASEO,
    p(9, 700, "cmd.exe", `C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd" --resume=${SID}"`, 0),
    p(10, 9, "node.exe", `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --resume=${SID}`, 0),
    p(11, 10, "bash.exe", SNAP, 2),
  ];
  assert.deepEqual(sessionWork(procs, SID, [SID], 900), { roots: [10], owned: true, late: [procs.at(-1)], foreign: false });
});

test("a session run through WSL, docker or ssh is out of sight: never taken for quiet", () => {
  const procs = [...PASEO, p(10, 700, "wsl.exe", `wsl.exe -e claude --resume=${SID}`, 0)];
  const w = sessionWork(procs, SID, [SID], 900);
  assert.equal(w.foreign, true);
  assert.equal(sessionWork(procs, OTHER, [SID, OTHER], 900).foreign, false, "only for its own session");
});

test("a daemon that is PID 1 (a container's entrypoint) still owns its Claude Code processes", () => {
  const procs = [p(1, 0, "node", "node paseo-daemon.js", -500), p(800, 1, "node", "plugin-process.js", -400), p(900, 800, "node", "helper", 1000),
    p(10, 1, "claude", `/root/.local/bin/claude --resume ${SID}`, 0), p(11, 10, "bash", SNAP, 300)];
  assert.deepEqual(sessionWork(procs, SID, [SID], 900), { roots: [10], owned: true, late: [procs.at(-1)], foreign: false });
});

// --- the helper itself, end to end: a fake daemon client next to it, real processes, real ps/CIM ---

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sid = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = { quiet: id(1), running: id(2), perm: id(3), subagents: id(4), race: id(5), lastMoment: id(6), shell: id(7), lsp: id(8), noproc: id(9), archived: id(10), codex: id(11), bg: id(12), unknown: id(13) };
const live = { model: "claude-opus-5-5" };
const AGENTS = [
  { id: ID.quiet, statuses: ["idle"], sessionId: sid(1), runtimeInfo: live },
  { id: ID.running, statuses: ["running"], sessionId: sid(2), runtimeInfo: live },
  { id: ID.perm, statuses: ["idle"], pendingPermissions: [{ id: "p1" }], sessionId: sid(3), runtimeInfo: live },
  { id: ID.subagents, statuses: ["idle"], subagents: 1, sessionId: sid(4), runtimeInfo: live },
  { id: ID.race, statuses: ["idle", "running"], sessionId: sid(5), runtimeInfo: live }, // a new turn by the second look
  { id: ID.lastMoment, statuses: ["idle", "idle", "running"], sessionId: sid(6), runtimeInfo: live }, // ... by the final status read
  { id: ID.shell, statuses: ["idle"], sessionId: sid(7), runtimeInfo: live },
  { id: ID.lsp, statuses: ["idle"], sessionId: sid(8), runtimeInfo: live },
  { id: ID.noproc, statuses: ["idle"], sessionId: sid(9), runtimeInfo: { model: null } },
  { id: ID.archived, statuses: ["idle"], archivedAt: "2026-10-01T00:00:00Z", sessionId: sid(10) },
  { id: ID.codex, statuses: ["idle"], provider: "codex", sessionId: sid(11) },
  { id: ID.bg, statuses: ["idle"], background: true, sessionId: sid(12), runtimeInfo: { model: null } },
];

const FAKE_CLIENT = `import fs from "node:fs";
const st = JSON.parse(process.env.FAKE_STATE);
const note = (x) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(x) + "\\n");
const looks = {};
const row = (a, status) => ({ id: a.id, provider: a.provider || "claude", status, activeTurn: null, pendingPermissions: a.pendingPermissions || [], archivedAt: a.archivedAt || null, runtimeInfo: a.runtimeInfo || null, persistence: { provider: a.provider || "claude", sessionId: a.sessionId } });
export async function connectToDaemon({ target }) {
  note({ connect: target });
  return {
    async fetchAgents(o) {
      const bg = !!(o.filter && o.filter.includeBackground);
      if (bg && st.noBackground) throw new Error("background workspaces are not supported by this daemon");
      const all = st.agents.filter((a) => bg || !a.background);
      const i = o.page && o.page.cursor ? Number(o.page.cursor) : 0; // one agent per page: the helper must follow the cursor
      return { entries: all.slice(i, i + 1).map((a) => ({ agent: row(a, a.statuses[0]), project: null })), pageInfo: { nextCursor: i + 1 < all.length ? String(i + 1) : null } };
    },
    async fetchAgent(id) {
      const a = st.agents.find((x) => x.id === id);
      if (!a) return null;
      looks[id] = (looks[id] || 0) + 1;
      return { agent: row(a, a.statuses[Math.min(looks[id], a.statuses.length) - 1]), project: null };
    },
    async listProviderSubagents(id) {
      const a = st.agents.find((x) => x.id === id);
      return { subagents: [{ status: "completed" }, ...Array.from({ length: a.subagents || 0 }, () => ({ status: "running" }))] };
    },
    async refreshAgent(id) { note({ refresh: id }); return {}; },
    async close() { note({ closed: true }); },
  };
}
`;
const FAKE_TARGET = `export function selectDaemonTarget(options, env) { return { kind: "fake", via: "selectDaemonTarget" }; }\n`;
// Stands in for a Claude Code process. "shell": runs a command through the shell-snapshot wrapper 1.5 s in,
// well inside the startup window that only applies to other shells. "lsp": a language server, same time.
const FAKE_CLAUDE = `const { spawn } = require("node:child_process");
const kind = process.argv[3];
if (kind === "none") process.stdout.write("child 0\\n");
else setTimeout(() => {
  const tag = kind === "shell" ? "${SNAP} && npm run dev" : "typescript-language-server --stdio";
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", tag], { stdio: "ignore" });
  process.stdout.write("child " + c.pid + "\\n");
}, 1500);
setInterval(() => {}, 1000);
`;

function setup(state: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmswapper-quiet-"));
  const utils = path.join(dir, "cli", "dist", "utils");
  fs.mkdirSync(utils, { recursive: true });
  fs.writeFileSync(path.join(dir, "cli", "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(utils, "client.js"), FAKE_CLIENT);
  fs.writeFileSync(path.join(utils, "daemon-target.js"), FAKE_TARGET);
  fs.writeFileSync(path.join(dir, "claude-fake.cjs"), FAKE_CLAUDE);
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(log, "");
  const env = { FAKE_STATE: JSON.stringify({ agents: AGENTS, ...state }), FAKE_LOG: log };
  const cli = { command: process.execPath, prefix: [], env: {}, cliIndex: path.join(dir, "cli", "dist", "index.js"), node: { command: process.execPath, env } };
  const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const reset = () => fs.writeFileSync(log, "");
  return { dir, cli, calls, reset };
}

type Fake = { claude: ChildProcess; childPid: number };
/** A fake Claude Code process for `session`, a child of this test process (which the helper descends from). */
function fakeClaude(dir: string, session: string, kind: "none" | "shell" | "lsp"): Promise<Fake> {
  const claude = spawn(process.execPath, [path.join(dir, "claude-fake.cjs"), `--resume=${session}`, kind], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake claude did not start")), 15_000);
    claude.stdout?.setEncoding("utf8").on("data", (c: string) => {
      const m = /child (\d+)/.exec(c);
      if (m) { clearTimeout(timer); resolve({ claude, childPid: Number(m[1]) }); }
    });
  });
}
const kill = (pid: number) => { try { if (pid) process.kill(pid); } catch { /* gone already */ } };
const results = (r: { results: ReadonlyMap<string, string>; error: string | null }) => ({ ...Object.fromEntries(r.results), ...(r.error ? { error: r.error } : {}) });

test("helper end to end: statuses, permissions, subagents, background shells, no process, paging, and the last looks before reloading", { timeout: 120_000 }, async () => {
  const { dir, cli, calls, reset } = setup();
  const fakes = await Promise.all([fakeClaude(dir, sid(1), "none"), fakeClaude(dir, sid(5), "none"), fakeClaude(dir, sid(6), "none"), fakeClaude(dir, sid(7), "shell"), fakeClaude(dir, sid(8), "lsp")]);
  try {
    const run = createQuietRunner(cli, { secondLookMs: 100 });
    assert.ok(run);
    const check = await run("check", "all");
    assert.deepEqual(results(check), {
      [ID.quiet]: "quiet", [ID.running]: "busy:turno", [ID.perm]: "busy:turno", [ID.subagents]: "busy:subagentes",
      [ID.race]: "quiet", [ID.lastMoment]: "quiet", [ID.shell]: "busy:segundo-plano", [ID.lsp]: "quiet",
      [ID.noproc]: "sin-proceso", [ID.bg]: "sin-proceso",
    }, "archived and non-Claude agents are not listed; background workspaces are");
    assert.equal(calls().filter((c) => "refresh" in c).length, 0, "check never reloads");
    assert.deepEqual(calls()[0], { connect: { kind: "fake", via: "selectDaemonTarget" } });
    reset();
    const reload = await run("reload", [ID.quiet, ID.race, ID.lastMoment, ID.noproc, ID.archived, ID.unknown, "not-an-id"]);
    assert.deepEqual(results(reload), {
      [ID.quiet]: "reloaded", [ID.race]: "busy:turno", [ID.lastMoment]: "busy:turno", [ID.noproc]: "sin-proceso", [ID.archived]: "gone", [ID.unknown]: "gone",
    }, "a turn that starts by the second look, or right before the reload, is not interrupted");
    assert.deepEqual(calls().filter((c) => "refresh" in c), [{ refresh: ID.quiet }]);
    assert.equal(calls().filter((c) => "connect" in c).length, 1);
    assert.deepEqual(calls().at(-1), { closed: true });
  } finally {
    for (const f of fakes) { kill(f.childPid); f.claude.kill(); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("helper end to end: a background shell started in the session's first seconds is waited for, then the session switches", { timeout: 120_000 }, async () => {
  const { dir, cli, calls } = setup();
  const { claude, childPid } = await fakeClaude(dir, sid(7), "shell");
  try {
    const run = createQuietRunner(cli, { secondLookMs: 100 }); // the default startup window
    assert.ok(run);
    assert.deepEqual(results(await run("reload", [ID.shell])), { [ID.shell]: "busy:segundo-plano" });
    assert.equal(calls().filter((c) => "refresh" in c).length, 0, "nothing was cut");
    kill(childPid);
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(results(await run("reload", [ID.shell])), { [ID.shell]: "reloaded" });
  } finally {
    kill(childPid);
    claude.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("helper end to end: an older daemon without background workspaces is still listed in full", { timeout: 60_000 }, async () => {
  const { dir, cli } = setup({ noBackground: true });
  try {
    const run = createQuietRunner(cli);
    assert.ok(run);
    const r = await run("check", "all");
    assert.equal(r.error, null);
    assert.equal(r.results.get(ID.noproc), "sin-proceso");
    assert.equal(r.results.has(ID.bg), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("helper failures come back as errors, never as quiet", { timeout: 60_000 }, async () => {
  const { dir, cli } = setup();
  try {
    fs.writeFileSync(path.join(dir, "cli", "dist", "utils", "client.js"), `export async function connectToDaemon() { throw new Error("ECONNREFUSED"); }\n`);
    const run = createQuietRunner(cli);
    assert.ok(run);
    assert.deepEqual(await run("reload", "all"), { results: new Map(), error: "connect: ECONNREFUSED" });
    fs.writeFileSync(path.join(dir, "cli", "dist", "utils", "client.js"), `export async function connectToDaemon() { setInterval(() => {}, 1000); return { fetchAgents: () => new Promise(() => {}) }; }\n`); // connects, never answers
    const stuck = createQuietRunner(cli, { stallMs: 1500 });
    assert.ok(stuck);
    assert.deepEqual(await stuck("check", "all"), { results: new Map(), error: "el ayudante dejó de responder" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
