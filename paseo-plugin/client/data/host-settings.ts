import { useSettings } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { swapperSettings, type HostEntry, type SwapperSettings } from "../../shared/contracts.ts";
import { mergeHostEntry, panelFlag, pendingFlags, withFlags, type FlagOverrides, type PanelFlag } from "../../shared/panel.ts";

export { mergeHostEntry } from "../../shared/panel.ts";

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

/**
 * What the panel keeps per device: folded, hidden. A toggle shows at once and is kept in the settings document,
 * so it survives a restart and follows this host's panel to every client. A local toggle only overrides the document until the
 * document says the same (saved here, or by another client); after that, a change made elsewhere shows.
 * Toggles in quick succession go out in one save; one that loses to another client's save is retried on the
 * newer revision; one that fails otherwise is not retried until something changes, and the fold still holds
 * for this session. A toggle made right before the panel closes is still written.
 */
/** Toggles a panel left unsaved when it closed (a save was in flight): the next panel saves them. */
let carried: FlagOverrides = {};

export function usePanelFlags() {
  const settings = useSettings(swapperSettings);
  const [overrides, setOverrides] = useState<FlagOverrides>(() => carried);
  const latest = useRef(overrides);
  latest.current = overrides;
  useEffect(() => { carried = {}; }, []); // taken over by this panel
  const values = settings.status === "ready" ? settings.values : null;
  const revision = settings.status === "ready" ? settings.revision : null;
  const failed = useRef<{ revision: string; overrides: FlagOverrides } | null>(null);
  const armed = useRef<{ next: SwapperSettings; revision: string } | null>(null);
  const save = useRef(settings.save);
  save.current = settings.save;
  useEffect(() => {
    armed.current = null;
    if (!values || revision === null || settings.saving) return;
    const pending = pendingFlags(values, overrides);
    if (pending !== overrides) return setOverrides(pending);
    if (failed.current?.revision === revision && failed.current.overrides === overrides) return;
    const next = withFlags(values, overrides);
    if (!next) return;
    armed.current = { next, revision };
    const timer = setTimeout(() => {
      armed.current = null;
      void save.current(next, revision).then((ok) => { failed.current = ok ? null : { revision, overrides }; });
    }, 400);
    return () => clearTimeout(timer);
  }, [overrides, revision, settings.saving]); // values change with revision
  useEffect(() => () => {
    const a = armed.current;
    if (a) void save.current(a.next, a.revision);
    else if (Object.keys(latest.current).length) carried = latest.current; // not saved yet: the next panel does it
  }, []);
  const get = (serverId: string, flag: PanelFlag) => panelFlag(values, overrides, serverId, flag);
  return {
    collapsed: (serverId: string) => get(serverId, "collapsed"),
    hidden: (serverId: string) => get(serverId, "hidden"),
    toggle: (serverId: string, flag: PanelFlag) =>
      setOverrides((o) => ({ ...o, [serverId]: { ...o[serverId], [flag]: !panelFlag(values, o, serverId, flag) } })),
  };
}
