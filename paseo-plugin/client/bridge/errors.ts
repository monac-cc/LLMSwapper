import { redact } from "../../shared/pick.ts";
import type { ErrorCode, OpError } from "../../shared/views.ts";

/**
 * Thrown inside the bridge; converted to OpResult at the runner boundary.
 * `maybeRan` is false ONLY when the device script provably never reached its first HTTP request:
 * create was refused before anything was spawned, or a LIVE capture showed a positive
 * "not found" / bad-cwd error and never the start marker. Everything else after a successful create
 * is conservatively "may have run": for a swap that means outcome unknown.
 * `startUnseen`: the terminal vanished without ever showing the start marker and without positive
 * evidence (most likely node never started, but zero-line captures can also be capture failures).
 * A same-nonce respawn is still safe (the device lock dedupes); a definite report is not.
 */
export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly maybeRan: boolean;
  readonly startUnseen: boolean;
  constructor(code: ErrorCode, message: string, maybeRan = false, startUnseen = false) {
    super(message);
    this.code = code;
    this.maybeRan = maybeRan;
    this.startUnseen = startUnseen;
  }
}

export const messageOf = (e: unknown): string => redact(e instanceof Error ? e.message : String(e), 300);

export function toOpError(e: unknown): OpError {
  if (e instanceof BridgeError) return { code: e.code, message: e.message };
  return { code: "terminal_failed", message: messageOf(e) };
}

/** Positive "executable not found" signals only (Windows node-pty, posix execvp, Node spawn). */
export const NOT_FOUND_RE = /File not found|error code: 2\b|ENOENT|execvp|No such file or directory|command not found|exec: [^\n]*not found|not recognized as|no se reconoce/i;
/** Windows CreateProcess ERROR_DIRECTORY / bad cwd (posix node-pty: "chdir(2) failed."): the workspace directory is unusable. */
export const BAD_CWD_RE = /error code: 267\b|ENOTDIR|chdir|directory name is invalid|nombre del directorio no es válido/i;

/** Messages come from the remote daemon / SDK (English). Classify; keep the raw text as detail. */
export function classifyClientError(raw: string): ErrorCode {
  if (/disconnected|Unknown Paseo host|connection changed|client is released|Transport not connected|Plugin has stopped/i.test(raw)) return "host_offline";
  if (/Update the host to use workspace terminals/i.test(raw)) return "sdk_unsupported";
  if (/not active or (does not exist|has no available directory)|workspaceId is required/i.test(raw)) return "no_workspace";
  if (BAD_CWD_RE.test(raw)) return "workspace_unusable";
  if (/permission|forbidden|not allowed|unauthori[sz]ed|daemon\.manage|workspace\.(read|write)/i.test(raw)) return "permission_denied";
  if (/Timeout waiting for message/i.test(raw)) return "bridge_timeout"; // the daemon MAY have spawned it
  if (NOT_FOUND_RE.test(raw)) return "node_missing";
  return "terminal_failed";
}

/** Thrown by the app proxy / SDK before a request leaves this client (ensureConnected, sendWhenConnected). */
const PRE_SEND_RE = /Paseo host is disconnected|Unknown Paseo host|connection changed|client is released|Plugin has stopped|Transport not connected/i;
/** Explicit refusals: the daemon (or SDK) rejected the create without spawning anything. */
const REFUSED: readonly ErrorCode[] = ["no_workspace", "workspace_unusable", "node_missing", "permission_denied", "sdk_unsupported"];

/**
 * A rejected terminals.create() proves nothing ran only for pre-send failures and explicit refusals.
 * Anything else ("Server disconnected", "Connection lost", timeouts, ...) may have reached the daemon,
 * which can spawn the process before the reply is lost.
 */
export const createNeverSent = (raw: string, code: ErrorCode): boolean => PRE_SEND_RE.test(raw) || REFUSED.includes(code);
