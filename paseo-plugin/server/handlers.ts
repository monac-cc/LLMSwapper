import type { RpcInput } from "@getpaseo/plugin";
import type { autoRpc, swapRpc } from "../shared/contracts.ts";
import type { ExecResults } from "../shared/exec.ts";
import { interpret, type OpData } from "../shared/interpret.ts";
import { InvalidOpError, planFor, type Plan, type SwapperOp } from "../shared/plan.ts";
import type { OpResult, SessionsView, SwapView } from "../shared/views.ts";
import { executePlan } from "./executor.ts";

type Op<K extends SwapperOp["kind"]> = Extract<SwapperOp, { kind: K }>;
type Exec = (plan: Plan, port: number) => Promise<ExecResults>;
type Read = "state" | "usage";
type Flight = { readonly gen: number; readonly p: Promise<OpResult<OpData[Read]>> };

/** Several clients (desktop, phone, panel + screen) may ask at once; LLMswapper does not dedupe. */
const STATE_MEMO_MS = 10_000;

/** After a successful swap: make open sessions follow it. Returns what was done, or null when not applicable. */
export type AfterSwap = (swap: SwapView) => Promise<SessionsView | null>;

export function createHandlers(getPort: () => Promise<number>, exec: Exec = executePlan, now: () => number = Date.now, afterSwap?: AfterSwap) {
  let mutating = false; // one swap/auto change at a time per daemon (LLMswapper also 409s globally)
  /** Finished mutations. A state round started in an older generation may predate the change it reports. */
  let gen = 0;
  const inflight = new Map<Read, Flight>();
  let stateMemo: { at: number; value: OpResult<OpData["state"]> } | null = null;

  async function run<K extends SwapperOp["kind"]>(op: Op<K>): Promise<OpResult<OpData[K]>> {
    let plan: Plan;
    try {
      plan = planFor(op);
    } catch (e) {
      return { ok: false, error: { code: "invalid_input", message: e instanceof InvalidOpError ? e.message : "Entrada no válida" } };
    }
    const port = await getPort();
    return interpret(op.kind as K, await exec(plan, port), { now: now(), port });
  }

  /**
   * Single flight per read kind: concurrent callers share one LLMswapper round. A state round from an older
   * generation is never handed to a later caller; usage does not depend on the active account, so it is shared anyway.
   */
  function shared<K extends Read>(kind: K): Promise<OpResult<OpData[K]>> {
    const hit = inflight.get(kind);
    if (hit && (kind === "usage" || hit.gen === gen)) return hit.p as Promise<OpResult<OpData[K]>>;
    const p: Promise<OpResult<OpData[K]>> = run({ kind } as Op<K>).finally(() => {
      if (inflight.get(kind)?.p === p) inflight.delete(kind); // a newer round may have replaced this one
    });
    inflight.set(kind, { gen, p });
    return p;
  }

  async function state(): Promise<OpResult<OpData["state"]>> {
    if (stateMemo && now() - stateMemo.at < STATE_MEMO_MS) return stateMemo.value;
    const started = gen;
    const value = await shared("state");
    if (started === gen) stateMemo = value.ok ? { at: now(), value } : null; // a mutation ended meanwhile: do not memoize
    return value;
  }

  async function mutate<K extends "swap" | "auto">(op: Op<K>): Promise<OpResult<OpData[K]>> {
    if (mutating) return { ok: false, error: { code: "host_busy", message: "Ya hay una operación en curso en este equipo." } };
    mutating = true;
    try {
      const result = await run(op);
      if ((op as SwapperOp).kind === "swap" && result.ok && afterSwap) {
        const swap = result.data as SwapView;
        // Never fail a swap that LLMswapper already applied because the session step failed.
        const sessions = await afterSwap(swap).catch(() => null);
        return { ok: true, data: { ...swap, sessions } as OpData[K] };
      }
      return result;
    } finally {
      mutating = false;
      gen++; // rounds already in flight are neither reused nor memoized
      stateMemo = null; // the next state read must see the change
    }
  }

  return {
    state,
    usage: () => shared("usage"),
    swap: (input: RpcInput<typeof swapRpc>) => mutate({ kind: "swap", accountId: input.accountId, target: input.target }),
    auto: (input: RpcInput<typeof autoRpc>) => mutate({ kind: "auto", enabled: input.enabled }),
  };
}
