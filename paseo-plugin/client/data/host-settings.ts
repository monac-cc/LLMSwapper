import { useSettings } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { DEFAULT_HOST_ENTRY, swapperSettings, type HostEntry } from "../../shared/contracts.ts";

/**
 * Merge a patch into one device's entry. A key patched to `undefined` is REMOVED: the app's save()
 * runs z.json() on the document, which rejects present-but-undefined values, so they must never reach it.
 */
export function mergeHostEntry(stored: HostEntry | undefined, patch: Partial<HostEntry> = {}): HostEntry {
  const merged: Record<string, unknown> = { ...DEFAULT_HOST_ENTRY, ...stored, ...patch };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged as HostEntry;
}

/** Patch one device's entry in the settings document (needs daemon.manage, like every plugin call). */
export function useHostEntryUpdater() {
  const settings = useSettings(swapperSettings);
  const update = useCallback(
    async (serverId: string, patch: Partial<HostEntry>): Promise<boolean> => {
      if (settings.status !== "ready") return false;
      const v = settings.values;
      return settings.save({ ...v, hosts: { ...v.hosts, [serverId]: mergeHostEntry(v.hosts[serverId], patch) } }, settings.revision);
    },
    [settings],
  );
  return { ready: settings.status === "ready", status: settings.status, saving: settings.saving, saveError: settings.saveError, update };
}
