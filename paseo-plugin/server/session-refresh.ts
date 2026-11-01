import type { QuietResults, QuietRunner } from "./quiet-helper.ts";

// A running Claude Code keeps its OAuth token in memory and only re-reads .credentials.json when that
// token is rejected or it is logged out (verified in claude 2.1.296). So after a swap, the Paseo agents
// of this machine that have a live Claude Code process are reloaded: Paseo closes the process and resumes
// the SAME conversation, and the next process reads the new account. An agent without a live process
// needs nothing: Paseo starts one at its next turn, with the new account.
//
// A reload must never cut work. It closes the Claude Code process, which cancels its subagents and takes
// its child processes with it, so an agent is reloaded only when it is QUIET: no turn running, no provider
// subagent running (workflows and background agents outlive the turn that started them) and no background
// shell (monitors, dev servers). The quiet helper checks all of it and reloads in the same pass. A busy
// agent keeps working on the account it started with and switches as soon as it is quiet, checked at
// every turn end and every minute. Where nothing can be checked, nothing is reloaded: the sessions keep
// the old account until restarted, exactly as a swap without the plugin.

export interface SessionsSummary {
  readonly reloading: number;
  readonly deferred: number;
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
}

/** Covers the gap between LLMswapper answering the panel's swap and `watch.note()`; short enough that a deliberate second swap still gets its own round. */
const COALESCE_MS = 5_000;
/** A session busy this long (a dev server left running, say) is left on the old account; the log says so. */
export const MAX_WAIT_MS = 12 * 60 * 60_000;
export const NO_HELPER_NOTE = "No se puede comprobar si las sesiones de Paseo tienen trabajo en marcha en este equipo: siguen con la cuenta anterior hasta que las reinicies.";
export const CHECK_FAILED_NOTE = "No se pudo comprobar si las sesiones de Paseo tienen trabajo en marcha: siguen con la cuenta anterior y se reintenta cada minuto.";

const short = (id: string) => id.slice(0, 8);
/** Settled for this swap: reloaded, or nothing to reload (no live process, archived, closed, deleted). */
const DONE = new Set(["reloaded", "sin-proceso", "gone"]);

export function createSessionRefresher(deps: RefresherDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(m));
  const quiet = deps.quiet;
  const summaryMs = deps.summaryMs ?? 20_000;
  /**
   * Agents owed a reload once they are quiet: since when, and the swap (`epoch`) that owes it. A round
   * started before a swap reports on the world before it, so it never settles that swap's entries.
   */
  const pending = new Map<string, { since: number; epoch: number }>();
  let epoch = 0;
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
  function record(results: QuietResults, since: number, roundEpoch: number): void {
    for (const [id, r] of results) {
      if (DONE.has(r)) {
        if (r === "reloaded") log(`LLMswapper: sesión ${short(id)} recargada con la cuenta nueva.`);
        if ((pending.get(id)?.epoch ?? 0) <= roundEpoch) pending.delete(id);
        continue;
      }
      if (!pending.has(id)) pending.set(id, { since, epoch: roundEpoch });
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
      log("LLMswapper: 12 h sin poder comprobar las sesiones; siguen con la cuenta anterior hasta que las recargues.");
    }
  }

  /** Reload rounds asked while one runs are merged into the next one. */
  let next: { ids: Set<string>; all: boolean; done: Promise<void> } | null = null;
  function schedule(ids: readonly string[] | "all"): Promise<void> {
    if (!next) {
      const batch: { ids: Set<string>; all: boolean; done: Promise<void> } = { ids: new Set(), all: false, done: Promise.resolve() };
      batch.done = exclusive(async () => {
        if (next === batch) next = null;
        if (!quiet) return;
        const all = batch.all;
        // Only agents still owed: one reloaded by the round before this one is not reloaded twice.
        const ids = [...batch.ids].filter((id) => pending.has(id));
        if (!all && !ids.length) return;
        const owedAtStart = owedAll;
        const since = (all ? owedAtStart : null) ?? now();
        const roundEpoch = epoch;
        const r = await quiet("reload", all ? "all" : ids);
        record(r.results, since, roundEpoch); // what was settled counts even when the round stopped early
        noteError(r.error);
        if (all && !r.error && owedAll === owedAtStart) owedAll = null; // a check that failed meanwhile is owed its own round
        expire();
      });
      next = batch;
    }
    if (ids === "all") next.all = true;
    else for (const id of ids) next.ids.add(id);
    return next.done;
  }

  /**
   * Called after the active account of this machine changed (panel swap, LLMswapper UI, auto-rotation).
   * Calls within COALESCE_MS share one round: the watch and the panel swap may both report the same change.
   */
  let last: { at: number; p: Promise<SessionsSummary> } | null = null;
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
    const late = new Promise<SessionsSummary>((r) => { timer = setTimeout(() => r({ reloading: 0, deferred: 0, note: CHECK_FAILED_NOTE }), Math.max(0, budgetMs)); });
    return Promise.race([p, late]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  }

  async function applyOnce(budgetMs: number): Promise<SessionsSummary> {
    if (!quiet) return { reloading: 0, deferred: 0, note: NO_HELPER_NOTE };
    // A read-only check for the summary, not queued behind a reload round: the swap is waiting for it.
    // The reloads that follow look at each agent again, twice, right before acting.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), Math.max(0, budgetMs)); });
    const r = await Promise.race([quiet("check", "all"), late]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    if (!r || r.error) {
      noteError(r ? r.error : "la comprobación tardó demasiado");
      owedAll = now(); // a new swap: its 12 h start now
      void schedule("all"); // whatever can be settled is, in the background
      return { reloading: 0, deferred: 0, note: CHECK_FAILED_NOTE };
    }
    noteError(null);
    owedAll = null;
    const t = now();
    const ready: string[] = [];
    let deferred = 0;
    pending.clear(); // every live agent is in this round; whatever was owed before is owed again from now
    epoch++;
    for (const [id, s] of r.results) {
      if (DONE.has(s)) continue;
      pending.set(id, { since: t, epoch });
      if (s === "quiet") ready.push(id);
      else {
        deferred++;
        log(`LLMswapper: ${short(id)} se recargará cuando acabe (${s.replace(/^\w+:/, "")}).`);
      }
    }
    if (ready.length) void schedule(ready);
    return { reloading: ready.length, deferred, note: null };
  }

  /** agent.turn_ended hook: the agent may be quiet now, unless another turn or background work is still going. */
  async function onTurnEnded(agentId: string): Promise<void> {
    if (!quiet || (!pending.has(agentId) && owedAll === null)) return;
    await sleep(1500);
    if (owedAll !== null) return schedule("all");
    if (pending.has(agentId)) return schedule([agentId]);
  }

  /** Periodic: background work can finish without a new turn. One helper run for every pending agent. */
  async function recheck(): Promise<void> {
    if (!quiet) return;
    if (owedAll !== null) return schedule("all");
    if (pending.size) return schedule([...pending.keys()]);
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
