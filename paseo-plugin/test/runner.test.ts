// Terminal lifecycle of the bridge against a FAKE PaseoApi + fake clock (no timers, no daemon).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError } from "../client/bridge/errors.ts";
import type { BridgeTerminal, Clock } from "../client/bridge/poll.ts";
import { orphanedTerminals, pendingReaps, runOnHostCore, type BridgeApi, type BridgeRunOptions } from "../client/bridge/runner-core.ts";
import { WORKSPACE_CACHE_TTL_MS, forgetWorkspaces, resolveWorkspaces, type WorkspaceLister } from "../client/bridge/workspace.ts";
import { pick } from "../shared/pick.ts";
import type { SwapperOp } from "../shared/plan.ts";
import { PICK } from "../shared/whitelist.ts";
import * as F from "./fixtures.ts";

const N = "00112233aabbccdd";
type Frame = { lines: string[]; totalLines: number } | Error;
/** A live terminal always reports totalLines >= rows (60); a deleted one reports 0. */
const live = (lines: string[]): Frame => {
  const all = [...lines, ...Array.from({ length: Math.max(0, 60 - lines.length) }, () => "")];
  return { lines: all, totalLines: all.length };
};
const GONE: Frame = { lines: [], totalLines: 0 };

function fakeClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new BridgeError("bridge_timeout", "Cancelado");
      t += ms;
    },
  };
}

interface Spawn { readonly command?: string; readonly args?: string[]; readonly cwd?: string; killed: boolean; killTries: number }

/**
 * behaviour(spawnIndex, elapsedMs) gives the frame captured at that moment; elapsed -1 = create (Error => reject).
 * killError: the handle's kill() rejects with it (stale proxied client after a reconnect); terminals.ref(id).kill()
 * on the (fresh) api still works and is recorded in refKills.
 */
function fakeHost(clock: Clock, behaviour: (i: number, elapsed: number) => Frame, cwds = ["/home/u/proj"], killError?: Error) {
  const spawns: Spawn[] = [];
  const refKills: string[] = [];
  let lists = 0;
  const api: BridgeApi = {
    workspaces: {
      list: async () => (lists++, {
        entries: cwds.map((cwd, i) => ({
          id: `wks_${i}`, name: `w${i}`, projectDisplayName: "p", workspaceDirectory: cwd, workspaceKind: "directory", archivingAt: null, activityAt: null,
        })),
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    },
    terminals: {
      create: async (o) => {
        const i = spawns.length;
        const s: Spawn = { command: o.command, args: o.args, cwd: o.cwd, killed: false, killTries: 0 };
        spawns.push(s);
        const born = clock.now();
        const atCreate = behaviour(i, -1);
        if (atCreate instanceof Error) throw atCreate;
        const term: BridgeTerminal = {
          id: `t${i}`,
          capture: async () => {
            const f = s.killed ? GONE : behaviour(i, clock.now() - born);
            if (f instanceof Error) throw f;
            return f;
          },
          kill: async () => {
            s.killTries++;
            if (killError) throw killError;
            s.killed = true;
          },
        };
        return term;
      },
      ref: (id: string) => ({
        kill: async () => {
          refKills.push(id);
          const s = spawns[Number(id.slice(1))];
          if (s) s.killed = true;
        },
      }),
    },
  };
  return { api, spawns, refKills, lists: () => lists };
}

const stateEnvelope = {
  v: 1, node: "v22.0.0",
  results: {
    health: { s: 200, j: pick(F.health, PICK.health), e: null }, targets: { s: 200, j: pick(F.targets, PICK.targets), e: null },
    accounts: { s: 200, j: pick(F.accounts, PICK.accounts), e: null }, auto: { s: 200, j: pick(F.auto, PICK.auto), e: null },
  },
};
const swapEnvelope = { v: 1, node: "v22.0.0", results: { swap: { s: 200, j: pick(F.swapOk, PICK.swap), e: null } } };
const SWAP: SwapperOp = { kind: "swap", accountId: "acc_a1b2c3", target: "host" };
const STATE: SwapperOp = { kind: "state" };

function run(serverId: string, op: SwapperOp, clock: Clock, api: BridgeApi, o: BridgeRunOptions = { port: 7373 }) {
  forgetWorkspaces(serverId);
  return runOnHostCore({ getClient: () => api, clock, nonce: () => N }, serverId, op, o);
}

test("happy path: direct spawn of node, result parsed, terminal killed", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, (_i, ms) => (ms < 300 ? live([]) : live(F.emitLines(stateEnvelope, N))));
  const r = await run("h1", STATE, clock, host.api);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(host.spawns.length, 1);
  assert.equal(host.spawns[0].command, "node");
  assert.equal(host.spawns[0].args?.[0], "-e");
  assert.ok(host.spawns[0].killed);
});

test("a silent op (start marker only, for 40 s) is NOT mistaken for an exit", async () => {
  const clock = fakeClock();
  const block = F.emitLines(swapEnvelope, N);
  const host = fakeHost(clock, (_i, ms) => (ms < 40_000 ? live([block[0]]) : live(block)));
  const r = await run("h2", SWAP, clock, host.api);
  assert.ok(r.ok, JSON.stringify(r));
});

test("transient capture() failures are tolerated", async () => {
  const clock = fakeClock();
  let n = 0;
  const host = fakeHost(clock, (_i, ms) => (ms >= 0 && n++ < 3 ? new Error("Timeout waiting for message (60000ms)") : live(F.emitLines(stateEnvelope, N))));
  const r = await run("h3", STATE, clock, host.api);
  assert.ok(r.ok, JSON.stringify(r));
});

test("POSIX: node missing (execvp, no start marker) -> one login-shell retry with the SAME nonce", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, (i, ms) => {
    if (i === 0) return ms < 200 ? live(["execvp(3) failed.: No such file or directory"]) : GONE;
    return live(F.emitLines(stateEnvelope, N));
  });
  const r = await run("h4", STATE, clock, host.api);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(host.spawns.length, 2);
  assert.equal(host.spawns[1].command, "/bin/sh");
  assert.equal(host.spawns[0].args?.[2], host.spawns[1].args?.[3], "same payload => same nonce => the device guard dedupes");
});

test("POSIX: node missing in the login shell too -> node_missing (nothing ran), even for a swap", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, (_i, ms) => (ms < 200 ? live(["sh: 1: exec: node: not found"]) : GONE));
  const r = await run("h4b", SWAP, clock, host.api);
  assert.ok(!r.ok && r.error.code === "node_missing", JSON.stringify(r));
  assert.equal(host.spawns.length, 2);
});

test("Windows: create rejects 'File not found' -> node_missing for a swap, no fallback", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => new Error("File not found: node"), ["C:\\Users\\u\\proj"]);
  const r = await run("h5", SWAP, clock, host.api);
  assert.ok(!r.ok && r.error.code === "node_missing", JSON.stringify(r));
  assert.equal(host.spawns.length, 1);
});

test("swap: ambiguous create timeout -> swap_unknown_result, never a second spawn", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => new Error("Timeout waiting for message (60000ms)"));
  const r = await run("h6", SWAP, clock, host.api);
  assert.ok(!r.ok && r.error.code === "swap_unknown_result", JSON.stringify(r));
  assert.equal(host.spawns.length, 1);
});

test("swap: started, then the terminal vanished -> swap_unknown_result", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, (_i, ms) => (ms < 1000 ? live([`__SWP_S_${N}__`]) : GONE));
  const r = await run("h7", SWAP, clock, host.api);
  assert.ok(!r.ok && r.error.code === "swap_unknown_result", JSON.stringify(r));
  assert.equal(host.spawns.length, 1);
});

test("swap: duplicate marker (another copy already ran) -> swap_unknown_result", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => live([`__SWP_D_${N}__`]));
  const r = await run("h8", SWAP, clock, host.api);
  assert.ok(!r.ok && r.error.code === "swap_unknown_result", JSON.stringify(r));
});

test("unusable workspace directory -> the next workspace is tried", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, (i) => (i === 0 ? new Error("Cannot create process, error code: 267") : live(F.emitLines(stateEnvelope, N))),
    ["C:\\gone", "C:\\Users\\u\\ok"]);
  const r = await run("h9", STATE, clock, host.api);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(host.spawns.map((s) => s.cwd), ["C:\\gone", "C:\\Users\\u\\ok"]);
});

test("timeout: the terminal is killed and the read reports bridge_timeout", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => live([`__SWP_S_${N}__`]));
  const r = await run("h10", STATE, clock, host.api);
  assert.ok(!r.ok && r.error.code === "bridge_timeout", JSON.stringify(r));
  assert.ok(host.spawns[0].killed);
});

test("abort (query cancelled) kills the terminal", async () => {
  const clock = fakeClock();
  const ctrl = new AbortController();
  const host = fakeHost(clock, (_i, ms) => {
    if (ms > 1000) ctrl.abort();
    return live([`__SWP_S_${N}__`]);
  });
  const r = await run("h11", { kind: "usage" }, clock, host.api, { port: 7373, signal: ctrl.signal });
  assert.ok(!r.ok && r.error.code === "bridge_timeout");
  assert.ok(host.spawns[0].killed);
});

test("offline host: getPaseoClient throws -> host_offline, nothing spawned", async () => {
  const r = await runOnHostCore({ getClient: () => { throw new Error("Paseo host is disconnected: srv_x"); } }, "h12", SWAP, { port: 7373 });
  assert.ok(!r.ok && r.error.code === "host_offline");
});

// --- create rejected while the request may already be on the daemon (review #16) ---

test("swap: create rejected by an in-flight disconnect ('Server disconnected') -> swap_unknown_result", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => new Error("Server disconnected"));
  const r = await run("h13", SWAP, clock, host.api);
  assert.ok(!r.ok && r.error.code === "swap_unknown_result", JSON.stringify(r));
  assert.equal(host.spawns.length, 1);
});

test("swap: create refused before sending ('Paseo host is disconnected') -> host_offline, nothing ran", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => new Error("Paseo host is disconnected: srv_x"));
  const r = await run("h14", SWAP, clock, host.api);
  assert.ok(!r.ok && r.error.code === "host_offline", JSON.stringify(r));
});

test("read: 'Server disconnected' on create is still reported as host_offline", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => new Error("Server disconnected"));
  const r = await run("h15", STATE, clock, host.api);
  assert.ok(!r.ok && r.error.code === "host_offline", JSON.stringify(r));
  assert.equal(host.spawns.length, 1);
});

// --- zero-line captures are not proof that nothing ran (review #17) ---

test("Windows swap: terminal gone without any output -> swap_unknown_result, no respawn", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => GONE, ["C:\\Users\\u\\proj"]);
  const r = await run("h16", SWAP, clock, host.api);
  assert.ok(!r.ok && r.error.code === "swap_unknown_result", JSON.stringify(r));
  assert.equal(host.spawns.length, 1);
});

test("POSIX swap: every copy vanishes without a trace -> swap_unknown_result, never a definite failure", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => GONE);
  const r = await run("h17", SWAP, clock, host.api);
  assert.ok(!r.ok && r.error.code === "swap_unknown_result", JSON.stringify(r));
  assert.equal(host.spawns.length, 2);
});

test("POSIX read: every copy vanishes without a trace -> node_missing once every candidate failed", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => GONE);
  const r = await run("h18", STATE, clock, host.api);
  assert.ok(!r.ok && r.error.code === "node_missing", JSON.stringify(r));
  assert.equal(host.spawns.length, 2);
});

test("POSIX swap: direct copy vanished silently, the login shell runs it (same nonce) -> ok", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, (i) => (i === 0 ? GONE : live(F.emitLines(swapEnvelope, N))));
  const r = await run("h19", SWAP, clock, host.api);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(host.spawns.length, 2);
  assert.equal(host.spawns[0].args?.[2], host.spawns[1].args?.[3], "same nonce => the device lock dedupes");
});

test("POSIX swap: direct copy vanished silently and the login-shell copy is a duplicate -> swap_unknown_result", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, (i) => (i === 0 ? GONE : live([`__SWP_D_${N}__`])));
  const r = await run("h20", SWAP, clock, host.api);
  assert.ok(!r.ok && r.error.code === "swap_unknown_result", JSON.stringify(r));
});

test("swap: device lock unavailable (fatal before the start marker) -> definite failure, no respawn", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => live(F.emitLines({ v: 1, fatal: "lock_unavailable EACCES" }, N).slice(1)));
  const r = await run("h21", SWAP, clock, host.api);
  assert.ok(!r.ok && r.error.code === "bridge_exited" && r.error.message.includes("lock_unavailable"), JSON.stringify(r));
  assert.equal(host.spawns.length, 1);
});

// --- missing workspace directory on POSIX (review #18) ---

test("POSIX: missing workspace directory (chdir failed) -> workspace_unusable, the next workspace is tried", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, (i, ms) => {
    if (i === 0) return ms < 200 ? live(["chdir(2) failed.: No such file or directory"]) : GONE;
    return live(F.emitLines(stateEnvelope, N));
  }, ["/mnt/gone/proj", "/home/u/ok"]);
  const r = await run("h22", STATE, clock, host.api);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(host.spawns.map((s) => [s.cwd, s.command]), [["/mnt/gone/proj", "node"], ["/home/u/ok", "node"]]);
});

test("POSIX: a workspace where both copies vanish without a trace is skipped", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, (i) => (i < 2 ? GONE : live(F.emitLines(stateEnvelope, N))), ["/mnt/gone/proj", "/home/u/ok"]);
  const r = await run("h23", STATE, clock, host.api);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(host.spawns.map((s) => [s.cwd, s.command]), [["/mnt/gone/proj", "node"], ["/mnt/gone/proj", "/bin/sh"], ["/home/u/ok", "node"]]);
});

// --- workspace cache vs. the workspace picked in Settings (review #19) ---

function lister(ids: () => string[]): WorkspaceLister & { calls: number } {
  const l = {
    calls: 0,
    list: async () => {
      l.calls++;
      return {
        entries: ids().map((id) => ({
          id, name: id, projectDisplayName: "p", workspaceDirectory: `/home/u/${id}`, workspaceKind: "directory", archivingAt: null, activityAt: null,
        })),
        pageInfo: { hasMore: false, nextCursor: null },
      };
    },
  };
  return l;
}

test("workspace cache: a workspace picked after the list was cached is honoured (re-list once)", async () => {
  forgetWorkspaces("c1");
  let ids = ["wks_a"];
  const l = lister(() => ids);
  assert.deepEqual((await resolveWorkspaces(l, "c1", undefined, 0)).candidates.map((w) => w.workspaceId), ["wks_a"]);
  ids = ["wks_a", "wks_b"];
  const c = await resolveWorkspaces(l, "c1", "wks_b", 1_000);
  assert.deepEqual(c.candidates.map((w) => w.workspaceId), ["wks_b", "wks_a"]);
  assert.equal(c.preferredMissing, false);
  assert.equal(l.calls, 2);
  await resolveWorkspaces(l, "c1", "wks_b", 2_000);
  assert.equal(l.calls, 2, "served from the cache once the preferred workspace is in it");
});

test("workspace cache: entries expire after the TTL", async () => {
  forgetWorkspaces("c2");
  const l = lister(() => ["wks_a"]);
  await resolveWorkspaces(l, "c2", undefined, 0);
  await resolveWorkspaces(l, "c2", undefined, WORKSPACE_CACHE_TTL_MS - 1);
  assert.equal(l.calls, 1);
  await resolveWorkspaces(l, "c2", undefined, WORKSPACE_CACHE_TTL_MS);
  assert.equal(l.calls, 2);
});

test("workspace cache: a preferred workspace missing from a fresh list is flagged, without re-listing every run", async () => {
  forgetWorkspaces("c3");
  const l = lister(() => ["wks_a"]);
  const c = await resolveWorkspaces(l, "c3", "wks_gone", 0);
  assert.equal(c.preferredMissing, true);
  assert.deepEqual(c.candidates.map((w) => w.workspaceId), ["wks_a"]);
  await resolveWorkspaces(l, "c3", "wks_gone", 1_000);
  assert.equal(l.calls, 1);
});

const warningCodes = (r: Awaited<ReturnType<typeof run>>): string[] =>
  r.ok && "warnings" in r.data ? r.data.warnings.map((w) => (typeof w === "string" ? w : w.code)) : [];

test("state over the bridge warns when the configured workspace was ignored", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => live(F.emitLines(stateEnvelope, N)));
  const r = await run("h24", STATE, clock, host.api, { port: 7373, workspaceId: "wks_gone" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(warningCodes(r).includes("bridge_workspace_missing"), JSON.stringify(r));
  const ok = await run("h25", STATE, clock, host.api, { port: 7373, workspaceId: "wks_0" });
  assert.ok(ok.ok && !warningCodes(ok).includes("bridge_workspace_missing"));
});

// --- kill after a reconnect (review #20) ---

const STALE = new Error("Paseo connection changed; call getPaseoClient again");

test("kill through the stale handle fails -> retried via a fresh client's terminals.ref(id).kill()", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => live(F.emitLines(stateEnvelope, N)), undefined, STALE);
  const r = await run("h26", STATE, clock, host.api);
  assert.ok(r.ok, JSON.stringify(r));
  await pendingReaps();
  assert.deepEqual(host.refKills, ["t0"]);
  assert.ok(host.spawns[0].killed);
  assert.ok(!orphanedTerminals().includes("h26/t0"));
});

test("kill retry waits for the host to come back", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => live(F.emitLines(stateEnvelope, N)), undefined, STALE);
  let offlineCalls = 0;
  const getClient = () => {
    // offline from the moment the stale handle's kill failed, for the next 3 calls
    if (host.spawns[0]?.killTries > 0 && offlineCalls++ < 3) throw new Error("Paseo host is disconnected: h27");
    return host.api;
  };
  forgetWorkspaces("h27");
  const r = await runOnHostCore({ getClient, clock, nonce: () => N }, "h27", STATE, { port: 7373 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(orphanedTerminals().includes("h27/t0"), "flagged while the kill is unconfirmed");
  await pendingReaps();
  assert.equal(offlineCalls, 4);
  assert.deepEqual(host.refKills, ["t0"]);
  assert.ok(!orphanedTerminals().includes("h27/t0"));
});

test("a terminal that can never be killed is flagged and logged, not dropped silently", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => live(F.emitLines(stateEnvelope, N)), undefined, STALE);
  const warnings: string[] = [];
  const getClient = () => {
    if (host.spawns[0]?.killTries > 0) throw new Error("Paseo host is disconnected: h28"); // never comes back
    return host.api;
  };
  forgetWorkspaces("h28");
  const r = await runOnHostCore({ getClient, clock, nonce: () => N, warn: (m) => warnings.push(m) }, "h28", STATE, { port: 7373 });
  assert.ok(r.ok, JSON.stringify(r));
  await pendingReaps();
  assert.deepEqual(host.refKills, []);
  assert.ok(orphanedTerminals().includes("h28/t0"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /t0/);
});

test("an orphan the reaper gave up on is killed by the next run once the host is back", async () => {
  const clock = fakeClock();
  const host = fakeHost(clock, () => live(F.emitLines(stateEnvelope, N)), undefined, STALE);
  let back = false;
  const getClient = () => {
    if (!back && host.spawns[0]?.killTries > 0) throw new Error("Paseo host is disconnected: h29");
    return host.api;
  };
  forgetWorkspaces("h29");
  const deps = { getClient, clock, nonce: () => N, warn: () => undefined };
  assert.ok((await runOnHostCore(deps, "h29", STATE, { port: 7373 })).ok);
  await pendingReaps();
  assert.ok(orphanedTerminals().includes("h29/t0"), "the reaper gave up while the host was away");
  back = true;
  assert.ok((await runOnHostCore(deps, "h29", STATE, { port: 7373 })).ok);
  await pendingReaps();
  assert.ok(host.refKills.includes("t0"), JSON.stringify(host.refKills));
  assert.ok(!orphanedTerminals().includes("h29/t0"));
});
