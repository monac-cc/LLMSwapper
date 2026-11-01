import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyClientError } from "../client/bridge/errors.ts";
import { interpretState, interpretSwap } from "../shared/interpret.ts";
import { metersFor } from "../shared/markers.ts";
import { clip, pick } from "../shared/pick.ts";
import { PICK } from "../shared/whitelist.ts";
import * as F from "./fixtures.ts";

const ctx = { now: Date.parse("2026-10-12T03:00:00Z"), port: 7373 };
const ok = (j: unknown, spec: Parameters<typeof pick>[1]) => ({ s: 200, j: pick(j, spec), e: null });

test("cached /api/auto brief: 0 % is LLMswapper's 'unknown' -> rendered as —", () => {
  const m = metersFor(undefined, { id: "acc_a1b2c3", label: "x", sessionPercent: 0, weeklyPercent: 37, sessionResetsAt: null, weeklyResetsAt: null });
  assert.equal(m.cached, true);
  assert.equal(m.session?.percent, null);
  assert.equal(m.session?.severity, "unknown");
  assert.equal(m.weekly?.percent, 37);
});

test("swap: HTTP 200 whose body could not be read -> outcome unknown (credentials may be written)", () => {
  for (const e of ["bad_json", "too_large"]) {
    const r = interpretSwap({ swap: { s: 200, j: null, e } }, ctx);
    assert.ok(!r.ok && r.error.code === "swap_unknown_result", e);
  }
});

test("claude_running warning names the OS target, never 'este equipo'", () => {
  const targets = { targets: [{ id: "host", kind: "host", label: "Windows", activeId: null, running: false }] };
  const s = interpretState({
    health: ok(F.health, PICK.health), targets: ok(targets, PICK.targets), accounts: ok(F.accounts, PICK.accounts), auto: ok(F.auto, PICK.auto),
  }, ctx);
  assert.ok(s.ok);
  if (!s.ok) return;
  const w = s.data.warnings.find((x) => x.code === "claude_running");
  assert.ok(w && w.message.includes("Windows") && !w.message.includes("este equipo"));
});

test("auto enabled without a registered active account -> auto_idle warning", () => {
  const s = interpretState({
    health: ok(F.health, PICK.health), targets: ok(F.targets, PICK.targets), accounts: ok(F.accounts, PICK.accounts),
    auto: ok({ ...F.auto, enabled: true, current: null }, PICK.auto),
  }, ctx);
  assert.ok(s.ok && s.data.warnings.some((w) => w.code === "auto_idle"));
});

test("clip keeps head and tail", () => {
  const s = `${"a".repeat(1000)}MIDDLE${"b".repeat(1000)}END`;
  const c = clip(s);
  assert.equal(c.length, 1500);
  assert.ok(c.startsWith("aaa") && c.endsWith("bEND") && !c.includes("MIDDLE"));
});

test("client error classification: only positive not-found signals mean node_missing", () => {
  assert.equal(classifyClientError("File not found: node"), "node_missing");
  assert.equal(classifyClientError("Cannot create process, error code: 2"), "node_missing");
  assert.equal(classifyClientError("Cannot create process, error code: 267"), "workspace_unusable");
  assert.equal(classifyClientError("Timeout waiting for message (60000ms)"), "bridge_timeout");
  assert.equal(classifyClientError("Paseo host is disconnected: srv_x"), "host_offline");
  assert.equal(classifyClientError("Workspace wks_1 is not active or does not exist"), "no_workspace");
  assert.equal(classifyClientError("something odd"), "terminal_failed");
});

test("claude_running: the machine's own environment follows the swap in Paseo; another environment (WSL) only reaches new sessions", async () => {
  const { deriveWarnings } = await import("../shared/warnings.ts");
  const health = { overridingEnv: [], staleMount: false, credentialsError: null, credentialsKind: "file", container: false, unavailable: [], claudeRunning: true } as unknown as Parameters<typeof deriveWarnings>[0];
  const w = deriveWarnings(health, [
    { id: "host", kind: "host", label: "Windows", activeId: null, running: true },
    { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu", activeId: null, running: true },
  ] as unknown as Parameters<typeof deriveWarnings>[1]).find((x) => x.code === "claude_running");
  assert.ok(w);
  assert.match(w.message, /Windows: tras un cambio de cuenta, las sesiones de Paseo con este plugin pasan a la nueva/);
  assert.match(w.message, /Ubuntu: un cambio de cuenta en ese entorno se aplica a las sesiones NUEVAS/);
});
