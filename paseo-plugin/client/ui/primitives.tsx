import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { ActivityIndicator, Pressable, Text } from "react-native";
import type { Styles } from "./theme.ts";

interface Base {
  readonly styles: Styles;
  readonly theme: PluginTheme;
}

export function Btn(p: Base & {
  label: string; onPress(): void; icon?: string; primary?: boolean; disabled?: boolean; busy?: boolean; accessibilityLabel?: string;
}) {
  const off = p.disabled === true || p.busy === true;
  const color = p.primary ? p.theme.colors.accentForeground : p.theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={p.accessibilityLabel ?? p.label}
      accessibilityState={{ disabled: off, busy: p.busy === true }}
      disabled={off}
      onPress={p.onPress}
      style={[p.styles.button, p.primary ? p.styles.buttonPrimary : null, off ? p.styles.disabled : null]}
    >
      {p.busy ? <ActivityIndicator size="small" color={color} /> : p.icon ? <Icon name={p.icon} size={14} color={color} /> : null}
      <Text style={[p.styles.buttonText, p.primary ? p.styles.buttonPrimaryText : null]}>{p.label}</Text>
    </Pressable>
  );
}
