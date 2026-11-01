import type { BusySessions } from "../shared/contracts.ts";
import type { QuietResults, QuietRunner } from "./quiet-helper.ts";

// A running Claude Code keeps its OAuth token in memory and only re-reads .credentials.json when that
// token is rejected or it is logged out (verified in claude 2.1.296). So after a swap, the Paseo agents
// of this machine that have a live Claude Code process are reloaded: Paseo closes the process and resumes
// the SAME conversation, and the next process reads the new account. An agent without a live process
// needs nothing: Paseo starts one at its next turn, with the new account.
//
// A reload closes the Claude Code process, which cancels its subagents and takes its child processes with
// it. What happens to an agent that is still working (a turn, a provider subagent such as a workflow or a
// background agent, a background shell) is the host's choice (settings.busySessions):
// - "stop" (default): stop it at once and continue on the new account, so the old account, often swapped
//   away from because it is nearly spent, spends nothing more. The helper reloads it and then tells it
//   what was cut: workflows resume from their journal without re-running finished steps.
// - "wait": reload it only once it is QUIET, checked at every turn end and every minute; meanwhile it
//   finishes on the account it started with.
// Quiet agents are reloaded at once either way. Where nothing can be checked, nothing is reloaded: the
// sessions keep the old account until restarted, exactly as a swap without the plugin.

export interface SessionsSummary {
  readonly reloading: number;
  /** Working agents stopped and continued on the new account ("stop" mode). */
  readonly stopped: number;
  /** Agents that finish first on the old account and switch once quiet. */
  readonly deferred: number;
  /** Agents run through WSL, docker or ssh: never reloaded, they keep the old account until restarted. */
  readonly unseen: number;
  /** Agents the check could not read: looked at again in the background (stopped if working, in stop mode). */
  readonly unchecked: number;
  /** The setting this summary was made under (the wording of "unchecked" depends on it). */
  readonly mode?: BusySessions;
  /** Why nothing could be done (no helper, the check failed); null when the agents were handled. */
  readonly note: string | null;
}

export interface RefresherDeps {
  /** Checks and reloads agents next to the daemon. null: this machine cannot tell, so nothing is reloaded. */
  readonly quiet: QuietRunner | null;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  /** Longest the summary takes when the swap does not say (Paseo gives a whole plugin RPC 30 s). */
  readonly summaryMs?: number;
  /** The host's settings.busySessions, read at each round. */
  readonly busySessions?: () => Promise<BusySessions>;
}

/** Covers the gap between LLMswapper answering the panel's swap and `watch.note()`; short enough that a deliberate second swap still gets its own round. */
const COALESCE_MS = 5_000;
/** A session busy this long (a dev server left running, say) is left on the old account; the log says so. */
export const MAX_WAIT_MS = 12 * 60 * 60_000;
export const NO_HELPER_NOTE = "No se puede comprobar si las sesiones de Paseo tienen trabajo en marcha en este equipo: siguen con la cuenta anterior hasta que las reinicies.";
export const CHECK_FAILED_NOTE = "No se pudo comprobar si las sesiones de Paseo tienen trabajo en marcha: siguen con la cuenta anterior y se reintenta cada minuto.";
export const CHECK_FAILED_STOP_NOTE = "No se pudo comprobar a tiempo si las sesiones de Paseo tienen trabajo en marcha: se hace ahora en segundo plano; las que lo tengan se paran y lo retoman con la cuenta nueva, y si tampoco se puede, se reintenta cada minuto.";
const failedNote = (mode: BusySessions) => (mode === "stop" ? CHECK_FAILED_STOP_NOTE : CHECK_FAILED_NOTE);

const short = (id: string) => id.slice(0, 8);
/** Settled for this swap: reloaded, stopped and continued, or nothing to reload (no live process, archived, closed, deleted). */
const isDone = (r: string) => r === "reloaded" || r === "sin-proceso" || r === "gone" || r === "stopped" || r.startsWith("stopped-sin-aviso:") || r.startsWith("stopped-sin-recarga:");
/** Working agents a stop round stops; the other busy ones (loading, no session yet, delegated, out of sight) wait. */
const STOPPABLE = new Set(["busy:turno", "busy:subagentes", "busy:segundo-plano"]);
const NONE = { reloading: 0, stopped: 0, deferred: 0, unseen: 0, unchecked: 0 } as const;
/** Busy reasons that only wait, in either mode: a delegated child, an agent still loading, one with no session yet. */
const WAIT_ONLY = new Set(["busy:delegado", "busy:cargando", "busy:sin-sesion"]);
const UNSEEN = "busy:sin-visibilidad";

export function createSessionRefresher(deps: RefresherDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(m));
  const quiet = deps.quiet;
  const summaryMs = deps.summaryMs ?? 20_000;
  const busySessions = deps.busySessions ?? (async (): Promise<BusySessions> => "stop");
  /**
   * Agents owed a reload: since when, and the swap that owes it (`epoch`, begun at `swapAt`). A round
   * started before a swap reports on the world before it, so it settles that swap's entries only for the
   * agents it reloaded after the swap began.
   */
  const pending = new Map<string, { since: number; epoch: number; swapAt: number; waitOnly: boolean }>();
  let epoch = 0;
  /** When each agent was last reloaded or stopped: an agent handled after a swap began needs nothing for it. */
  const lastActed = new Map<string, number>();
  /** Agents settled since the swap that owedAll stands for began (owedSince): an "all" round retried after an error skips them. */
  const settledOwed = new Set<string>();
  let owedSince: number | null = null;
  /** Set when a whole round could not even be checked: since when every agent is owed a reload. */
  let owedAll: number | null = null;

  /** One reload round at a time, so no agent is reloaded twice for one swap. Checks run outside it. */
  let chain: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  }

  let lastError = "";
  function noteError(error: string | null): void {
    if (error && error !== lastError) log(`LLMswapper: no se pudo comprobar las sesiones (${error}).`);
    lastError = error ?? "";
  }

  /** Records a reload round that started in `roundEpoch`. `since`: when the agents found busy started waiting, if they were not pending yet. */
  function record(results: QuietResults, since: number, roundEpoch: number, actedAt: ReadonlyMap<string, number> = new Map(), stop = false, reclassify = false): void {
    for (const [id, r] of results) {
      const at = actedAt.get(id);
      if (r === UNSEEN) {
        if (pending.delete(id)) log(`LLMswapper: ${short(id)} corre fuera de la vista del plugin (WSL, docker, ssh): no se recarga; sigue con la cuenta anterior hasta que la reinicies.`);
        continue;
      }
      if (isDone(r)) {
        if (at !== undefined) lastActed.set(id, Math.max(lastActed.get(id) ?? -Infinity, at));
        if (owedSince !== null && (at === undefined || at >= owedSince)) settledOwed.add(id);
        if (r === "reloaded") log(`LLMswapper: sesión ${short(id)} recargada con la cuenta nueva.`);
        if (r === "stopped") log(`LLMswapper: sesión ${short(id)} parada; sigue con la cuenta nueva lo que tenía en marcha.`);
        if (r.startsWith("stopped-sin-aviso:")) log(`LLMswapper: sesión ${short(id)} parada con la cuenta nueva, pero no se le pudo pedir que siga (${r.slice(18)}): escríbele «sigue».`);
        if (r.startsWith("stopped-sin-recarga:")) log(`LLMswapper: sesión ${short(id)} avisada de que siga, pero su recarga falló (${r.slice(20)}): si sigue con la cuenta anterior, recárgala a mano.`);
        const e = pending.get(id);
        if (!e || e.epoch <= roundEpoch || (actedAt.get(id) ?? -Infinity) >= e.swapAt) pending.delete(id);
        continue;
      }
      const e = pending.get(id);
      if (!e) pending.set(id, { since, epoch: roundEpoch, swapAt: since, waitOnly: stop && WAIT_ONLY.has(r) });
      else if (reclassify) e.waitOnly = stop && WAIT_ONLY.has(r);
      if (r.startsWith("error:")) log(`LLMswapper: no se pudo recargar ${short(id)} (${r.slice(6)}); se reintenta.`);
    }
  }

  function expire(): void {
    const t = now();
    for (const [id, { since }] of pending) {
      if (t - since < MAX_WAIT_MS) continue;
      pending.delete(id);
      log(`LLMswapper: la sesión ${short(id)} lleva 12 h ocupada; sigue con la cuenta anterior hasta que la recargues.`);
    }
    if (owedAll !== null && t - owedAll >= MAX_WAIT_MS) {
      owedAll = null;
      owedSince = null;
      log("LLMswapper: 12 h sin poder comprobar las sesiones; siguen con la cuenta anterior hasta que las recargues.");
    }
  }

  /** Reload rounds asked while one runs are merged into the next one; one that stops makes the round stop. */
  type Batch = { ids: Set<string>; all: boolean; stop: boolean; done: Promise<void> };
  let next: Batch | null = null;
  function schedule(ids: readonly string[] | "all", mode: BusySessions): Promise<void> {
    if (!next) {
      const batch: Batch = { ids: new Set(), all: false, stop: false, done: Promise.resolve() };
      batch.done = exclusive(async () => {
        if (next === batch) next = null;
        if (!quiet) return;
        // An "all" round runs only while a failed check is still owed: if the round before settled it,
        // stopping every agent again would cut their resumed work twice. Its pending agents still get a go.
        const all = batch.all && owedAll !== null;
        // Only agents still owed: one reloaded by the round before this one is not reloaded twice.
        const ids = [...new Set([...batch.ids, ...(batch.all && !all ? pending.keys() : [])])].filter((id) => pending.has(id));
        if (!all && !ids.length) return;
        const owedAtStart = owedAll;
        const since = (all ? owedAtStart : null) ?? now();
        const roundEpoch = epoch;
        // An "all" round classifies every agent afresh (the helper sees delegated, loading or session-less ones itself).
        const waitOnly = all ? [] : [...pending].filter(([, e]) => e.waitOnly).map(([id]) => id);
        const r = await quiet(batch.stop ? "stop" : "reload", all ? "all" : ids, { waitOnly, skip: all ? [...settledOwed] : [] });
        record(r.results, since, roundEpoch, r.actedAt, batch.stop, all); // what was settled counts even when the round stopped early
        noteError(r.error);
        if (all && !r.error && owedAll === owedAtStart) { owedAll = null; owedSince = null; settledOwed.clear(); } // a check that failed meanwhile is owed its own round
        expire();
      });
      next = batch;
    }
    if (ids === "all") next.all = true;
    else for (const id of ids) next.ids.add(id);
    if (mode === "stop") next.stop = true;
    return next.done;
  }

  /**
   * Called after the active account of this machine changed (panel swap, LLMswapper UI, auto-rotation).
   * Calls within COALESCE_MS share one round: the watch and the panel swap may both report the same change.
   */
  let last: { at: number; p: Promise<SessionsSummary> } | null = null;
  let lastMode: BusySessions = "stop";
  function apply(budgetMs = summaryMs): Promise<SessionsSummary> {
    const t = now();
    if (last && t - last.at < COALESCE_MS) return within(last.p, budgetMs);
    const p = applyOnce(Math.min(summaryMs, budgetMs));
    last = { at: t, p };
    return p;
  }

  /** A shared round still answers this caller within its own budget. */
  function within(p: Promise<SessionsSummary>, budgetMs: number): Promise<SessionsSummary> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<SessionsSummary>((r) => { timer = setTimeout(() => r({ ...NONE, note: failedNote(lastMode) }), Math.max(0, budgetMs)); });
    return Promise.race([p, late]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  }

  async function applyOnce(budgetMs: number): Promise<SessionsSummary> {
    if (!quiet) return { ...NONE, note: NO_HELPER_NOTE };
    const swapAt = now();
    const mode = await busySessions().catch((): BusySessions => "stop");
    lastMode = mode;
    // A read-only check for the summary, not queued behind a reload round: the swap is waiting for it.
    // The round that follows looks at each agent again right before acting.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), Math.max(0, budgetMs)); });
    const r = await Promise.race([quiet("check", "all"), late]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    if (!r || r.error) {
      noteError(r ? r.error : "la comprobación tardó demasiado");
      owedAll = now(); // a new swap: its 12 h start now, and every agent is owed again
      owedSince = swapAt;
      settledOwed.clear();
      for (const [id, at] of lastActed) if (at >= swapAt) settledOwed.add(id); // handled since this swap began
      pending.clear(); // the "all" round re-classifies everyone
      epoch++;
      void schedule("all", mode); // whatever can be settled is, in the background
      return { ...NONE, note: failedNote(mode) };
    }
    noteError(null);
    owedAll = null;
    owedSince = null;
    settledOwed.clear();
    const t = now();
    const ready: string[] = [];
    let reloading = 0, stopped = 0, deferred = 0, unseen = 0, unchecked = 0;
    pending.clear(); // every live agent is in this round; whatever was owed before is owed again from now
    epoch++;
    for (const [id, at] of lastActed) if (at < swapAt) lastActed.delete(id);
    for (const [id, s] of r.results) {
      if (isDone(s) || (lastActed.get(id) ?? -Infinity) >= swapAt) continue; // handled after this swap began: its next process reads the new account
      if (s === UNSEEN) {
        unseen++;
        log(`LLMswapper: ${short(id)} corre fuera de la vista del plugin (WSL, docker, ssh): no se recarga; sigue con la cuenta anterior hasta que la reinicies.`);
        continue;
      }
      const waitOnly = WAIT_ONLY.has(s);
      pending.set(id, { since: t, epoch, swapAt, waitOnly: mode === "stop" && waitOnly });
      if (s === "quiet") { ready.push(id); reloading++; }
      else if (mode === "stop" && STOPPABLE.has(s)) { ready.push(id); stopped++; }
      else if (s.startsWith("error:")) { ready.push(id); unchecked++; log(`LLMswapper: no se pudo comprobar ${short(id)} (${s.slice(6)}); se mira de nuevo ahora.`); }
      else {
        deferred++;
        log(`LLMswapper: ${short(id)} se recargará cuando acabe (${s.replace(/^\w+:/, "")}).`);
      }
    }
    if (ready.length) void schedule(ready, mode);
    return { reloading, stopped, deferred, unseen, unchecked, mode, note: null };
  }

  /** agent.turn_ended hook: the agent may be quiet now, unless another turn or background work is still going. */
  async function onTurnEnded(agentId: string): Promise<void> {
    if (!quiet || (!pending.has(agentId) && owedAll === null)) return;
    await sleep(1500);
    const mode = await busySessions().catch((): BusySessions => "stop");
    if (owedAll !== null) return schedule("all", mode);
    if (pending.has(agentId)) return schedule([agentId], mode);
  }

  /** Periodic: background work can finish without a new turn. One helper run for every pending agent. */
  async function recheck(): Promise<void> {
    if (!quiet || (owedAll === null && !pending.size)) return;
    const mode = await busySessions().catch((): BusySessions => "stop");
    if (owedAll !== null) return schedule("all", mode);
    return schedule([...pending.keys()], mode);
  }

  return {
    apply,
    onTurnEnded,
    recheck,
    pendingAgents: (): string[] => [...pending.keys()],
    /** Resolves when every queued reload round has finished (tests, shutdown). */
    idle: async (): Promise<void> => { while (true) { const c = chain; await c; if (c === chain) return; } },
  };
}
export type SessionRefresher = ReturnType<typeof createSessionRefresher>;
