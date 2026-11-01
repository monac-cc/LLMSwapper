import { spawn } from "node:child_process";
import path from "node:path";
import type { CliCommand } from "./paseo-cli.ts";
import { parsePsOutput, parseWinProcs, sessionWork } from "./quiet-rules.ts";

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
// One JSON line per agent as it is settled, so a helper killed half-way still reports what it did.

/** Per agent: "quiet" (check mode), "reloaded", "sin-proceso", "busy:<why>", "gone" or "error:<message>". */
export type QuietResults = ReadonlyMap<string, string>;
/** `error` set when the run failed or stopped early; `results` holds whatever was settled before that. */
export interface QuietRun {
  readonly results: QuietResults;
  readonly error: string | null;
}
export type QuietRunner = (mode: "check" | "reload", ids: readonly string[] | "all") => Promise<QuietRun>;

const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;
const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_DONE = "el ayudante terminó sin acabar";

const MAIN = String.raw`
const cfg = JSON.parse(process.env.LLMSWAPPER_QUIET_ARGS || "{}");
const line = (o) => process.stdout.write(JSON.stringify(o) + "\n");
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
let daemon;
try {
  const { connectToDaemon } = await import(pathToFileURL(cfg.utils).href);
  let target = null;
  try {
    const dt = await import(pathToFileURL(path.join(path.dirname(cfg.utils), "daemon-target.js")).href);
    target = dt.selectDaemonTarget({}, process.env);
  } catch {}
  if (!target) target = { kind: "instance", home: process.env.PASEO_HOME || path.join(os.homedir(), ".paseo") };
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
const ids = cfg.ids === "all" ? listed.map((a) => a.id) : cfg.ids;
const graceMs = cfg.graceMs ?? 10000;
const statusWhy = (a) => !a || a.archivedAt || a.status === "closed" ? "gone"
  : !RELOADABLE.has(a.status) || a.activeTurn || (a.pendingPermissions && a.pendingPermissions.length) ? "busy:turno" : null;
// Paseo fills runtimeInfo.model from the live Claude Code process; a loaded agent without one has null.
const looksLive = (a) => !!(a.runtimeInfo && (a.runtimeInfo.model || a.runtimeInfo.extra));
let shared = null;
async function look(id, table, final) {
  const a = agentOf(await daemon.fetchAgent(id));
  const why = statusWhy(a);
  if (why) return why;
  if (((await daemon.listProviderSubagents(id)).subagents || []).some((s) => s && s.status === "running")) return "busy:subagentes";
  const w = sessionWork(table(), (a.persistence && a.persistence.sessionId) || "", claimed, process.pid, graceMs);
  if (w.foreign) return "busy:sin-visibilidad"; // run through WSL, docker, ssh...: its work cannot be seen from here
  if (!w.owned && !(w.roots.length && looksLive(a))) return "sin-proceso";
  if (w.late.length) return "busy:segundo-plano";
  if (final) return statusWhy(agentOf(await daemon.fetchAgent(id))); // the status last, right before the reload
  return null;
}
for (const id of ids) {
  let r;
  try {
    r = await look(id, () => (shared = shared || procTable()), false);
    if (!r && cfg.mode === "reload") {
      await sleep(cfg.secondLookMs ?? 3000);
      r = await look(id, procTable, true);
      if (!r) { await daemon.refreshAgent(id); r = "reloaded"; }
    }
  } catch (e) { r = /not found|unknown agent/i.test(msg(e)) ? "gone" : "error:" + msg(e); }
  line({ id, r: r || "quiet" });
}
try { await daemon.close(); } catch {}
finish({ done: true });
`;

/** The helper's source: the rules as tested (embedded by toString) plus the daemon round. */
export function helperSource(): string {
  return [
    `import { execFileSync } from "node:child_process";`,
    `import os from "node:os";`,
    `import path from "node:path";`,
    `import { pathToFileURL } from "node:url";`,
    `const parsePsOutput = (${parsePsOutput.toString()});`,
    `const parseWinProcs = (${parseWinProcs.toString()});`,
    `const sessionWork = (${sessionWork.toString()});`,
    MAIN,
  ].join("\n");
}

/** The helper's JSON lines: one {id, r} per settled agent, then {done} or {error}. Pure (unit-tested). */
export function parseQuietOutput(stdout: string): QuietRun {
  const results = new Map<string, string>();
  let error: string | null = NOT_DONE;
  for (const raw of stdout.split(/\r?\n/)) {
    let o: { id?: unknown; r?: unknown; done?: unknown; error?: unknown } | null;
    try { o = JSON.parse(raw) as typeof o; } catch { continue; }
    if (!o || typeof o !== "object") continue;
    if (typeof o.id === "string" && AGENT_ID_RE.test(o.id) && typeof o.r === "string") results.set(o.id, o.r);
    else if (o.done === true) error = null;
    else if (typeof o.error === "string") error = o.error;
  }
  return { results, error };
}

export interface QuietOptions {
  /** How long after its Claude Code process a shell without the snapshot wrapper counts as startup. */
  readonly graceMs?: number;
  /** Pause between the two looks of a reload. */
  readonly secondLookMs?: number;
  /** Killed when silent this long (one agent's reload takes seconds); results so far are kept. */
  readonly stallMs?: number;
}

export function createQuietRunner(cli: CliCommand | null, opts: QuietOptions = {}): QuietRunner | null {
  if (!cli || !cli.cliIndex || !cli.node) return null;
  const node = cli.node;
  const utils = path.join(path.dirname(cli.cliIndex), "utils", "client.js");
  const source = helperSource();
  const stallMs = opts.stallMs ?? 120_000;
  return (mode, ids) => {
    const list = ids === "all" ? "all" : ids.filter((id) => AGENT_ID_RE.test(id));
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
        resolve(why ? { results: r.results, error: why } : r.error === NOT_DONE && tail ? { results: r.results, error: `${r.error}: ${tail}` } : r);
      };
      const stall = () => { child.kill(); finish("el ayudante dejó de responder"); };
      const child = spawn(node.command, ["--input-type=module", "-e", source], {
        env: { ...proc.env, ...node.env, LLMSWAPPER_QUIET_ARGS: JSON.stringify({ utils, mode, ids: list, graceMs: opts.graceMs, secondLookMs: opts.secondLookMs }) },
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
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
