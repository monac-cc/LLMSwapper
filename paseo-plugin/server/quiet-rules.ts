// Pure rules for "is this Claude Code session doing anything in the background?". Each function is
// self-contained (no imports, no outer references) because the helper that runs them next to the
// daemon embeds their source with Function.prototype.toString: what the tests check is what runs.

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly args: string;
  /** Epoch ms. */
  readonly startedAt: number;
}

/** `ps -axww -o pid=,ppid=,etime=,args=` (macOS and Linux); etime is [[dd-]hh:]mm:ss. */
export function parsePsOutput(text: string, now: number): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const secs = Number(m[3] || 0) * 86400 + Number(m[4] || 0) * 3600 + Number(m[5]) * 60 + Number(m[6]);
    const args = m[7].trim();
    const exe = args.split(/\s+/)[0] || "";
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: exe.split(/[\\/]/).pop() || exe, args, startedAt: now - secs * 1000 });
  }
  return out;
}

/** Windows: Get-CimInstance Win32_Process as JSON [{p, pp, n, s (ISO), c}]. */
export function parseWinProcs(json: string): Proc[] {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: Proc[] = [];
  for (const r of list as { p?: unknown; pp?: unknown; n?: unknown; s?: unknown; c?: unknown }[]) {
    const startedAt = r && typeof r.s === "string" ? Date.parse(r.s) : NaN;
    if (typeof r.p !== "number" || typeof r.pp !== "number" || !Number.isFinite(startedAt)) continue;
    out.push({ pid: r.p, ppid: r.pp, name: typeof r.n === "string" ? r.n : "", args: typeof r.c === "string" ? r.c : "", startedAt });
  }
  return out;
}

export interface SessionWork {
  /** The Claude Code processes looked at: the session's own, or (`owned` false) the ones no live agent claims. */
  readonly roots: number[];
  readonly owned: boolean;
  /** Live background work under those roots. */
  readonly late: Proc[];
  /** Paseo runs this session through something that is not Claude Code (`wsl -e claude`, docker, ssh): its work is out of sight. */
  readonly foreign: boolean;
}

/**
 * Live background work of the Claude Code session `sessionId`, among the Claude Code processes Paseo
 * started: children of an ancestor of `selfPid` (the helper, so the daemon), directly or through the
 * cmd.exe that runs an npm `claude.cmd` on Windows.
 *
 * Work is what Claude Code runs through a shell: every Bash/Monitor call goes through its shell-snapshot
 * wrapper and every PowerShell call through its launcher script (both counted at any age), and any other
 * shell started more than `graceMs` after the session's process. Everything under such a shell is work
 * too. Other children (MCP and LSP servers, the console host) are not: they live as long as the session.
 *
 * A process says whose it is with --resume/--session-id <id>. A brand-new agent's first process carries
 * neither, and Paseo can take a new session id without restarting the process. So when the session has
 * no process of its own, the processes no live agent claims (`claimed`: every agent's session id) stand
 * in for it: their work cannot be told apart, and waiting is the safe side.
 */
export function sessionWork(procs: readonly Proc[], sessionId: string, claimed: readonly string[], selfPid: number, graceMs = 10_000): SessionWork {
  const byPid = new Map<number, Proc>();
  const children = new Map<number, Proc[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    const list = children.get(p.ppid);
    if (list) list.push(p); else children.set(p.ppid, [p]);
  }
  // pid 1 included: a daemon can be a container's entrypoint.
  const owners = new Set<number>();
  for (let p = byPid.get(selfPid), hops = 0; p && p.ppid >= 1 && !owners.has(p.ppid) && hops < 64; p = byPid.get(p.ppid), hops++) owners.add(p.ppid);
  // The native binary, or Node running Claude Code's cli.js ("C:\Program Files\nodejs\node.exe" "...\claude-code\cli.js").
  const isClaude = (p: Proc) => /claude/i.test(p.name) || /claude/i.test((p.args.match(/"[^"]*"|\S+/g) ?? []).slice(0, 2).join(" "));
  const isCmd = (p: Proc) => /^cmd(\.exe)?$/i.test(p.name);
  const sidOf = (p: Proc) => (/--(?:resume|session-id)[= ]"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(p.args) ?? [])[1]?.toLowerCase() ?? null;
  const direct = procs.filter((p) => owners.has(p.ppid));
  const claudes: Proc[] = [];
  const launchers = new Set<number>();
  for (const p of direct) {
    if (isClaude(p)) { claudes.push(p); continue; }
    if (!isCmd(p)) continue;
    for (const c of children.get(p.pid) ?? []) if (isClaude(c) && c.startedAt + 2000 >= p.startedAt) { claudes.push(c); launchers.add(p.pid); }
  }
  const sid = sessionId.toLowerCase();
  const own = sid ? claudes.filter((p) => sidOf(p) === sid) : [];
  const foreign = !!sid && !own.length && direct.some((p) => !launchers.has(p.pid) && !isClaude(p) && sidOf(p) === sid);
  const known = new Set(claimed.map((c) => c.toLowerCase()));
  const roots = own.length ? own : claudes.filter((p) => { const s = sidOf(p); return !s || !known.has(s); });
  const isShell = (p: Proc) => /^-?(?:bash|sh|zsh|dash|fish|ksh|tcsh|csh|pwsh|powershell|cmd)(?:\.exe)?$/i.test(p.name);
  const isWrapped = (p: Proc) => /shell-snapshots|CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT|__claudeCodeScript/.test(p.args);
  const late: Proc[] = [];
  const seen = new Set<number>();
  for (const root of roots) {
    seen.add(root.pid);
    const stack: [Proc, boolean][] = [[root, false]];
    while (stack.length) {
      const [parent, parentWork] = stack.pop() as [Proc, boolean];
      for (const c of children.get(parent.pid) ?? []) {
        // A child cannot predate its parent: that is a reused pid (Windows keeps dead parents' ids).
        if (seen.has(c.pid) || c.startedAt + 2000 < parent.startedAt) continue;
        seen.add(c.pid);
        const work = parentWork || isWrapped(c) || (isShell(c) && c.startedAt - root.startedAt > graceMs);
        if (work && !/^conhost(\.exe)?$/i.test(c.name)) late.push(c);
        stack.push([c, work]);
      }
    }
  }
  return { roots: roots.map((p) => p.pid), owned: own.length > 0, late, foreign };
}
