import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostSummary } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { Btn } from "./primitives.tsx";
import type { Styles } from "./theme.ts";

/**
 * Which devices the panel shows (the gear in its header). A device left unticked disappears from the panel and
 * is not read until it is ticked again; this one always shows. Kept in the settings, like «Ocultar en el panel».
 */
export function DevicesDialog(p: {
  open: boolean; onClose(): void; hosts: readonly PluginHostSummary[]; localId: string;
  hidden(serverId: string): boolean; onToggle(serverId: string): void; styles: Styles; theme: PluginTheme;
}) {
  const { styles, theme } = p;
  const shown = p.hosts.filter((h) => h.serverId === p.localId || !p.hidden(h.serverId)).length;
  return (
    <Modal title="Dispositivos del panel" open={p.open} onOpenChange={(open) => { if (!open) p.onClose(); }}>
      <Modal.Content>
        <Text style={styles.muted}>
          {`Marca los que quieres ver (${shown} de ${p.hosts.length}). Los que desmarques desaparecen del panel y no se leen hasta que vuelvas a marcarlos.`}
        </Text>
        <View style={{ gap: 2 }}>
          {p.hosts.map((h) => {
            const local = h.serverId === p.localId;
            const on = local || !p.hidden(h.serverId);
            const online = local || h.status === "online";
            const color = on ? theme.colors.accent : theme.colors.foregroundMuted;
            return (
              <Pressable key={h.serverId} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: local }} aria-checked={on}
                accessibilityLabel={local ? `${h.label}, este equipo: siempre visible` : `Mostrar ${h.label} en el panel`}
                disabled={local} onPress={() => p.onToggle(h.serverId)}
                style={[styles.row, { gap: 8, paddingVertical: 6 }]}>
                <Icon name={on ? "SquareCheck" : "Square"} size={16} color={color} />
                <View style={[styles.dot, { backgroundColor: online ? theme.colors.statusSuccess : theme.colors.foregroundMuted }]} />
                <Text style={[styles.text, { flexShrink: 1 }]} numberOfLines={1}>{h.label}</Text>
                {local ? <Text style={styles.tiny}>este equipo</Text> : null}
              </Pressable>
            );
          })}
        </View>
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <Btn label="Hecho" primary onPress={p.onClose} styles={styles} theme={theme} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
