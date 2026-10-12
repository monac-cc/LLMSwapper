// Synthetic LLMswapper responses (shapes from the v1.2.3 contract). Secrets are fake and MUST never survive pick().
// Assembled at runtime, as in LLMswapper itself: no token-shaped literal in the source for scanners to flag.
export const FAKE_TOKEN = ["sk", "ant", "oat01", "FAKEFAKEFAKEFAKE"].join("-");
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const FAKE_JWT = [b64url({ alg: "HS256" }), b64url({ sub: "x" }), Buffer.from("signature").toString("base64url")].join(".");

export const health = {
  ok: true, claudeRunning: true, pids: [1234], node: "v24.14.1", platform: "win32",
  credentialsBackend: { kind: "file", location: "C:\\Users\\x\\.claude\\.credentials.json" },
  overridingEnv: [], container: false, unavailable: [], build: "", staleMount: false,
  paths: { claudeJson: "C:\\Users\\x\\.claude.json", data: "C:\\Users\\x\\llmswapper\\data" },
};
export const targets = {
  targets: [
    { id: "host", kind: "host", label: "Windows", activeId: "acc_a1b2c3", running: true },
    { id: "wsl:Ubuntu-24.04", kind: "wsl", label: "Ubuntu-24.04", activeId: "acc_d4e5f6", running: false },
  ],
};
export const accounts = {
  activeId: "acc_a1b2c3",
  accounts: [
    {
      id: "acc_a1b2c3", label: "Trabajo", email: null, color: "#3b82f6", plan: null, org: null, addedAt: 1, lastSwappedAt: 2,
      isActive: true, tokenExpired: false, sessionEndsAt: null, canReadUsage: false, renewable: false, expiresAt: 3,
      accessToken: FAKE_TOKEN, refreshToken: FAKE_TOKEN, credentials: { claudeAiOauth: { accessToken: FAKE_TOKEN } },
    },
    {
      id: "acc_d4e5f6", label: `Personal ${FAKE_TOKEN}`, email: "yo@example.com", color: "red", plan: "Max 5x", org: null,
      addedAt: 1, lastSwappedAt: null, isActive: false, tokenExpired: true, expiresAt: null,
    },
  ],
};
export const auto = {
  enabled: false, target: "host", threshold: 90,
  current: { id: "acc_a1b2c3", label: "Trabajo", email: null, sessionPercent: 42, weeklyPercent: 10, sessionResetsAt: "2026-10-12T05:00:00Z", weeklyResetsAt: null },
  next: null,
  queue: [{ id: "acc_d4e5f6", label: "Personal", email: null, sessionPercent: null, weeklyPercent: null, sessionResetsAt: null, weeklyResetsAt: null, eligible: false, reason: "token caducado", role: "" }],
};
export const usageAll = {
  acc_a1b2c3: {
    id: "acc_a1b2c3", ok: true, fetchedAt: 1000, viaProbe: true,
    session: { percent: 81.5, resetsAt: "2026-10-12T05:00:00Z", severity: "high" },
    weekly: { percent: 0, resetsAt: null, severity: "unknown" },
    scoped: [], opus: null, extraUsage: null, locked: null, stale: true, staleSince: 900, staleReason: "429",
  },
  acc_d4e5f6: { id: "acc_d4e5f6", ok: false, error: `401 ${FAKE_JWT}`, status: 401, needsRelogin: true },
  __rate: { until: 5 },
};
export const swapOk = {
  ok: true, target: "wsl:Ubuntu-24.04", targetLabel: "Ubuntu-24.04", verified: false,
  warnings: ["Claude Code está abierto en Ubuntu-24.04 (1 proceso(s)). El cambio se aplicará a sesiones NUEVAS."],
  backup: "C:\\Users\\x\\llmswapper\\data\\backups\\2026", droppedCacheKeys: ["k"], usage: null,
  account: { id: "acc_a1b2c3", label: "Trabajo", accessToken: FAKE_TOKEN },
};

/** What the device script prints for `obj` (start marker + one result block). */
export function emitLines(obj: unknown, nonce: string, width = 160): string[] {
  const b = Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
  const out = [`__SWP_S_${nonce}__`, `__SWP_B_${nonce}__`];
  for (let i = 0; i < b.length; i += width) out.push(b.slice(i, i + width));
  out.push(`__SWP_E_${nonce}_${b.length}__`);
  return out;
}
