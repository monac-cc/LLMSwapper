import { BridgeError } from "./errors.ts";

/** Fields of PaseoWorkspace the bridge uses (the SDK descriptor satisfies this structurally). */
export interface WorkspaceLike {
  readonly id: string;
  readonly name: string;
  readonly projectDisplayName: string;
  readonly workspaceDirectory?: string;
  readonly workspaceKind: string;
  readonly archivingAt?: string | null;
  readonly activityAt: string | null;
}

export interface WorkspaceLister {
  list(options: { page: { limit: number; cursor?: string } }): Promise<{
    entries: readonly WorkspaceLike[];
    pageInfo: { hasMore: boolean; nextCursor: string | null };
  }>;
}

export interface BridgeWorkspace {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly label: string;
}

const KIND_RANK: Record<string, number> = { directory: 0, local_checkout: 1, checkout: 2, worktree: 3 };
const activity = (w: WorkspaceLike): number => (w.activityAt ? Date.parse(w.activityAt) || 0 : 0);

/**
 * Usable workspaces, best bridge owner first. Every standalone terminal opens a background tab in any
 * client currently showing its workspace, so prefer plain directories and the LEAST recently active one.
 */
export async function listBridgeWorkspaces(api: WorkspaceLister, maxPages = 5): Promise<BridgeWorkspace[]> {
  const all: WorkspaceLike[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await api.list({ page: cursor ? { limit: 200, cursor } : { limit: 200 } });
    for (const w of page.entries) if (w.workspaceDirectory && !w.archivingAt) all.push(w);
    cursor = page.pageInfo.hasMore && page.pageInfo.nextCursor ? page.pageInfo.nextCursor : undefined;
    if (!cursor) break;
  }
  return all
    .sort((a, b) => (KIND_RANK[a.workspaceKind] ?? 9) - (KIND_RANK[b.workspaceKind] ?? 9) || activity(a) - activity(b))
    .map((w) => ({ workspaceId: w.id, cwd: w.workspaceDirectory ?? "", label: `${w.projectDisplayName} · ${w.name}` }));
}

/** Cached per host for a short while: workspaces come and go, and Settings can pick a new one any time. */
export const WORKSPACE_CACHE_TTL_MS = 5 * 60_000;
interface CacheEntry {
  readonly list: BridgeWorkspace[];
  readonly at: number;
  /** Preferred id already looked up in a FRESH list without success (no re-list on every run). */
  readonly missing?: string;
}
const cache = new Map<string, CacheEntry>();
export const forgetWorkspaces = (serverId: string): void => void cache.delete(serverId);

export interface WorkspaceChoice {
  readonly candidates: BridgeWorkspace[];
  /** The workspace configured in Settings is not (or no longer) usable on that host: automatic order used. */
  readonly preferredMissing: boolean;
}

/** Candidates for one run: the configured workspace (if usable) first, then the automatic order. */
export async function resolveWorkspaces(
  api: WorkspaceLister, serverId: string, preferredId?: string, now: number = Date.now(),
): Promise<WorkspaceChoice> {
  const hit = cache.get(serverId);
  let entry = hit && now - hit.at >= 0 && now - hit.at < WORKSPACE_CACHE_TTL_MS ? hit : undefined;
  // Picked in Settings after this list was cached: list again before ignoring the user's choice.
  if (entry && preferredId && entry.missing !== preferredId && !entry.list.some((w) => w.workspaceId === preferredId)) entry = undefined;
  if (!entry) {
    const list = await listBridgeWorkspaces(api);
    const missing = preferredId && !list.some((w) => w.workspaceId === preferredId) ? preferredId : undefined;
    entry = { list, at: now, missing };
    if (list.length > 0) cache.set(serverId, entry);
    else cache.delete(serverId);
  }
  const list = entry.list;
  if (list.length === 0) {
    throw new BridgeError("no_workspace", "Ese equipo no tiene ningún workspace abierto en Paseo.");
  }
  const preferred = preferredId ? list.find((w) => w.workspaceId === preferredId) : undefined;
  return {
    candidates: preferred ? [preferred, ...list.filter((w) => w !== preferred)] : list,
    preferredMissing: Boolean(preferredId) && !preferred,
  };
}

/** POSIX vs Windows host, from the workspace path shape (the only OS signal available before spawning). */
export const isWindowsPath = (cwd: string): boolean => /^[A-Za-z]:[\\/]|^\\\\/.test(cwd);
