import type { CliRunner } from "./paseo-cli.ts";

// A running Claude Code keeps its OAuth token in memory and only re-reads .credentials.json when that
// token is rejected or it is logged out (verified in claude 2.1.296). So after a swap, the Paseo agents
// of this machine are reloaded: Paseo restarts the Claude Code process and resumes the SAME conversation
// (`paseo agent reload`), and the new process reads the new account. Idle agents now; busy ones when
// their turn ends, never mid-turn.

export interface SessionsSummary {
  readonly reloading: number;
  readonly deferred: number;
  /** Why nothing could be done (no CLI, list failed); null when the agents were handled. */
  readonly note: string | null;
}

const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_RE = /^claude(?:\/|$)/i;
/** Statuses with a session worth restarting now. "closed" has no process: its next start reads the new account anyway. */
const RELOAD_NOW = new Set(["idle", "error"]);

export interface ListedAgent {
  readonly id: string;
  readonly provider: string;
  readonly status: string;
}

/** `paseo agent ls --global --json`: [{id, provider: "claude/<model>", status, ...}]. Tolerant, never throws. */
export function parseAgentList(stdout: string): ListedAgent[] {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a: unknown) => {
    const o = a as { id?: unknown; provider?: unknown; status?: unknown } | null;
    return o && typeof o.id === "string" && typeof o.provider === "string" && typeof o.status === "string"
      ? [{ id: o.id, provider: o.provider, status: o.status }] : [];
  });
}

/** `paseo agent inspect <id> --json`: {Status: "idle" | "running" | ...}. */
export function parseInspectStatus(stdout: string): string | null {
  try {
    const o = JSON.parse(stdout) as { Status?: unknown; status?: unknown } | null;
    const s = o?.Status ?? o?.status;
    return typeof s === "string" ? s : null;
  } catch {
    return null;
  }
}

export interface RefresherDeps {
  readonly cli: CliRunner | null;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

/** Covers the gap between LLMswapper answering the panel's swap and `watch.note()`; short enough that a deliberate second swap still gets its own round. */
const COALESCE_MS = 5_000;

export function createSessionRefresher(deps: RefresherDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(m));
  /** Busy agents owed a reload when their current turn ends. */
  const deferred = new Set<string>();
  /** One reload at a time: each restarts a Claude Code process (~10 s). */
  let queue: Promise<void> = Promise.resolve();
  const queued = new Set<string>();

  function reload(id: string): void {
    if (queued.has(id) || !deps.cli) return;
    queued.add(id);
    const cli = deps.cli;
    queue = queue.then(async () => {
      queued.delete(id);
      const r = await cli(["agent", "reload", id, "--json"], 120_000);
      log(r.code === 0 ? `LLMswapper: sesión ${id.slice(0, 8)} recargada con la cuenta nueva.` : `LLMswapper: no se pudo recargar ${id.slice(0, 8)} (código ${r.code}).`);
    }).catch(() => undefined);
  }

  /**
   * Called after the active account of this machine changed (panel swap, LLMswapper UI, auto-rotation).
   * Calls within COALESCE_MS share one round: the watch and the panel swap may both report the same change.
   */
  let last: { at: number; p: Promise<SessionsSummary> } | null = null;
  function apply(): Promise<SessionsSummary> {
    const t = now();
    if (last && t - last.at < COALESCE_MS) return last.p;
    const p = applyOnce();
    last = { at: t, p };
    return p;
  }

  async function applyOnce(): Promise<SessionsSummary> {
    if (!deps.cli) return { reloading: 0, deferred: 0, note: "No se encontró la CLI de Paseo en este equipo: reinicia las sesiones abiertas a mano." };
    const r = await deps.cli(["agent", "ls", "--global", "--json"], 30_000);
    if (r.code !== 0) return { reloading: 0, deferred: 0, note: "No se pudieron listar los agentes de Paseo: reinicia las sesiones abiertas a mano." };
    let reloading = 0;
    for (const a of parseAgentList(r.stdout)) {
      if (!CLAUDE_RE.test(a.provider) || !AGENT_ID_RE.test(a.id)) continue;
      if (a.status === "running" || a.status === "initializing") {
        deferred.add(a.id);
      } else if (RELOAD_NOW.has(a.status)) {
        deferred.delete(a.id);
        reload(a.id);
        reloading++;
      }
    }
    return { reloading, deferred: deferred.size, note: null };
  }

  /** agent.turn_ended hook. Waits a moment and only reloads if the agent did not start another turn. */
  async function onTurnEnded(agentId: string): Promise<void> {
    if (!deferred.has(agentId) || !deps.cli) return;
    await sleep(1500);
    if (!deferred.has(agentId)) return; // handled meanwhile by a newer apply()
    const r = await deps.cli(["agent", "inspect", agentId, "--json"], 30_000);
    const status = r.code === 0 ? parseInspectStatus(r.stdout) : null;
    if (status === "running" || status === "initializing") return; // a new turn already started: next turn end
    deferred.delete(agentId);
    if (status !== null && status !== "closed") reload(agentId);
  }

  return {
    apply,
    onTurnEnded,
    pendingAgents: (): string[] => [...deferred],
    /** Resolves when every queued reload has finished (tests, shutdown). */
    idle: (): Promise<void> => queue,
  };
}
export type SessionRefresher = ReturnType<typeof createSessionRefresher>;
