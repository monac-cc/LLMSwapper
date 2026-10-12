import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecResults } from "../shared/exec.ts";
import { formatCountdown, severityOf } from "../shared/format.ts";
import { interpretState, interpretSwap, interpretUsage } from "../shared/interpret.ts";
import { accountMarkers } from "../shared/markers.ts";
import { pick } from "../shared/pick.ts";
import { PICK } from "../shared/whitelist.ts";
import * as F from "./fixtures.ts";

const ok = (j: unknown, spec: Parameters<typeof pick>[1]) => ({ s: 200, j: pick(j, spec), e: null });
const ctx = { now: Date.parse("2026-10-12T03:00:00Z"), port: 7373 };

test("pick drops tokens, paths, unknown fields and redacts secrets inside strings", () => {
  const text = JSON.stringify([pick(F.accounts, PICK.accounts), pick(F.health, PICK.health), pick(F.usageAll, PICK.usageAll), pick(F.swapOk, PICK.swap)]);
  assert.ok(!text.includes("sk-ant-"), "no sk-ant");
  assert.ok(!text.includes("eyJ"), "no JWT");
  for (const k of ["accessToken", "refreshToken", "credentials", "location", "paths", "backup", "droppedCacheKeys", "__rate", "addedAt"]) {
    assert.ok(!text.includes(`"${k}"`), k);
  }
  assert.ok(text.includes("[oculto]"));
});

test("state: happy path, per-target active ids, invalid color neutralised, warnings", () => {
  const r: ExecResults = {
    health: ok(F.health, PICK.health), targets: ok(F.targets, PICK.targets),
    accounts: ok(F.accounts, PICK.accounts), auto: ok(F.auto, PICK.auto),
  };
  const s = interpretState(r, ctx);
  assert.ok(s.ok);
  if (!s.ok) return;
  assert.deepEqual(s.data.targets.map((t) => [t.id, t.activeId, t.swappable]), [["host", "acc_a1b2c3", true], ["wsl:Ubuntu-24.04", "acc_d4e5f6", true]]);
  assert.equal(s.data.accounts[1].color, "#888888");
  assert.ok(s.data.warnings.some((w) => w.code === "claude_running"));
  assert.equal(s.data.auto?.current?.sessionResetsAt, Date.parse("2026-10-12T05:00:00Z"));
});

test("state: LLMswapper down / timeout / 403 / old version without /api/auto", () => {
  const down: ExecResults = { health: { s: 0, j: null, e: "ECONNREFUSED" } };
  const a = interpretState(down, ctx);
  assert.ok(!a.ok && a.error.code === "swapper_down");
  const slow = interpretState({ health: { s: 0, j: null, e: "timeout" } }, ctx);
  assert.ok(!slow.ok && slow.error.code === "swapper_timeout");
  const forbidden = interpretState({ health: { s: 403, j: { ok: false, error: "Host no permitido" }, e: null } }, ctx);
  assert.ok(!forbidden.ok && forbidden.error.code === "swapper_forbidden" && forbidden.error.message.includes("Host no permitido"));
  const old = interpretState({
    health: ok(F.health, PICK.health), targets: ok(F.targets, PICK.targets), accounts: ok(F.accounts, PICK.accounts),
    auto: { s: 404, j: { ok: false, error: "Endpoint desconocido" }, e: null },
  }, ctx);
  assert.ok(old.ok && old.data.auto === null && !old.data.warnings.some((w) => w.code === "auto_unavailable"));
});

test("usage: unknown severity renders as null percent; stale and relogin kept; __rate skipped", () => {
  const u = interpretUsage({ usage: ok(F.usageAll, PICK.usageAll) }, ctx);
  assert.ok(u.ok);
  if (!u.ok) return;
  const a = u.data.byId.acc_a1b2c3;
  assert.ok(a.kind === "ok");
  if (a.kind !== "ok") return;
  assert.equal(a.session.percent, 81.5);
  assert.equal(a.session.severity, "high");
  assert.equal(a.weekly.percent, null);
  assert.equal(a.weekly.severity, "unknown");
  assert.deepEqual(a.stale, { since: 900, reason: "429" });
  const b = u.data.byId.acc_d4e5f6;
  assert.ok(b.kind === "error" && b.needsRelogin && !b.message.includes("eyJ"));
  assert.equal(Object.keys(u.data.byId).length, 2);
});

test("swap: success, 409, 500 restored, lost response", () => {
  const s = interpretSwap({ swap: ok(F.swapOk, PICK.swap) }, ctx);
  assert.ok(s.ok && s.data.accountId === "acc_a1b2c3" && s.data.warnings.length === 1 && s.data.usage === null);
  const busy = interpretSwap({ swap: { s: 409, j: { ok: false, error: "Ya hay un cambio de cuenta en curso" }, e: null } }, ctx);
  assert.ok(!busy.ok && busy.error.code === "swap_busy");
  const failed = interpretSwap({ swap: { s: 500, j: { ok: false, error: "El token de esta cuenta ya no es válido (401) - config restaurado" }, e: null } }, ctx);
  assert.ok(!failed.ok && failed.error.code === "swapper_failed" && failed.error.message.endsWith("config restaurado"));
  const lost = interpretSwap({ swap: { s: 0, j: null, e: "timeout" } }, ctx);
  assert.ok(!lost.ok && lost.error.code === "swap_unknown_result");
  const refused = interpretSwap({ swap: { s: 0, j: null, e: "ECONNREFUSED" } }, ctx);
  assert.ok(!refused.ok && refused.error.code === "swapper_down");
});

test("severity thresholds", () => {
  assert.deepEqual([null, 0, 49.9, 50, 79.9, 80, 94.9, 95, 100].map(severityOf),
    ["unknown", "normal", "normal", "medium", "medium", "high", "high", "critical", "critical"]);
});

test("countdown and markers", () => {
  const now = 1_000_000_000_000;
  assert.equal(formatCountdown(now + (2 * 60 + 14) * 60_000, now), "en 2 h 14 min");
  assert.equal(formatCountdown(now + (3 * 24 + 4) * 3600_000, now), "en 3 d 4 h");
  assert.equal(formatCountdown(now - 1, now), "ya");
  const m = accountMarkers({
    id: "acc_a1b2c3", label: "x", email: null, color: "#000000", plan: null, tokenExpired: true,
    sessionEndsAt: now + 3600_000, canReadUsage: false, renewable: false, expiresAt: null, swappable: true,
  }, { kind: "error", message: "401", status: 401, needsRelogin: true, rateLimited: false, throttled: false, retryInS: null }, now);
  assert.deepEqual(m.map((x) => x.key), ["expired", "relogin", "session-ends", "probe", "pasted"]);
});
