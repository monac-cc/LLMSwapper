import assert from "node:assert/strict";
import { test } from "node:test";
import { swapperSettings, type SwapperSettings } from "../shared/contracts.ts";
import {
  globalAuto, mergeHostEntry, panelFlag, pendingFlags, sameIgnoringPanel, withFlags, withPanelFlagsOf, type AutoHost, type FlagOverrides,
} from "../shared/panel.ts";
import type { AutoView } from "../shared/views.ts";

const auto = (enabled: boolean, current: AutoView["current"] = { id: "acc_111111", label: "CTO" } as AutoView["current"]): AutoView =>
  ({ enabled, target: "host", threshold: 90, current, next: null }) as AutoView;
const host = (id: string, a: AutoView | null, usable = true): AutoHost => ({ id, label: id.toUpperCase(), auto: a, usable });

test("global auto switch: all off turns all on, all on turns all off, mixed turns the rest on", () => {
  const off = globalAuto([host("a", auto(false)), host("b", auto(false))]);
  assert.deepEqual({ total: off.total, on: off.on, turnOn: off.turnOn, targets: off.targets.map((t) => t.id) }, { total: 2, on: 0, turnOn: true, targets: ["a", "b"] });
  const on = globalAuto([host("a", auto(true)), host("b", auto(true))]);
  assert.deepEqual({ on: on.on, turnOn: on.turnOn, targets: on.targets.map((t) => t.id) }, { on: 2, turnOn: false, targets: ["a", "b"] });
  const mixed = globalAuto([host("a", auto(true)), host("b", auto(false)), host("c", auto(false))]);
  assert.deepEqual({ on: mixed.on, total: mixed.total, turnOn: mixed.turnOn, targets: mixed.targets.map((t) => t.id) }, { on: 1, total: 3, turnOn: true, targets: ["b", "c"] }, "only the ones that are off change");
});

test("global auto switch ignores devices it cannot act on: offline, not opted in, unread, without LLMswapper auto", () => {
  const g = globalAuto([host("a", auto(true)), host("b", auto(false), false), host("c", null), host("d", auto(false), false)]);
  assert.deepEqual({ total: g.total, on: g.on, turnOn: g.turnOn, targets: g.targets.length }, { total: 1, on: 1, turnOn: false, targets: 1 });
  assert.equal(g.skipped, 2, "two devices with rotation it cannot reach now are left as they are, and said so");
  assert.deepEqual(globalAuto([]), { total: 0, on: 0, turnOn: false, targets: [], skipped: 0 });
});

const settings = (hosts: SwapperSettings["hosts"] = {}): SwapperSettings => swapperSettings.schema.parse({ hosts });

test("panel flags: what was just toggled wins, else the settings, else off", () => {
  const s = settings({ srv_a: mergeHostEntry(undefined, { collapsed: true, hidden: true }) });
  assert.equal(panelFlag(s, {}, "srv_a", "collapsed"), true);
  assert.equal(panelFlag(s, {}, "srv_a", "hidden"), true);
  assert.equal(panelFlag(s, { srv_a: { hidden: false } }, "srv_a", "hidden"), false);
  assert.equal(panelFlag(s, { srv_a: { hidden: false } }, "srv_a", "collapsed"), true, "one flag's toggle leaves the other as stored");
  assert.equal(panelFlag(s, {}, "srv_b", "hidden"), false);
  assert.equal(panelFlag(null, { srv_b: { collapsed: true } }, "srv_b", "collapsed"), true, "before the settings load");
});

test("panel flags are written into the settings document, keeping every other field, and only when they differ", () => {
  const s = settings({ srv_a: mergeHostEntry(undefined, { bridge: true, port: 7400, nodeCommand: "/usr/bin/node" }) });
  const next = withFlags(s, { srv_a: { collapsed: true, hidden: true }, srv_local: { collapsed: true } });
  assert.ok(next);
  assert.deepEqual(next.hosts.srv_a, { bridge: true, port: 7400, nodeCommand: "/usr/bin/node", hidden: true, collapsed: true });
  assert.deepEqual(next.hosts.srv_local, { bridge: false, port: 7373, hidden: false, collapsed: true }, "the plugin's own host gets an entry too");
  assert.equal(next.localPort, s.localPort);
  assert.equal(withFlags(next, { srv_a: { collapsed: true, hidden: true }, srv_local: { collapsed: true } }), null, "already saved: nothing to write");
  assert.equal(withFlags(s, {}), null);
});

test("a settings document saved before this version (no collapsed field) still reads, unfolded", () => {
  const old = swapperSettings.schema.parse({ hosts: { srv_a: { bridge: true, port: 7373, hidden: false } } });
  assert.equal(old.hosts.srv_a.collapsed, false);
});

test("a toggle stops overriding once the document says it, so a later change from another panel shows and is not undone", () => {
  // Two panels (desktop, phone) on one settings document, each with its own local overrides.
  let doc = settings({});
  let writes = 0;
  const round = (local: FlagOverrides): FlagOverrides => {
    const pending = pendingFlags(doc, local);
    const next = withFlags(doc, pending);
    if (next) { doc = next; writes++; }
    return pendingFlags(doc, pending);
  };
  let desktop = round({ srv_x: { hidden: true, collapsed: true } }); // hide and fold on the desktop
  assert.equal(doc.hosts.srv_x.hidden, true);
  assert.deepEqual(desktop, {}, "saved: the desktop no longer overrides");
  let phone = round({ srv_x: { hidden: false } }); // show it again on the phone
  for (let i = 0; i < 5; i++) { desktop = round(desktop); phone = round(phone); } // both panels keep running
  assert.equal(doc.hosts.srv_x.hidden, false, "the phone's change stands");
  assert.equal(doc.hosts.srv_x.collapsed, true, "and the fold, untouched by it, too");
  assert.equal(writes, 2, "one write per toggle, no tug of war");
  assert.equal(panelFlag(doc, desktop, "srv_x", "hidden"), false, "the desktop shows it");
  const partial = pendingFlags(doc, { srv_x: { hidden: false, collapsed: false } });
  assert.deepEqual(partial, { srv_x: { collapsed: false } }, "only what the document does not say yet stays pending");
});

test("settings edits survive a panel change made elsewhere: no conflict, and the panel's change is kept", () => {
  const base = settings({ srv_a: mergeHostEntry(undefined, { bridge: true }) });
  const elsewhere = withFlags(base, { srv_a: { collapsed: true }, srv_b: { hidden: true } });
  assert.ok(elsewhere);
  assert.equal(sameIgnoringPanel(base, elsewhere), true);
  assert.equal(sameIgnoringPanel(base, { ...base, localPort: 7400 }), false);
  assert.equal(sameIgnoringPanel(base, { ...base, hosts: { ...base.hosts, srv_a: mergeHostEntry(base.hosts.srv_a, { port: 7400 }) } }), false);
  const draft = { ...base, autoRefreshMinutes: 15 as const }; // an unsaved edit in the settings form
  const rebased = withPanelFlagsOf(draft, elsewhere, base);
  assert.equal(rebased.autoRefreshMinutes, 15, "the edit is kept");
  assert.equal(rebased.hosts.srv_a.collapsed, true, "the fold is not undone");
  assert.equal(rebased.hosts.srv_b.hidden, true, "nor the hidden device");
  assert.equal(rebased.hosts.srv_a.bridge, true);
  // The form itself changed srv_b's «Ocultar en el panel»: the form's choice wins over the panel's.
  const own = { ...base, hosts: { ...base.hosts, srv_b: mergeHostEntry(undefined, { hidden: false, port: 7500 }) } };
  const ownBase = { ...base, hosts: { ...base.hosts, srv_b: mergeHostEntry(undefined, { hidden: true }) } };
  assert.equal(withPanelFlagsOf(own, elsewhere, ownBase).hosts.srv_b.hidden, false);
});
