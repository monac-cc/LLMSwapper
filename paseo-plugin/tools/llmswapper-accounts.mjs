#!/usr/bin/env node
// Copies LLMswapper's pasted-token accounts (claude setup-token) to other devices. Zero deps, Node 18+.
//
//   node tools/llmswapper-accounts.mjs export [--store <accounts.json>] [--out <file>] [--sin-cifrar]
//
// Writes ONE self-contained file (default ./llmswapper-cuentas.mjs) holding the accounts encrypted with a
// passphrase you type (AES-256-GCM, key from scrypt). On each device, with LLMswapper running:
//
//   node llmswapper-cuentas.mjs [--port 7373]
//
// asks the passphrase and adds every account through LLMswapper's own POST /api/accounts/token, then
// restores its colour. Tokens are never printed. Accounts imported with /login (rotating refresh token)
// are NOT exported: two devices refreshing the same token would kill each other's copy.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MIN_PASS = 12;
const KDF = { N: 2 ** 17, r: 8, p: 1 }; // ~128 MiB, ~0.5 s: the file may travel through untrusted places

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Hidden input on a TTY; one line from stdin otherwise (tests, pipes). LLMSWAPPER_PASS for automation. */
export function askHidden(prompt) {
  if (process.env.LLMSWAPPER_PASS) return Promise.resolve(process.env.LLMSWAPPER_PASS);
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => { buf += c; const i = buf.indexOf("\n"); if (i >= 0) { stdin.pause(); resolve(buf.slice(0, i).replace(/\r$/, "")); } });
      stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { stdin.setRawMode(false); stdin.off("data", onData); stdin.pause(); process.stdout.write("\n"); resolve(value); return; }
        if (ch === "\u0003") { stdin.setRawMode(false); process.stdout.write("\n"); reject(new Error("Cancelado")); return; }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

function readStore(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const store = JSON.parse(text);
  if (!store || !Array.isArray(store.accounts)) throw new Error(`${file} no parece un almacén de LLMswapper`);
  return store;
}

/** Only pasted long-lived tokens are safe to clone across devices. */
export function selectAccounts(store) {
  const picked = [], skipped = [];
  for (const a of store.accounts) {
    const o = a && a.oauth;
    const name = (a && a.label) || (a && a.email) || (a && a.id) || "?";
    if (!o || typeof o.accessToken !== "string" || !o.accessToken) skipped.push({ name, why: "sin token" });
    else if (o.refreshToken) skipped.push({ name, why: "sesión importada con /login (token renovable): añádela en cada equipo con «claude setup-token»" });
    else picked.push({ label: a.label || a.email || null, color: typeof a.color === "string" ? a.color : null, token: o.accessToken });
  }
  return { picked, skipped };
}

export function encrypt(plain, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32, { ...KDF, maxmem: 256 * 1024 * 1024 });
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { v: 1, kdf: "scrypt", ...KDF, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

// The importer that travels to the other devices. Kept dependency-free and readable: whoever runs it can audit it.
const IMPORTER = String.raw`#!/usr/bin/env node
// LLMswapper accounts export. Run on the target device with LLMswapper running:  node __FILE__ [--port 7373]
// It asks the passphrase, then adds each account through LLMswapper's POST /api/accounts/token.
// Holds year-long Claude tokens (encrypted). Delete this file once imported everywhere.
import crypto from "node:crypto";
const BUNDLE = __BUNDLE__;
const LABELS = __LABELS__;
const port = (() => { const i = process.argv.indexOf("--port"); return i > 0 ? Number(process.argv[i + 1]) : Number(process.env.PORT || 7373); })();
const base = "http://127.0.0.1:" + port;
const scrub = (s) => String(s).replace(/sk-ant-[A-Za-z0-9_-]+/g, "[token]");
function ask(prompt) {
  if (process.env.LLMSWAPPER_PASS) return Promise.resolve(process.env.LLMSWAPPER_PASS);
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) { let b = ""; stdin.setEncoding("utf8"); stdin.on("data", (c) => { b += c; const i = b.indexOf("\n"); if (i >= 0) { stdin.pause(); resolve(b.slice(0, i).replace(/\r$/, "")); } }); stdin.on("end", () => resolve(b.replace(/\r?\n$/, ""))); return; }
    let v = ""; stdin.setRawMode(true); stdin.setEncoding("utf8");
    const on = (chunk) => { for (const ch of chunk) {
      if (ch === "\r" || ch === "\n") { stdin.setRawMode(false); stdin.off("data", on); stdin.pause(); process.stdout.write("\n"); resolve(v); return; }
      if (ch === "\u0003") { stdin.setRawMode(false); process.stdout.write("\n"); reject(new Error("Cancelado")); return; }
      if (ch === "\u007f" || ch === "\b") v = v.slice(0, -1); else if (ch >= " ") v += ch; } };
    stdin.on("data", on); stdin.resume();
  });
}
async function api(path, method, body) {
  const res = await fetch(base + path, { method, headers: { "X-Swapper": "1", "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(scrub(data.error || ("HTTP " + res.status)));
  return data;
}
async function main() {
  console.log("Cuentas en este fichero: " + LABELS.join(", "));
  try { await fetch(base + "/api/targets", { headers: { "X-Swapper": "1" }, signal: AbortSignal.timeout(5000) }); }
  catch { throw new Error("No llego a LLMswapper en " + base + ". Arráncalo (node server.js) o indica --port."); }
  let accounts;
  if (BUNDLE.plain) accounts = JSON.parse(Buffer.from(BUNDLE.plain, "base64").toString("utf8")).accounts;
  else try {
    const pass = await ask("Contraseña de la exportación: ");
    const key = crypto.scryptSync(pass, Buffer.from(BUNDLE.salt, "base64"), 32, { N: BUNDLE.N, r: BUNDLE.r, p: BUNDLE.p, maxmem: 256 * 1024 * 1024 });
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(BUNDLE.iv, "base64"));
    d.setAuthTag(Buffer.from(BUNDLE.tag, "base64"));
    accounts = JSON.parse(Buffer.concat([d.update(Buffer.from(BUNDLE.data, "base64")), d.final()]).toString("utf8")).accounts;
  } catch { throw new Error("Contraseña incorrecta o fichero dañado."); }
  let ok = 0;
  for (const a of accounts) {
    const name = a.label || "(sin nombre)";
    try {
      const r = await api("/api/accounts/token", "POST", { token: a.token, label: a.label || undefined });
      if (a.color && r.account && r.account.id) await api("/api/accounts/" + r.account.id, "PATCH", { color: a.color }).catch(() => {});
      ok++;
      console.log("  ✔ " + name + (r.account && r.account.id ? " (" + r.account.id + ")" : "") + ((r.warnings || []).length ? " · " + r.warnings.map(scrub).join(" · ") : ""));
    } catch (e) {
      console.log("  ✗ " + name + ": " + scrub(e.message));
    }
  }
  console.log(ok + "/" + accounts.length + " cuentas añadidas. Si ya existían, se han actualizado. Borra este fichero cuando hayas terminado con todos los equipos.");
  if (ok < accounts.length) process.exitCode = 1;
}
main().catch((e) => { console.error("✗ " + scrub(e.message)); process.exitCode = 1; });
`;

export function buildImporter(bundle, labels, fileName) {
  return IMPORTER.split("__FILE__").join(fileName).split("__BUNDLE__").join(JSON.stringify(bundle)).split("__LABELS__").join(JSON.stringify(labels));
}

async function exportCmd() {
  const store = arg("--store", path.join(os.homedir(), "llmswapper", "data", "accounts.json"));
  const out = path.resolve(arg("--out", "llmswapper-cuentas.mjs"));
  const { picked, skipped } = selectAccounts(readStore(store));
  for (const s of skipped) console.log(`  · no se exporta ${s.name}: ${s.why}`);
  if (!picked.length) throw new Error("No hay cuentas de token pegado que exportar.");
  console.log(`Se exportarán ${picked.length} cuentas: ${picked.map((a) => a.label || "(sin nombre)").join(", ")}`);
  const payload = JSON.stringify({ v: 1, exportedAt: new Date().toISOString(), accounts: picked });
  let bundle;
  if (process.argv.includes("--sin-cifrar")) {
    // No passphrase: base64 only, NOT encryption. Anyone with the file can use the accounts.
    bundle = { v: 1, plain: Buffer.from(payload, "utf8").toString("base64") };
  } else {
    const pass = await askHidden(`Contraseña para cifrar (mín. ${MIN_PASS} caracteres): `);
    if (pass.length < MIN_PASS) throw new Error(`La contraseña debe tener al menos ${MIN_PASS} caracteres.`);
    if (!process.env.LLMSWAPPER_PASS && (await askHidden("Repítela: ")) !== pass) throw new Error("Las contraseñas no coinciden.");
    bundle = encrypt(payload, pass);
  }
  fs.writeFileSync(out, buildImporter(bundle, picked.map((a) => a.label || "(sin nombre)"), path.basename(out)), { mode: 0o600 });
  console.log(`Listo: ${out}`);
  console.log(`En cada equipo, con LLMswapper en marcha:  node ${path.basename(out)}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const cmd = process.argv[2];
  (cmd === "export" ? exportCmd() : Promise.reject(new Error("uso: node tools/llmswapper-accounts.mjs export [--store <accounts.json>] [--out <fichero>] [--sin-cifrar]")))
    .catch((e) => { console.error(`✗ ${String(e.message).replace(/sk-ant-[A-Za-z0-9_-]+/g, "[token]")}`); process.exitCode = 1; });
}
