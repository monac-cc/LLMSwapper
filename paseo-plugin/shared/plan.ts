import { isAccountId, isTargetId } from "./ids.ts";
import type { PickSpec } from "./pick.ts";
import { PICK } from "./whitelist.ts";

/** Every operation the plugin can perform. Nothing else is ever sent to LLMswapper. */
export type SwapperOp =
  | { readonly kind: "state" }
  | { readonly kind: "usage" }
  | { readonly kind: "swap"; readonly accountId: string; readonly target: string }
  | { readonly kind: "auto"; readonly enabled: boolean };

export interface PlanRequest {
  readonly key: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: Readonly<Record<string, string | boolean>>;
  readonly pick: PickSpec;
  readonly timeoutMs: number;
}

export interface Plan {
  readonly kind: SwapperOp["kind"];
  /** Whole-operation budget on the device (the bridge script emits a timeout after this). */
  readonly timeoutMs: number;
  readonly requests: readonly PlanRequest[];
}

export class InvalidOpError extends Error {}

export function planFor(op: SwapperOp): Plan {
  switch (op.kind) {
    case "state":
      // No Anthropic calls: health, targets, accounts and auto read local state only.
      return {
        kind: "state",
        timeoutMs: 12_000,
        requests: [
          { key: "health", method: "GET", path: "/api/health", pick: PICK.health, timeoutMs: 8_000 },
          { key: "targets", method: "GET", path: "/api/targets", pick: PICK.targets, timeoutMs: 10_000 },
          { key: "accounts", method: "GET", path: "/api/accounts?target=host", pick: PICK.accounts, timeoutMs: 8_000 },
          { key: "auto", method: "GET", path: "/api/auto", pick: PICK.auto, timeoutMs: 8_000 },
        ],
      };
    case "usage":
      // Never ?force=1. LLMswapper serves its 4-min cache and enforces its own 80 s gap.
      return {
        kind: "usage",
        timeoutMs: 60_000,
        requests: [{ key: "usage", method: "GET", path: "/api/usage/all", pick: PICK.usageAll, timeoutMs: 55_000 }],
      };
    case "swap":
      if (!isAccountId(op.accountId)) throw new InvalidOpError("Id de cuenta no válido");
      if (!isTargetId(op.target)) throw new InvalidOpError("Entorno no válido");
      return {
        kind: "swap",
        timeoutMs: 45_000,
        requests: [{
          key: "swap", method: "POST", path: "/api/swap",
          body: { id: op.accountId, target: op.target }, // target ALWAYS a validated string
          pick: PICK.swap, timeoutMs: 40_000,
        }],
      };
    case "auto":
      if (typeof op.enabled !== "boolean") throw new InvalidOpError("Valor de rotación no válido");
      return {
        kind: "auto",
        timeoutMs: 10_000,
        requests: [{ key: "auto", method: "POST", path: "/api/auto", body: { enabled: op.enabled }, pick: PICK.auto, timeoutMs: 8_000 }],
      };
  }
}
