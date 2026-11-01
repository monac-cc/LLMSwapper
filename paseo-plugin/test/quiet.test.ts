import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createQuietRunner } from "../server/quiet-helper.ts";
import { type Proc, parsePsOutput, parseWinProcs, sessionWork } from "../server/quiet-rules.ts";
import { continuationMessage, readTranscriptLine } from "../server/stop-notice.ts";

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
const looks = {}, refreshes = {}, sends = {};
const row = (a, status) => ({ id: a.id, provider: a.provider || "claude", status, activeTurn: null, pendingPermissions: a.pendingPermissions || [], archivedAt: a.archivedAt || null, runtimeInfo: a.runtimeInfo || null, labels: a.labels || {}, persistence: { provider: a.provider || "claude", sessionId: a.sessionId } });
// Claude Code writes a user message it received to the session transcript: the helper looks for its notice there.
const deliver = (a, text) => {
  const projects = process.env.CLAUDE_CONFIG_DIR + "/projects";
  for (const d of fs.readdirSync(projects)) {
    const f = projects + "/" + d + "/" + a.sessionId + ".jsonl";
    if (fs.existsSync(f)) fs.appendFileSync(f, JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\\n");
  }
};
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
      const running = a.subs || Array.from({ length: a.subagents || 0 }, (_, i) => ({ id: "toolu_" + i, title: "Agent", description: "tarea " + i }));
      return { subagents: [{ id: "toolu_done", status: "completed" }, ...running.map((x) => ({ ...x, status: "running" }))] };
    },
    async refreshAgent(id) {
      note({ refresh: id });
      const a = st.agents.find((x) => x.id === id);
      refreshes[id] = (refreshes[id] || 0) + 1;
      if (a && a.refreshFails && refreshes[id] <= a.refreshFails) throw new Error("Timed out closing previous session during refresh");
      return {};
    },
    async sendAgentMessage(id, text, opts) {
      note({ send: id, text, opts });
      const a = st.agents.find((x) => x.id === id);
      sends[id] = (sends[id] || 0) + 1;
      if (a && a.sendFails && sends[id] <= a.sendFails) throw new Error("timeout waiting for the run to start");
      if (a && !a.lostNotice) deliver(a, text);
      return { accepted: true };
    },
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
  const claudeDir = path.join(dir, "claude-config");
  fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
  const env = { FAKE_STATE: JSON.stringify({ agents: AGENTS, ...state }), FAKE_LOG: log, CLAUDE_CONFIG_DIR: claudeDir };
  const cli = { command: process.execPath, prefix: [], env: {}, cliIndex: path.join(dir, "cli", "dist", "index.js"), node: { command: process.execPath, env } };
  const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const reset = () => fs.writeFileSync(log, "");
  /** Writes a session transcript the way Claude Code does: <config>/projects/<project>/<session>.jsonl. */
  const transcript = (session: string, lines: unknown[]) => {
    const p = path.join(claudeDir, "projects", "C--some-project");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, `${session}.jsonl`), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  };
  return { dir, cli, calls, reset, transcript };
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
    assert.deepEqual(await run("reload", "all"), { results: new Map(), actedAt: new Map(), error: "connect: ECONNREFUSED" });
    fs.writeFileSync(path.join(dir, "cli", "dist", "utils", "client.js"), `export async function connectToDaemon() { setInterval(() => {}, 1000); return { fetchAgents: () => new Promise(() => {}) }; }\n`); // connects, never answers
    const stuck = createQuietRunner(cli, { stallMs: 1500 });
    assert.ok(stuck);
    assert.deepEqual(await stuck("check", "all"), { results: new Map(), actedAt: new Map(), error: "el ayudante dejó de responder" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- stop and continue: what a stopped session is told ---

const SCRIPT = "/home/u/.claude/projects/p/s/workflows/scripts/resume-probe-wf_test-001.js";
const WF_USE = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_wf1", name: "Workflow", input: { script: "export const meta = {}", args: { question: "¿por qué?", n: 3 } } }] } };
const WF_LINE = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_wf1", content: [{ type: "text", text: "Workflow launched" }] }] },
  toolUseResult: { status: "async_launched", taskId: "wzme2maxj", taskType: "local_workflow", workflowName: "resume-probe", runId: "wf_test-001", summary: "probe", scriptPath: SCRIPT } };
const AGENT_LINE = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ag1", content: "Async agent launched successfully." }] },
  toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1234567890abcdef", description: "Background sleep probe", prompt: "sleep", canContinueAgent: true } };
const RESUMED_LINE = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_send1", content: "Resuming agent" }] },
  toolUseResult: { success: true, message: "Resuming agent a9999999999999999", resumedAgentId: "a9999999999999999" } };
const BASH_LINE = (task: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash_" + task, content: "ok" }] }, toolUseResult: { stdout: "", backgroundTaskId: task } });
const DONE_LINE = (task: string) => ({ type: "user", message: { role: "user", content: `<task-notification>\n<task-id>${task}</task-id>\n<status>completed</status>\n</task-notification>` } });
const facts = (lines: unknown[], ids: string[]) => {
  const acc = { launches: new Map(), args: new Map(), openShells: new Set<string>() };
  for (const l of lines) readTranscriptLine(typeof l === "string" ? l : JSON.stringify(l), new Set(ids), acc);
  return acc;
};

test("transcript: running workflows (run id, script, args), background agents (also once continued) and open shells", () => {
  const f = facts([WF_USE, WF_LINE, "garbage toolUseResult", AGENT_LINE, RESUMED_LINE, BASH_LINE("b1"), BASH_LINE("b2"), DONE_LINE("b1"), { type: "assistant", message: { content: [] } }], ["toolu_wf1", "toolu_ag1", "toolu_send1"]);
  assert.deepEqual(f.launches.get("toolu_wf1"), { kind: "workflow", name: "resume-probe", runId: "wf_test-001", scriptPath: SCRIPT });
  assert.equal(f.args.get("toolu_wf1"), JSON.stringify({ question: "¿por qué?", n: 3 }));
  assert.deepEqual(f.launches.get("toolu_ag1"), { kind: "agent", description: "Background sleep probe", agentId: "a1234567890abcdef" });
  assert.deepEqual(f.launches.get("toolu_send1"), { kind: "agent", description: "", agentId: "a9999999999999999" }, "an agent already continued once is continued again");
  assert.deepEqual([...f.openShells], ["b2"], "a shell whose task notification came is closed");
  const midTurn = { type: "attachment", attachment: { type: "queued_command", prompt: "<task-notification>\n<task-id>b2</task-id>\n<status>completed</status>\n</task-notification>" } };
  assert.deepEqual([...facts([BASH_LINE("b2"), midTurn], []).openShells], [], "a notification that arrived mid-turn closes it too");
  assert.deepEqual([...facts([BASH_LINE("b3"), { type: "queue-operation", operation: "enqueue", content: "<task-id>b3</task-id> completed" }], []).openShells], []);
  const MONITOR = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mon", content: "Monitor started" }] }, toolUseResult: { taskId: "bmon1", persistent: true, timeoutMs: 0 } };
  const event = { type: "queue-operation", operation: "enqueue", content: "<task-notification><task-id>bmon1</task-id><summary>log line</summary><event>ERROR x</event></task-notification>" };
  const ended = { type: "user", message: { role: "user", content: "<task-notification><task-id>bmon1</task-id><status>completed</status></task-notification>" } };
  assert.deepEqual([...facts([MONITOR, event], []).openShells], ["bmon1"], "a Monitor is open, and an event does not close it");
  assert.deepEqual([...facts([MONITOR, event, ended], []).openShells], [], "its final notification does");
  assert.deepEqual([...facts([WF_LINE], []).openShells], [], "a workflow taskId is not a shell");
  assert.equal(facts([WF_USE, WF_LINE], ["toolu_other"]).launches.size, 0, "only the calls still running");
});

test("the continuation message says what was cut and how to pick each part up", () => {
  const m = continuationMessage({
    turn: true, shells: true, others: ["tarea\nsin rastro"], nonce: "abcd1234",
    launches: [{ kind: "workflow", name: "resume-probe", runId: "wf_test-001", scriptPath: "/x/a.js", args: "{\"n\":3}" }, { kind: "agent", description: "Background sleep probe", agentId: "a1234567890abcdef" }],
  });
  assert.match(m, /^\[LLMswapper · aviso abcd1234\] Se ha cambiado la cuenta de Claude/);
  assert.match(m, /Tu respuesta en curso/);
  assert.match(m, /scriptPath "\/x\/a\.js", resumeFromRunId "wf_test-001" y los mismos args que la primera vez \(\{"n":3\}\)/);
  assert.match(m, /no lo relances desde cero/);
  assert.match(m, /SendMessage a ese id/);
  assert.match(m, /«tarea sin rastro»: búscala en esta conversación/, "one line each, no line breaks smuggled in");
  assert.match(m, /comandos en segundo plano/);
  assert.match(m, /comprueba en qué estado quedó/);
  assert.ok(m.includes("Si te llega otra copia de este aviso (abcd1234), ignórala."));
  const long = continuationMessage({ turn: false, shells: false, others: [], nonce: "n", launches: [{ kind: "workflow", name: "w", runId: "wf_1", scriptPath: "/s.js", args: JSON.stringify("x".repeat(5000)) }] });
  assert.match(long, /los mismos args que la primera vez \(están en esta conversación\)/);
  assert.match(continuationMessage({ turn: false, shells: false, others: [], launches: [], nonce: "n" }), /Nada que se pudiera identificar/);
});

const STOP_AGENTS = [
  { id: id(21), statuses: ["idle"], sessionId: sid(21), runtimeInfo: live, subs: [
    { id: "toolu_wf1", title: "Workflow", description: "probe" }, { id: "toolu_ag1", title: "Agent", description: "Background sleep probe" },
    { id: "toolu_lost", title: "Agent", description: "tarea sin rastro" }, { id: "toolu_nested", title: "Agent", description: "nieto", parentSubagentId: "toolu_ag1" }] },
  { id: id(22), statuses: ["running"], sessionId: sid(22), runtimeInfo: live },
  { id: id(23), statuses: ["idle"], sessionId: sid(23), runtimeInfo: live },
  { id: id(24), statuses: ["idle"], sessionId: sid(24), runtimeInfo: live },
  { id: id(25), statuses: ["idle"], sessionId: sid(25), runtimeInfo: { model: null } },
  { id: id(26), statuses: ["idle", "running"], sessionId: sid(26), runtimeInfo: live }, // a turn starts right before the reload
  { id: id(31), statuses: ["running"], sessionId: sid(31), runtimeInfo: live, refreshFails: 2 },
  { id: id(32), statuses: ["running", "running", "idle"], sessionId: sid(32), runtimeInfo: live, lostNotice: true }, // idle once reloaded
  { id: id(33), statuses: ["running"], sessionId: sid(33), runtimeInfo: live, labels: { "paseo.parent-agent-id": "bbbbbbbb-0000-4000-8000-0000000000aa" } },
  { id: id(34), statuses: ["initializing"], sessionId: sid(34), runtimeInfo: live },
  { id: id(35), statuses: ["running"], sessionId: "", runtimeInfo: live },
  { id: id(36), statuses: ["running"], sessionId: sid(36), runtimeInfo: live },
  { id: id(37), statuses: ["running"], sessionId: sid(37), runtimeInfo: live, sendFails: 1 },
  { id: id(38), statuses: ["idle"], sessionId: sid(38), runtimeInfo: live, refreshFails: 2, subs: [{ id: "toolu_w38", title: "Workflow", description: "w" }] }, // its process survives the failed reload
  { id: id(40), statuses: ["running"], sessionId: sid(40), runtimeInfo: live, refreshFails: 2 }, // same, with a reply in progress
  { id: id(39), statuses: ["running"], sessionId: sid(39), runtimeInfo: live },
];
const STOP_FAST = { settleMs: 50, deliverMs: 1500 };

test("helper end to end, stop mode: working sessions are reloaded at once and told how to continue; quiet ones are just reloaded", { timeout: 120_000 }, async () => {
  const { dir, cli, calls, transcript } = setup({ agents: STOP_AGENTS });
  transcript(sid(21), [{ type: "user", message: { content: "hola" } }, WF_USE, WF_LINE, "garbage", AGENT_LINE, BASH_LINE("b9")]);
  const fakes = await Promise.all([fakeClaude(dir, sid(21), "none"), fakeClaude(dir, sid(23), "shell"), fakeClaude(dir, sid(24), "none"), fakeClaude(dir, sid(26), "none")]);
  try {
    const run = createQuietRunner(cli, STOP_FAST);
    assert.ok(run);
    const r = await run("stop", [id(21), id(22), id(23), id(24), id(25), id(26)]);
    assert.deepEqual(results(r), { [id(21)]: "stopped", [id(22)]: "stopped", [id(23)]: "stopped", [id(24)]: "reloaded", [id(25)]: "sin-proceso", [id(26)]: "stopped" });
    assert.deepEqual([...(r.actedAt?.keys() ?? [])], [id(21), id(22), id(23), id(24), id(26)], "the helper says when it acted on each");
    const c = calls();
    assert.deepEqual(c.filter((x) => "refresh" in x).map((x) => x.refresh), [id(21), id(22), id(23), id(24), id(26)]);
    const sends = c.filter((x) => "send" in x) as { send: string; text: string; opts: { activeTurnBehavior?: string; messageId?: string } }[];
    assert.deepEqual(sends.map((x) => x.send), [id(21), id(22), id(23), id(26)], "only the sessions whose work was cut are told to continue");
    assert.ok(sends.every((x) => x.opts.activeTurnBehavior === "steer" && typeof x.opts.messageId === "string"), "never interrupts a message typed meanwhile; one id per notice");
    for (const x of sends) assert.ok(c.findIndex((y) => y.refresh === x.send) < c.indexOf(x), "told after the reload");
    const text = (agent: string) => sends.find((x) => x.send === agent)?.text ?? "";
    assert.match(text(id(21)), /resumeFromRunId "wf_test-001" y los mismos args que la primera vez \(\{"question":"¿por qué\?","n":3\}\)/);
    assert.ok(text(id(21)).includes(`scriptPath "${SCRIPT}"`));
    assert.match(text(id(21)), /«Background sleep probe» \(id a1234567890abcdef\)/);
    assert.match(text(id(21)), /«tarea sin rastro»: búscala/);
    assert.doesNotMatch(text(id(21)), /nieto/, "nested subagents are their parent's business");
    assert.doesNotMatch(text(id(21)), /Tu respuesta en curso/);
    assert.match(text(id(22)), /Tu respuesta en curso/);
    assert.match(text(id(23)), /comandos en segundo plano/);
    assert.match(text(id(26)), /Tu respuesta en curso/);
  } finally {
    for (const x of fakes) { kill(x.childPid); x.claude.kill(); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("helper end to end, stop mode: what it does not stop, and the notice it cannot lose", { timeout: 120_000 }, async () => {
  const { dir, cli, calls, transcript } = setup({ agents: STOP_AGENTS });
  for (const n of [31, 32, 37]) transcript(sid(n), [{ type: "user", message: { content: "hola" } }]);
  // Run through something that is not Claude Code (wsl -e claude, docker exec...): the wrapper carries the session id.
  const wrapper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--resume=${sid(36)}`], { stdio: "ignore" }); // "--": not a Node option
  const survivor = await fakeClaude(dir, sid(38), "none");
  const survivor2 = await fakeClaude(dir, sid(40), "none");
  try {
    await new Promise((r) => setTimeout(r, 500));
    const run = createQuietRunner(cli, STOP_FAST);
    assert.ok(run);
    const check = await run("check", [id(33), id(34), id(35), id(36)]);
    assert.deepEqual(results(check), { [id(33)]: "busy:delegado", [id(34)]: "busy:cargando", [id(35)]: "busy:sin-sesion", [id(36)]: "busy:sin-visibilidad" },
      "the check classifies them as the stop round acts: none counted as stoppable");
    const r = await run("stop", [id(31), id(32), id(33), id(34), id(35), id(36), id(37), id(38), id(39), id(40)], { waitOnly: [id(39)] });
    const res: Record<string, string | undefined> = results(r);
    assert.match(String(res[id(31)]), /^stopped-sin-recarga:Timed out closing/, "the reload failed twice, the notice still went out");
    assert.equal(res[id(32)], "stopped-sin-aviso:el aviso no llegó a la conversación", "never reached the transcript: reported, after one resend");
    assert.deepEqual([res[id(33)], res[id(34)], res[id(35)], res[id(36)]], ["busy:delegado", "busy:cargando", "busy:sin-sesion", "busy:sin-visibilidad"]);
    assert.equal(res[id(37)], "stopped", "a send that times out is retried");
    assert.match(String(res[id(38)]), /^error:no se pudo recargar: Timed out/, "the old process is still there: nothing was cut, nothing to continue, tried again later");
    assert.match(String(res[id(40)]), /^stopped-sin-recarga:/, "Paseo interrupts the reply before the reload fails: that much was cut, and is said");
    assert.equal(res[id(39)], "busy:turno", "an agent that only waits is never stopped in a stop round");
    const c = calls();
    const refreshed = c.filter((x) => "refresh" in x).map((x) => x.refresh);
    assert.deepEqual([...new Set(refreshed)], [id(31), id(32), id(37), id(38), id(40)], "the delegated child, a loading agent, one without a session, one out of sight and one that only waits are left alone");
    assert.equal(c.filter((x) => x.send === id(38)).length, 0, "no notice for work that was not cut");
    const t40 = String((c.find((x) => x.send === id(40)) as { text?: string } | undefined)?.text);
    assert.ok(t40.includes("Tu respuesta en curso") && !t40.includes("comandos en segundo plano"), t40);
    const sends = c.filter((x) => "send" in x) as { send: string; opts: { messageId: string } }[];
    const of = (a: string) => sends.filter((x) => x.send === a).map((x) => x.opts.messageId);
    assert.equal(of(id(32)).length, 2);
    assert.notEqual(of(id(32))[0], of(id(32))[1], "a notice that never arrived is sent again as a new message");
    assert.equal(of(id(37)).length, 2);
    assert.equal(of(id(37))[0], of(id(37))[1], "a retried send keeps its id, so it is never delivered twice");
  } finally {
    wrapper.kill();
    kill(survivor.childPid); survivor.claude.kill();
    kill(survivor2.childPid); survivor2.claude.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("helper end to end, stop mode: working agents are stopped before quiet ones get their second look", { timeout: 120_000 }, async () => {
  const { dir, cli, calls } = setup({ agents: STOP_AGENTS });
  const quietOne = await fakeClaude(dir, sid(24), "none");
  try {
    const run = createQuietRunner(cli, { settleMs: 50, deliverMs: 1500, secondLookMs: 300 });
    assert.ok(run);
    const r = await run("stop", [id(24), id(22)]); // the quiet one comes first in the list
    assert.deepEqual(results(r), { [id(24)]: "reloaded", [id(22)]: "stopped" });
    assert.deepEqual(calls().filter((x) => "refresh" in x).map((x) => x.refresh), [id(22), id(24)], "the working one is not kept waiting on the old account");
  } finally {
    kill(quietOne.childPid); quietOne.claude.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
