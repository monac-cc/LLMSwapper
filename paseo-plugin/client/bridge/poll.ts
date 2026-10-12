import { parseBridgeOutput, type BridgeEnvelope } from "../../shared/bridge.ts";
import { redact } from "../../shared/pick.ts";
import { BAD_CWD_RE, BridgeError, NOT_FOUND_RE, classifyClientError, messageOf } from "./errors.ts";

/** Narrow view of PaseoTerminalHandle (structurally satisfied by the SDK handle; easy to fake in tests). */
export interface BridgeTerminal {
  readonly id: string;
  capture(options?: { start?: number; stripAnsi?: boolean }): Promise<{ lines: string[]; totalLines: number }>;
  kill(): Promise<void>;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new BridgeError("bridge_timeout", "Cancelado"));
      const onAbort = () => {
        clearTimeout(id);
        reject(new BridgeError("bridge_timeout", "Cancelado"));
      };
      const id = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export interface PollOptions {
  readonly nonce: string;
  readonly timeoutMs: number;
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
}

const GONE_POLLS = 2;          // consecutive totalLines===0 before concluding the process exited
const MAX_CAPTURE_ERRORS = 6;  // consecutive capture() rejections before giving up

/** Abort after create: the process exists, so the run may have happened (reads only pass a signal). */
const cancelled = (): never => {
  throw new BridgeError("bridge_timeout", "Cancelado", true);
};

const tailOf = (lines: readonly string[]): string =>
  redact(lines.map((l) => l.trimEnd()).filter((l) => l.length > 0).slice(-3).join(" | "), 300);

/**
 * Polls capture() until this run's block is complete. A live terminal always reports
 * totalLines >= rows (scrollback + grid); the daemon answers totalLines 0 once the terminal is gone
 * (the PTY exited and was deleted) but ALSO when its capture fails (worker timeout or crash), and we
 * only sample the output. So "gone without the start marker" proves nothing by itself: only a
 * positive error in a tail captured while the terminal was live does (bad cwd first: posix
 * "chdir(2) failed.: No such file or directory" also matches NOT_FOUND_RE).
 * No refresh()/list() calls: they are unscoped and can fail for reasons unrelated to our process.
 * The caller kills the terminal in all cases.
 */
export async function pollForEnvelope(term: BridgeTerminal, o: PollOptions, clock: Clock = realClock): Promise<BridgeEnvelope> {
  const pollMs = o.pollMs ?? 250;
  const deadline = clock.now() + o.timeoutMs;
  let started = false;
  let gone = 0;
  let errors = 0;
  let tail = "";
  await clock.sleep(150, o.signal).catch(cancelled);
  for (;;) {
    let cap: { lines: string[]; totalLines: number } | null = null;
    try {
      cap = await term.capture({ start: 0, stripAnsi: true });
      errors = 0;
    } catch (e) {
      const raw = messageOf(e);
      if (classifyClientError(raw) === "host_offline" || ++errors >= MAX_CAPTURE_ERRORS) {
        throw new BridgeError(classifyClientError(raw) === "host_offline" ? "host_offline" : "terminal_failed", raw, true);
      }
    }
    if (cap) {
      const parsed = parseBridgeOutput(cap.lines, o.nonce);
      if (parsed.status === "done") return parsed.envelope;
      if (parsed.status === "corrupt") throw new BridgeError("bridge_corrupt", parsed.message, true);
      if (parsed.status === "duplicate") {
        // Another process with this nonce already ran on the device: this copy did nothing.
        throw new BridgeError("bridge_exited", "Ejecución duplicada descartada en el equipo remoto.", true);
      }
      if (parsed.started) started = true;
      if (cap.totalLines === 0) {
        if (++gone >= GONE_POLLS) {
          if (started) throw new BridgeError("bridge_exited", `El proceso remoto terminó sin respuesta${tail ? `: ${tail}` : ""}`, true);
          if (BAD_CWD_RE.test(tail)) throw new BridgeError("workspace_unusable", `La carpeta del workspace no está disponible en ese equipo (${tail}).`);
          if (NOT_FOUND_RE.test(tail)) throw new BridgeError("node_missing", `Node.js no está disponible en ese equipo (${tail}).`);
          // No positive evidence: probably never started, but it may have run unseen.
          throw new BridgeError("bridge_exited", `Node.js no llegó a ejecutar el script${tail ? `: ${tail}` : " (¿no instalado o demasiado antiguo?)"}`, true, true);
        }
      } else {
        gone = 0;
        const t = tailOf(cap.lines);
        if (t) tail = t;
      }
    }
    if (clock.now() >= deadline) throw new BridgeError("bridge_timeout", `Sin respuesta en ${Math.round(o.timeoutMs / 1000)} s`, true);
    await clock.sleep(pollMs, o.signal).catch(cancelled);
  }
}
