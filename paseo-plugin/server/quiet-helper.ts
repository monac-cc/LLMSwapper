import { spawn } from "node:child_process";
import path from "node:path";
import type { CliCommand } from "./paseo-cli.ts";
import { parsePsOutput, parseWinProcs, sessionWork } from "./quiet-rules.ts";
import { continuationMessage, readTranscriptLine } from "./stop-notice.ts";

// Paseo's reload closes the Claude Code process: it cancels the provider subagents (workflows, background
// agents) and the process tree goes with it (background shells, monitors, dev servers); a turn running at
// that moment is interrupted. Paseo knows when stopping a runtime is safe (its idle-runtime cleanup asks
// ClaudeAgentSession.canStopRuntime) but exposes neither that nor a "reload when safe", so this helper
// approximates it from outside, next to the daemon, over ONE daemon connection. Per agent:
//   1. status idle/error with no turn and no pending permission, no provider subagent running, no
//      background shell (quiet-rules.ts);
//   2. no live Claude Code process: nothing to reload, its next process reads the new account anyway;
//   3. reload mode: a second look a few seconds later (a background task that just ended starts the turn
//      that delivers its result), status read last, then refreshAgent at once.
// Stop mode does not wait: a working agent is reloaded at once, which stops everything it runs, and then
// told what was cut and how to pick it up on the new account (stop-notice.ts): workflows resume from
// their journal without re-running finished steps, background agents continue from their transcript.
// It runs in two passes: every working agent is reloaded first, then all of them are told, and each
// notice is checked to have reached the session (sent again once if it did not).
// One JSON line per agent as it is settled, so a helper killed half-way still reports what it did.

/**
 * Per agent: "quiet" (check mode), "reloaded", "stopped" (stop mode: reloaded, told to continue, and the
 * notice reached the conversation), "stopped-sin-recarga:<message>" (told to continue, but the reload
 * failed), "stopped-sin-aviso:<message>" (reloaded, but the notice did not get through), "sin-proceso",
 * "busy:<why>" (turno, subagentes, segundo-plano, cargando, sin-sesion, delegado, sin-visibilidad),
 * "gone" or "error:<message>".
 */
export type QuietResults = ReadonlyMap<string, string>;
/** `error` set when the run failed or stopped early; `results` holds whatever was settled before that. */
export interface QuietRun {
  readonly results: QuietResults;
  readonly error: string | null;
  /** When the helper reloaded each agent it reloaded (epoch ms): it acted on whatever swap was current then. */
  readonly actedAt?: ReadonlyMap<string, number>;
}
export type QuietMode = "check" | "reload" | "stop";
export interface QuietRoundOptions {
  /** Stop mode: agents that only wait (reloaded once quiet, never stopped). */
  readonly waitOnly?: readonly string[];
  /** "all": agents already settled for the swap this round is owed for. */
  readonly skip?: readonly string[];
}
export type QuietRunner = (mode: QuietMode, ids: readonly string[] | "all", opts?: QuietRoundOptions) => Promise<QuietRun>;

const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;
const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_DONE = "el ayudante terminó sin acabar";

const MAIN = String.raw`
const cfg = JSON.parse(process.env.LLMSWAPPER_QUIET_ARGS || "{}");
const line = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const beat = () => line({ beat: true }); // keeps the plugin's stall watchdog quiet during a long round
const finish = (o) => { process.stdout.write(JSON.stringify(o) + "\n", () => process.exit(0)); };
const msg = (e) => String((e && e.message) || e).slice(0, 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RELOADABLE = new Set(["idle", "error"]);
const agentOf = (r) => (r && (r.agent || r)) || null;
function procTable() {
  if (process.platform === "win32") {
    const ps = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; n = $_.Name; s = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { $null }); c = $_.CommandLine } } | ConvertTo-Json -Compress';
    return parseWinProcs(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 256 * 1024 * 1024 }));
  }
  return parsePsOutput(execFileSync("ps", ["-axww", "-o", "pid=,ppid=,etime=,args="], { encoding: "utf8", timeout: 15000, maxBuffer: 256 * 1024 * 1024 }), Date.now());
}
const paseoHome = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
let daemon;
try {
  const { connectToDaemon } = await import(pathToFileURL(cfg.utils).href);
  let target = null;
  try {
    const dt = await import(pathToFileURL(path.join(path.dirname(cfg.utils), "daemon-target.js")).href);
    target = dt.selectDaemonTarget({}, process.env);
  } catch {}
  if (!target) target = { kind: "instance", home: paseoHome };
  daemon = await connectToDaemon({ target });
} catch (e) { finish({ error: "connect: " + msg(e) }); await new Promise(() => {}); }
// Every agent of the daemon, background workspaces included where the daemon has them: their session
// ids tell which Claude Code processes are claimed (quiet-rules.ts), and "all" reloads all of them.
const listed = [];
try {
  const page = async (cursor, background) => daemon.fetchAgents({
    sort: [{ key: "created_at", direction: "desc" }], page: { limit: 200, ...(cursor ? { cursor } : {}) },
    ...(background ? { filter: { includeBackground: true } } : {}),
  });
  let background = true;
  try { await page(undefined, true); } catch { background = false; }
  let cursor;
  do { // the CLI's own paging (agent-directory.js): createdAt never changes, so nobody moves past the cursor
    const p = await page(cursor, background);
    for (const a of (p.entries || []).map(agentOf)) if (a && /^claude/i.test(a.provider) && !a.archivedAt && a.status !== "closed") listed.push(a);
    cursor = (p.pageInfo && p.pageInfo.nextCursor) || undefined;
  } while (cursor);
} catch (e) { finish({ error: "list: " + msg(e) }); await new Promise(() => {}); }
const claimed = listed.map((a) => (a.persistence && a.persistence.sessionId) || "").filter(Boolean);
const skip = new Set(cfg.skip || []); // settled since the swap that owes this "all" round
const ids = [...new Set(cfg.ids === "all" ? listed.map((a) => a.id).filter((id) => !skip.has(id)) : cfg.ids)];
// In a stop round, these only wait: reloaded once quiet, never stopped (delegated, loading, no session yet).
const waitOnly = new Set(cfg.waitOnly || []);
const graceMs = cfg.graceMs ?? 10000;
const sidOf = (a) => (a && a.persistence && a.persistence.sessionId) || "";
const statusWhy = (a) => !a || a.archivedAt || a.status === "closed" ? "gone"
  : a.status === "initializing" ? "busy:cargando"
  : !RELOADABLE.has(a.status) || a.activeTurn || (a.pendingPermissions && a.pendingPermissions.length) ? "busy:turno" : null;
// Paseo fills runtimeInfo.model from the live Claude Code process; a loaded agent without one has null.
const looksLive = (a) => !!(a.runtimeInfo && (a.runtimeInfo.model || a.runtimeInfo.extra));
// A child another agent delegated to (create_agent) reports its finish to that agent: stopping its turn
// would tell the parent it was canceled. It finishes first, on the old account.
const delegated = (a) => !!(a.labels && typeof a.labels["paseo.parent-agent-id"] === "string" && a.labels["paseo.parent-agent-id"].trim());
const runningSubagents = async (id) => ((await daemon.listProviderSubagents(id)).subagents || []).filter((s) => s && s.status === "running");
// One process table per run for the first looks; a failure is remembered so it costs one timeout, not one per agent.
let shared = null, sharedError = null;
const sharedTable = () => {
  if (shared) return shared;
  if (sharedError) throw sharedError;
  try { return (shared = procTable()); } catch (e) { sharedError = e; throw e; }
};
async function look(id, table, final) {
  const a = agentOf(await daemon.fetchAgent(id));
  const why = statusWhy(a);
  if (why === "gone" || why === "busy:cargando") return why;
  let w;
  try { w = sessionWork(table(), sidOf(a), claimed, process.pid, graceMs); }
  catch (e) { if (why) return why; throw e; } // already busy: the table only refines why
  if (w.foreign) return "busy:sin-visibilidad"; // run through WSL, docker, ssh...: its work cannot be seen from here
  const subs = why ? [] : await runningSubagents(id);
  if (why || subs.length) return !sidOf(a) ? "busy:sin-sesion" : why === "busy:turno" && delegated(a) ? "busy:delegado" : why || "busy:subagentes";
  if (!w.owned && !(w.roots.length && looksLive(a))) return "sin-proceso";
  if (w.late.length) return "busy:segundo-plano";
  if (final) return statusWhy(agentOf(await daemon.fetchAgent(id))); // the status last, right before the reload
  return null;
}
// Where Claude Code keeps transcripts: the daemon's CLAUDE_CONFIG_DIR or ~/.claude, plus any a Paseo
// provider override points Claude Code to (config.json agents.providers.*.env).
const claudeDirs = (() => {
  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude")];
  try {
    const providers = (JSON.parse(fs.readFileSync(path.join(paseoHome, "config.json"), "utf8")).agents || {}).providers || {};
    for (const p of Object.values(providers)) if (p && p.env && typeof p.env.CLAUDE_CONFIG_DIR === "string") dirs.push(p.env.CLAUDE_CONFIG_DIR);
  } catch {}
  return [...new Set(dirs.filter(Boolean))];
})();
function transcriptOf(sid) {
  if (!sid) return null;
  for (const dir of claudeDirs) {
    try {
      const projects = path.join(dir, "projects");
      for (const d of fs.readdirSync(projects)) { const f = path.join(projects, d, sid + ".jsonl"); if (fs.existsSync(f)) return f; }
    } catch {}
  }
  return null;
}
async function factsOf(file, toolUseIds) {
  const acc = { launches: new Map(), args: new Map(), openShells: new Set() };
  if (!file) return acc;
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const l of rl) readTranscriptLine(l, toolUseIds, acc);
  return acc;
}
const sizeOf = (file) => { try { return file ? fs.statSync(file).size : 0; } catch { return 0; } };
/**
 * Whether the notice reached the session: its nonce in the transcript after byte offset from (Claude Code
 * writes a message that starts a turn at once), or a queue entry (one that joins a running turn is queued
 * and written in full only when the turn takes it, at the next tool boundary).
 */
async function arrived(file, from, nonce, ms) {
  for (const t0 = Date.now(); ; await sleep(1000)) {
    try {
      const size = fs.statSync(file).size;
      if (size > from) {
        const fd = fs.openSync(file, "r"), buf = Buffer.alloc(Math.min(size - from, 8 * 1024 * 1024));
        fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
        const tail = buf.toString("utf8");
        if (tail.includes("aviso " + nonce) || /"operation":"enqueue"/.test(tail)) return true;
      }
    } catch {}
    if (Date.now() - t0 >= ms) return false;
    beat();
  }
}
let acted = 0;
const refresh = async (id) => { acted = acted || Date.now(); beat(); await daemon.refreshAgent(id); };
/** The session's Claude Code processes (its own, or the unclaimed ones that stand in), to tell whether a failed reload left them running. */
const rootsOf = (sid) => { try { return sessionWork(procTable(), sid, claimed, process.pid, graceMs).roots; } catch { return null; } };
/** Stops a working agent (pass 1). Returns a result, or a plan for its notice (pass 2). */
async function stopNow(id, a, subs, shells, turn, file) {
  // One last look right before the reload: a turn that started since the first one is cut too, and said so.
  const last = agentOf(await daemon.fetchAgent(id));
  const why = statusWhy(last);
  if (why === "gone" || why === "busy:cargando") return why;
  if (why === "busy:turno") { if (delegated(last)) return "busy:delegado"; turn = true; }
  const sid = sidOf(last);
  const facts = await factsOf(file, new Set(subs.map((s) => s.id)));
  // Nested subagents are their parent agent's business: continuing the parent picks them up.
  const launches = [], others = [];
  for (const s of subs.filter((x) => !x.parentSubagentId)) {
    const l = facts.launches.get(s.id);
    if (!l) others.push(s.description || s.title || "tarea");
    else if (l.kind === "workflow") launches.push({ ...l, args: facts.args.get(s.id) ?? null });
    else launches.push(l.description ? l : { ...l, description: s.description || s.title || "agente" });
  }
  const before = rootsOf(sid);
  let refreshError = null;
  for (let attempt = 0; attempt < 2; attempt++) { // the old process is often gone even when the reply times out
    try { await refresh(id); refreshError = null; break; } catch (e) { refreshError = e; await sleep(3000); }
  }
  const nonce = globalThis.crypto.randomUUID().slice(0, 8);
  const plan = (cut) => ({ id, sid, file: file || transcriptOf(sid), nonce, refreshError, text: continuationMessage({ ...cut, nonce }) });
  if (refreshError) {
    const after = rootsOf(sid);
    if (before && after && before.length && before.every((pid) => after.includes(pid))) {
      // The old process survived: its background work goes on, on the old account; tried again next round.
      // Paseo interrupts a running turn before it reloads, though, so a reply in progress was cut: say that.
      if (!turn) return "error:no se pudo recargar: " + msg(refreshError);
      return plan({ turn: true, launches: [], others: [], shells: false });
    }
  }
  return plan({ turn, launches, others, shells });
}
/** Sends a stopped agent its notice and checks it got there (pass 2). */
async function tell(p) {
  const from = sizeOf(p.file);
  let sendError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Joining a running turn (a message the app had queued started it): accepted means queued; nothing to wait for.
    const joining = statusWhy(agentOf(await daemon.fetchAgent(p.id))) === "busy:turno";
    const messageId = globalThis.crypto.randomUUID(); // one id per send: a retry after a timeout is never delivered twice
    let sent = false;
    for (let t = 0; t < 2 && !sent; t++) {
      beat();
      try { await daemon.sendAgentMessage(p.id, p.text, { activeTurnBehavior: "steer", messageId }); sent = true; }
      catch (e) { sendError = e; await sleep(2000); }
    }
    // Always looked for from before the first send: a slow first copy is not mistaken for a lost one.
    if (sent && (joining || !p.file || await arrived(p.file, from, p.nonce, cfg.deliverMs ?? 45000))) {
      return p.refreshError ? "stopped-sin-recarga:" + msg(p.refreshError) : "stopped";
    }
  }
  return "stopped-sin-aviso:" + (sendError ? msg(sendError) : "el aviso no llegó a la conversación");
}
async function stopRound(id) {
  const a = agentOf(await daemon.fetchAgent(id));
  const why = statusWhy(a);
  if (why === "gone" || why === "busy:cargando") return why;
  const sid = sidOf(a);
  const subs = await runningSubagents(id);
  const w = sessionWork(procTable(), sid, claimed, process.pid, graceMs);
  if (w.foreign) return "busy:sin-visibilidad"; // its work cannot be seen from here: not stopped blind
  const live = w.owned || (w.roots.length > 0 && looksLive(a));
  // Without a process of its own, unclaimed shells count only if its own transcript left one running.
  const file = transcriptOf(sid);
  const shells = live && w.late.length > 0 && (w.owned || (await factsOf(file, new Set())).openShells.size > 0);
  const turn = why === "busy:turno";
  if (turn || subs.length || shells) {
    if (!sid) return "busy:sin-sesion"; // a refresh without a session would start an empty conversation
    if (turn && delegated(a)) return "busy:delegado";
    return stopNow(id, a, subs, shells, turn, file);
  }
  if (!live) return "sin-proceso";
  return { later: true, file }; // quiet: looked at again once every working agent is stopped
}
/** A quiet agent's second look, a few seconds after its first (a task that just ended starts the turn that delivers its result), then the status last, right before the reload. */
async function quietRound(id, file) {
  const subs2 = await runningSubagents(id);
  const again = agentOf(await daemon.fetchAgent(id));
  const why2 = statusWhy(again);
  if (!why2 && !subs2.length) { await refresh(id); return "reloaded"; }
  if (why2 && why2 !== "busy:turno") return why2;
  if (why2 && delegated(again)) return "busy:delegado";
  return stopNow(id, again, subs2, false, !!why2, file);
}
async function reloadRound(id) {
  let r = await look(id, sharedTable, false);
  if (!r && cfg.mode !== "check") {
    await sleep(cfg.secondLookMs ?? 3000);
    r = await look(id, procTable, true);
    if (!r) { await refresh(id); r = "reloaded"; }
  }
  return r || "quiet";
}
// "at": when the helper reloaded the agent. An error carries none: a failed reload settled nothing.
const settle = (id, r) => line({ id, r, ...(acted && !String(r).startsWith("error:") ? { at: acted } : {}) });
const notices = [], quietLater = [];
const handle = (id, r) => {
  if (r && typeof r === "object" && r.later) quietLater.push({ id, file: r.file });
  else if (r && typeof r === "object") {
    // Reloaded; told in pass 2. If the helper dies before then, this line says so.
    notices.push({ ...r, at: acted });
    line({ id, r: "stopped-sin-aviso:el ayudante se cortó antes de avisar", at: acted });
  } else settle(id, r);
};
const guarded = async (fn) => {
  try { return await fn(); }
  catch (e) { return !acted && /not found|unknown agent/i.test(msg(e)) ? "gone" : "error:" + msg(e); }
};
for (const id of ids) {
  acted = 0;
  handle(id, await guarded(() => (cfg.mode === "stop" && !waitOnly.has(id) ? stopRound(id) : reloadRound(id))));
}
if (quietLater.length) {
  beat();
  await sleep(cfg.secondLookMs ?? 3000);
  for (const q of quietLater) { acted = 0; handle(q.id, await guarded(() => quietRound(q.id, q.file))); }
}
// Pass 2: every stopped agent was reloaded first, so none kept spending the old account while another
// one's notice was checked. A message the app had queued gets a moment to start its own turn first.
if (notices.length) {
  await sleep(cfg.settleMs ?? 3000);
  await Promise.all(notices.map(async (p) => {
    let r;
    try { r = await tell(p); } catch (e) { r = "stopped-sin-aviso:" + msg(e); }
    line({ id: p.id, r, at: p.at });
  }));
}
try { await daemon.close(); } catch {}
finish({ done: true });
`;

/** The helper's source: the rules as tested (embedded by toString) plus the daemon round. */
export function helperSource(): string {
  return [
    `import { execFileSync } from "node:child_process";`,
    `import fs from "node:fs";`,
    `import os from "node:os";`,
    `import path from "node:path";`,
    `import readline from "node:readline";`,
    `import { pathToFileURL } from "node:url";`,
    `const parsePsOutput = (${parsePsOutput.toString()});`,
    `const parseWinProcs = (${parseWinProcs.toString()});`,
    `const sessionWork = (${sessionWork.toString()});`,
    `const readTranscriptLine = (${readTranscriptLine.toString()});`,
    `const continuationMessage = (${continuationMessage.toString()});`,
    MAIN,
  ].join("\n");
}

/** The helper's JSON lines: one {id, r, at?} per settled agent, heartbeats, then {done} or {error}. Pure (unit-tested). */
export function parseQuietOutput(stdout: string): QuietRun {
  const results = new Map<string, string>();
  const actedAt = new Map<string, number>();
  let error: string | null = NOT_DONE;
  for (const raw of stdout.split(/\r?\n/)) {
    let o: { id?: unknown; r?: unknown; at?: unknown; done?: unknown; error?: unknown } | null;
    try { o = JSON.parse(raw) as typeof o; } catch { continue; }
    if (!o || typeof o !== "object") continue;
    if (typeof o.id === "string" && AGENT_ID_RE.test(o.id) && typeof o.r === "string") {
      results.set(o.id, o.r);
      if (typeof o.at === "number" && Number.isFinite(o.at)) actedAt.set(o.id, o.at);
    } else if (o.done === true) error = null;
    else if (typeof o.error === "string") error = o.error;
  }
  return { results, error, actedAt };
}

export interface QuietOptions {
  /** How long after its Claude Code process a shell without the snapshot wrapper counts as startup. */
  readonly graceMs?: number;
  /** Pause between the two looks of a reload. */
  readonly secondLookMs?: number;
  /** Stop mode: pause after the reload before the notice, and how long to wait for it to reach the transcript. */
  readonly settleMs?: number;
  readonly deliverMs?: number;
  /** Killed when silent this long (one agent's reload takes seconds); results so far are kept. */
  readonly stallMs?: number;
}

export function createQuietRunner(cli: CliCommand | null, opts: QuietOptions = {}): QuietRunner | null {
  if (!cli || !cli.cliIndex || !cli.node) return null;
  const node = cli.node;
  const utils = path.join(path.dirname(cli.cliIndex), "utils", "client.js");
  const source = helperSource();
  const stallMs = opts.stallMs ?? 120_000;
  return (mode, ids, round = {}) => {
    const list = ids === "all" ? "all" : [...new Set(ids)].filter((id) => AGENT_ID_RE.test(id));
    if (list !== "all" && !list.length) return Promise.resolve({ results: new Map(), error: null });
    return new Promise<QuietRun>((resolve) => {
      let out = "", err = "", settled = false;
      let timer = setTimeout(() => stall(), stallMs);
      const finish = (why: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const r = parseQuietOutput(out);
        const tail = err.trim().split(/\r?\n/).pop()?.slice(0, 200);
        resolve(why ? { ...r, error: why } : r.error === NOT_DONE && tail ? { ...r, error: `${r.error}: ${tail}` } : r);
      };
      const stall = () => { child.kill(); finish("el ayudante dejó de responder"); };
      // The source goes in on stdin: as an -e argument it would run into Windows' 32 K command-line limit.
      const child = spawn(node.command, ["--input-type=module", "-"], {
        env: { ...proc.env, ...node.env, LLMSWAPPER_QUIET_ARGS: JSON.stringify({ utils, mode, ids: list, waitOnly: round.waitOnly ?? [], skip: round.skip ?? [], graceMs: opts.graceMs, secondLookMs: opts.secondLookMs, settleMs: opts.settleMs, deliverMs: opts.deliverMs }) },
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.on("error", () => undefined); // a helper that dies at once reports through its exit
      child.stdin.end(source);
      child.stdout.setEncoding("utf8").on("data", (c: string) => {
        if (out.length < 4_194_304) out += c;
        clearTimeout(timer);
        timer = setTimeout(() => stall(), stallMs);
      });
      child.stderr.setEncoding("utf8").on("data", (c: string) => { if (err.length < 4096) err += c; });
      child.on("error", (e: Error) => finish(`no se pudo lanzar el ayudante: ${e.message}`));
      child.on("close", () => finish(null));
    });
  };
}
