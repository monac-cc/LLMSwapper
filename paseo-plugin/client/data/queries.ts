import type { PluginHostSummary } from "@getpaseo/plugin/client";
import { useIsMutating, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { queuedCount, queuedRepollDelayMs } from "../../shared/markers.ts";
import type { AutoView, ErrorCode, OpError, OpResult, StateView, SwapView, UsageView } from "../../shared/views.ts";
import type { SwapInput, Transport } from "./transport.ts";
import { usageQueue } from "./usage-gate.ts";

export const qk = {
  all: ["llmswapper"] as const,
  state: (serverId: string) => ["llmswapper", "state", serverId] as const,
  usage: (serverId: string) => ["llmswapper", "usage", serverId] as const,
  mutation: (serverId: string) => ["llmswapper", "mutation", serverId] as const,
  /** Every per-device swap or auto change (not autoAll). */
  mutations: ["llmswapper", "mutation"] as const,
  /** The panel's one switch for automatic rotation on several devices. */
  autoAll: ["llmswapper", "mutation-auto-all"] as const,
};

export class OpFailure extends Error {
  readonly error: OpError;
  constructor(error: OpError) {
    super(error.message);
    this.error = error;
  }
}

export const unwrap = <T>(r: OpResult<T>): T => {
  if (r.ok) return r.data;
  throw new OpFailure(r.error);
};

export const opErrorOf = (e: unknown): OpError | null =>
  e == null ? null : e instanceof OpFailure ? e.error : { code: "rpc_failed", message: e instanceof Error ? e.message : String(e) };

const MIN_USAGE_REFRESH_MS = 5 * 60_000;
/** After these, automatic refresh stops until the user presses Actualizar (no point re-spawning terminals). */
const BACKOFF: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "swapper_down", "node_missing", "no_workspace", "workspace_unusable", "permission_denied", "sdk_unsupported", "endpoint_missing",
  "bridge_disabled",
]);

const canQuery = (t: Transport, h: PluginHostSummary) =>
  h.serverId === t.localServerId || (h.status === "online" && t.enabled(h.serverId));

function interval(refreshMs: number | false) {
  return (query: { state: { error: unknown } }): number | false => {
    if (refreshMs === false) return false;
    const code = opErrorOf(query.state.error)?.code;
    return code && BACKOFF.has(code) ? false : refreshMs;
  };
}

// The queryFns never read TanStack's `signal`: once consumed, removing the last observer (unmount,
// workspace switch) aborts the fetch, which kills the remote node mid-read and throws its result away.
// Bridge runs have their own deadline and always kill their terminal; unmount only stops retries.

/** health + targets + accounts + auto. No Anthropic calls. */
export function useHostState(t: Transport, h: PluginHostSummary, refreshMs: number | false) {
  const rpc = t.kind(h.serverId) === "rpc";
  return useQuery({
    queryKey: qk.state(h.serverId),
    queryFn: async (): Promise<StateView> => unwrap(await t.state(h.serverId)),
    enabled: canQuery(t, h),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    retry: false,                                     // every retry would spawn another remote terminal
    // bridge: remounts (workspace switches) reuse the cache, unless it was invalidated meanwhile (a change that
    // settled while the card was gone, a device shown again in the panel)
    refetchOnMount: rpc ? true : (q) => q.state.isInvalidated,
    retryOnMount: rpc,                                // bridge: a failed read with no data waits for Actualizar
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: interval(refreshMs),
    refetchIntervalInBackground: false,
  });
}

/** A hidden device is not read: its usage read still waiting in the gate is dropped. One already running finishes. */
export async function dropQueuedUsage(qc: QueryClient, serverId: string): Promise<void> {
  if (!usageQueue.waiting(serverId)) return;
  const cancelled = qc.cancelQueries({ queryKey: qk.usage(serverId), exact: true }, { revert: true }); // previous data, no error
  usageQueue.drop(serverId);
  await cancelled;
}

/** A device shown again in the panel reads its state when its card mounts (it may have changed while hidden). */
export const markForReread = (qc: QueryClient, serverId: string) =>
  qc.invalidateQueries({ queryKey: qk.state(serverId), exact: true }, { cancelRefetch: false });

/** /api/usage/all WITHOUT force, through the cross-device FIFO gate; >= 5 min between automatic reads. */
export function useHostUsage(t: Transport, h: PluginHostSummary, refreshMs: number | false) {
  const rpc = t.kind(h.serverId) === "rpc";
  const enabled = canQuery(t, h);
  const q = useQuery({
    queryKey: qk.usage(h.serverId),
    // Queued reads stay in the gate after an unmount and fill the cache (the transport re-checks the opt-in);
    // only hiding the device drops one that has not started (dropQueuedUsage).
    queryFn: async (): Promise<UsageView> => unwrap(await usageQueue.run(h.serverId, () => t.usage(h.serverId))),
    enabled,
    staleTime: MIN_USAGE_REFRESH_MS,
    gcTime: 30 * 60_000,
    retry: false,                                     // never retry usage (429 cooldowns double)
    refetchOnMount: rpc,
    retryOnMount: rpc,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: interval(refreshMs === false ? false : Math.max(refreshMs, MIN_USAGE_REFRESH_MS)),
    refetchIntervalInBackground: false,
  });
  useQueuedRepoll(h.serverId, q.data, q.dataUpdatedAt, enabled);
  return q;
}

/** Per host, shared by every mounted card of it: the result a follow-up was planned for, and whether it ran. */
interface Repoll {
  readonly sweep: number;
  /** Queued/throttled entries in that result. */
  readonly pending: number;
  /** Follow-ups already run in this chain; 0 = a fresh sweep (manual, interval or first load). */
  readonly chain: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Its follow-up read was started and has not failed: the next result belongs to the chain. */
  fired: boolean;
}
const repolls = new Map<string, Repoll>();

/**
 * LLMswapper's rate floor lets about one Anthropic read through per sweep, queues the rest with retryInS,
 * and expects the frontend to re-poll. Follow-ups chain while each one makes progress (fewer entries
 * pending than the result before), at most one per account, each >= 60 s apart and none after a 429,
 * through the same queryFn: usage gate, never forced. A follow-up does nothing if, when due, no enabled
 * card of the host is mounted (unmount, opt-out, offline), a newer read is running or has landed, or the
 * last read failed. A follow-up that fails ends the chain, so the next sweep starts a fresh one.
 */
function planRepoll(qc: QueryClient, serverId: string, data: UsageView, updatedAt: number): void {
  const prev = repolls.get(serverId);
  if (prev && prev.sweep >= updatedAt) return; // already handled (another card, a re-render)
  if (prev?.timer) clearTimeout(prev.timer); // superseded by a newer result
  const pending = queuedCount(data.byId);
  const followUp = prev?.fired === true;
  const chain = followUp ? prev.chain + 1 : 0;
  const entry: Repoll = { sweep: updatedAt, pending, chain, timer: null, fired: false };
  repolls.set(serverId, entry);
  if (followUp && (pending >= prev.pending || chain >= Object.keys(data.byId).length)) return; // no progress: stop
  const delay = queuedRepollDelayMs(data.byId);
  if (delay === null) return;
  const key = qk.usage(serverId);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const q = qc.getQueryCache().find({ queryKey: key, exact: true });
    const s = q?.state;
    if (!q || !s || !q.isActive() || s.fetchStatus !== "idle" || s.dataUpdatedAt !== updatedAt || s.errorUpdatedAt > updatedAt) return;
    entry.fired = true;
    void qc.invalidateQueries({ queryKey: key }, { cancelRefetch: false }).then(() => {
      // Failed follow-up: no new data, so no planRepoll ran for it. Break the chain explicitly.
      if (repolls.get(serverId) === entry && (q.state.errorUpdatedAt ?? 0) > updatedAt) entry.fired = false;
    });
  }, delay);
}

function useQueuedRepoll(serverId: string, data: UsageView | undefined, updatedAt: number, active: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (data && active) planRepoll(qc, serverId, data, updatedAt);
  }, [qc, serverId, updatedAt, active]); // `data` changes with updatedAt
}

/** Opt-out: drop the host's cached reads so no stale accounts or controls remain. Nothing is aborted. */
export function forgetHost(qc: QueryClient, serverId: string): void {
  qc.removeQueries({ queryKey: qk.state(serverId), exact: true });
  qc.removeQueries({ queryKey: qk.usage(serverId), exact: true });
}

/** Manual refresh: never cancels an in-flight read (that would kill a remote node mid-read and start another). */
export const refreshHost = (qc: QueryClient, serverId: string) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: qk.state(serverId) }, { cancelRefetch: false }),
    qc.invalidateQueries({ queryKey: qk.usage(serverId) }, { cancelRefetch: false }),
  ]);
export const refreshAll = (qc: QueryClient) => qc.invalidateQueries({ queryKey: qk.all }, { cancelRefetch: false });

// ---- mutations: one in flight per host (fail fast, never queue a swap) ----
const busyHosts = new Set<string>();

async function withHostLock<T>(serverId: string, fn: () => Promise<OpResult<T>>): Promise<OpResult<T>> {
  if (busyHosts.has(serverId)) {
    return { ok: false, error: { code: "host_busy", message: "Ya hay un cambio en curso en este host. Espera a que termine." } };
  }
  busyHosts.add(serverId);
  try {
    return await fn();
  } finally {
    busyHosts.delete(serverId);
  }
}

export const useHostBusy = (serverId: string): boolean => {
  const own = useIsMutating({ mutationKey: qk.mutation(serverId) });
  const all = useIsMutating({ mutationKey: qk.autoAll, predicate: (m) => ((m.state.variables as AutoAllInput | undefined)?.ids ?? []).includes(serverId) });
  return own + all > 0;
};

/**
 * Every device's last read state, straight from the cache: each card owns its query. No observer is added,
 * so nothing here can change how those queries fetch (an observer's options would become the query's).
 */
export function useCachedStates(serverIds: readonly string[]): readonly (StateView | undefined)[] {
  const qc = useQueryClient();
  const key = serverIds.join(" ");
  const read = () => serverIds.map((id) => qc.getQueryData<StateView>(qk.state(id)));
  const [states, setStates] = useState(read);
  useEffect(() => {
    const update = () => setStates((old) => {
      const now = read();
      return now.length === old.length && now.every((x, i) => x === old[i]) ? old : now;
    });
    update();
    return qc.getQueryCache().subscribe(update);
  }, [qc, key]); // read() follows key
  return states;
}

/** Wait for a state read already in flight: it may predate the change, and bridge runs are never aborted. */
async function settleStateRead(qc: QueryClient, serverId: string): Promise<void> {
  const q = qc.getQueryCache().find({ queryKey: qk.state(serverId), exact: true });
  if (q?.state.fetchStatus === "fetching") await q.promise?.catch(() => undefined);
}

/** Re-read targets/accounts/auto after a change (no Anthropic calls). Joins a read that started after it. */
async function rereadState(qc: QueryClient, serverId: string): Promise<void> {
  await settleStateRead(qc, serverId);
  await qc.invalidateQueries({ queryKey: qk.state(serverId) }, { cancelRefetch: false });
}

/** Optimistic auto value; `auto_idle` cannot apply once rotation is off (the re-read restores the rest). */
function withAuto(old: StateView, auto: AutoView): StateView {
  const idle = auto.enabled && auto.current === null;
  return { ...old, auto, warnings: idle ? old.warnings : old.warnings.filter((w) => w.code !== "auto_idle") };
}

export function useSwap(t: Transport, serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: qk.mutation(serverId),
    mutationFn: async (input: SwapInput): Promise<SwapView> => unwrap(await withHostLock(serverId, () => t.swap(serverId, input))),
    retry: false,
    onSuccess: ({ accountId, usage }) => {
      if (accountId && usage) {
        qc.setQueryData<UsageView>(qk.usage(serverId), (old) => (old ? { ...old, byId: { ...old.byId, [accountId]: usage } } : old));
      }
    },
    // success, failure or unknown: re-read targets/accounts/auto (no Anthropic calls). Usage is NOT refetched.
    // A pre-swap read is awaited, not cancelled: cancelling no longer stops the remote run, it would only
    // start a second terminal next to it.
    onSettled: () => rereadState(qc, serverId),
  });
}

/** Sets one device's automatic rotation and keeps its cached state in step (shared by the card's switch and the panel's). */
async function setAutoOn(qc: QueryClient, t: Transport, serverId: string, enabled: boolean): Promise<AutoView> {
  try {
    const auto = unwrap(await withHostLock(serverId, () => t.setAuto(serverId, enabled)));
    await settleStateRead(qc, serverId); // a pre-toggle read must not land on top of the new value
    qc.setQueryData<StateView>(qk.state(serverId), (old) => (old ? withAuto(old, auto) : old));
    return auto;
  } finally {
    // Success or failure: re-read so the derived warnings (auto_idle...) match LLMswapper. No Anthropic calls.
    await rereadState(qc, serverId).catch(() => undefined);
  }
}

export interface AutoAllInput {
  readonly ids: readonly string[];
  readonly enabled: boolean;
}
export interface AutoAllResult {
  readonly id: string;
  readonly error: OpError | null;
}

/** The panel's switch: the same change on several devices at once, each under its own host lock. */
export function useSetAutoMany(t: Transport) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: qk.autoAll,
    mutationFn: ({ ids, enabled }: AutoAllInput): Promise<AutoAllResult[]> =>
      Promise.all(ids.map((id) => setAutoOn(qc, t, id, enabled).then(() => ({ id, error: null }), (e: unknown) => ({ id, error: opErrorOf(e) })))),
    retry: false,
  });
}

export function useSetAuto(t: Transport, serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: qk.mutation(serverId),
    mutationFn: (enabled: boolean): Promise<AutoView> => setAutoOn(qc, t, serverId, enabled),
    retry: false,
  });
}
