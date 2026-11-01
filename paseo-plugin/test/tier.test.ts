import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecResults } from "../shared/exec.ts";
import { interpretState } from "../shared/interpret.ts";
import { hasSessionWindow, metersA11y, metersFor } from "../shared/markers.ts";
import { pick } from "../shared/pick.ts";
import { planFor } from "../shared/plan.ts";
import { PICK } from "../shared/whitelist.ts";
import type { MeterView } from "../shared/views.ts";
import * as F from "./fixtures.ts";

const ok = (j: unknown, spec: Parameters<typeof pick>[1]) => ({ s: 200, j: pick(j, spec), e: null });
const ctx = { now: Date.parse("2026-10-12T03:00:00Z"), port: 7373 };
const H = 3600_000;

/** /api/accounts of an LLMswapper that knows tiers: one account per raw value under test. */
function stateWithTiers(tiers: readonly unknown[]) {
  const base = F.accounts.accounts[0];
  const accounts = tiers.map((tier, i) => ({ ...base, id: `acc_t${String(i).padStart(5, "0")}`, label: `T${i}`, tier }));
  const r: ExecResults = {
    health: ok(F.health, PICK.health), targets: ok(F.targets, PICK.targets),
    accounts: ok({ activeId: null, accounts }, PICK.accounts), auto: ok(F.auto, PICK.auto),
  };
  return interpretState(r, ctx);
}

test("tier crosses the whitelist on both paths (the state plan carries PICK.accounts to the device script)", () => {
  const accounts = planFor({ kind: "state" }).requests.find((r) => r.key === "accounts");
  assert.ok(accounts);
  const picked = pick({ activeId: null, accounts: [{ ...F.accounts.accounts[0], tier: "ultra" }] }, accounts.pick) as { accounts: { tier?: unknown }[] };
  assert.equal(picked.accounts[0].tier, "ultra");
});

test("tier: the four plans pass, null stays null, unknown values and types become null", () => {
  const s = stateWithTiers(["free", "pro", "max", "ultra", null, "enterprise", "Ultra", "max_20x", 5, { x: 1 }]);
  assert.ok(s.ok);
  if (!s.ok) return;
  assert.deepEqual(s.data.accounts.map((a) => a.tier), ["free", "pro", "max", "ultra", null, null, null, null, null, null]);
});

test("tier: an older LLMswapper without the field -> null for every account (both bars, as before)", () => {
  const s = interpretState({
    health: ok(F.health, PICK.health), targets: ok(F.targets, PICK.targets),
    accounts: ok(F.accounts, PICK.accounts), auto: ok(F.auto, PICK.auto),
  }, ctx);
  assert.ok(s.ok);
  if (!s.ok) return;
  assert.deepEqual(s.data.accounts.map((a) => a.tier), [null, null]);
  assert.ok(s.data.accounts.every(hasSessionWindow));
});

test("only Ultra drops the 5-hour window", () => {
  assert.deepEqual((["free", "pro", "max", "ultra", null] as const).map((tier) => hasSessionWindow({ tier })), [true, true, true, false, true]);
});

test("row accessibility label: Ultra says there is no 5-hour limit, the others read both meters as before", () => {
  const now = ctx.now;
  const meter = (percent: number, resetsAt: number | null): MeterView => ({ percent, resetsAt, severity: "normal" });
  const meters = { session: meter(42, now + 2 * H + 14 * 60_000), weekly: meter(10.5, now + 3 * 24 * H + 4 * H), cached: false };
  assert.deepEqual(metersA11y({ tier: "max" }, meters, now), ["5 horas 42 %, reinicio en 2 h 14 min", "7 días 10,5 %, reinicio en 3 d 4 h"]);
  assert.deepEqual(metersA11y({ tier: null }, meters, now), ["5 horas 42 %, reinicio en 2 h 14 min", "7 días 10,5 %, reinicio en 3 d 4 h"]);
  assert.deepEqual(metersA11y({ tier: "ultra" }, meters, now), ["sin límite de 5 horas", "7 días 10,5 %, reinicio en 3 d 4 h"]);
  // a weekly reading whose window already reset reads as unknown, as the bar shows it
  const reset = { ...meters, weekly: meter(99, now - 1) };
  assert.deepEqual(metersA11y({ tier: "ultra" }, reset, now), ["sin límite de 5 horas", "7 días —"]);
  assert.deepEqual(metersA11y({ tier: "ultra" }, metersFor(undefined, undefined), now), ["sin límite de 5 horas", "7 días —"]);
});
