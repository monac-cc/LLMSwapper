/** Strict allowlists. Anything that does not match is shown read-only and never sent to LLMswapper. */
export const ACCOUNT_ID_RE = /^acc_[0-9a-f]{6}$/;
export const TARGET_ID_RE = /^(?:host|wsl:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
export const NONCE_RE = /^[0-9a-f]{16}$/;
/** "node" or an absolute path to a node binary (passed as argv[0], never through a shell). */
export const NODE_COMMAND_RE = /^(?:node|\/[^\u0000-\u001f"]{1,255}|[A-Za-z]:\\[^\u0000-\u001f"]{1,255})$/;

export const isAccountId = (v: unknown): v is string => typeof v === "string" && ACCOUNT_ID_RE.test(v);
export const isTargetId = (v: unknown): v is string => typeof v === "string" && TARGET_ID_RE.test(v);
export const isNodeCommand = (v: unknown): v is string => typeof v === "string" && NODE_COMMAND_RE.test(v);
export const isPort = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
