import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import { DEFAULT_PORT, type swapperSettings } from "../shared/contracts.ts";

type Schema = (typeof swapperSettings)["schema"];

/** Tracks settings.localPort; falls back to 7373 when settings are missing or invalid. */
export function createPortSource(settings: PluginSettings<Schema>) {
  let port = DEFAULT_PORT;
  const apply = (s: PluginSettingsState<Schema>) => {
    port = s.status === "ready" ? s.values.localPort : DEFAULT_PORT;
  };
  const ready = settings.read().then(apply, () => undefined);
  const unsubscribe = settings.subscribe(apply);
  return {
    get: async (): Promise<number> => {
      await ready;
      return port;
    },
    dispose: unsubscribe,
  };
}
