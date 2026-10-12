// Runs the REAL device script with the current Node against a FAKE LLMswapper on an ephemeral port.
// Never touches 127.0.0.1:7373. Lock files go to the per-user run-once dir (swept after 1 h).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildBridgeInvocation, newNonce, parseBridgeOutput } from "../shared/bridge.ts";
import { pick } from "../shared/pick.ts";
import { planFor, type SwapperOp } from "../shared/plan.ts";
import { PICK } from "../shared/whitelist.ts";
import { executePlan } from "../server/executor.ts";
import * as F from "./fixtures.ts";

const LONG_ERROR = `No se pudo refrescar el token: ${"x".repeat(1800)} - config LA RESTAURACIÓN FALLÓ (EPERM) - restaura a mano desde /home/x/llmswapper/data/backups/2026-10-12`;
const ROUTES: Record<string, { status: number; body: unknown }> = {
  "GET /api/health": { status: 200, body: F.health }, "GET /api/targets": { status: 200, body: F.targets },
  "GET /api/accounts?target=host": { status: 200, body: F.accounts }, "GET /api/auto": { status: 200, body: F.auto },
  "GET /api/usage/all": { status: 200, body: F.usageAll }, "POST /api/swap": { status: 200, body: F.swapOk },
  "POST /api/auto": { status: 200, body: F.auto },
};
const seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
let server: Server;
let port = 0;
let swapFails = false;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const key = `${req.method} ${req.url}`;
      const hit = swapFails && key === "POST /api/swap" ? { status: 500, body: { ok: false, error: LONG_ERROR } } : ROUTES[key];
      const ok = req.headers["x-swapper"] === "1" && req.headers.origin === undefined && hit !== undefined;
      res.writeHead(ok ? hit.status : 403, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok ? hit.body : { ok: false, error: "Falta la cabecera X-Swapper" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
const usedNonces = new Set<string>();
// Same dirs the device script tries (POSIX appends the uid; the home fallback is used if tmpdir is unusable).
const uid = typeof process.getuid === "function" ? process.getuid() : null;
const lockDirs = [join(tmpdir(), `llmswapper-bridge${uid === null ? "" : `-${uid}`}`), ...(uid === null ? [] : [join(homedir(), ".llmswapper-bridge")])];
after(async () => {
  for (const n of usedNonces) {
    for (const d of lockDirs) try { unlinkSync(join(d, n)); } catch { /* not created here */ }
  }
  await new Promise<void>((r) => server.close(() => r()));
});

function runDevice(op: SwapperOp, nonce: string, lingerMs: number, p = port): Promise<{ stdout: string; exitedAfterMs: number }> {
  usedNonces.add(nonce);
  const inv = buildBridgeInvocation(op, { port: p, nonce, lingerMs });
  const t0 = Date.now();
  const child = spawn(process.execPath, inv.args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  return new Promise((resolve) => child.on("exit", () => resolve({ stdout, exitedAfterMs: Date.now() - t0 })));
}

const EXPECTED: Record<SwapperOp["kind"], Record<string, unknown>> = {
  state: { health: pick(F.health, PICK.health), targets: pick(F.targets, PICK.targets), accounts: pick(F.accounts, PICK.accounts), auto: pick(F.auto, PICK.auto) },
  usage: { usage: pick(F.usageAll, PICK.usageAll) },
  swap: { swap: pick(F.swapOk, PICK.swap) },
  auto: { auto: pick(F.auto, PICK.auto) },
};
const OPS: SwapperOp[] = [
  { kind: "state" }, { kind: "usage" }, { kind: "swap", accountId: "acc_a1b2c3", target: "wsl:Ubuntu-24.04" }, { kind: "auto", enabled: false },
];

for (const op of OPS) {
  test(`device script ${op.kind}: start marker, JS pick == TS pick, no secrets, lingers then exits`, async () => {
    const nonce = newNonce();
    const { stdout, exitedAfterMs } = await runDevice(op, nonce, 400);
    assert.ok(stdout.includes(`\u001b]0;LLMswapper\u0007`), "sets the terminal title");
    assert.ok(stdout.indexOf(`__SWP_S_${nonce}__`) < stdout.indexOf(`__SWP_B_${nonce}__`), "start marker first");
    const parsed = parseBridgeOutput(stdout, nonce);
    assert.equal(parsed.status, "done");
    if (parsed.status !== "done") return;
    const decoded = JSON.stringify(parsed.envelope);
    assert.ok(!decoded.includes("sk-ant-") && !decoded.includes("eyJ"), "no secrets in decoded output");
    const results = parsed.envelope.results ?? {};
    for (const [key, expected] of Object.entries(EXPECTED[op.kind])) {
      assert.equal(results[key]?.s, 200, key);
      assert.deepEqual(results[key]?.j, expected, key);
    }
    assert.ok(exitedAfterMs >= 400, `lingered ${exitedAfterMs} ms`);
  });
}

test("run-once guard: a second process with the same nonce prints D and sends nothing", async () => {
  const nonce = newNonce();
  const op: SwapperOp = { kind: "swap", accountId: "acc_a1b2c3", target: "host" };
  seen.length = 0;
  await runDevice(op, nonce, 50);
  const second = await runDevice(op, nonce, 50);
  assert.equal(seen.filter((s) => s.method === "POST").length, 1, "exactly one swap reached LLMswapper");
  assert.deepEqual(parseBridgeOutput(second.stdout, nonce), { status: "duplicate" });
});

// --- per-user run-once lock on POSIX (review #1 / #17). Skipped on Windows (no uid; tmpdir is per user). ---
test("POSIX lock: created in the per-user dir with mode 0700, not the shared path", { skip: uid === null }, async () => {
  const { chmodSync, mkdirSync, rmSync, statSync, existsSync } = await import("node:fs");
  const shared = join(tmpdir(), "llmswapper-bridge");
  rmSync(lockDirs[0], { recursive: true, force: true });
  rmSync(shared, { recursive: true, force: true });
  const nonce = newNonce();
  await runDevice({ kind: "state" }, nonce, 50);
  assert.ok(existsSync(join(lockDirs[0], nonce)), "lock file is in the per-user dir");
  assert.equal(statSync(lockDirs[0]).mode & 0o777, 0o700, "per-user dir is 0700");
  assert.ok(!existsSync(shared), "the shared llmswapper-bridge dir was never used");
  // A directory pre-created by another user (group/world-writable) is refused; the home fallback is used.
  rmSync(lockDirs[0], { recursive: true, force: true });
  mkdirSync(lockDirs[0]);
  chmodSync(lockDirs[0], 0o777); // mkdir alone honours the umask (0755): set it explicitly, as another user would
  rmSync(lockDirs[1], { recursive: true, force: true });
  seen.length = 0;
  const n2 = newNonce();
  const { stdout } = await runDevice({ kind: "swap", accountId: "acc_a1b2c3", target: "host" }, n2, 50);
  assert.equal(parseBridgeOutput(stdout, n2).status, "done", "the swap still ran via the home fallback");
  assert.ok(existsSync(join(lockDirs[1], n2)), "lock file landed in the home fallback dir");
  assert.equal(seen.filter((s) => s.method === "POST").length, 1);
  rmSync(lockDirs[0], { recursive: true, force: true });
});

test("POSIX lock: no usable dir => a swap emits lock_unavailable and sends nothing; a read runs", { skip: uid === null }, async () => {
  const { chmodSync, mkdirSync, rmSync } = await import("node:fs");
  for (const d of lockDirs) { rmSync(d, { recursive: true, force: true }); mkdirSync(d); chmodSync(d, 0o777); }
  try {
    seen.length = 0;
    const n1 = newNonce();
    const swap = await runDevice({ kind: "swap", accountId: "acc_a1b2c3", target: "host" }, n1, 50);
    const p = parseBridgeOutput(swap.stdout, n1);
    assert.ok(p.status === "done" && p.envelope.fatal?.startsWith("lock_unavailable"), swap.stdout);
    assert.ok(!swap.stdout.includes(`__SWP_S_${n1}__`), "no start marker: nothing was sent");
    assert.equal(seen.filter((s) => s.method === "POST").length, 0, "the swap reached LLMswapper zero times");
    // A read (only GET requests) runs unguarded even without a lock.
    seen.length = 0;
    const n2 = newNonce();
    const read = await runDevice({ kind: "state" }, n2, 50);
    assert.equal(parseBridgeOutput(read.stdout, n2).status, "done", "the read ran unguarded");
    assert.ok(seen.some((s) => s.method === "GET"));
  } finally {
    for (const d of lockDirs) rmSync(d, { recursive: true, force: true });
  }
});

test("long error: JS clip == TS clip, keeps the backup path at the end", async () => {
  swapFails = true;
  try {
    const nonce = newNonce();
    const { stdout } = await runDevice({ kind: "swap", accountId: "acc_a1b2c3", target: "host" }, nonce, 50);
    const p = parseBridgeOutput(stdout, nonce);
    assert.ok(p.status === "done");
    if (p.status !== "done") return;
    const r = p.envelope.results?.swap;
    assert.equal(r?.s, 500);
    assert.deepEqual(r?.j, pick({ ok: false, error: LONG_ERROR }, PICK.error));
    assert.ok(String((r?.j as { error: string }).error).endsWith("restaura a mano desde /home/x/llmswapper/data/backups/2026-10-12"));
  } finally {
    swapFails = false;
  }
});

test("device script: connection refused is reported, not thrown", async () => {
  const nonce = newNonce();
  const closed = await new Promise<number>((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
  const { stdout } = await runDevice({ kind: "state" }, nonce, 50, closed);
  const p = parseBridgeOutput(stdout, nonce);
  assert.ok(p.status === "done" && p.envelope.results?.health?.e === "ECONNREFUSED");
});

test("server executor sends X-Swapper, no Origin, JSON body with string target", async () => {
  seen.length = 0;
  const r = await executePlan(planFor({ kind: "swap", accountId: "acc_a1b2c3", target: "host" }), port);
  assert.equal(r.swap?.s, 200);
  assert.deepEqual(r.swap?.j, pick(F.swapOk, PICK.swap));
  const req = seen.find((s) => s.method === "POST");
  assert.ok(req);
  assert.equal(req.headers["x-swapper"], "1");
  assert.equal(req.headers.origin, undefined);
  assert.deepEqual(JSON.parse(req.body), { id: "acc_a1b2c3", target: "host" });
});
