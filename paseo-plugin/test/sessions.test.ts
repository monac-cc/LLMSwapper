import assert from "node:assert/strict";
import { test } from "node:test";
import { createActiveWatch, hostActiveId } from "../server/active-watch.ts";
import { createHandlers } from "../server/handlers.ts";
import type { CliResult } from "../server/paseo-cli.ts";
import { resolveCli } from "../server/paseo-cli.ts";
import { createSessionRefresher, parseAgentList } from "../server/session-refresh.ts";
import type { ExecResults } from "../shared/exec.ts";
import { swapNoticeLines } from "../shared/swap-notice.ts";
import type { SwapView } from "../shared/views.ts";

const A = "6acdee01-5bdf-4441-9429-2307ba0e4532"; // idle claude
const B = "f3eb24c4-2c08-4fe5-bd09-e8f3464b009c"; // running claude
const C = "8802dc9f-a4b3-45e3-8443-4aff46f96398"; // closed claude
const D = "11ec2c5f-0640-4ce0-a037-6f86b8ec5871"; // idle codex
const LIST = JSON.stringify([
  { id: A, provider: "claude/claude-opus-5-5", status: "idle" },
  { id: B, provider: "claude/claude-opus-5-5", status: "running" },
  { id: C, provider: "claude/claude-opus-5-5", status: "closed" },
  { id: D, provider: "codex/gpt-5", status: "idle" },
  { id: "not-a-uuid", provider: "claude", status: "idle" },
]);

function fakeCli(inspect: Record<string, string> = {}) {
  const calls: string[][] = [];
  const run = async (args: readonly string[]): Promise<CliResult> => {
    calls.push([...args]);
    if (args[0] === "agent" && args[1] === "ls") return { code: 0, stdout: LIST, stderr: "" };
    if (args[0] === "agent" && args[1] === "inspect") return { code: 0, stdout: JSON.stringify({ Status: inspect[args[2]] ?? "idle" }), stderr: "" };
    if (args[0] === "agent" && args[1] === "reload") return { code: 0, stdout: JSON.stringify({ status: "reloaded" }), stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls, reloads: () => calls.filter((c) => c[1] === "reload").map((c) => c[2]) };
}
const quiet = { log: () => undefined, sleep: async () => undefined };

test("CLI agent list is parsed tolerantly", () => {
  assert.equal(parseAgentList(LIST).length, 5);
  assert.deepEqual(parseAgentList("not json"), []);
  assert.deepEqual(parseAgentList(JSON.stringify({ entries: [] })), []);
});

test("apply reloads idle Claude agents now and defers the busy ones; codex, closed and bad ids are left alone", async () => {
  const cli = fakeCli();
  const r = createSessionRefresher({ cli: cli.run, ...quiet });
  const s = await r.apply();
  await r.idle();
  assert.deepEqual(s, { reloading: 1, deferred: 1, note: null });
  assert.deepEqual(cli.reloads(), [A]);
  assert.deepEqual(r.pendingAgents(), [B]);
  assert.ok(cli.calls[0].includes("--global"), "lists agents of every directory");
});

test("a deferred agent is reloaded after its turn, but not if it already started another one", async () => {
  const inspect: Record<string, string> = { [B]: "running" };
  const cli = fakeCli(inspect);
  const r = createSessionRefresher({ cli: cli.run, ...quiet });
  await r.apply();
  await r.idle();
  await r.onTurnEnded(B); // the user sent another message right away
  await r.idle();
  assert.deepEqual(cli.reloads(), [A]);
  assert.deepEqual(r.pendingAgents(), [B], "still owed a reload");
  inspect[B] = "idle";
  await r.onTurnEnded(B);
  await r.idle();
  assert.deepEqual(cli.reloads(), [A, B]);
  assert.deepEqual(r.pendingAgents(), []);
  await r.onTurnEnded(A); // not deferred: nothing happens
  assert.deepEqual(cli.reloads(), [A, B]);
});

test("the watch and the panel reporting the same change share one round", async () => {
  let t = 1000;
  const cli = fakeCli();
  const r = createSessionRefresher({ cli: cli.run, ...quiet, now: () => t });
  const [x, y] = await Promise.all([r.apply(), r.apply()]);
  assert.equal(x, y);
  await r.idle();
  assert.deepEqual(cli.reloads(), [A]);
  t += 6000; // a later, deliberate swap gets its own round
  await r.apply();
  await r.idle();
  assert.deepEqual(cli.reloads(), [A, A]);
});

test("without the Paseo CLI nothing runs and the note says so", async () => {
  const r = createSessionRefresher({ cli: null, ...quiet });
  const s = await r.apply();
  assert.equal(s.reloading + s.deferred, 0);
  assert.match(s.note ?? "", /CLI de Paseo/);
});

test("CLI resolution: desktop install launches Paseo.exe without cmd.exe; Windows without it gives up", () => {
  const exe = "C:\\Users\\u\\AppData\\Local\\Programs\\Paseo\\Paseo.exe";
  const c = resolveCli(exe, "win32", () => true, undefined);
  assert.ok(c);
  assert.equal(c.command, exe);
  assert.equal(c.env.ELECTRON_RUN_AS_NODE, "1");
  assert.ok(c.prefix.some((p) => p.endsWith("index.js")));
  assert.equal(resolveCli(exe, "win32", () => false, undefined), null);
  assert.equal(resolveCli("/usr/bin/node", "linux", () => false, undefined)?.command, "paseo");
});

test("CLI resolution: macOS app bundle, Linux desktop and npm daemons", () => {
  const has = (paths: string[]) => (p: string) => paths.includes(p);
  const mac = "/Applications/Paseo.app/Contents/MacOS/Paseo";
  const macRes = "/Applications/Paseo.app/Contents/Resources";
  const m = resolveCli(mac, "darwin", has([`${macRes}/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js`, `${macRes}/app.asar`]), undefined);
  assert.equal(m?.command, mac);
  assert.ok(m?.prefix.includes(`${macRes}/app.asar/node_modules/@getpaseo/cli/dist/index.js`), JSON.stringify(m));
  const lin = "/opt/Paseo/paseo";
  const l = resolveCli(lin, "linux", has(["/opt/Paseo/resources/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js", "/opt/Paseo/resources/app.asar"]), undefined);
  assert.equal(l?.env.ELECTRON_RUN_AS_NODE, "1");
  // npm/CLI daemon: plugin-process.js lives in node_modules/@getpaseo/server; the CLI is its sibling package.
  const nm = "/home/u/.npm-global/lib/node_modules";
  const entry = `${nm}/@getpaseo/server/dist/server/server/plugins/plugin-process.js`;
  const n = resolveCli("/usr/bin/node", "linux", has([`${nm}/@getpaseo/cli/dist/index.js`]), entry);
  assert.deepEqual(n, { command: "/usr/bin/node", prefix: [`${nm}/@getpaseo/cli/dist/index.js`], env: {} });
  // same on Windows with backslashes
  const wnm = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules";
  const w = resolveCli("C:\\Program Files\\nodejs\\node.exe", "win32", has([`${wnm}\\@getpaseo\\cli\\dist\\index.js`]), `${wnm}\\@getpaseo\\server\\dist\\server\\server\\plugins\\plugin-process.js`);
  assert.equal(w?.prefix[0], `${wnm}\\@getpaseo\\cli\\dist\\index.js`);
});

const targets = (active: string | null): ExecResults => ({
  targets: { s: 200, e: null, j: { targets: [{ id: "host", activeId: active }, { id: "wsl:Ubuntu", activeId: "acc_000000" }] } },
});

test("active watch: first reading is not a change; outside changes fire once; panel swaps are noted", async () => {
  let active: string | null = "acc_111111";
  const changes: [string | null, string | null][] = [];
  const w = createActiveWatch({ getPort: async () => 7373, exec: async () => targets(active), onChange: (a, b) => changes.push([a, b]) });
  await w.tick();
  assert.deepEqual(changes, []);
  active = "acc_222222"; // LLMswapper auto-rotation
  await w.tick();
  await w.tick();
  assert.deepEqual(changes, [["acc_111111", "acc_222222"]]);
  w.note("acc_333333"); // panel swap already handled
  active = "acc_333333";
  await w.tick();
  assert.equal(changes.length, 1);
  assert.equal(hostActiveId({ targets: { s: 0, j: null, e: "ECONNREFUSED" } }), undefined, "LLMswapper down is not a change");
});

const swapResult = (target: string): ExecResults => ({
  swap: { s: 200, e: null, j: { ok: true, target, targetLabel: target === "host" ? "Windows" : "Ubuntu", verified: true, warnings: [], account: { id: "acc_222222", label: "CTO" } } },
});

test("handlers attach the session summary to a successful swap, and a failing session step never fails the swap", async () => {
  const seen: string[] = [];
  const ok = createHandlers(async () => 7373, async () => swapResult("host"), Date.now, async (s) => {
    seen.push(s.target);
    return { reloading: 2, deferred: 1, note: null };
  });
  const r = await ok.swap({ accountId: "acc_222222", target: "host" });
  assert.ok(r.ok);
  assert.deepEqual(r.data.sessions, { reloading: 2, deferred: 1, note: null });
  assert.deepEqual(seen, ["host"]);
  const broken = createHandlers(async () => 7373, async () => swapResult("host"), Date.now, async () => { throw new Error("cli crashed"); });
  const r2 = await broken.swap({ accountId: "acc_222222", target: "host" });
  assert.ok(r2.ok);
  assert.equal(r2.data.sessions, null);
});

const view = (over: Partial<SwapView>): SwapView => ({
  target: "host", targetLabel: "Windows", accountId: "acc_222222", accountLabel: "CTO", verified: true,
  warnings: ["Claude Code está abierto en Windows (3 proceso(s)). El cambio se aplicará a sesiones NUEVAS."],
  usage: null, sessions: null, ...over,
});

test("notice: LLMswapper's 'sesiones NUEVAS' is replaced by what really happens", () => {
  const host = swapNoticeLines(view({ sessions: { reloading: 2, deferred: 1, note: null } }));
  assert.ok(!host.some((l) => /NUEVAS/.test(l)));
  assert.ok(host.some((l) => /2 sesiones de Paseo se recargan ya y 1 sesión al terminar su turno/.test(l)), host.join(" | "));
  assert.ok(host.some((l) => /fuera de Paseo/.test(l)));
  const wsl = swapNoticeLines(view({ target: "wsl:Ubuntu", targetLabel: "Ubuntu" }));
  assert.ok(wsl.some((l) => /Ubuntu \(3 procesos\).*claude -c/.test(l)), wsl.join(" | "));
  const none = swapNoticeLines(view({ warnings: [], sessions: { reloading: 0, deferred: 0, note: null } }));
  assert.deepEqual(none, ["No había sesiones de Paseo abiertas que recargar."]);
});
