// Compiles the plugin with the DAEMON's own compiler (in memory, write:false) exactly as
// `paseo plugin install/reload` would, without touching ~/.paseo. Windows desktop install only.
// Then checks that the session helper embedded in the COMPILED server bundle still parses: its
// rules travel as Function.prototype.toString of the compiled functions.
//   npm run check:bundle            (PASEO_EXE overrides the Paseo.exe path)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
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

const tail = "return module.exports;\n})";
const bundle = out.serverBundle;
if (typeof bundle !== "string" || !bundle.trimEnd().endsWith(tail)) throw new Error("unexpected server bundle shape");
const exposed = bundle.trimEnd().slice(0, -tail.length) + "module.exports.__helperSource = helperSource;\n" + tail;
const req = createRequire(path.join(root, "package.json")); // the bundle's externals (zod, the plugin SDK) from devDependencies
const helper = (0, eval)(exposed)(req).__helperSource();
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmswapper-bundle-")), "helper.mjs");
fs.writeFileSync(file, helper);
const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
fs.rmSync(path.dirname(file), { recursive: true, force: true });
if (check.status !== 0) throw new Error(`the compiled session helper does not parse:\n${check.stderr}`);
console.log(`session helper: ${helper.length} chars, parses`);
console.log("check:bundle OK (daemon compiler accepted client + server entries)");
