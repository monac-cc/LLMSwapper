// Compiles the plugin with the DAEMON's own compiler (in memory, write:false) exactly as
// `paseo plugin install/reload` would, without touching ~/.paseo. Windows desktop install only.
//   npm run check:bundle            (PASEO_EXE overrides the Paseo.exe path)
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const exe = process.env.PASEO_EXE ?? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Paseo", "Paseo.exe");

if (!process.versions.electron) {
  const r = spawnSync(exe, [fileURLToPath(import.meta.url)], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  process.exit(r.status ?? 1);
}

const compiler = path.join(path.dirname(exe), "resources", "app.asar", "node_modules", "@getpaseo", "server", "dist", "server", "server", "plugins", "compiler.js");
const { compilePlugin } = await import(pathToFileURL(compiler).href);
const out = await compilePlugin({ client: path.join(root, "index.client.tsx"), server: path.join(root, "index.server.ts") });
for (const [k, v] of Object.entries(out)) console.log(`${k}: ${typeof v === "string" ? `${v.length} chars` : typeof v}`);
console.log("check:bundle OK (daemon compiler accepted client + server entries)");
