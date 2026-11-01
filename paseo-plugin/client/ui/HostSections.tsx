import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { Tone } from "../../shared/markers.ts";
import type { GlobalAuto } from "../../shared/panel.ts";
import type { AutoView, WarningView } from "../../shared/views.ts";
import { toneColor, type Styles } from "./theme.ts";

interface Base {
  readonly styles: Styles;
  readonly theme: PluginTheme;
}

/**
 * Only warnings that change what a swap does (overriding env var, broken mount, credential store, idle
 * auto-rotation...). Info notes ("Claude Code abierto") are shown in the swap dialog instead.
 */
export function CompactWarnings(p: Base & { warnings: readonly WarningView[] }) {
  const shown = p.warnings.filter((w) => w.level !== "info");
  if (shown.length === 0) return null;
  return (
    <View style={{ gap: 2 }}>
      {shown.map((w) => {
        const color = toneColor(p.theme, w.level === "danger" ? "danger" : "warning");
        return (
          <View key={w.code + w.message} style={p.styles.row} accessibilityRole="alert">
            <Icon name="TriangleAlert" size={11} color={color} />
            <Text style={[p.styles.tiny, { color, flex: 1 }]} numberOfLines={2}>{w.message}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** Auto-rotation as a small toggle pill. Turning it on asks for confirmation (caller), off is immediate. */
export function AutoPill(p: Base & { auto: AutoView | null; disabled: boolean; onToggle(next: boolean): void }) {
  if (!p.auto) return null;
  const on = p.auto.enabled;
  const color = on ? p.theme.colors.accent : p.theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled: p.disabled }}
      aria-checked={on}
      accessibilityLabel={`Rotación automática ${on ? "activada" : "desactivada"}, umbral ${p.auto.threshold} %${p.auto.next ? `, siguiente ${p.auto.next.label}` : ""}`}
      disabled={p.disabled}
      onPress={() => p.onToggle(!on)}
      style={[p.styles.pill, { borderColor: color }, p.disabled ? p.styles.disabled : null]}
    >
      <Icon name="Repeat2" size={10} color={color} />
      <Text style={[p.styles.tiny, { color }]}>{on ? `auto ${p.auto.threshold}%` : "auto"}</Text>
    </Pressable>
  );
}

/**
 * The panel's switch for automatic rotation on every device it shows: "auto" when all agree, "auto 2/5"
 * (dashed) when only some rotate. Turning it on asks for confirmation (caller), off is immediate.
 */
export function GlobalAutoPill(p: Base & { summary: GlobalAuto; busy: boolean; onPress(): void }) {
  const { total, on } = p.summary;
  const off = total === 0 || p.busy;
  const mixed = on > 0 && on < total;
  const color = on > 0 ? p.theme.colors.accent : p.theme.colors.foregroundMuted;
  const where = total === 1 ? "el equipo disponible" : `los ${total} equipos disponibles`;
  const skipped = p.summary.skipped ? `; ${p.summary.skipped === 1 ? "1 equipo sin conexión no cambia" : `${p.summary.skipped} equipos sin conexión no cambian`}` : "";
  const state = (total === 0 ? "sin equipos disponibles" : on === total ? `activada en ${where}` : on === 0 ? `desactivada en ${where}` : `activada en ${on} de ${total} equipos disponibles`) + skipped;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: mixed ? "mixed" : total > 0 && on === total, disabled: off, busy: p.busy }}
      aria-checked={total > 0 && on === total}
      accessibilityLabel={`Rotación automática ${state}`}
      accessibilityHint={total === 0 ? undefined : p.summary.turnOn ? "La activa en los equipos disponibles del panel" : "La desactiva en los equipos disponibles del panel"}
      disabled={off}
      onPress={p.onPress}
      style={[p.styles.pill, { borderColor: color }, mixed ? { borderStyle: "dashed" } : null, off && !p.busy ? p.styles.disabled : null]}
    >
      {p.busy ? <ActivityIndicator size="small" color={color} style={{ width: 10, height: 10, transform: [{ scale: 0.5 }] }} /> : <Icon name="Repeat2" size={10} color={color} />}
      <Text style={[p.styles.tiny, { color }]}>{mixed ? `auto ${on}/${total}` : "auto"}</Text>
    </Pressable>
  );
}

/** Icon-only button for headers. */
export function IconBtn(p: Base & { icon: string; label: string; onPress(): void; disabled?: boolean; busy?: boolean; expanded?: boolean }) {
  const off = p.disabled === true || p.busy === true;
  return (
    // aria-*: the desktop app (react-native-web) reads those, not accessibilityState
    <Pressable accessibilityRole="button" accessibilityLabel={p.label} accessibilityState={{ disabled: off, busy: p.busy === true, expanded: p.expanded }} aria-expanded={p.expanded}
      disabled={off} onPress={p.onPress} style={[p.styles.iconButton, off && !p.busy ? p.styles.disabled : null]}>
      {/* fixed 13x13 box: the animated spinner must not grow the header row */}
      <View style={{ width: 13, height: 13, alignItems: "center", justifyContent: "center" }}>
        {p.busy ? (
          <ActivityIndicator size="small" color={p.theme.colors.foregroundMuted} style={{ transform: [{ scale: 0.6 }] }} />
        ) : (
          <Icon name={p.icon} size={13} color={p.theme.colors.foregroundMuted} />
        )}
      </View>
    </Pressable>
  );
}

/** One-line message with an optional action and a close cross. */
export function InlineNotice(p: Base & {
  tone: Tone; text: string; action?: { label: string; onPress(): void }; onClose?: () => void;
}) {
  const color = toneColor(p.theme, p.tone);
  return (
    <View style={[p.styles.row, { gap: 6 }]} accessibilityRole="alert">
      <Icon name={p.tone === "success" ? "CircleCheck" : p.tone === "muted" ? "Info" : "TriangleAlert"} size={12} color={color} />
      <Text style={[p.styles.small, { color, flex: 1 }]} numberOfLines={3}>{p.text}</Text>
      {p.action ? (
        <Pressable accessibilityRole="button" onPress={p.action.onPress} style={[p.styles.pill, { borderColor: color }]}>
          <Text style={[p.styles.tiny, { color }]}>{p.action.label}</Text>
        </Pressable>
      ) : null}
      {p.onClose ? <IconBtn icon="X" label="Cerrar aviso" onPress={p.onClose} styles={p.styles} theme={p.theme} /> : null}
    </View>
  );
}
