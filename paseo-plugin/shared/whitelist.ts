import type { PickSpec } from "./pick.ts";

// Only these fields ever cross the wire. Tokens, paths, backups and cache keys are not listed.
const METER: Record<string, PickSpec> = { percent: 1, resetsAt: 1, severity: 1 };
const USAGE: Record<string, PickSpec> = {
  id: 1, ok: 1, fetchedAt: 1, session: METER, weekly: METER, viaProbe: 1,
  stale: 1, staleSince: 1, staleReason: 1, queued: 1, retryInS: 1,
  error: 1, status: 1, needsRelogin: 1, throttled: 1, rateLimited: 1,
};
const BRIEF: Record<string, PickSpec> = {
  id: 1, label: 1, sessionPercent: 1, weeklyPercent: 1, sessionResetsAt: 1, weeklyResetsAt: 1,
};

export const PICK = {
  health: {
    ok: 1, claudeRunning: 1, pids: 1, node: 1, platform: 1,
    credentialsBackend: { kind: 1, error: 1 },
    overridingEnv: 1, container: 1, unavailable: 1, build: 1, staleMount: 1,
  },
  targets: { targets: [{ id: 1, kind: 1, label: 1, activeId: 1, running: 1 }] },
  accounts: {
    activeId: 1,
    accounts: [{
      id: 1, label: 1, email: 1, color: 1, plan: 1, isActive: 1, tokenExpired: 1,
      sessionEndsAt: 1, canReadUsage: 1, renewable: 1, expiresAt: 1, lastSwappedAt: 1,
    }],
  },
  auto: {
    enabled: 1, target: 1, threshold: 1, current: BRIEF, next: BRIEF,
    queue: [{ ...BRIEF, eligible: 1, reason: 1, role: 1 }],
  },
  usageAll: { "*": USAGE },
  swap: {
    ok: 1, target: 1, targetLabel: 1, verified: 1, warnings: 1, usage: USAGE,
    account: { id: 1, label: 1 },
  },
  error: { ok: 1, error: 1 },
} satisfies Record<string, PickSpec>;
