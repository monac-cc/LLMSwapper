import fs from "node:fs";
import path from "node:path";

/** Typed locally: the main tsconfig has React Native globals, not @types/node. */
const proc = (globalThis as unknown as {
  process: { execPath: string; platform: string; argv: string[]; env: Record<string, string | undefined> };
}).process;

export interface CliCommand {
  readonly command: string;
  readonly prefix: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The CLI package's dist/index.js and the Node that runs it, when known (not for a bare `paseo` on PATH). */
  readonly cliIndex?: string;
  readonly node?: { readonly command: string; readonly env: Readonly<Record<string, string>> };
}

const ELECTRON_ENV = { ELECTRON_RUN_AS_NODE: "1", PASEO_NODE_ENV: "production" } as const;

/**
 * The Paseo CLI, without any shell (Windows never goes through cmd.exe). In order:
 * 1. Desktop app: the plugin subprocess is the app binary itself (Electron as Node), launched the way
 *    resources/bin/paseo(.cmd) does it. resources/ sits next to the binary on Windows and Linux, and in
 *    Paseo.app/Contents/Resources on macOS.
 * 2. npm/CLI daemon: the plugin subprocess runs .../@getpaseo/server/.../plugin-process.js. The CLI package
 *    is either its parent (npm nests server inside cli/node_modules) or its sibling, run with the same Node.
 * 3. `paseo` from PATH (POSIX only).
 */
export function resolveCli(
  execPath = proc.execPath, platform = proc.platform, exists: (p: string) => boolean = fs.existsSync, entry: string | undefined = proc.argv[1],
): CliCommand | null {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dir = p.dirname(execPath);
  for (const resources of [p.join(dir, "resources"), p.join(dir, "..", "Resources")]) {
    const runner = p.join(resources, "app.asar.unpacked", "dist", "daemon", "node-entrypoint-runner.js");
    const asar = p.join(resources, "app.asar");
    if (exists(runner) && exists(asar)) {
      const cliIndex = p.join(asar, "node_modules", "@getpaseo", "cli", "dist", "index.js");
      return {
        command: execPath,
        prefix: ["--disable-warning=DEP0040", runner, "node-script", cliIndex],
        env: ELECTRON_ENV,
        cliIndex,
        node: { command: execPath, env: ELECTRON_ENV },
      };
    }
  }
  // npm nests the server inside the CLI package (cli/node_modules/@getpaseo/server): the CLI is the parent.
  const nested = entry ? /^(.*[\\/]@getpaseo[\\/]cli)[\\/]node_modules[\\/]@getpaseo[\\/]server[\\/]/.exec(entry) : null;
  const sibling = entry ? /^(.*)[\\/]@getpaseo[\\/]server[\\/]/.exec(entry) : null;
  for (const cliIndex of [nested ? p.join(nested[1], "dist", "index.js") : null, sibling ? p.join(sibling[1], "@getpaseo", "cli", "dist", "index.js") : null]) {
    if (cliIndex && exists(cliIndex)) return { command: execPath, prefix: [cliIndex], env: {}, cliIndex, node: { command: execPath, env: {} } };
  }
  return platform === "win32" ? null : { command: "paseo", prefix: [], env: {} };
}
