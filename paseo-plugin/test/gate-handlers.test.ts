import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { executePlan, MAX_BODY_BYTES } from "../server/executor.ts";
import { createHandlers } from "../server/handlers.ts";
import type { ExecResults } from "../shared/exec.ts";
import { createSerialGate } from "../shared/gate.ts";
import { pick } from "../shared/pick.ts";
import type { Plan } from "../shared/plan.ts";
import { PICK } from "../shared/whitelist.ts";
import * as F from "./fixtures.ts";

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => void (t += ms),
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("Cancelado");
      t += ms;
    },
  };
}

test("gate: FIFO, spacing from END of one task to START of the next", async () => {
  const c = fakeClock();
  const gate = createSerialGate(20_000, c);
  const starts: number[] = [];
  const task = (ms: number) => async () => {
    starts.push(c.now());
    c.advance(ms);
    return ms;
  };
  const r = await Promise.all([gate.run(task(5_000)), gate.run(task(1_000)), gate.run(task(0))]);
  assert.deepEqual(r, [5_000, 1_000, 0]);
  assert.deepEqual(starts, [0, 25_000, 46_000]);
  assert.equal(gate.queued(), 0);
});

test("gate: an aborted waiter frees its slot (no extra delay for later tasks)", async () => {
  const c = fakeClock();
  const gate = createSerialGate(20_000, c);
  const ctrl = new AbortController();
  ctrl.abort();
  await gate.run(async () => c.advance(1_000));
  await assert.rejects(gate.run(async () => "never", ctrl.signal));
  const t0 = c.now();
  await gate.run(async () => undefined);
  assert.equal(c.now() - t0, 20_000, "only the spacing after the first task");
});

const okState: ExecResults = {
  health: { s: 200, j: pick(F.health, PICK.health), e: null }, targets: { s: 200, j: pick(F.targets, PICK.targets), e: null },
  accounts: { s: 200, j: pick(F.accounts, PICK.accounts), e: null }, auto: { s: 200, j: pick(F.auto, PICK.auto), e: null },
};

test("server: concurrent reads share one LLMswapper round; state memo is dropped after a mutation", async () => {
  let calls = 0;
  let t = 0;
  const exec = async (plan: Plan): Promise<ExecResults> => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return plan.kind === "state" ? okState : { swap: { s: 200, j: pick(F.swapOk, PICK.swap), e: null } };
  };
  const h = createHandlers(async () => 7373, exec, () => t);
  const [a, b] = await Promise.all([h.state(), h.state()]);
  assert.ok(a.ok && b.ok);
  assert.equal(calls, 1, "single flight");
  await h.state();
  assert.equal(calls, 1, "memo (10 s)");
  const [s1, s2] = await Promise.all([h.swap({ accountId: "acc_a1b2c3", target: "host" }), h.swap({ accountId: "acc_a1b2c3", target: "host" })]);
  assert.ok(s1.ok);
  assert.ok(!s2.ok && s2.error.code === "host_busy", "one mutation at a time");
  await h.state();
  assert.equal(calls, 3, "state re-read after the swap");
  t += 11_000;
  await h.state();
  assert.equal(calls, 4, "memo expired");
});

/** Fake LLMswapper: a state round answers with the auto flag of the moment it STARTS, and is delivered on release. */
function heldSwapper() {
  let enabled = false;
  const held: (() => void)[] = [];
  let stateCalls = 0;
  const exec = async (plan: Plan): Promise<ExecResults> => {
    if (plan.kind === "auto") {
      enabled = true;
      return { auto: { s: 200, j: pick({ ...F.auto, enabled }, PICK.auto), e: null } };
    }
    stateCalls++;
    const answer: ExecResults = { ...okState, auto: { s: 200, j: pick({ ...F.auto, enabled }, PICK.auto), e: null } };
    return new Promise((resolve) => held.push(() => resolve(answer)));
  };
  return { exec, release: (i: number) => held[i](), calls: () => stateCalls };
}
const flush = () => new Promise<void>((r) => setImmediate(r));
const autoOf = (r: Awaited<ReturnType<ReturnType<typeof createHandlers>["state"]>>) => (r.ok ? r.data.auto?.enabled : undefined);

test("server: a state round that started before a mutation ended is not shared with later callers", async () => {
  const f = heldSwapper();
  const h = createHandlers(async () => 7373, f.exec, () => 0);
  const pre = h.state();
  await flush();
  assert.equal(f.calls(), 1);
  assert.ok((await h.auto({ enabled: true })).ok);
  const post = h.state();
  await flush();
  assert.equal(f.calls(), 2, "post-mutation caller starts a fresh round");
  f.release(1); // the fresh round finishes first and is memoized...
  assert.equal(autoOf(await post), true);
  f.release(0); // ...then the stale one must not overwrite the memo
  assert.equal(autoOf(await pre), false, "the caller that asked before the change still gets its own round");
  assert.equal(autoOf(await h.state()), true, "memo keeps the post-mutation round");
  assert.equal(f.calls(), 2, "served from the memo");
});

test("server: a state round overlapping a mutation does not refill the memo", async () => {
  const f = heldSwapper();
  const h = createHandlers(async () => 7373, f.exec, () => 0);
  const pre = h.state();
  await flush();
  assert.ok((await h.auto({ enabled: true })).ok);
  f.release(0); // finishes after the mutation, with what LLMswapper said before it
  assert.equal(autoOf(await pre), false);
  const post = h.state();
  await flush();
  assert.equal(f.calls(), 2, "not served from a memo filled by the overlapping round");
  f.release(1);
  assert.equal(autoOf(await post), true);
  assert.equal(autoOf(await h.state()), true);
  assert.equal(f.calls(), 2);
});

test("server: a state round started during a mutation is not reused after it", async () => {
  const f = heldSwapper();
  let finishAuto = () => {};
  const exec = async (plan: Plan): Promise<ExecResults> => {
    if (plan.kind === "auto") await new Promise<void>((r) => (finishAuto = r));
    return f.exec(plan);
  };
  const h = createHandlers(async () => 7373, exec, () => 0);
  const m = h.auto({ enabled: true });
  await flush();
  const during = h.state();
  await flush();
  finishAuto();
  assert.ok((await m).ok);
  const post = h.state();
  await flush();
  assert.equal(f.calls(), 2);
  f.release(0);
  f.release(1);
  assert.equal(autoOf(await during), false);
  assert.equal(autoOf(await post), true);
});

/** Throwaway HTTP server on an ephemeral port (never 7373). */
async function withServer(handle: (path: string, res: ServerResponse) => void, body: (port: number, seen: string[]) => Promise<void>) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    handle(req.url ?? "", res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await body((server.address() as AddressInfo).port, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
const onePlan = (path: string): Plan => ({
  kind: "state", timeoutMs: 20_000, requests: [{ key: "x", method: "GET", path, pick: PICK.error, timeoutMs: 20_000 }],
});

test("executor: a body over 4 MiB is cut off as too_large instead of buffered", async () => {
  let closed = false;
  await withServer((_path, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    const chunk = Buffer.alloc(256 * 1024, 0x20);
    const pump = () => {
      while (!closed && res.write(chunk)) { /* fill the socket */ }
      if (!closed) res.once("drain", pump);
    };
    res.on("close", () => (closed = true));
    pump();
  }, async (port) => {
    const t0 = Date.now();
    const r = await executePlan(onePlan("/big"), port);
    assert.deepEqual(r.x, { s: 200, j: null, e: "too_large" });
    assert.ok(Date.now() - t0 < 10_000, "aborted at the cap, not at the timeout");
  });
  assert.ok(MAX_BODY_BYTES === 4 * 1024 * 1024);
});

test("executor: a body under the cap is decoded as UTF-8 across chunk boundaries", async () => {
  const bytes = Buffer.from(JSON.stringify({ ok: false, error: "contraseña caducada €" }), "utf8");
  const cut = bytes.indexOf(Buffer.from("ñ")) + 1; // split inside the multi-byte character
  await withServer((_path, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write(bytes.subarray(0, cut));
    setTimeout(() => res.end(bytes.subarray(cut)), 20);
  }, async (port) => {
    const r = await executePlan(onePlan("/ok"), port);
    assert.deepEqual(r.x, { s: 200, j: { ok: false, error: "contraseña caducada €" }, e: null });
  });
});

test("executor: redirects are not followed", async () => {
  await withServer((path, res) => {
    if (path === "/moved") {
      res.writeHead(307, { Location: "/elsewhere" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
  }, async (port, seen) => {
    const r = await executePlan(onePlan("/moved"), port);
    assert.equal(r.x?.s, 307);
    assert.deepEqual(seen, ["/moved"]);
  });
});
