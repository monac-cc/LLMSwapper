import { z } from "zod";
// Shapes of LLMswapper responses AFTER the whitelist pick. z.object strips unknown keys (2nd whitelist).
// Optional = added in later LLMswapper releases (keeps older installs on other devices working).
const Iso = z.string().nullable();
const Severity = z.enum(["normal", "medium", "high", "critical", "unknown"]).catch("unknown");

export const RawHealth = z.object({
  ok: z.literal(true), claudeRunning: z.boolean(), pids: z.array(z.number().nullable()),
  node: z.string(), platform: z.string(),
  credentialsBackend: z.object({ kind: z.string(), error: z.string().optional() }).nullable().optional(),
  overridingEnv: z.array(z.string().nullable()).default([]),
  container: z.boolean().optional(), unavailable: z.array(z.string().nullable()).optional(),
  build: z.string().optional(), staleMount: z.boolean().optional(),
});
export const RawTargets = z.object({
  targets: z.array(z.object({
    id: z.string(), kind: z.string(), label: z.string(), activeId: z.string().nullable(), running: z.boolean(),
  })),
});
export const RawAccount = z.object({
  id: z.string(), label: z.string(), email: z.string().nullable(), color: z.string(), plan: z.string().nullable(),
  isActive: z.boolean(), tokenExpired: z.boolean(), sessionEndsAt: z.number().nullable().optional(),
  canReadUsage: z.boolean().optional(), renewable: z.boolean().optional(),
  expiresAt: z.number().nullable(), lastSwappedAt: z.number().nullable(),
});
export const RawAccounts = z.object({ activeId: z.string().nullable(), accounts: z.array(RawAccount) });
const RawBrief = z.object({
  id: z.string(), label: z.string(), sessionPercent: z.number().nullable(), weeklyPercent: z.number().nullable(),
  sessionResetsAt: Iso, weeklyResetsAt: Iso,
});
export const RawAuto = z.object({
  enabled: z.boolean(), target: z.string(), threshold: z.number(),
  current: RawBrief.nullable(), next: RawBrief.nullable(),
  queue: z.array(RawBrief.extend({ eligible: z.boolean(), reason: z.string().nullable(), role: z.string() })),
});
const RawMeter = z.object({ percent: z.number(), resetsAt: Iso, severity: Severity });
export const RawUsageOk = z.object({
  id: z.string(), ok: z.literal(true), fetchedAt: z.number(), session: RawMeter, weekly: RawMeter,
  viaProbe: z.boolean().optional(), stale: z.boolean().optional(), staleSince: z.number().optional(),
  staleReason: z.string().optional(), queued: z.boolean().optional(), retryInS: z.number().optional(),
});
export const RawUsageErr = z.object({
  id: z.string(), ok: z.literal(false), error: z.string(), status: z.number(), needsRelogin: z.boolean(),
  throttled: z.boolean().optional(), rateLimited: z.boolean().optional(), retryInS: z.number().optional(),
});
export const RawUsage = z.discriminatedUnion("ok", [RawUsageOk, RawUsageErr]);
export const RawSwap = z.object({
  ok: z.literal(true), target: z.string(), targetLabel: z.string(), verified: z.boolean(),
  warnings: z.array(z.string().nullable()), usage: RawUsageOk.nullable().catch(null),
  account: z.object({ id: z.string(), label: z.string() }).nullable(),
});
export const RawError = z.object({ ok: z.literal(false), error: z.string() });
