import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SettingsScreen } from "./client/SettingsScreen.tsx";
import { Dashboard } from "./client/ui/Dashboard.tsx";

const PANEL_ID = "swapper";
const SCREEN_ID = "swapper";
const ICON = "ArrowLeftRight"; // confirmed in the app's lucide bundle; unknown names throw on contributions

function SwapperPanel({ theme, layout, host }: PluginWorkspacePanelProps) {
  return <Dashboard theme={theme} layout={layout} host={host} variant="panel" />;
}

function SwapperScreen({ theme, layout, host }: PluginScreenProps) {
  // Paseo draws the screen header; keep our own toolbar for "Actualizar todo".
  return <Dashboard theme={theme} layout={layout} host={host} variant="screen" />;
}

function SwapperSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow icon={ICON} label="LLMswapper" active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })} />
  );
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addWorkspacePanel({
      id: PANEL_ID, title: "LLMswapper", icon: ICON, context: "workspace",
      locations: ["workspace", "explorer"], Component: SwapperPanel,
    }),
    client.addScreen({ id: SCREEN_ID, title: "LLMswapper", Component: SwapperScreen }),
    client.addSidebarHeaderItem({ id: "swapper", title: "LLMswapper", Component: SwapperSidebarItem }),
    client.addSettingsScreen({ id: "settings", title: "LLMswapper", icon: "ServerCog", Component: SettingsScreen }),
    client.addCommandCenterItem({
      id: "swapper-open-panel", title: "LLMswapper: abrir panel", icon: ICON,
      keywords: ["llmswapper", "swapper", "cuenta", "claude"], context: "workspace",
      onSelect: (ctx) => ctx.openPanel(PANEL_ID),
    }),
    client.addCommandCenterItem({
      id: "swapper-open-explorer", title: "LLMswapper: abrir en el Explorer (derecha)", icon: ICON,
      keywords: ["llmswapper", "swapper", "explorer"], context: "workspace",
      onSelect: (ctx) => ctx.openPanel(PANEL_ID, { location: "explorer" }),
    }),
    client.addCommandCenterItem({
      id: "swapper-open-screen", title: "LLMswapper: pantalla completa", icon: ICON,
      keywords: ["llmswapper", "swapper"], context: "global",
      onSelect: (ctx) => ctx.openScreen({ screenId: SCREEN_ID }),
    }),
    // NOT "/swapper": LLMswapper ships a Claude Code skill with that name, and provider commands win.
    client.addSlashCommand({
      name: "llmswapper", description: "Abrir el panel de LLMswapper", argumentHint: "[explorer]", context: "workspace",
      onSubmit: (ctx) => ctx.openPanel(PANEL_ID, ctx.args.trim() === "explorer" ? { location: "explorer" } : undefined),
    }),
  ];
  return async () => {
    for (const c of cleanups.reverse()) await c();
  };
}
