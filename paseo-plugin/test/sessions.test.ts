import assert from "node:assert/strict";
import { test } from "node:test";
import { createActiveWatch, hostActiveId } from "../server/active-watch.ts";
import { createHandlers } from "../server/handlers.ts";
import { resolveCli } from "../server/paseo-cli.ts";
import { createQuietRunner, parseQuietOutput, type QuietMode, type QuietRoundOptions, type QuietRun } from "../server/quiet-helper.ts";
import { CHECK_FAILED_NOTE, CHECK_FAILED_STOP_NOTE, MAX_WAIT_MS, NO_HELPER_NOTE, type SessionsSummary, createSessionRefresher } from "../server/session-refresh.ts";
import type { ExecResults } from "../shared/exec.ts";
import { swapNoticeLines } from "../shared/swap-notice.ts";
import type { SwapView } from "../shared/views.ts";

const A = "6acdee01-5bdf-4441-9429-2307ba0e4532";
const B = "f3eb24c4-2c08-4fe5-bd09-e8f3464b009c";
const C = "8802dc9f-a4b3-45e3-8443-4aff46f96398";

/**
 * Fake quiet helper. `state`: per live agent, "quiet", "sin-proceso" or the busy reason ("turno",
 * "subagentes", "segundo-plano", "sin-visibilidad"); agents not in it are gone. Like the real one, "reload"
 * re-checks each agent, and "stop" stops and continues the working ones.
 */
function fakeQuiet(state: Record<string, string>, opts: { delayMs?: number } = {}) {
  const calls: { mode: string; ids: readonly string[] | "all" }[] = [];
  const reloads: string[] = [];
  const stops: string[] = [];
  let inFlight = 0, maxInFlight = 0;
  const ctl = { fail: null as string | null, beforeReload: null as (() => void) | null, clock: () => Date.now() };
  const actedAt = new Map<string, number>();
  const run = async (mode: QuietMode, ids: readonly string[] | "all", round: QuietRoundOptions = {}): Promise<QuietRun> => {
    calls.push({ mode, ids });
    const waitOnly = new Set(round.waitOnly ?? []);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (ctl.fail) return { results: new Map(), error: ctl.fail };
      if (mode === "reload") ctl.beforeReload?.();
      const results = new Map<string, string>();
      for (const id of ids === "all" ? Object.keys(state) : ids) {
        const st = state[id];
        if (st === undefined) results.set(id, "gone");
        else if (st === "sin-proceso") results.set(id, st);
        else if (mode === "stop" && !waitOnly.has(id) && ["turno", "subagentes", "segundo-plano"].includes(st)) { stops.push(id); actedAt.set(id, ctl.clock()); results.set(id, "stopped"); state[id] = "turno"; } // continuing, on the new account
        else if (st !== "quiet") results.set(id, `busy:${st}`);
        else if (mode === "check") results.set(id, "quiet");
        else { reloads.push(id); actedAt.set(id, ctl.clock()); results.set(id, "reloaded"); state[id] = "sin-proceso"; } // Paseo starts the next process at the next turn
      }
      return { results, error: null, actedAt: new Map([...actedAt].filter(([k]) => results.has(k))) };
    } finally { inFlight--; }
  };
  return { run, calls, reloads, stops, ctl, maxInFlight: () => maxInFlight };
}
/** The tests below this line until "stop and continue" are about the "wait" mode. */
const silent = { log: () => undefined, sleep: async () => undefined, busySessions: async () => "wait" as const };
/** A summary without the mode it was made under (checked on its own). */
const summary = ({ mode: _mode, ...rest }: SessionsSummary) => rest;

test("apply reloads the quiet agents now and defers the busy ones", async () => {
  const q = fakeQuiet({ [A]: "quiet", [B]: "turno" });
  const r = createSessionRefresher({ quiet: q.run, ...silent });
  const s = await r.apply();
  await r.idle();
  assert.deepEqual(summary(s), { reloading: 1, stopped: 0, deferred: 1, unseen: 0, unchecked: 0, note: null });
  assert.deepEqual(q.reloads, [A]);
  assert.deepEqual(r.pendingAgents(), [B]);
  assert.deepEqual(q.calls[0], { mode: "check", ids: "all" }, "every live Claude agent of the daemon");
  assert.deepEqual(q.calls[1], { mode: "reload", ids: [A] }, "the helper checks A again right before reloading it");
});

test("a deferred agent is reloaded after its turn, but not if it already started another one", async () => {
  const state: Record<string, string> = { [A]: "quiet", [B]: "turno" };
  const q = fakeQuiet(state);
  const r = createSessionRefresher({ quiet: q.run, ...silent });
  await r.apply();
  await r.idle();
  await r.onTurnEnded(B); // the user sent another message right away
  await r.idle();
  assert.deepEqual(q.reloads, [A]);
  assert.deepEqual(r.pendingAgents(), [B], "still owed a reload");
  state[B] = "quiet";
  await r.onTurnEnded(B);
  await r.idle();
  assert.deepEqual(q.reloads, [A, B]);
  assert.deepEqual(r.pendingAgents(), []);
  const n = q.calls.length;
  await r.onTurnEnded(A); // not owed anything: the helper is not even run
  assert.equal(q.calls.length, n);
});

test("the watch and the panel reporting the same change share one round", async () => {
  let t = 1000;
  const state: Record<string, string> = { [A]: "quiet" };
  const q = fakeQuiet(state);
  q.ctl.clock = () => t;
  const r = createSessionRefresher({ quiet: q.run, ...silent, now: () => t });
  const [x, y] = await Promise.all([r.apply(), r.apply()]);
  assert.equal(x, y);
  await r.idle();
  assert.deepEqual(q.reloads, [A]);
  t += 6000; // a later, deliberate swap gets its own round
  state[A] = "quiet"; // A was used meanwhile: a new process, on the previous account
  await r.apply();
  await r.idle();
  assert.deepEqual(q.reloads, [A, A]);
});

test("without the helper nothing runs and the note says so", async () => {
  const r = createSessionRefresher({ quiet: null, ...silent });
  const s = await r.apply();
  await r.recheck();
  assert.deepEqual(summary(s), { reloading: 0, stopped: 0, deferred: 0, unseen: 0, unchecked: 0, note: NO_HELPER_NOTE });
  assert.equal(createQuietRunner(resolveCli("/usr/bin/node", "linux", () => false, undefined)), null, "bare paseo on PATH: no daemon client to ask");
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
  assert.deepEqual(n, { command: "/usr/bin/node", prefix: [`${nm}/@getpaseo/cli/dist/index.js`], env: {}, cliIndex: `${nm}/@getpaseo/cli/dist/index.js`, node: { command: "/usr/bin/node", env: {} } });
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
  const budgets: number[] = [];
  const ok = createHandlers(async () => 7373, async () => swapResult("host"), Date.now, async (s, budgetMs) => {
    seen.push(s.target);
    budgets.push(budgetMs);
    return { reloading: 2, stopped: 0, deferred: 1, unseen: 0, unchecked: 0, note: null };
  });
  const r = await ok.swap({ accountId: "acc_222222", target: "host" });
  assert.ok(r.ok);
  assert.deepEqual(r.data.sessions, { reloading: 2, stopped: 0, deferred: 1, unseen: 0, unchecked: 0, note: null });
  assert.deepEqual(seen, ["host"]);
  assert.ok(budgets[0] > 26_000 && budgets[0] <= 27_000, `the summary gets what is left of Paseo's 30 s RPC: ${budgets[0]}`);
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
  const host = swapNoticeLines(view({ sessions: { reloading: 2, stopped: 0, deferred: 1, unseen: 0, unchecked: 0, note: null } }));
  assert.ok(!host.some((l) => /NUEVAS/.test(l)));
  assert.ok(host.some((l) => /^2 sesiones de Paseo se recargan ya: conservan la conversación y siguen con la cuenta nueva\.$/.test(l)), host.join(" | "));
  assert.ok(host.some((l) => /^1 sesión sigue con la cuenta anterior hasta que termine lo que está haciendo, también en segundo plano; después cambia sola\.$/.test(l)), host.join(" | "));
  assert.ok(host.some((l) => /fuera de Paseo/.test(l)));
  const wsl = swapNoticeLines(view({ target: "wsl:Ubuntu", targetLabel: "Ubuntu" }));
  assert.ok(wsl.some((l) => /Ubuntu \(3 procesos\).*claude -c/.test(l)), wsl.join(" | "));
  const none = swapNoticeLines(view({ warnings: [], sessions: { reloading: 0, stopped: 0, deferred: 0, unseen: 0, unchecked: 0, note: null } }));
  assert.deepEqual(none, ["Ninguna sesión de Paseo tenía Claude en marcha: la próxima vez que escribas en una, ya irá con la cuenta nueva."]);
});

// --- never cut work: reload only QUIET agents (no turn, no running subagent, no background process) ---

test("background work is waited for: subagents or a background shell keep the agent on the old account until they end", async () => {
  const state: Record<string, string> = { [A]: "subagentes", [B]: "segundo-plano", [C]: "quiet" };
  const q = fakeQuiet(state);
  const r = createSessionRefresher({ quiet: q.run, ...silent });
  const s = await r.apply();
  await r.idle();
  assert.deepEqual(summary(s), { reloading: 1, stopped: 0, deferred: 2, unseen: 0, unchecked: 0, note: null });
  assert.deepEqual(q.reloads, [C], "nothing is cut");
  await r.recheck(); // still working
  await r.idle();
  assert.deepEqual(q.reloads, [C]);
  state[A] = "quiet"; // the workflow ended, with no new turn
  await r.recheck();
  await r.idle();
  assert.deepEqual(q.reloads, [C, A]);
  assert.deepEqual(r.pendingAgents(), [B], "its background shell still runs");
});

test("work that starts between the check and the reload is not cut: the reload round checks again", async () => {
  const state: Record<string, string> = { [A]: "quiet" };
  const q = fakeQuiet(state);
  q.ctl.beforeReload = () => { state[A] = "turno"; }; // a new message arrives right after the summary
  const r = createSessionRefresher({ quiet: q.run, ...silent });
  const s = await r.apply();
  await r.idle();
  assert.equal(s.reloading, 1, "the summary said it would reload");
  assert.deepEqual(q.reloads, [], "but it was busy by then");
  assert.deepEqual(r.pendingAgents(), [A]);
  q.ctl.beforeReload = null;
  state[A] = "quiet";
  await r.onTurnEnded(A);
  await r.idle();
  assert.deepEqual(q.reloads, [A]);
});

test("one helper at a time, and one reload per agent, however many triggers overlap", async () => {
  const state: Record<string, string> = { [A]: "quiet", [B]: "turno" };
  const q = fakeQuiet(state, { delayMs: 5 });
  const r = createSessionRefresher({ quiet: q.run, ...silent });
  const s = await r.apply();
  state[B] = "quiet";
  await Promise.all([r.onTurnEnded(B), r.onTurnEnded(B), r.recheck(), r.recheck()]);
  await r.idle();
  assert.equal(s.deferred, 1);
  assert.equal(q.maxInFlight(), 1);
  assert.deepEqual([...q.reloads].sort(), [A, B].sort());
  assert.deepEqual(r.pendingAgents(), []);
});

test("a failed check reloads nothing, says so, and retries every agent later", async () => {
  const logs: string[] = [];
  const q = fakeQuiet({ [A]: "quiet", [B]: "turno" });
  q.ctl.fail = "connect: ECONNREFUSED";
  const r = createSessionRefresher({ quiet: q.run, log: (m) => logs.push(m), sleep: async () => undefined, busySessions: async () => "wait" as const });
  const s = await r.apply();
  assert.deepEqual(summary(s), { reloading: 0, stopped: 0, deferred: 0, unseen: 0, unchecked: 0, note: CHECK_FAILED_NOTE });
  await r.recheck();
  await r.idle();
  assert.equal(logs.filter((l) => /ECONNREFUSED/.test(l)).length, 1, "the same error is logged once");
  assert.deepEqual(q.reloads, []);
  q.ctl.fail = null;
  await r.recheck();
  await r.idle();
  assert.deepEqual(q.calls.at(-1), { mode: "reload", ids: "all" });
  assert.deepEqual(q.reloads, [A]);
  assert.deepEqual(r.pendingAgents(), [B]);
});

test("an agent that stays busy for 12 h is let go, with a log line", async () => {
  let t = 0;
  const logs: string[] = [];
  const q = fakeQuiet({ [A]: "segundo-plano" });
  const r = createSessionRefresher({ quiet: q.run, log: (m) => logs.push(m), sleep: async () => undefined, busySessions: async () => "wait" as const, now: () => t });
  await r.apply();
  t += MAX_WAIT_MS - 60_000;
  await r.recheck();
  await r.idle();
  assert.deepEqual(r.pendingAgents(), [A]);
  t += 60_000;
  await r.recheck();
  await r.idle();
  assert.deepEqual(r.pendingAgents(), []);
  assert.ok(logs.some((l) => /6acdee01.*12 h/.test(l)), logs.join(" | "));
  const n = q.calls.length;
  await r.recheck();
  assert.equal(q.calls.length, n, "nothing left to check");
});

test("helper output is parsed defensively, and what was settled before a failure is kept", () => {
  const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n");
  const r = parseQuietOutput(`noise\n${lines({ id: A, r: "reloaded" }, { id: B, r: "busy:segundo-plano" }, { id: "not-an-id", r: "quiet" }, { id: C, r: 3 }, { done: true })}\n`);
  assert.deepEqual(r, { results: new Map([[A, "reloaded"], [B, "busy:segundo-plano"]]), error: null, actedAt: new Map() });
  assert.deepEqual(parseQuietOutput(lines({ beat: true }, { id: A, r: "stopped", at: 1234 }, { done: true })).actedAt, new Map([[A, 1234]]), "when it acted; heartbeats are ignored");
  assert.deepEqual(parseQuietOutput(lines({ error: "connect: no daemon" })), { results: new Map(), error: "connect: no daemon", actedAt: new Map() });
  const cut = parseQuietOutput(lines({ id: A, r: "reloaded" })); // killed before {done}
  assert.deepEqual([...cut.results], [[A, "reloaded"]]);
  assert.ok(cut.error);
  assert.ok(parseQuietOutput("garbage").error);
});

test("sessions without a live Claude Code process are neither reloaded nor waited for", async () => {
  const q = fakeQuiet({ [A]: "sin-proceso", [B]: "turno", [C]: "sin-proceso" });
  const r = createSessionRefresher({ quiet: q.run, ...silent });
  const s = await r.apply();
  await r.idle();
  assert.deepEqual(summary(s), { reloading: 0, stopped: 0, deferred: 1, unseen: 0, unchecked: 0, note: null });
  assert.deepEqual(q.reloads, []);
  assert.deepEqual(r.pendingAgents(), [B]);
});

test("a reload round that dies half-way keeps what it settled: nobody is reloaded twice", async () => {
  const q = fakeQuiet({ [A]: "quiet", [B]: "quiet" });
  const real = q.run;
  let cut = true;
  const run = async (mode: QuietMode, ids: readonly string[] | "all"): Promise<QuietRun> => {
    const r = await real(mode, ids);
    if (mode !== "reload" || !cut) return r;
    cut = false;
    return { results: new Map([...r.results].slice(0, 1)), error: "el ayudante dejó de responder" }; // A done, then killed
  };
  const r = createSessionRefresher({ quiet: run, ...silent });
  await r.apply();
  await r.idle();
  assert.deepEqual(r.pendingAgents(), [B]);
  await r.recheck();
  await r.idle();
  assert.deepEqual(q.calls.filter((c) => c.mode === "reload").map((c) => c.ids), [[A, B], [B]]);
  assert.deepEqual(r.pendingAgents(), []);
});

test("a round that started before a newer swap does not settle that swap's waits", async () => {
  const state: Record<string, string> = { [A]: "quiet", [B]: "quiet" };
  const q = fakeQuiet(state);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let gated = true;
  const run = async (mode: QuietMode, ids: readonly string[] | "all"): Promise<QuietRun> => {
    if (mode === "reload" && gated) { gated = false; const r = await q.run(mode, ids); await gate; return r; } // reloads, then reports late
    return q.run(mode, ids);
  };
  let t = 0;
  q.ctl.clock = () => t; // round 1 reloads at t=0, before swap 2
  const r = createSessionRefresher({ quiet: run, ...silent, now: () => t });
  await r.apply(); // round 1 reloads A and B, and is slow to report
  state[A] = "turno"; // you write to A: a new process, on the account of swap 1
  t += 10_000;
  const second = await r.apply(); // swap 2 finds A busy
  assert.equal(second.deferred, 1);
  release();
  await r.idle();
  assert.deepEqual(r.pendingAgents(), [A], "round 1's 'reloaded' predates swap 2: A still owes swap 2 a reload");
  state[A] = "quiet";
  await r.onTurnEnded(A);
  await r.idle();
  assert.deepEqual(q.reloads, [A, B, A]);
});

test("a check that fails while an older catch-up round runs is still owed its own round", async () => {
  const q = fakeQuiet({ [A]: "turno" });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let reloads = 0;
  const run = async (mode: QuietMode, ids: readonly string[] | "all"): Promise<QuietRun> => {
    if (mode === "check") return { results: new Map(), error: "connect: ECONNREFUSED" };
    reloads++;
    if (reloads === 1) await gate; // the first catch-up round is slow, and works
    if (reloads === 2) return { results: new Map(), error: "connect: ECONNREFUSED" }; // the newer swap's round fails
    return q.run(mode, ids);
  };
  let t = 0;
  const r = createSessionRefresher({ quiet: run, ...silent, now: () => t });
  await r.apply(); // fails: a catch-up "all" round starts, and is slow
  t += 10_000;
  await r.apply(); // a newer swap, whose check fails too, while that round runs
  release();
  await r.idle();
  assert.equal(reloads, 2);
  const before = q.calls.length;
  await r.recheck();
  await r.idle();
  assert.deepEqual(q.calls.slice(before), [{ mode: "reload", ids: "all" }], "the older round's success did not settle the newer swap");
});

test("the swap does not wait behind a reload round, nor for a check that hangs", async () => {
  const q = fakeQuiet({ [A]: "quiet" });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let hang = false;
  const run = async (mode: QuietMode, ids: readonly string[] | "all"): Promise<QuietRun> => {
    if (mode === "reload") await gate; // a long reload round (one agent restarts in ~10 s)
    if (mode === "check" && hang) return new Promise<QuietRun>(() => undefined);
    return q.run(mode, ids);
  };
  let t = 0;
  const r = createSessionRefresher({ quiet: run, ...silent, now: () => t, summaryMs: 50 });
  await r.apply(); // schedules A's reload, which now hangs on the gate
  t += 10_000;
  const second = await r.apply(); // another swap while that round runs
  assert.equal(second.reloading, 1, "answered at once from its own check");
  t += 10_000;
  hang = true;
  const third = await r.apply();
  assert.equal(third.note, CHECK_FAILED_NOTE, "a hung check gives up within summaryMs");
  release();
  await r.idle();
  assert.deepEqual(q.reloads, [A], "one reload: the queued rounds found A settled");
});

test("CLI resolution: npm nests the server inside the CLI package (homelab, nvm in WSL)", () => {
  const root = "/usr/local/lib/node_modules/@getpaseo/cli";
  const entry = `${root}/node_modules/@getpaseo/server/dist/server/server/plugins/plugin-process.js`;
  const c = resolveCli("/usr/bin/node", "linux", (p) => p === `${root}/dist/index.js`, entry);
  assert.equal(c?.cliIndex, `${root}/dist/index.js`);
  assert.deepEqual(c?.node, { command: "/usr/bin/node", env: {} });
});

// --- stop and continue (the default): the old account spends nothing more ---

test("by default a swap stops working sessions at once and has them continue on the new account", async () => {
  const D = "11ec2c5f-0640-4ce0-a037-6f86b8ec5871";
  const E = "50aa64c2-1111-4222-8333-444455556666";
  const q = fakeQuiet({ [A]: "quiet", [B]: "subagentes", [C]: "segundo-plano", [D]: "sin-proceso", [E]: "sin-visibilidad" });
  const r = createSessionRefresher({ quiet: q.run, log: () => undefined, sleep: async () => undefined }); // no setting: the default
  const s = await r.apply();
  await r.idle();
  assert.deepEqual(summary(s), { reloading: 1, stopped: 2, deferred: 0, unseen: 1, unchecked: 0, note: null });
  assert.deepEqual(q.calls[1], { mode: "stop", ids: [A, B, C] }, "one round: quiet ones reloaded, working ones stopped");
  assert.deepEqual(q.reloads, [A]);
  assert.deepEqual(q.stops, [B, C]);
  assert.deepEqual(r.pendingAgents(), [], "what cannot be seen is never stopped blind, nor retried every minute: the panel says it keeps the old account");
});

test("the setting is read at every round: switching to wait lets working sessions finish first", async () => {
  let mode: "stop" | "wait" = "wait";
  const state: Record<string, string> = { [A]: "turno" };
  const q = fakeQuiet(state);
  let t = 0;
  const r = createSessionRefresher({ quiet: q.run, log: () => undefined, sleep: async () => undefined, now: () => t, busySessions: async () => mode });
  const s = await r.apply();
  await r.idle();
  assert.deepEqual(summary(s), { reloading: 0, stopped: 0, deferred: 1, unseen: 0, unchecked: 0, note: null });
  assert.deepEqual(q.stops, []);
  mode = "stop";
  await r.recheck(); // still owed: the next round follows the new setting
  await r.idle();
  assert.deepEqual(q.stops, [A]);
  assert.deepEqual(r.pendingAgents(), []);
});

test("a session stopped but not told to continue is settled, and the log says to write to it", async () => {
  const logs: string[] = [];
  const run = async (mode: QuietMode, ids: readonly string[] | "all"): Promise<QuietRun> =>
    mode === "check" ? { results: new Map([[A, "busy:turno"]]), error: null } : { results: new Map([[A, "stopped-sin-aviso:timeout"]]), error: null };
  const r = createSessionRefresher({ quiet: run, log: (m) => logs.push(m), sleep: async () => undefined });
  await r.apply();
  await r.idle();
  assert.deepEqual(r.pendingAgents(), []);
  assert.ok(logs.some((l) => /6acdee01.*escríbele «sigue»/.test(l)), logs.join(" | "));
});

test("notice: stopped sessions are announced, and the old account is said to spend nothing more", () => {
  const lines = swapNoticeLines(view({ warnings: [], sessions: { reloading: 1, stopped: 2, deferred: 1, unseen: 0, unchecked: 0, note: null } }));
  assert.deepEqual(lines, [
    "1 sesión de Paseo se recarga ya y 2 sesiones con trabajo en marcha se paran y lo retoman: conservan la conversación y siguen con la cuenta nueva.",
    "1 sesión sigue con la cuenta anterior hasta que termine lo que está haciendo, también en segundo plano; después cambia sola.",
    "Lo que se cortó en las sesiones paradas sigue con la cuenta nueva, y sus workflows se reanudan sin repetir los pasos terminados.",
  ]);
  const old = swapNoticeLines(view({ warnings: [], sessions: { reloading: 0, deferred: 0, note: null } as unknown as SwapView["sessions"] }));
  assert.equal(old.length, 1, "a host before 0.1.4 sends no `stopped`: read as 0");
});

test("notice: one session takes the singular, and only with nothing left behind does the old account stop spending", () => {
  assert.deepEqual(swapNoticeLines(view({ warnings: [], sessions: { reloading: 0, stopped: 1, deferred: 0, unseen: 0, unchecked: 0, note: null } })), [
    "1 sesión con trabajo en marcha se para y lo retoma: conserva la conversación y sigue con la cuenta nueva.",
    "Las sesiones de Paseo de este equipo ya no gastan de la cuenta anterior: lo que se cortó sigue con la nueva, y los workflows se reanudan sin repetir los pasos terminados.",
  ]);
  assert.deepEqual(swapNoticeLines(view({ warnings: [], sessions: { reloading: 1, stopped: 0, deferred: 0, unseen: 0, unchecked: 0, note: null } })), [
    "1 sesión de Paseo se recarga ya: conserva la conversación y sigue con la cuenta nueva.",
  ]);
});

test("stop mode: delegated, loading and session-less agents wait instead of being stopped", async () => {
  const q = fakeQuiet({ [A]: "delegado", [B]: "cargando", [C]: "sin-sesion" });
  const r = createSessionRefresher({ quiet: q.run, log: () => undefined, sleep: async () => undefined });
  const s = await r.apply();
  await r.idle();
  assert.deepEqual(summary(s), { reloading: 0, stopped: 0, deferred: 3, unseen: 0, unchecked: 0, note: null });
  assert.deepEqual(q.stops, []);
  assert.deepEqual(r.pendingAgents().sort(), [A, B, C].sort());
});

test("stop mode: a failed check says the work is being handled in the background, not that sessions keep the old account", async () => {
  const q = fakeQuiet({ [A]: "turno" });
  q.ctl.fail = "la comprobación tardó demasiado";
  const r = createSessionRefresher({ quiet: q.run, log: () => undefined, sleep: async () => undefined });
  assert.equal((await r.apply()).note, CHECK_FAILED_STOP_NOTE);
  await r.idle();
});

test("after a failed check, an 'all' round queued behind the catch-up round does not stop everyone twice", async () => {
  const state: Record<string, string> = { [A]: "turno", [B]: "subagentes" };
  const q = fakeQuiet(state);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((res) => { release = res; });
  let first = true;
  const run = async (mode: QuietMode, ids: readonly string[] | "all"): Promise<QuietRun> => {
    if (mode === "check") return { results: new Map(), error: "connect: ECONNREFUSED" };
    if (first) { first = false; await gate; } // the catch-up round is slow; a turn end and a tick arrive meanwhile
    return q.run(mode, ids);
  };
  const r = createSessionRefresher({ quiet: run, log: () => undefined, sleep: async () => undefined });
  await r.apply();
  const extra = [r.onTurnEnded(A), r.recheck()];
  await new Promise((res) => setTimeout(res, 10));
  release();
  await Promise.all(extra);
  await r.idle();
  assert.deepEqual(q.stops.sort(), [A, B].sort(), "each agent stopped once");
  assert.ok(q.calls.filter((c) => c.ids === "all").length === 1, JSON.stringify(q.calls));
});

test("a stop made after a newer swap began settles that swap too: the agent is not stopped twice", async () => {
  let t = 0;
  const state: Record<string, string> = { [A]: "subagentes" };
  const q = fakeQuiet(state);
  q.ctl.clock = () => t;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((res) => { release = res; });
  let first = true;
  const run = async (mode: QuietMode, ids: readonly string[] | "all"): Promise<QuietRun> => {
    if (mode !== "check" && first) { first = false; await gate; } // swap 1's round is queued behind other agents
    return q.run(mode, ids);
  };
  const r = createSessionRefresher({ quiet: run, log: () => undefined, sleep: async () => undefined, now: () => t });
  await r.apply(); // swap 1 at t=0
  t = 10_000;
  await r.apply(); // swap 2 at t=10 s: A still busy with the same work, owed again
  t = 12_000;
  release(); // swap 1's round now stops A, after swap 2 began: its new process already reads swap 2's account
  await r.idle();
  assert.deepEqual(q.stops, [A]);
  assert.deepEqual(r.pendingAgents(), [], "nothing left to stop for swap 2");
});

test("stop mode: agents that only wait are passed as such to every round, and a check error is looked at again at once", async () => {
  const state: Record<string, string> = { [A]: "delegado", [B]: "turno" };
  const q = fakeQuiet(state);
  const rounds: QuietRoundOptions[] = [];
  const run = async (mode: QuietMode, ids: readonly string[] | "all", round: QuietRoundOptions = {}): Promise<QuietRun> => {
    if (mode === "check") return { results: new Map([[A, "busy:delegado"], [B, "error:listProviderSubagents failed"]]), error: null };
    rounds.push(round);
    return q.run(mode, ids, round);
  };
  const r = createSessionRefresher({ quiet: run, log: () => undefined, sleep: async () => undefined });
  const s = await r.apply();
  await r.idle();
  assert.deepEqual(summary(s), { reloading: 0, stopped: 0, deferred: 1, unseen: 0, unchecked: 1, note: null });
  assert.deepEqual(q.stops, [B], "the unchecked one was working: stopped in the same round");
  state[A] = "turno"; // the delegated child's turn goes on: it still only waits
  await r.recheck();
  await r.idle();
  assert.deepEqual(q.stops, [B]);
  assert.deepEqual(rounds.at(-1)?.waitOnly, [A]);
});

test("an 'all' round retried after an error skips the agents already settled for that swap", async () => {
  const state: Record<string, string> = { [A]: "turno", [B]: "turno" };
  const q = fakeQuiet(state);
  const rounds: { ids: readonly string[] | "all"; skip?: readonly string[] }[] = [];
  let fail = true;
  const run = async (mode: QuietMode, ids: readonly string[] | "all", round: QuietRoundOptions = {}): Promise<QuietRun> => {
    if (mode === "check") return { results: new Map(), error: "connect: ECONNREFUSED" };
    rounds.push({ ids, skip: round.skip });
    if (fail) { fail = false; const r = await q.run(mode, [A], round); return { ...r, error: "el ayudante dejó de responder" }; } // A stopped, then the helper died
    return q.run(mode, ids === "all" ? Object.keys(state).filter((id) => !(round.skip ?? []).includes(id)) : ids, round);
  };
  const r = createSessionRefresher({ quiet: run, log: () => undefined, sleep: async () => undefined });
  await r.apply();
  await r.idle();
  await r.recheck();
  await r.idle();
  assert.deepEqual(rounds.map((x) => x.skip), [[], [A]]);
  assert.deepEqual(q.stops, [A, B], "A, already stopped and continuing, is not stopped again");
});

test("an agent handled after a swap began is not handled again for it, and ids are never sent twice", async () => {
  let t = 0;
  const state: Record<string, string> = { [A]: "turno" };
  const q = fakeQuiet(state);
  q.ctl.clock = () => t;
  const r = createSessionRefresher({ quiet: q.run, log: () => undefined, sleep: async () => undefined, now: () => t });
  t = 1000;
  await r.apply(); // stops A at t=1000
  await r.idle();
  t = 1000; // a second report of the same swap arrives later, outside the coalescing window of the first (forced here)
  const again = createSessionRefresher; void again;
  t = 7000;
  state[A] = "turno"; // A works on, on the new account
  const before = q.stops.length;
  await r.apply(); // a new swap at 7000: A was handled at 1000, so it is owed again
  await r.idle();
  assert.equal(q.stops.length, before + 1);
  assert.ok(q.calls.every((c) => c.ids === "all" || new Set(c.ids).size === c.ids.length));
});

test("out-of-sight agents are counted apart and never retried", async () => {
  const q = fakeQuiet({ [A]: "sin-visibilidad", [B]: "quiet" });
  const r = createSessionRefresher({ quiet: q.run, log: () => undefined, sleep: async () => undefined });
  const s = await r.apply();
  await r.idle();
  assert.deepEqual(summary(s), { reloading: 1, stopped: 0, deferred: 0, unseen: 1, unchecked: 0, note: null });
  assert.deepEqual(r.pendingAgents(), []);
  const n = q.calls.length;
  await r.recheck();
  assert.equal(q.calls.length, n, "nothing owed: no helper run every minute for it");
});

test("a failed reload settles nothing: a newer swap still owes that agent", async () => {
  let t = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((res) => { release = res; });
  let first = true;
  const run = async (mode: QuietMode, ids: readonly string[] | "all"): Promise<QuietRun> => {
    if (mode === "check") return { results: new Map([[A, "busy:subagentes"]]), error: null };
    if (first) { first = false; await gate; return { results: new Map([[A, "error:no se pudo recargar: timeout"]]), error: null, actedAt: new Map([[A, 12_000]]) }; }
    return { results: new Map([[A, "stopped"]]), error: null, actedAt: new Map([[A, t]]) };
  };
  const r = createSessionRefresher({ quiet: run, log: () => undefined, sleep: async () => undefined, now: () => t });
  await r.apply(); // swap 1; its stop round hangs on A
  t = 10_000;
  const second = r.apply(); // swap 2 starts at 10 s
  release(); // swap 1's round reports a FAILED reload at 12 s, before swap 2's check returns
  const s = await second;
  assert.equal(s.stopped, 1, "swap 2 still owes A its stop");
  await r.idle();
  assert.deepEqual(r.pendingAgents(), []);
});

test("in wait mode a check error is reported as unchecked, not as work being finished; the summary says the mode", async () => {
  const run = async (mode: QuietMode): Promise<QuietRun> =>
    mode === "check" ? { results: new Map([[A, "error:process table timed out"]]), error: null } : { results: new Map([[A, "reloaded"]]), error: null };
  const r = createSessionRefresher({ quiet: run, ...silent });
  const s = await r.apply();
  await r.idle();
  assert.deepEqual(s, { reloading: 0, stopped: 0, deferred: 0, unseen: 0, unchecked: 1, mode: "wait", note: null });
  assert.deepEqual(swapNoticeLines(view({ warnings: [], sessions: s })), [
    "1 sesión no se pudo comprobar: se mira de nuevo en segundo plano y cambia a la cuenta nueva en cuanto no tenga trabajo en marcha.",
  ]);
});

test("after a failed check, the catch-up round re-classifies everyone and skips what was handled since the swap began", async () => {
  let t = 0;
  const rounds: { ids: readonly string[] | "all"; round: QuietRoundOptions }[] = [];
  let checkOk = true;
  const run = async (mode: QuietMode, ids: readonly string[] | "all", round: QuietRoundOptions = {}): Promise<QuietRun> => {
    if (mode === "check") return checkOk ? { results: new Map([[A, "busy:delegado"], [B, "busy:turno"]]), error: null } : { results: new Map(), error: "timeout" };
    rounds.push({ ids, round });
    return ids === "all" ? { results: new Map([[A, "busy:turno"]]), error: null } : { results: new Map([[B, "stopped"]]), error: null, actedAt: new Map([[B, t]]) };
  };
  const r = createSessionRefresher({ quiet: run, log: () => undefined, sleep: async () => undefined, now: () => t });
  await r.apply(); // swap 1: A waits (delegated), B stopped
  await r.idle();
  t = 10_000;
  checkOk = false;
  await r.apply(); // swap 2: the check fails
  await r.idle();
  const all = rounds.find((x) => x.ids === "all");
  assert.ok(all);
  assert.deepEqual(all.round.waitOnly, [], "the all round sees who is delegated itself");
  assert.deepEqual(all.round.skip, [], "B was handled before swap 2 began: owed again");
});
