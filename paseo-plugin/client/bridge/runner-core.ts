import { LOCK_FATAL, TERMINAL_SIZE, buildBridgeInvocation, newNonce, type BridgeEnvelope, type SpawnMode } from "../../shared/bridge.ts";
import { interpret, type OpData } from "../../shared/interpret.ts";
import { InvalidOpError, planFor, type SwapperOp } from "../../shared/plan.ts";
import type { OpError, OpResult, StateView, WarningView } from "../../shared/views.ts";
import { BridgeError, classifyClientError, createNeverSent, messageOf, toOpError } from "./errors.ts";
import { pollForEnvelope, realClock, type BridgeTerminal, type Clock } from "./poll.ts";
import { forgetWorkspaces, isWindowsPath, resolveWorkspaces, type BridgeWorkspace, type WorkspaceChoice, type WorkspaceLister } from "./workspace.ts";

type Op<K extends SwapperOp["kind"]> = Extract<SwapperOp, { kind: K }>;

/** The slice of PaseoApi the bridge needs. getPaseoClient(id) satisfies it structurally. */
export interface BridgeApi {
  readonly terminals: {
    create(options: {
      workspaceId: string; cwd?: string; name?: string; command?: string; args?: string[]; size?: { rows: number; cols: number };
    }): Promise<BridgeTerminal>;
    /** Handle for an existing terminal on a FRESH client: kills a bridge terminal after a reconnect. */
    ref?(id: string): { kill(): Promise<void> };
  };
  readonly workspaces: WorkspaceLister;
}

export interface BridgeDeps {
  /** Called fresh for every run: cached PaseoApi objects throw after a reconnect. */
  readonly getClient: (serverId: string) => BridgeApi;
  readonly clock?: Clock;
  readonly nonce?: () => string;
  /** Where a terminal that could not be killed is reported (default console.warn). */
  readonly warn?: (message: string) => void;
}

export interface BridgeRunOptions {
  readonly port: number;
  readonly workspaceId?: string;
  readonly nodeCommand?: string;
  readonly signal?: AbortSignal;
}

const CLIENT_SLACK_MS = 10_000; // relay round trips on top of the on-device budget
const MAX_WORKSPACE_TRIES = 3;
/** Background kill retries through a fresh client after the handle failed (≈ 2 min in total). */
const REAP_DELAYS_MS = [0, 2_000, 5_000, 10_000, 20_000, 40_000, 45_000];

const SWAP_UNKNOWN: OpError = {
  code: "swap_unknown_result",
  message: "Se perdió la respuesta del equipo remoto. El cambio puede haberse aplicado: actualiza para comprobarlo antes de reintentar.",
};

const WORKSPACE_IGNORED: WarningView = {
  code: "bridge_workspace_missing", level: "warning",
  message: "El workspace elegido para el puente ya no está disponible en ese equipo: se usó otro. Revisa Ajustes > LLMswapper.",
};

function borrow(deps: BridgeDeps, serverId: string): BridgeApi {
  try {
    return deps.getClient(serverId);
  } catch (e) {
    const raw = messageOf(e);
    throw new BridgeError(classifyClientError(raw) === "host_offline" ? "host_offline" : "terminal_failed", raw);
  }
}

const reaping = new Set<Promise<void>>();
const orphans = new Set<string>();

/** Bridge terminals whose kill failed and is still unconfirmed ("serverId/terminalId"). */
export const orphanedTerminals = (): string[] => [...orphans];

/** Resolves once every background kill retry has finished (tests, shutdown). */
export async function pendingReaps(): Promise<void> {
  while (reaping.size > 0) await Promise.all([...reaping]);
}

/**
 * The handle's kill() failed (typically the proxied client changed after a reconnect, so every handle
 * method throws). The daemon keeps the terminal, and its tab, alive: retry through a fresh client until
 * the host is back, bounded. Never silent: a terminal still alive at the end is logged and flagged.
 */
function reapLater(deps: BridgeDeps, serverId: string, id: string, clock: Clock, first: unknown): void {
  const key = `${serverId}/${id}`;
  orphans.add(key); // flagged until a kill succeeds
  const job = (async () => {
    let lastError = messageOf(first);
    for (const ms of REAP_DELAYS_MS) {
      if (ms > 0) await clock.sleep(ms).catch(() => undefined);
      try {
        const terminals = deps.getClient(serverId).terminals;
        if (!terminals.ref) break;
        await terminals.ref(id).kill();
        orphans.delete(key);
        return;
      } catch (e) {
        lastError = messageOf(e); // still offline, or the session changed again
      }
    }
    try {
      (deps.warn ?? console.warn)(`LLMswapper: no se pudo cerrar el terminal del puente ${id} en ${serverId} (${lastError}). Ciérralo a mano si sigue abierto.`);
    } catch {
      // logging must never break the bridge
    }
  })();
  reaping.add(job);
  void job.finally(() => reaping.delete(job));
}

/**
 * The host answered again: retry the kill of every terminal of it that reapLater gave up on (a login
 * shell blocked on an rc-file prompt never exits on its own). Background, never delays the run;
 * killing an id the daemon no longer knows succeeds, so already-exited terminals just get unflagged.
 */
function retryOrphans(api: BridgeApi, serverId: string): void {
  const ref = api.terminals.ref;
  if (!ref) return;
  for (const key of orphans) {
    if (!key.startsWith(`${serverId}/`)) continue;
    const job = ref(key.slice(serverId.length + 1)).kill().then(() => { orphans.delete(key); }, () => undefined);
    reaping.add(job);
    void job.finally(() => reaping.delete(job));
  }
}

/** One spawn + poll + kill. Throws BridgeError; `maybeRan` tells whether the script may have run. */
async function attempt(
  deps: BridgeDeps, serverId: string, ws: BridgeWorkspace, op: SwapperOp, mode: SpawnMode, nonce: string, o: BridgeRunOptions, clock: Clock,
): Promise<BridgeEnvelope> {
  const inv = buildBridgeInvocation(op, { port: o.port, nonce, nodeCommand: o.nodeCommand, mode });
  const api = borrow(deps, serverId); // fresh per spawn: survives a reconnect between attempts
  let term: BridgeTerminal;
  try {
    term = await api.terminals.create({
      workspaceId: ws.workspaceId, cwd: ws.cwd, name: "LLMswapper", command: inv.command, args: inv.args, size: TERMINAL_SIZE,
    });
  } catch (e) {
    const raw = messageOf(e);
    const code = classifyClientError(raw);
    // Only pre-send failures and explicit refusals prove nothing was spawned. A disconnect while the
    // request was in flight ("Server disconnected", timeouts, ...) may have let the daemon spawn it.
    throw new BridgeError(code, raw, !createNeverSent(raw, code));
  }
  try {
    return await pollForEnvelope(term, { nonce, timeoutMs: planFor(op).timeoutMs + CLIENT_SLACK_MS, signal: o.signal }, clock);
  } finally {
    try {
      await term.kill(); // idempotent; the device script also self-exits
    } catch (e) {
      reapLater(deps, serverId, term.id, clock, e);
    }
  }
}

const skipsWorkspace = (e: BridgeError): boolean => !e.maybeRan && (e.code === "workspace_unusable" || e.code === "no_workspace");

/** Never saw the start marker: a same-nonce respawn is safe (the device lock dedupes). */
const respawnable = (e: BridgeError): boolean =>
  (e.code === "node_missing" || e.code === "bridge_exited") && (!e.maybeRan || e.startUnseen);

/** Positive evidence that node is not reachable (from create or a live tail), not just silence. */
const nodeProvablyMissing = (e: BridgeError): boolean => e.code === "node_missing" && !e.maybeRan;

interface RunOutcome {
  readonly env: BridgeEnvelope;
  readonly preferredMissing: boolean;
}

async function runEnvelope(deps: BridgeDeps, serverId: string, op: SwapperOp, o: BridgeRunOptions): Promise<RunOutcome> {
  const clock = deps.clock ?? realClock;
  const nonce = (deps.nonce ?? newNonce)(); // ONE nonce per logical run: the device-side guard drops duplicates
  buildBridgeInvocation(op, { port: o.port, nonce, nodeCommand: o.nodeCommand }); // validate before touching the host
  const api = borrow(deps, serverId);
  retryOrphans(api, serverId);
  let choice: WorkspaceChoice;
  try {
    choice = await resolveWorkspaces(api.workspaces, serverId, o.workspaceId, clock.now());
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    const raw = messageOf(e);
    throw new BridgeError(classifyClientError(raw), raw);
  }
  let unsure = false; // some attempt of this run may have reached the device script
  /** The final error must not claim "nothing ran" if any earlier attempt may have. */
  const final = (e: BridgeError): BridgeError => (unsure && !e.maybeRan ? new BridgeError(e.code, e.message, true) : e);
  /** One attempt; its BridgeError is returned (not thrown) so the loop can decide what comes next. */
  const spawn = async (ws: BridgeWorkspace, mode: SpawnMode): Promise<BridgeEnvelope | BridgeError> => {
    let env: BridgeEnvelope;
    try {
      env = await attempt(deps, serverId, ws, op, mode, nonce, o, clock);
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      if (e.maybeRan) unsure = true;
      return e;
    }
    if (env.fatal?.startsWith(LOCK_FATAL)) {
      // Emitted before the start marker: this copy sent nothing (mutating ops refuse to run unguarded).
      throw final(new BridgeError("bridge_exited", `El equipo remoto no permite crear el bloqueo de ejecución única (${env.fatal}); no se envió nada a LLMswapper.`));
    }
    return env;
  };
  let last: BridgeError | null = null;
  for (const ws of choice.candidates.slice(0, MAX_WORKSPACE_TRIES)) {
    const r1 = await spawn(ws, "direct");
    if (!(r1 instanceof BridgeError)) return { env: r1, preferredMissing: choice.preferredMissing };
    if (skipsWorkspace(r1)) {
      forgetWorkspaces(serverId);
      last = r1;
      continue; // nothing ran: try the next workspace
    }
    // nvm/fnm-only POSIX hosts: one login-shell respawn. Safe: nothing ran, or same nonce => device lock.
    if (!respawnable(r1) || isWindowsPath(ws.cwd)) throw final(r1);
    const r2 = await spawn(ws, "login-shell");
    if (!(r2 instanceof BridgeError)) return { env: r2, preferredMissing: choice.preferredMissing };
    if (skipsWorkspace(r2)) {
      forgetWorkspaces(serverId);
      last = r2;
      continue;
    }
    if (!respawnable(r2)) throw final(r2);
    const both = new BridgeError("node_missing", `${r1.message} / shell de login: ${r2.message}`, r1.maybeRan || r2.maybeRan);
    if (nodeProvablyMissing(r1) || nodeProvablyMissing(r2)) throw final(both);
    // Both copies vanished without a trace: maybe this directory is the problem (unmounted, deleted).
    forgetWorkspaces(serverId);
    last = both;
  }
  throw last ? final(last) : new BridgeError("no_workspace", "Ningún workspace de ese equipo sirve para el puente.");
}

/** Runs one op on a host WITHOUT the plugin, through a short-lived terminal. Never throws. */
export async function runOnHostCore<K extends SwapperOp["kind"]>(
  deps: BridgeDeps, serverId: string, op: Op<K>, o: BridgeRunOptions,
): Promise<OpResult<OpData[K]>> {
  const mutating = op.kind === "swap";
  try {
    const { env, preferredMissing } = await runEnvelope(deps, serverId, op, o);
    if (env.fatal) {
      if (mutating) return { ok: false, error: SWAP_UNKNOWN };
      return {
        ok: false,
        error: env.fatal === "script_timeout"
          ? { code: "swapper_timeout", message: "LLMswapper no respondió a tiempo en ese equipo." }
          : { code: "bridge_exited", message: `Fallo en el script remoto: ${env.fatal}` },
      };
    }
    const res = interpret(op.kind as K, env.results ?? {}, { now: (deps.clock ?? realClock).now(), port: o.port });
    if (preferredMissing && op.kind === "state" && res.ok) {
      const data = res.data as unknown as StateView;
      return { ok: true, data: { ...data, warnings: [...data.warnings, WORKSPACE_IGNORED] } as unknown as OpData[K] };
    }
    return res;
  } catch (e) {
    if (e instanceof InvalidOpError) return { ok: false, error: { code: "invalid_input", message: e.message } };
    const err = toOpError(e);
    // Swap: anything after the script may have started is an UNKNOWN outcome. Never retried.
    if (mutating && !(e instanceof BridgeError && !e.maybeRan)) {
      return { ok: false, error: { ...SWAP_UNKNOWN, message: `${SWAP_UNKNOWN.message} (${err.message})` } };
    }
    return { ok: false, error: err };
  }
}
