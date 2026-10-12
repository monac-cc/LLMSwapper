// SDK-bound contracts shared by client and server: plugin RPCs and host-scoped settings.
// (Kept out of tsconfig.test.json: everything else in shared/ is SDK-free and runs under node --test.)
import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { ACCOUNT_ID_RE, NODE_COMMAND_RE, TARGET_ID_RE } from "./ids.ts";
import { AutoResult, StateResult, SwapResult, UsageResult } from "./views.ts";

// ---- RPC: served only by the daemon this plugin is installed on, for ITS OWN LLMswapper. ----
// Inputs carry no port, path or URL: the plugin is not a loopback proxy. Handlers never throw for
// expected failures; they return { ok:false, error:{ code, message } }.
export const stateRpc = defineRpc({ name: "state.get", input: z.object({}), output: StateResult });
export const usageRpc = defineRpc({ name: "usage.get", input: z.object({}), output: UsageResult });
export const swapRpc = defineRpc({
  name: "swap.run",
  input: z.object({ accountId: z.string().regex(ACCOUNT_ID_RE), target: z.string().regex(TARGET_ID_RE) }),
  output: SwapResult,
});
export const autoRpc = defineRpc({ name: "auto.set", input: z.object({ enabled: z.boolean() }), output: AutoResult });

// ---- Settings: one document on the plugin's daemon; per-device entries keyed by Paseo serverId. ----
const Port = z.number().int().min(1).max(65535);
export const DEFAULT_PORT = 7373;

export const hostEntry = z.object({
  /** Explicit opt-in: nothing runs on a remote device until the user enables it. */
  bridge: z.boolean().default(false),
  /** LLMswapper port on that device. */
  port: Port.default(DEFAULT_PORT),
  /** Workspace on that device that owns the short-lived terminal; empty = automatic choice. */
  workspaceId: z.string().max(200).optional(),
  /** "node" or an absolute path, for daemons whose PATH lacks node. */
  nodeCommand: z.string().regex(NODE_COMMAND_RE).optional(),
  hidden: z.boolean().default(false),
});
export type HostEntry = z.output<typeof hostEntry>;
export const DEFAULT_HOST_ENTRY: HostEntry = { bridge: false, port: DEFAULT_PORT, hidden: false };

export const DEFAULT_REFRESH_MINUTES = 5;

/**
 * v1 -> v2: auto-refresh went from off by default to every 5 minutes. A v1 document holds an explicit
 * 0 even if nobody chose it: saving a per-host opt-in wrote every default. So 0 (or a missing value)
 * becomes 5; any other choice is kept. Runs on the host when it reads an older document.
 */
export function migrateSettings(values: unknown, fromVersion: number): unknown {
  if (!values || typeof values !== "object" || Array.isArray(values)) return values;
  const v: Record<string, unknown> = { ...(values as Record<string, unknown>) };
  if (fromVersion < 2 && (v.autoRefreshMinutes === 0 || v.autoRefreshMinutes === undefined)) v.autoRefreshMinutes = DEFAULT_REFRESH_MINUTES;
  return v;
}

export const swapperSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 2,
  migrate: migrateSettings,
  schema: z.object({
    /** LLMswapper port of the plugin's own daemon. Read ONLY by the server. */
    localPort: Port.default(DEFAULT_PORT),
    /** 0 = off; otherwise minutes between automatic refreshes while the panel is mounted. */
    autoRefreshMinutes: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(30)]).default(DEFAULT_REFRESH_MINUTES),
    /** Diagnostics: reach this daemon's own LLMswapper through the terminal bridge instead of RPC. */
    bridgeForLocal: z.boolean().default(false),
    hosts: z.record(z.string(), hostEntry).default({}),
  }),
});
export type SwapperSettings = z.output<typeof swapperSettings.schema>;
