import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Typed locally: the main tsconfig has React Native globals, not @types/node. */
const proc = (globalThis as unknown as {
  process: { execPath: string; platform: string; argv: string[]; env: Record<string, string | undefined> };
}).process;

export interface CliResult {
  /** null = could not start, or killed on timeout. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type CliRunner = (args: readonly string[], timeoutMs?: number) => Promise<CliResult>;

export interface CliCommand {
  readonly command: string;
  readonly prefix: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const ELECTRON_ENV = { ELECTRON_RUN_AS_NODE: "1", PASEO_NODE_ENV: "production" } as const;

/**
 * The Paseo CLI, without any shell (Windows never goes through cmd.exe). In order:
 * 1. Desktop app: the plugin subprocess is the app binary itself (Electron as Node), launched the way
 *    resources/bin/paseo(.cmd) does it. resources/ sits next to the binary on Windows and Linux, and in
 *    Paseo.app/Contents/Resources on macOS.
 * 2. npm/CLI daemon: the plugin subprocess runs node_modules/@getpaseo/server/.../plugin-process.js, so
 *    the CLI package is its sibling node_modules/@getpaseo/cli, run with the same Node.
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
      return {
        command: execPath,
        prefix: ["--disable-warning=DEP0040", runner, "node-script", p.join(asar, "node_modules", "@getpaseo", "cli", "dist", "index.js")],
        env: ELECTRON_ENV,
      };
    }
  }
  const m = entry ? /^(.*)[\\/]@getpaseo[\\/]server[\\/]/.exec(entry) : null;
  if (m) {
    const cli = p.join(m[1], "@getpaseo", "cli", "dist", "index.js");
    if (exists(cli)) return { command: execPath, prefix: [cli], env: {} };
  }
  return platform === "win32" ? null : { command: "paseo", prefix: [], env: {} };
}

const MAX_OUTPUT = 4 * 1024 * 1024;

export function createCliRunner(cli: CliCommand | null = resolveCli()): CliRunner | null {
  if (!cli) return null;
  return (args, timeoutMs = 120_000) =>
    new Promise<CliResult>((resolve) => {
      let out = "", err = "", done = false;
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout: out, stderr: err });
      };
      const child = spawn(cli.command, [...cli.prefix, ...args], {
        env: { ...proc.env, ...cli.env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8").on("data", (c: string) => { if (out.length < MAX_OUTPUT) out += c; });
      child.stderr.setEncoding("utf8").on("data", (c: string) => { if (err.length < MAX_OUTPUT) err += c; });
      const timer = setTimeout(() => { child.kill(); finish(null); }, timeoutMs);
      child.on("error", (e) => { err += String(e); finish(null); });
      child.on("close", (code) => finish(code));
    });
}
