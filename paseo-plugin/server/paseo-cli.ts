import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Typed locally: the main tsconfig has React Native globals, not @types/node. */
const proc = (globalThis as unknown as {
  process: { execPath: string; platform: string; env: Record<string, string | undefined> };
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

/**
 * The Paseo CLI, launched the way the desktop app's resources\bin\paseo.cmd does it but WITHOUT cmd.exe:
 * the plugin subprocess is Paseo.exe itself (Electron as Node), so its execPath sits next to resources/.
 * Elsewhere (CLI/npm installs on Linux or macOS) `paseo` from PATH. Windows never goes through a shell.
 */
export function resolveCli(execPath = proc.execPath, platform = proc.platform, exists: (p: string) => boolean = fs.existsSync): CliCommand | null {
  const resources = path.join(path.dirname(execPath), "resources");
  const runner = path.join(resources, "app.asar.unpacked", "dist", "daemon", "node-entrypoint-runner.js");
  const asar = path.join(resources, "app.asar");
  if (exists(runner) && exists(asar)) {
    return {
      command: execPath,
      prefix: ["--disable-warning=DEP0040", runner, "node-script", path.join(asar, "node_modules", "@getpaseo", "cli", "dist", "index.js")],
      env: { ELECTRON_RUN_AS_NODE: "1", PASEO_NODE_ENV: "production" },
    };
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
