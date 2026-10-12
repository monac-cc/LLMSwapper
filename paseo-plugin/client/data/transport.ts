import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { DEFAULT_PORT, autoRpc, stateRpc, swapRpc, swapperSettings, usageRpc, type SwapperSettings } from "../../shared/contracts.ts";
import type { AutoView, OpError, OpResult, StateView, SwapView, UsageView } from "../../shared/views.ts";
import { classifyClientError, messageOf } from "../bridge/errors.ts";
import { runOnHost } from "../bridge/runner.ts";

export interface SwapInput {
  readonly accountId: string;
  readonly target: string;
}

export interface Transport {
  /** serverId of the daemon serving this plugin bundle (props.host.id): reached by plugin RPC. */
  readonly localServerId: string;
  /** Settings are readable: `enabled(id) === false` is a definitive opt-out, not "still loading". */
  readonly settingsReady: boolean;
  kind(serverId: string): "rpc" | "bridge";
  /** RPC host: always. Bridge host: only after the explicit per-host opt-in. */
  enabled(serverId: string): boolean;
  /**
   * Every op re-checks the opt-in at CALL time and returns `bridge_disabled` (nothing runs) for a host
   * that is not opted in. `signal` is only for aborts the caller owns: never pass TanStack's signal
   * (an unmount would then kill a remote node mid-read and drop its result).
   */
  state(serverId: string, signal?: AbortSignal): Promise<OpResult<StateView>>;
  usage(serverId: string, signal?: AbortSignal): Promise<OpResult<UsageView>>;
  swap(serverId: string, input: SwapInput): Promise<OpResult<SwapView>>;
  setAuto(serverId: string, enabled: boolean): Promise<OpResult<AutoView>>;
}

/** What the settings document allows, per host. `hosts` undefined = settings not readable: no remote host is opted in. */
interface Routing {
  readonly hosts: SwapperSettings["hosts"] | undefined;
  readonly bridgeForLocal: boolean;
  readonly localPort: number;
}

const toRouting = (values: SwapperSettings | undefined): Routing => ({
  hosts: values?.hosts,
  bridgeForLocal: values?.bridgeForLocal === true,
  localPort: values?.localPort ?? DEFAULT_PORT,
});

/**
 * Latest READY routing per plugin host, shared by every Dashboard and the Settings screen of this bundle.
 * Ops read it at call time, so a read queued by a Dashboard that has since unmounted still sees an
 * opt-out saved afterwards from the Settings screen.
 */
const routingByHost = new Map<string, Routing>();

/** Record the settings document for `localServerId`. Only ready values: a loading consumer never resets it. */
export function publishRouting(localServerId: string, values: SwapperSettings): void {
  routingByHost.set(localServerId, toRouting(values));
}

function routeOf(r: Routing, localServerId: string, id: string): "rpc" | "bridge" | "off" {
  if (id === localServerId) return r.bridgeForLocal ? "bridge" : "rpc"; // bridgeForLocal is only true with ready settings
  return r.hosts?.[id]?.bridge === true ? "bridge" : "off";
}

const bridgeOptions = (r: Routing, localServerId: string, id: string, signal?: AbortSignal) => ({
  port: id === localServerId ? r.localPort : (r.hosts?.[id]?.port ?? DEFAULT_PORT),
  workspaceId: r.hosts?.[id]?.workspaceId || undefined,
  nodeCommand: r.hosts?.[id]?.nodeCommand || undefined,
  signal,
});

const BRIDGE_OFF: OpError = {
  code: "bridge_disabled",
  message: "La lectura por terminal está desactivada para este equipo: no se ha ejecutado nada en él.",
};
const refused = <T>(): Promise<OpResult<T>> => Promise.resolve({ ok: false, error: BRIDGE_OFF });

function rpcError(e: unknown, mutating: boolean): OpError {
  const raw = messageOf(e);
  if (classifyClientError(raw) === "permission_denied") return { code: "permission_denied", message: raw };
  // RPC timeout (30 s daemon side / 60 s app side) after a swap was sent = unknown outcome.
  return mutating
    ? { code: "swap_unknown_result", message: `El plugin no respondió (${raw}). El cambio puede haberse aplicado: actualiza para comprobarlo.` }
    : { code: "rpc_failed", message: `El plugin no respondió: ${raw}` };
}

async function viaRpc<T>(call: () => Promise<OpResult<T>>, mutating: boolean): Promise<OpResult<T>> {
  try {
    return await call();
  } catch (e) {
    return { ok: false, error: rpcError(e, mutating) };
  }
}

export function useTransport(localServerId: string): Transport {
  const rpcState = useRpc(stateRpc);
  const rpcUsage = useRpc(usageRpc);
  const rpcSwap = useRpc(swapRpc);
  const rpcAuto = useRpc(autoRpc);
  const settings = useSettings(swapperSettings);
  const ready = settings.status === "ready";
  const values = ready ? settings.values : undefined;
  const { hosts, bridgeForLocal, localPort } = toRouting(values);
  if (values) publishRouting(localServerId, values);

  return useMemo<Transport>(() => {
    const rendered: Routing = { hosts, bridgeForLocal, localPort };
    // Latest routing, read when an op actually starts: a usage read queued in the gate, or a confirm dialog
    // opened before the user opted the host out, must not run on it afterwards.
    const atCall = (id: string) => {
      const r = routingByHost.get(localServerId) ?? rendered;
      return { r, route: routeOf(r, localServerId, id) };
    };
    return {
      localServerId,
      settingsReady: ready,
      kind: (id) => (routeOf(rendered, localServerId, id) === "rpc" ? "rpc" : "bridge"),
      enabled: (id) => routeOf(rendered, localServerId, id) !== "off",
      state: (id, signal) => {
        const { r, route } = atCall(id);
        if (route === "rpc") return viaRpc(() => rpcState({}), false);
        return route === "off" ? refused() : runOnHost(id, { kind: "state" }, bridgeOptions(r, localServerId, id, signal));
      },
      usage: (id, signal) => {
        const { r, route } = atCall(id);
        if (route === "rpc") return viaRpc(() => rpcUsage({}), false);
        return route === "off" ? refused() : runOnHost(id, { kind: "usage" }, bridgeOptions(r, localServerId, id, signal));
      },
      swap: (id, input) => {
        const { r, route } = atCall(id);
        if (route === "rpc") return viaRpc(() => rpcSwap({ accountId: input.accountId, target: input.target }), true);
        return route === "off"
          ? refused()
          : runOnHost(id, { kind: "swap", accountId: input.accountId, target: input.target }, bridgeOptions(r, localServerId, id));
      },
      setAuto: (id, enabled) => {
        const { r, route } = atCall(id);
        if (route === "rpc") return viaRpc(() => rpcAuto({ enabled }), false);
        return route === "off" ? refused() : runOnHost(id, { kind: "auto", enabled }, bridgeOptions(r, localServerId, id));
      },
    };
  }, [localServerId, rpcState, rpcUsage, rpcSwap, rpcAuto, hosts, bridgeForLocal, localPort, ready]);
}
