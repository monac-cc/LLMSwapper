import type { ExecResults } from "../shared/exec.ts";
import type { Plan } from "../shared/plan.ts";
import { PICK } from "../shared/whitelist.ts";

/** Local reads only (no Anthropic call): LLMswapper answers /api/targets from its store and a 30 s WSL cache. */
const TARGETS_PLAN: Plan = {
  kind: "state",
  timeoutMs: 12_000,
  requests: [{ key: "targets", method: "GET", path: "/api/targets", pick: PICK.targets, timeoutMs: 10_000 }],
};

/** Active account of the machine's own environment ("host"), or undefined when it could not be read. */
export function hostActiveId(results: ExecResults): string | null | undefined {
  const r = results.targets;
  if (!r || r.s !== 200 || r.e !== null) return undefined;
  const list = (r.j as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(list)) return undefined;
  const host = list.find((t: unknown) => (t as { id?: unknown } | null)?.id === "host") as { activeId?: unknown } | undefined;
  if (!host) return undefined;
  return typeof host.activeId === "string" ? host.activeId : null;
}

export interface ActiveWatchDeps {
  readonly getPort: () => Promise<number>;
  readonly exec: (plan: Plan, port: number) => Promise<ExecResults>;
  /** The host account changed from `from` to `to`. Not called for the first reading. */
  readonly onChange: (from: string | null, to: string | null) => void;
  readonly intervalMs?: number;
}

/**
 * Notices account changes made OUTSIDE the panel too (LLMswapper's own page, /swapper, its auto-rotation),
 * so open Paseo sessions follow them. The panel's own swaps call `note()` so they are not handled twice.
 */
export function createActiveWatch(deps: ActiveWatchDeps) {
  let known: string | null | undefined; // undefined = no reading yet
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const id = hostActiveId(await deps.exec(TARGETS_PLAN, await deps.getPort()));
      if (id === undefined) return; // LLMswapper down or unreadable: keep the last known value
      const prev = known;
      known = id;
      if (prev !== undefined && prev !== id) deps.onChange(prev, id);
    } catch {
      // never let the watch break the plugin
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start(): void {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), deps.intervalMs ?? 30_000);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** A swap done through the panel: record it so the next tick does not see it as an outside change. */
    note(activeId: string | null): void {
      known = activeId;
    },
  };
}
