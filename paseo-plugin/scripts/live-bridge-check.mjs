// OPTIONAL manual check of the terminal bridge against the LOCAL daemon WITHOUT installing the plugin.
// Runs the read-only "state" op (GET health/targets/accounts/auto on 127.0.0.1:<port>) through a real
// short-lived terminal, prints a lifecycle trace, then verifies the terminal is gone.
//   node scripts/live-bridge-check.mjs <workspaceId> [port]
// Connects like the Paseo CLI does (local daemon credential from ~/.paseo, never printed).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const exe = process.env.PASEO_EXE ?? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Paseo", "Paseo.exe");
if (!process.versions.electron) {
  const r = spawnSync(exe, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  process.exit(r.status ?? 1);
}
const [workspaceId, portArg] = process.argv.slice(2);
if (!workspaceId) throw new Error("uso: node scripts/live-bridge-check.mjs <workspaceId> [puerto]");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgs = path.join(path.dirname(exe), "resources", "app.asar", "node_modules", "@getpaseo");
const { connectToDaemon } = await import(pathToFileURL(path.join(pkgs, "cli", "dist", "utils", "client.js")).href);
const { createPaseoApi } = await import(pathToFileURL(path.join(pkgs, "client", "dist", "index.js")).href);
const { runOnHostCore } = await import(pathToFileURL(path.join(root, "client", "bridge", "runner-core.ts")).href);

const daemon = await connectToDaemon({ target: { kind: "instance", home: path.join(os.homedir(), ".paseo") } });
const api = createPaseoApi(daemon);
const trace = [];
let nonce = "";
const t0 = Date.now();
const traced = {
  workspaces: api.workspaces,
  terminals: {
    create: async (o) => {
      const h = await api.terminals.create(o);
      trace.push(`+${Date.now() - t0} create ${o.command} (${o.args.length} args)`);
      return {
        id: h.id,
        capture: async (c) => {
          const r = await h.capture(c);
          trace.push(`+${Date.now() - t0} capture totalLines=${r.totalLines} nonEmpty=${r.lines.filter((l) => l.trim()).length}`);
          return r;
        },
        kill: async () => {
          await h.kill();
          const after = await h.capture({ start: 0 });
          const left = await api.terminals.list({ workspaceId: o.workspaceId });
          trace.push(`+${Date.now() - t0} kill; totalLines after kill=${after.totalLines}; terminals left in workspace=${left.entries.length}`);
        },
      };
    },
  },
};
const r = await runOnHostCore({ getClient: () => traced, nonce: () => (nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("")) },
  "live-check", { kind: "state" }, { port: Number(portArg ?? 7373), workspaceId });
for (const l of trace) console.log(l);
console.log(r.ok
  ? `OK en ${Date.now() - t0} ms: ${r.data.targets.length} entornos, ${r.data.accounts.length} cuentas, avisos: ${r.data.warnings.map((w) => w.code).join(", ") || "ninguno"}`
  : `ERROR ${r.error.code}: ${r.error.message}`);
try { fs.unlinkSync(path.join(os.tmpdir(), "llmswapper-bridge", nonce)); } catch { /* already swept */ }
await daemon.close?.();
process.exit(r.ok ? 0 : 1);
