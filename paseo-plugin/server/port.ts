import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import { type BusySessions, DEFAULT_BUSY_SESSIONS, DEFAULT_PORT, type swapperSettings, type SwapperSettings } from "../shared/contracts.ts";

type Schema = (typeof swapperSettings)["schema"];

/** Tracks one value of the host's settings; `fallback` when they are missing or invalid. */
function track<T>(settings: PluginSettings<Schema>, pick: (v: SwapperSettings) => T, fallback: T) {
  let value = fallback;
  const apply = (s: PluginSettingsState<Schema>) => {
    value = s.status === "ready" ? pick(s.values) : fallback;
  };
  const ready = settings.read().then(apply, () => undefined);
  const unsubscribe = settings.subscribe(apply);
  return {
    get: async (): Promise<T> => {
      await ready;
      return value;
    },
    dispose: unsubscribe,
  };
}

/** Tracks settings.localPort; falls back to 7373 when settings are missing or invalid. */
export const createPortSource = (settings: PluginSettings<Schema>) => track(settings, (v) => v.localPort, DEFAULT_PORT);

/** Tracks settings.busySessions; falls back to stopping and continuing. */
export const createBusySessionsSource = (settings: PluginSettings<Schema>) =>
  track<BusySessions>(settings, (v) => v.busySessions, DEFAULT_BUSY_SESSIONS);
