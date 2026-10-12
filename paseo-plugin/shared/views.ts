import { z } from "zod";
// What the UI consumes. Identical whether it came over plugin RPC or the terminal bridge.

export const Severity = z.enum(["normal", "medium", "high", "critical", "unknown"]);
export type Severity = z.infer<typeof Severity>;

export const ErrorCode = z.enum([
  // transport (client side)
  "host_offline", "no_workspace", "workspace_unusable", "node_missing", "terminal_failed", "permission_denied", "sdk_unsupported",
  "bridge_timeout", "bridge_exited", "bridge_corrupt", "rpc_failed", "host_busy", "invalid_input",
  "bridge_disabled", // refused client side: the host is not opted in (nothing ran on it)
  // LLMswapper
  "swapper_down", "swapper_timeout", "swapper_unreachable", "swapper_forbidden", "endpoint_missing",
  "bad_request", "swapper_failed", "bad_response",
  // swap specifics
  "swap_busy", "swap_unknown_result",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const OpError = z.object({ code: ErrorCode, message: z.string(), status: z.number().optional() });
export type OpError = z.infer<typeof OpError>;
export type OpResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: OpError };

export function resultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: OpError }),
  ]);
}

export const MeterView = z.object({
  percent: z.number().nullable(), resetsAt: z.number().nullable(), severity: Severity,
});
export type MeterView = z.infer<typeof MeterView>;

export const UsageEntryView = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"), fetchedAt: z.number(), session: MeterView, weekly: MeterView, probe: z.boolean(),
    stale: z.object({ since: z.number().nullable(), reason: z.string().nullable() }).nullable(),
    queuedRetryInS: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("error"), message: z.string(), status: z.number(), needsRelogin: z.boolean(),
    rateLimited: z.boolean(), throttled: z.boolean(), retryInS: z.number().nullable(),
  }),
]);
export type UsageEntryView = z.infer<typeof UsageEntryView>;

export const UsageView = z.object({ receivedAt: z.number(), byId: z.record(z.string(), UsageEntryView) });
export type UsageView = z.infer<typeof UsageView>;

export const HealthView = z.object({
  claudeRunning: z.boolean(), claudeProcesses: z.number(), node: z.string(), platform: z.string(),
  credentialsKind: z.string(), credentialsError: z.string().nullable(), overridingEnv: z.array(z.string()),
  container: z.boolean(), unavailable: z.array(z.string()), build: z.string(), staleMount: z.boolean(),
});
export type HealthView = z.infer<typeof HealthView>;
export const TargetView = z.object({
  id: z.string(), kind: z.string(), label: z.string(), activeId: z.string().nullable(), running: z.boolean(),
  swappable: z.boolean(),
});
export type TargetView = z.infer<typeof TargetView>;
export const AccountView = z.object({
  id: z.string(), label: z.string(), email: z.string().nullable(), color: z.string(), plan: z.string().nullable(),
  tokenExpired: z.boolean(), sessionEndsAt: z.number().nullable(), canReadUsage: z.boolean(),
  renewable: z.boolean(), expiresAt: z.number().nullable(), swappable: z.boolean(),
});
export type AccountView = z.infer<typeof AccountView>;
export const BriefView = z.object({
  id: z.string(), label: z.string(), sessionPercent: z.number().nullable(), weeklyPercent: z.number().nullable(),
  sessionResetsAt: z.number().nullable(), weeklyResetsAt: z.number().nullable(),
});
export type BriefView = z.infer<typeof BriefView>;
export const AutoView = z.object({
  enabled: z.boolean(), target: z.string(), threshold: z.number(),
  current: BriefView.nullable(), next: BriefView.nullable(),
  queue: z.array(BriefView.extend({ eligible: z.boolean(), reason: z.string().nullable() })),
});
export type AutoView = z.infer<typeof AutoView>;
export const WarningView = z.object({
  code: z.string(), level: z.enum(["info", "warning", "danger"]), message: z.string(),
});
export type WarningView = z.infer<typeof WarningView>;

export const StateView = z.object({
  receivedAt: z.number(), health: HealthView, targets: z.array(TargetView), accounts: z.array(AccountView),
  auto: AutoView.nullable(), warnings: z.array(WarningView),
});
export type StateView = z.infer<typeof StateView>;

/** Open Paseo sessions of the plugin host after a swap on its own environment (null: not applicable). */
export const SessionsView = z.object({ reloading: z.number(), deferred: z.number(), note: z.string().nullable() });
export type SessionsView = z.infer<typeof SessionsView>;

export const SwapView = z.object({
  target: z.string(), targetLabel: z.string(), accountId: z.string().nullable(), accountLabel: z.string().nullable(),
  verified: z.boolean(), warnings: z.array(z.string()), usage: UsageEntryView.nullable(),
  sessions: SessionsView.nullable(),
});
export type SwapView = z.infer<typeof SwapView>;

export const StateResult = resultSchema(StateView);
export const UsageResult = resultSchema(UsageView);
export const SwapResult = resultSchema(SwapView);
export const AutoResult = resultSchema(AutoView);
