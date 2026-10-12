// Main tsconfig only (React Native globals, no @types/node): the few Node APIs server/paseo-cli.ts uses.
// tsconfig.test.json checks the same file against the real @types/node.
declare module "node:child_process" {
  interface Stream {
    setEncoding(encoding: string): Stream;
    on(event: "data", listener: (chunk: string) => void): Stream;
  }
  interface ChildProcess {
    readonly stdout: Stream;
    readonly stderr: Stream;
    kill(): boolean;
    on(event: "error", listener: (error: Error) => void): ChildProcess;
    on(event: "close", listener: (code: number | null) => void): ChildProcess;
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: { env?: Record<string, string | undefined>; windowsHide?: boolean; stdio?: readonly string[] },
  ): ChildProcess;
}
declare module "node:fs" {
  const fs: { existsSync(path: string): boolean };
  export default fs;
}
declare module "node:path" {
  interface PathApi { join(...parts: string[]): string; dirname(path: string): string }
  const path: PathApi & { readonly win32: PathApi; readonly posix: PathApi };
  export default path;
}
