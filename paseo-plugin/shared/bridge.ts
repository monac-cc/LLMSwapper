import { z } from "zod";
import { decodeBase64Text, encodeTextBase64Url } from "./base64.ts";
import { RawResult } from "./exec.ts";
import { NONCE_RE, isNodeCommand, isPort } from "./ids.ts";
import { InvalidOpError, planFor, type SwapperOp } from "./plan.ts";
import { SCRIPT_TEMPLATE } from "./bridge-script.ts";
import { PICK } from "./whitelist.ts";

export { isAccountId, isNodeCommand, isPort, isTargetId } from "./ids.ts";

/** node -e BOOT <b64>: argv[1] is the payload. No spaces, no double quotes, none of & | < > ^ % ! $ `. */
export const BOOT = "eval(Buffer.from(process.argv[1],'base64').toString())";
export const CHUNK = 160;                // base64 chars per output line; the terminal has 200 cols
export const TERMINAL_SIZE = { rows: 60, cols: 200 } as const;
// cmd.exe line limit 8191 (the daemon wraps .cmd node shims in cmd.exe) minus node path (<= 258), " -e ",
// BOOT and the cmd.exe /d /s /c quoting (< 400 in total).
export const MAX_ARG_B64 = 7_600;
export const DEFAULT_LINGER_MS = 20_000; // device process stays alive this long after emitting

/**
 * POSIX-only fallback when `node` is not on the daemon's PATH (nvm/fnm set up in shell rc files).
 * CONSTANT text: data reaches it only as positional args ($0 = BOOT, $1 = payload, $2 = node command).
 * Nothing is typed into a shell, so no prompt race, no echo and no canonical-mode line limit.
 * stdin is /dev/null: an rc-file prompt (zsh compinit "[y/n]?", read -q, ...) gets EOF instead of
 * blocking on the PTY forever; stdout/stderr stay on the PTY for the markers.
 */
export const LOGIN_SHELL_WRAPPER =
  `case "\${SHELL##*/}" in bash|zsh|ksh|mksh) S="$SHELL";; *) S=$(command -v bash || command -v zsh || echo /bin/sh);; esac; ` +
  `exec "$S" -lic 'exec "$2" -e "$0" "$1"' "$0" "$1" "$2" </dev/null`;

/** Device-side fatal when the run-once lock is unusable: emitted before the start marker, nothing was sent. */
export const LOCK_FATAL = "lock_unavailable";

export interface RemoteScriptOptions {
  readonly port: number;
  readonly nonce: string;
  readonly lingerMs?: number;
}

/** Pure: the JS source the device runs for `op`. Throws InvalidOpError on bad input. */
export function buildRemoteScript(op: SwapperOp, opts: RemoteScriptOptions): string {
  if (!isPort(opts.port)) throw new InvalidOpError("Puerto no válido");
  if (!NONCE_RE.test(opts.nonce)) throw new InvalidOpError("Nonce no válido");
  const plan = planFor(op); // validates account / target ids
  const cfg = {
    n: opts.nonce, p: opts.port, w: CHUNK, l: opts.lingerMs ?? DEFAULT_LINGER_MS, t: plan.timeoutMs, x: PICK.error,
    g: plan.requests.some((r) => r.method !== "GET") ? 1 : 0, // mutating: never run without the run-once lock
    r: plan.requests.map((r) => ({ key: r.key, m: r.method, u: r.path, b: r.body ?? null, k: r.pick, t: r.timeoutMs })),
  };
  return SCRIPT_TEMPLATE.split("__CFG__").join(JSON.stringify(cfg)); // split/join: no $& replacement patterns
}

export type SpawnMode = "direct" | "login-shell";

export interface BridgeInvocation {
  readonly command: string;
  readonly args: string[];
  readonly payload: string;
}

export interface InvocationOptions extends RemoteScriptOptions {
  readonly nodeCommand?: string;
  readonly mode?: SpawnMode;
}

/** Arguments for terminals.create({ command, args }). Never a shell line built from data. */
export function buildBridgeInvocation(op: SwapperOp, opts: InvocationOptions): BridgeInvocation {
  const node = opts.nodeCommand ?? "node";
  if (!isNodeCommand(node)) throw new InvalidOpError("Ruta de Node.js no válida");
  const payload = encodeTextBase64Url(buildRemoteScript(op, opts));
  if (payload.length > MAX_ARG_B64) throw new InvalidOpError("Script del puente demasiado grande");
  return opts.mode === "login-shell"
    ? { command: "/bin/sh", args: ["-c", LOGIN_SHELL_WRAPPER, BOOT, payload, node], payload }
    : { command: node, args: ["-e", BOOT, payload], payload };
}

/** 16 lowercase hex chars. Math.random is enough: the nonce only has to be unpredictable to echoed text. */
export const newNonce = (): string => {
  let s = "";
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
};

export const BridgeEnvelope = z.object({
  v: z.literal(1),
  node: z.string().max(40).optional(),
  results: z.record(z.string(), RawResult).optional(),
  fatal: z.string().max(1600).optional(),
});
export type BridgeEnvelope = z.infer<typeof BridgeEnvelope>;

export type BridgeParse =
  | { readonly status: "pending"; readonly started: boolean }
  | { readonly status: "duplicate" }
  | { readonly status: "done"; readonly envelope: BridgeEnvelope }
  | { readonly status: "corrupt"; readonly message: string };

const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const B64_LINE_RE = /^[A-Za-z0-9+/=_-]*$/;

/** Pure and wrap-agnostic: `text` is capture().lines or one string (CRLF ok). */
export function parseBridgeOutput(text: string | readonly string[], nonce: string): BridgeParse {
  const lines = (typeof text === "string" ? text.split(/\r?\n/) : text).map((l) => l.replace(ANSI_RE, "").trim());
  if (lines.includes(`__SWP_D_${nonce}__`)) return { status: "duplicate" };
  const started = lines.includes(`__SWP_S_${nonce}__`);
  const begin = lines.indexOf(`__SWP_B_${nonce}__`);
  if (begin < 0) return { status: "pending", started };
  const endPrefix = `__SWP_E_${nonce}_`;
  let end = -1;
  let expected = -1;
  for (let i = begin + 1; i < lines.length; i++) {
    const l = lines[i];
    const n = l.startsWith(endPrefix) && l.endsWith("__") ? l.slice(endPrefix.length, -2) : "";
    if (/^[0-9]{1,7}$/.test(n)) {
      end = i;
      expected = Number(n);
      break;
    }
  }
  if (end < 0) return { status: "pending", started: true };
  const body = lines.slice(begin + 1, end);
  if (!body.every((l) => B64_LINE_RE.test(l))) return { status: "corrupt", message: "Salida del puente con caracteres inesperados" };
  const payload = body.join("");
  if (payload.length !== expected) return { status: "corrupt", message: `Salida incompleta (${payload.length}/${expected})` };
  let json: unknown;
  try {
    json = JSON.parse(decodeBase64Text(payload));
  } catch {
    return { status: "corrupt", message: "Salida del puente ilegible" };
  }
  const env = BridgeEnvelope.safeParse(json);
  return env.success ? { status: "done", envelope: env.data } : { status: "corrupt", message: "Sobre del puente no válido" };
}
