import type { PluginTheme } from "@getpaseo/plugin";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { formatCountdown, formatPercent } from "../../shared/format.ts";
import { accountMarkers, metersFor } from "../../shared/markers.ts";
import type { AccountView, BriefView, TargetView, UsageEntryView } from "../../shared/views.ts";
import { MiniBars } from "./MiniBars.tsx";
import { toneColor, type Styles } from "./theme.ts";

/** One account as a small tile: name, where it is active, 5 h / 7 d bars. Press = choose where to use it. */
export function AccountTile(p: {
  account: AccountView; targets: readonly TargetView[]; usage: UsageEntryView | undefined; brief: BriefView | undefined;
  /** Nothing to offer (host locked, or active everywhere it could go): the tile is not pressable. */
  disabled: boolean; pending: boolean; onPress(): void;
  now: number; styles: Styles; theme: PluginTheme;
}) {
  const { account: a, styles, theme, now } = p;
  const meters = metersFor(p.usage, p.brief);
  const activeIn = p.targets.filter((t) => t.activeId === a.id);
  const stale = p.usage?.kind === "ok" && p.usage.stale !== null;
  // Only what needs attention fits in a tile; the full list stays in the accessibility label.
  const markers = accountMarkers(a, p.usage, now);
  const alert = markers.find((m) => m.tone === "danger") ?? markers.find((m) => m.tone === "warning");
  const describe = (label: string, pct: number | null, resetsAt: number | null | undefined) =>
    `${label} ${formatPercent(pct)}${resetsAt ? `, reinicio ${formatCountdown(resetsAt, now)}` : ""}`;
  const a11y = [
    a.label,
    activeIn.length ? `en uso en ${activeIn.map((t) => t.label).join(" y ")}` : null,
    describe("5 horas", meters.session?.percent ?? null, meters.session?.resetsAt),
    describe("7 días", meters.weekly?.percent ?? null, meters.weekly?.resetsAt),
    ...markers.map((m) => m.label),
  ].filter(Boolean).join(". ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={p.disabled ? undefined : "Elegir en qué entorno usar esta cuenta"}
      accessibilityState={{ disabled: p.disabled, busy: p.pending }}
      disabled={p.disabled || p.pending}
      onPress={p.onPress}
      style={({ pressed }) => [
        styles.tile,
        activeIn.length ? { borderColor: theme.colors.accent } : null,
        pressed ? { opacity: 0.75 } : null,
      ]}
    >
      {/* spinner outside the name's width budget, so long names never push past the border */}
      {p.pending ? (
        <View pointerEvents="none" style={{ position: "absolute", top: 4, left: 4, transform: [{ scale: 0.7 }] }}>
          <ActivityIndicator size="small" color={theme.colors.accent} />
        </View>
      ) : null}
      <Text style={[styles.tileName, { maxWidth: "100%" }]} numberOfLines={1}>{a.label}</Text>
      <View style={styles.tileBadges}>
        {activeIn.map((t) => (
          <View key={t.id} style={[styles.tileBadge, { borderColor: theme.colors.accent }]}>
            <Text style={[styles.tileBadgeText, { color: theme.colors.accent }]}>{t.label}</Text>
          </View>
        ))}
      </View>
      <MiniBars session={meters.session} weekly={meters.weekly} dim={meters.cached || stale} now={now} styles={styles} theme={theme} />
      {alert ? (
        <Text style={[styles.tiny, { color: toneColor(theme, alert.tone), textAlign: "center" }]} numberOfLines={1}>{alert.label}</Text>
      ) : null}
    </Pressable>
  );
}
