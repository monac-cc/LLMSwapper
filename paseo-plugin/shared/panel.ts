import { DEFAULT_HOST_ENTRY, type HostEntry, type SwapperSettings } from "./contracts.ts";
import type { AutoView } from "./views.ts";

/**
 * Merge a patch into one device's entry. A key patched to `undefined` is REMOVED: the app's save()
 * runs z.json() on the document, which rejects present-but-undefined values, so they must never reach it.
 */
export function mergeHostEntry(stored: HostEntry | undefined, patch: Partial<HostEntry> = {}): HostEntry {
  const merged: Record<string, unknown> = { ...DEFAULT_HOST_ENTRY, ...stored, ...patch };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged as HostEntry;
}

export interface AutoHost {
  readonly id: string;
  readonly label: string;
  readonly auto: AutoView | null;
  /** Shown in the panel, opted in, online and with its state read: a switch there would be obeyed. */
  readonly usable: boolean;
}

export interface GlobalAuto {
  /** Devices the switch acts on. */
  readonly total: number;
  /** Of those, how many rotate automatically now. */
  readonly on: number;
  /** What pressing the switch does: turn rotation on where it is off, or (all on) off everywhere. */
  readonly turnOn: boolean;
  /** The devices pressing it changes. */
  readonly targets: readonly AutoHost[];
  /** Devices with rotation it cannot reach now (offline, not read yet...): left as they are. */
  readonly skipped: number;
}

/** The panel's one switch for automatic rotation on every device it shows. Pure (unit-tested). */
export function globalAuto(hosts: readonly AutoHost[]): GlobalAuto {
  const usable = hosts.filter((h): h is AutoHost & { auto: AutoView } => h.usable && h.auto !== null);
  const on = usable.filter((h) => h.auto.enabled).length;
  const turnOn = on < usable.length;
  const skipped = hosts.filter((h) => !h.usable && h.auto !== null).length;
  return { total: usable.length, on, turnOn, targets: usable.filter((h) => h.auto.enabled !== turnOn), skipped };
}

/** What the panel itself keeps per device in the settings document. */
export type PanelFlag = "collapsed" | "hidden";
/** Panel toggles made here and not yet in the document, per device. */
export type FlagOverrides = Readonly<Record<string, Readonly<Partial<Record<PanelFlag, boolean>>>>>;

const stored = (values: SwapperSettings, serverId: string, flag: PanelFlag): boolean => values.hosts[serverId]?.[flag] ?? false;

/** A device's flag as the panel shows it: what was just toggled here, else what the settings say. */
export function panelFlag(settings: SwapperSettings | null, overrides: FlagOverrides, serverId: string, flag: PanelFlag): boolean {
  return overrides[serverId]?.[flag] ?? settings?.hosts[serverId]?.[flag] ?? false;
}

/**
 * The toggles the document does not say yet. Once it does (saved here, or by another client), a toggle stops
 * overriding it, so a later change made elsewhere shows. The same object when nothing is dropped.
 */
export function pendingFlags(values: SwapperSettings, overrides: FlagOverrides): FlagOverrides {
  let dropped = false;
  const out: Record<string, Partial<Record<PanelFlag, boolean>>> = {};
  for (const [id, flags] of Object.entries(overrides)) {
    const keep = (Object.entries(flags) as [PanelFlag, boolean][]).filter(([flag, on]) => stored(values, id, flag) !== on);
    if (keep.length !== Object.keys(flags).length) dropped = true;
    if (keep.length) out[id] = Object.fromEntries(keep);
  }
  return dropped ? out : overrides;
}

/** The settings document with the panel's toggles applied; null when it already says so. Pure (unit-tested). */
export function withFlags(values: SwapperSettings, overrides: FlagOverrides): SwapperSettings | null {
  const hosts = { ...values.hosts };
  let changed = false;
  for (const [id, flags] of Object.entries(overrides)) {
    const patch = Object.fromEntries((Object.entries(flags) as [PanelFlag, boolean][]).filter(([flag, on]) => stored(values, id, flag) !== on));
    if (!Object.keys(patch).length) continue;
    hosts[id] = mergeHostEntry(hosts[id], patch);
    changed = true;
  }
  return changed ? { ...values, hosts } : null;
}

/** Two documents that differ at most in what the panel sets (folded and hidden devices). */
export function sameIgnoringPanel(a: SwapperSettings, b: SwapperSettings): boolean {
  const { hosts: ha, ...ra } = a;
  const { hosts: hb, ...rb } = b;
  const top = new Set([...Object.keys(ra), ...Object.keys(rb)]) as Set<keyof typeof ra>;
  for (const k of top) if (JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) return false;
  for (const id of new Set([...Object.keys(ha), ...Object.keys(hb)])) {
    const x = mergeHostEntry(ha[id], { collapsed: false, hidden: false }), y = mergeHostEntry(hb[id], { collapsed: false, hidden: false });
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]) as Set<keyof typeof x>;
    for (const k of keys) if (x[k] !== y[k]) return false;
  }
  return true;
}

/**
 * A settings draft carried over to `values` (seeded from `base`): it takes the panel's toggles from `values`,
 * except a device's "hidden" that the draft itself changed (the settings form edits that one too).
 */
export function withPanelFlagsOf(draft: SwapperSettings, values: SwapperSettings, base: SwapperSettings): SwapperSettings {
  const hosts = { ...draft.hosts };
  for (const id of new Set([...Object.keys(draft.hosts), ...Object.keys(values.hosts)])) {
    const collapsed = stored(values, id, "collapsed");
    const hidden = stored(draft, id, "hidden") !== stored(base, id, "hidden") ? stored(draft, id, "hidden") : stored(values, id, "hidden");
    if (stored(draft, id, "collapsed") !== collapsed || stored(draft, id, "hidden") !== hidden) hosts[id] = mergeHostEntry(hosts[id], { collapsed, hidden });
  }
  return { ...draft, hosts };
}
