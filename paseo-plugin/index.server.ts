import type { PluginServerContext } from "@getpaseo/plugin/server";
import { autoRpc, stateRpc, swapRpc, swapperSettings, usageRpc } from "./shared/contracts.ts";
import { createActiveWatch } from "./server/active-watch.ts";
import { executePlan } from "./server/executor.ts";
import { createHandlers } from "./server/handlers.ts";
import { createCliRunner } from "./server/paseo-cli.ts";
import { createPortSource } from "./server/port.ts";
import { createSessionRefresher } from "./server/session-refresh.ts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(swapperSettings);
  const port = createPortSource(settings);
  const cli = createCliRunner();
  console.log(cli
    ? "LLMswapper: tras un cambio de cuenta en este equipo se recargarán sus sesiones de Claude en Paseo."
    : "LLMswapper: no se encontró la CLI de Paseo; las sesiones abiertas no se recargarán solas.");
  const refresher = createSessionRefresher({ cli });
  // Account changes made outside the panel (LLMswapper's page, /swapper, its auto-rotation) reach open sessions too.
  const watch = createActiveWatch({
    getPort: port.get,
    exec: executePlan,
    onChange: () => void refresher.apply().catch(() => undefined),
  });
  const h = createHandlers(port.get, executePlan, Date.now, async (swap) => {
    if (swap.target !== "host") return null; // Paseo's Claude Code agents use this machine's own credentials
    watch.note(swap.accountId);
    return refresher.apply();
  });
  server.handle(stateRpc, h.state);
  server.handle(usageRpc, h.usage);
  server.handle(swapRpc, h.swap);
  server.handle(autoRpc, h.auto);
  const offTurn = server.on("agent.turn_ended", (event) => refresher.onTurnEnded(event.agent.id));
  watch.start();
  return () => {
    watch.stop();
    offTurn();
    void port.dispose();
  };
}
