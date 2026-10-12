import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TOOL = path.resolve("tools/llmswapper-accounts.mjs");
// Fixtures built at runtime (no token literal in the source).
const tok = (n: string) => ["sk", "ant", "oat01", `FAKE${n}`.padEnd(40, "x")].join("-");
const PASS = "una-frase-de-prueba-larga";

/** Async: the fake LLMswapper lives in THIS process, so a blocking spawnSync would starve it. */
function runAsync(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, { env });
    let stdout = "", stderr = "";
    c.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    c.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function fakeSwapper() {
  const received: { method: string; url: string; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      received.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.setHeader("Content-Type", "application/json");
      if (req.headers["x-swapper"] !== "1") { res.statusCode = 403; res.end(JSON.stringify({ error: "no" })); return; }
      if (req.url === "/api/accounts/token") { res.end(JSON.stringify({ ok: true, kind: "inference", warnings: [], account: { id: "acc_" + String(body.label).toLowerCase().slice(0, 6).padEnd(6, "0") } })); return; }
      res.end(JSON.stringify({ ok: true, targets: [] }));
    });
  });
  return new Promise<{ port: number; received: typeof received; close(): void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, received, close: () => server.close() })));
}

test("export -> self-contained importer -> LLMswapper API; tokens never printed; renewable sessions skipped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swp-accounts-"));
  try {
    const store = path.join(dir, "accounts.json");
    fs.writeFileSync(store, "﻿" + JSON.stringify({ version: 1, accounts: [
      { id: "acc_aaaaaa", label: "CGomez", color: "#7c5cff", oauth: { accessToken: tok("A"), refreshToken: null } },
      { id: "acc_bbbbbb", label: "CTO", color: "#22d3ee", oauth: { accessToken: tok("B"), refreshToken: null } },
      { id: "acc_cccccc", label: "Login", color: "#000000", oauth: { accessToken: tok("C"), refreshToken: tok("R") } },
    ] }));
    const out = path.join(dir, "llmswapper-cuentas.mjs");
    const env = { ...process.env, LLMSWAPPER_PASS: PASS };
    const ex = spawnSync(process.execPath, [TOOL, "export", "--store", store, "--out", out], { env, encoding: "utf8" });
    assert.equal(ex.status, 0, ex.stderr);
    assert.match(ex.stdout, /Se exportarán 2 cuentas: CGomez, CTO/);
    assert.match(ex.stdout, /no se exporta Login/);
    const file = fs.readFileSync(out, "utf8");
    for (const n of ["A", "B", "C", "R"]) assert.ok(!file.includes(tok(n)) && !ex.stdout.includes(tok(n)), `token ${n} leaked`);

    const sw = await fakeSwapper();
    try {
      const bad = await runAsync([out, "--port", String(sw.port)], { ...process.env, LLMSWAPPER_PASS: "otra-contraseña-mala" });
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /Contraseña incorrecta/);
      assert.equal(sw.received.filter((r) => r.method === "POST").length, 0, "nothing sent with a wrong passphrase");

      const run = await runAsync([out, "--port", String(sw.port)], env);
      assert.equal(run.status, 0, run.stderr + run.stdout);
      assert.match(run.stdout, /2\/2 cuentas añadidas/);
      for (const n of ["A", "B"]) assert.ok(!run.stdout.includes(tok(n)), "importer printed a token");
      const posts = sw.received.filter((r) => r.method === "POST");
      assert.deepEqual(posts.map((p) => [p.body.label, p.body.token]), [["CGomez", tok("A")], ["CTO", tok("B")]]);
      const patches = sw.received.filter((r) => r.method === "PATCH");
      assert.deepEqual(patches.map((p) => [p.url, p.body.color]), [["/api/accounts/acc_cgomez", "#7c5cff"], ["/api/accounts/acc_cto000", "#22d3ee"]]);
    } finally {
      sw.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--sin-cifrar: no passphrase on either side, same import", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swp-accounts-plain-"));
  try {
    const store = path.join(dir, "accounts.json");
    fs.writeFileSync(store, JSON.stringify({ version: 1, accounts: [{ id: "acc_aaaaaa", label: "CGomez", color: "#7c5cff", oauth: { accessToken: tok("P"), refreshToken: null } }] }));
    const out = path.join(dir, "cuentas.mjs");
    const env = { ...process.env };
    delete env.LLMSWAPPER_PASS;
    const ex = spawnSync(process.execPath, [TOOL, "export", "--store", store, "--out", out, "--sin-cifrar"], { env, encoding: "utf8", input: "" });
    assert.equal(ex.status, 0, ex.stderr);
    assert.ok(!ex.stdout.includes(tok("P")) && !fs.readFileSync(out, "utf8").includes(tok("P")), "token in clear");
    const sw = await fakeSwapper();
    try {
      const run = await runAsync([out, "--port", String(sw.port)], env);
      assert.equal(run.status, 0, run.stderr + run.stdout);
      assert.deepEqual(sw.received.filter((r) => r.method === "POST").map((p) => p.body.token), [tok("P")]);
    } finally {
      sw.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
