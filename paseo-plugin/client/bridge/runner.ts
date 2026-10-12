import { getPaseoClient } from "@getpaseo/plugin/client"; // injected by the app; not loadable under node --test
import type { OpData } from "../../shared/interpret.ts";
import type { SwapperOp } from "../../shared/plan.ts";
import type { OpResult } from "../../shared/views.ts";
import { runOnHostCore, type BridgeDeps, type BridgeRunOptions } from "./runner-core.ts";

const appDeps: BridgeDeps = { getClient: (serverId) => getPaseoClient(serverId) };

export function runOnHost<K extends SwapperOp["kind"]>(
  serverId: string, op: Extract<SwapperOp, { kind: K }>, o: BridgeRunOptions,
): Promise<OpResult<OpData[K]>> {
  return runOnHostCore(appDeps, serverId, op, o);
}
