import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOOT, LOGIN_SHELL_WRAPPER, MAX_ARG_B64, buildBridgeInvocation, buildRemoteScript, newNonce, parseBridgeOutput,
} from "../shared/bridge.ts";
import { InvalidOpError, type SwapperOp } from "../shared/plan.ts";
import { emitLines } from "./fixtures.ts";

const N = "0123456789abcdef";
const OPS: SwapperOp[] = [
  { kind: "state" }, { kind: "usage" }, { kind: "auto", enabled: true },
  { kind: "swap", accountId: "acc_a1b2c3", target: "wsl:Ubuntu-24.04" },
];

test("every op builds a parseable script under the argv limit", () => {
  for (const op of OPS) {
    const src = buildRemoteScript(op, { port: 7373, nonce: N });
    // Syntax check of OUR generated script only (never invoked here).
    assert.doesNotThrow(() => new Function("require", "process", "Buffer", src));
    const inv = buildBridgeInvocation(op, { port: 7373, nonce: N });
    assert.equal(inv.command, "node");
    assert.deepEqual(inv.args.slice(0, 2), ["-e", BOOT]);
    assert.ok(inv.payload.length < MAX_ARG_B64, `${op.kind}: ${inv.payload.length}`);
  }
});

test("BOOT has no shell metacharacters; login-shell mode passes data only as positional args", () => {
  assert.doesNotMatch(BOOT, /[\s"&|<>^%!$`;]/);
  const inv = buildBridgeInvocation({ kind: "state" }, { port: 7373, nonce: N, mode: "login-shell", nodeCommand: "/opt/node/bin/node" });
  assert.equal(inv.command, "/bin/sh");
  assert.deepEqual(inv.args, ["-c", LOGIN_SHELL_WRAPPER, BOOT, inv.payload, "/opt/node/bin/node"]);
  assert.ok(!LOGIN_SHELL_WRAPPER.includes(inv.payload));
});

test("invalid ids, port, nonce and node command are rejected before anything is built", () => {
  const bad: SwapperOp[] = [
    { kind: "swap", accountId: "acc_a1b2c3'+process.exit()+'", target: "host" },
    { kind: "swap", accountId: "ACC_A1B2C3", target: "host" },
    { kind: "swap", accountId: "acc_a1b2c3", target: "wsl:Ubuntu; rm -rf /" },
    { kind: "swap", accountId: "acc_a1b2c3", target: "host\n" },
    { kind: "swap", accountId: "acc_a1b2c3", target: "wsl:" },
  ];
  for (const op of bad) assert.throws(() => buildRemoteScript(op, { port: 7373, nonce: N }), InvalidOpError);
  assert.throws(() => buildRemoteScript({ kind: "state" }, { port: 0, nonce: N }), InvalidOpError);
  assert.throws(() => buildRemoteScript({ kind: "state" }, { port: 7373, nonce: "zz" }), InvalidOpError);
  for (const node of ["node.exe; calc", "relative/node", "/usr/bin/node\n", 'C:\\a"b', "C:node.exe"]) {
    assert.throws(() => buildBridgeInvocation({ kind: "state" }, { port: 7373, nonce: N, nodeCommand: node }), InvalidOpError, node);
  }
  for (const node of ["node", "/home/u/.nvm/versions/node/v22.23.3/bin/node", "C:\\Program Files\\nodejs\\node.exe"]) {
    assert.equal(buildBridgeInvocation({ kind: "state" }, { port: 7373, nonce: N, nodeCommand: node }).command, node);
  }
});

test("swap target is embedded as a JSON string, never an object", () => {
  const src = buildRemoteScript({ kind: "swap", accountId: "acc_a1b2c3", target: "host" }, { port: 7373, nonce: N });
  assert.match(src, /"b":\{"id":"acc_a1b2c3","target":"host"\}/);
});

test("newNonce is 16 hex", () => {
  for (let i = 0; i < 50; i++) assert.match(newNonce(), /^[0-9a-f]{16}$/);
});

const env = { v: 1, node: "v24.0.0", results: { health: { s: 200, j: { ok: true }, e: null } } };

test("parse: pending (with started flag) until both markers are present", () => {
  const lines = emitLines(env, N);
  assert.deepEqual(parseBridgeOutput([], N), { status: "pending", started: false });
  assert.deepEqual(parseBridgeOutput(lines.slice(0, 1), N), { status: "pending", started: true });
  assert.equal(parseBridgeOutput(lines.slice(0, -1), N).status, "pending");
  assert.equal(parseBridgeOutput(lines, N).status, "done");
  assert.deepEqual(parseBridgeOutput([`__SWP_D_${N}__`], N), { status: "duplicate" });
});

test("parse: noise, ANSI, CRLF string input and terminal re-wrapping", () => {
  const lines = emitLines(env, N);
  const wrapped = lines.flatMap((l) => (l.length > 80 ? [l.slice(0, 80), l.slice(80)] : [l]));
  const text = ["$ node -e ...", "\u001b[32mnoise\u001b[0m", ...wrapped.map((l) => `  ${l}   `), "$"].join("\r\n");
  const r = parseBridgeOutput(text, N);
  assert.equal(r.status, "done");
  if (r.status === "done") assert.deepEqual(r.envelope, env);
});

test("parse: other nonce is ignored; truncation and junk are corrupt", () => {
  assert.equal(parseBridgeOutput(emitLines(env, "ffffffffffffffff"), N).status, "pending");
  const lines = emitLines({ ...env, pad: "x".repeat(400) }, N);
  assert.equal(parseBridgeOutput([...lines.slice(0, 3), ...lines.slice(4)], N).status, "corrupt");
  const junk = [...lines];
  junk[2] = "not base64!";
  assert.equal(parseBridgeOutput(junk, N).status, "corrupt");
  assert.equal(parseBridgeOutput(emitLines({ v: 2 }, N), N).status, "corrupt");
});
