import type { PluginServerContext } from "@getpaseo/plugin/server";
import { autoRpc, stateRpc, swapRpc, swapperSettings, usageRpc } from "./shared/contracts.ts";
import { createActiveWatch } from "./server/active-watch.ts";
import { executePlan } from "./server/executor.ts";
import { createHandlers } from "./server/handlers.ts";
import { resolveCli } from "./server/paseo-cli.ts";
import { createPortSource } from "./server/port.ts";
import { createQuietRunner } from "./server/quiet-helper.ts";
import { createSessionRefresher } from "./server/session-refresh.ts";

/** Busy agents switch as soon as they are quiet; background work can finish without a new turn. */
const RECHECK_MS = 60_000;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(swapperSettings);
  const port = createPortSource(settings);
  const quiet = createQuietRunner(resolveCli());
  console.log(quiet
    ? "LLMswapper: tras un cambio de cuenta, cada sesión de Claude en Paseo se recargará cuando no tenga trabajo en marcha (ni en segundo plano)."
    : "LLMswapper: no se encontró el cliente de Paseo; las sesiones abiertas no se recargarán solas.");
  const refresher = createSessionRefresher({ quiet });
  // Account changes made outside the panel (LLMswapper's page, /swapper, its auto-rotation) reach open sessions too.
  const watch = createActiveWatch({
    getPort: port.get,
    exec: executePlan,
    onChange: () => void refresher.apply().catch(() => undefined),
  });
  const h = createHandlers(port.get, executePlan, Date.now, async (swap, budgetMs) => {
    if (swap.target !== "host") return null; // Paseo's Claude Code agents use this machine's own credentials
    watch.note(swap.accountId);
    return refresher.apply(budgetMs);
  });
  server.handle(stateRpc, h.state);
  server.handle(usageRpc, h.usage);
  server.handle(swapRpc, h.swap);
  server.handle(autoRpc, h.auto);
  const offTurn = server.on("agent.turn_ended", (event) => refresher.onTurnEnded(event.agent.id));
  const recheck = setInterval(() => void refresher.recheck().catch(() => undefined), RECHECK_MS);
  watch.start();
  return () => {
    clearInterval(recheck);
    watch.stop();
    offTurn();
    void port.dispose();
  };
}
