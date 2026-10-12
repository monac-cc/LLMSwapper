import type { PluginTheme } from "@getpaseo/plugin";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { formatCountdown, formatPercent, formatPercentShort, formatShortCountdown } from "../../shared/format.ts";
import { accountMarkers, metersFor } from "../../shared/markers.ts";
import { SESSION_WINDOW_MS, WEEKLY_WINDOW_MS, elapsedPercent, paceTone, type PaceTone } from "../../shared/pace.ts";
import type { AccountView, BriefView, MeterView, TargetView, UsageEntryView } from "../../shared/views.ts";
import { seriesColors, toneColor, type Styles } from "./theme.ts";

function paceColor(theme: PluginTheme, tone: PaceTone, series: string): string {
  if (tone === "exhausted") return theme.colors.statusDanger;
  if (tone === "ahead") return theme.colors.statusWarning;
  if (tone === "unknown") return theme.colors.foregroundMuted;
  return series;
}

/** A reading whose window has reset since it was taken says nothing about the new window. */
const live = (m: MeterView | null, now: number): MeterView | null =>
  m && !(m.resetsAt !== null && m.resetsAt <= now) ? m : null;

/** One thin horizontal meter: fill = usage, tick = share of the window's time already gone. */
function HBar(p: { meter: MeterView | null; windowMs: number; series: string; dim: boolean; now: number; styles: Styles; theme: PluginTheme }) {
  const c = p.theme.colors;
  const meter = live(p.meter, p.now);
  const reset = meter?.resetsAt ?? null;
  const raw = meter?.percent ?? null;
  // One value for the label AND its colour: a "95%" is always red, a "0%" never shows a sliver.
  const shown = raw === null ? null : Math.round(raw);
  const elapsed = elapsedPercent(reset, p.windowMs, p.now);
  const tone = paceTone(shown, elapsed);
  const width = shown === null || shown <= 0 ? 0 : Math.min(100, Math.max(2, raw ?? 0));
  return (
    <View style={p.styles.lineBarRow}>
      <View style={p.styles.lineTrack}>
        {width > 0 ? (
          <View style={{ width: `${width}%`, height: "100%", borderRadius: 2, opacity: p.dim ? 0.55 : 1,
            backgroundColor: tone === "exhausted" ? c.statusDanger : p.series }} />
        ) : null}
        {elapsed !== null ? (
          <View pointerEvents="none" style={{ position: "absolute", top: -2, bottom: -2, width: 1, left: `${elapsed}%`, backgroundColor: c.foregroundMuted, opacity: 0.8 }} />
        ) : null}
      </View>
      <Text style={[p.styles.linePct, { color: paceColor(p.theme, tone, p.series) }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>{formatPercentShort(shown)}</Text>
      <Text style={p.styles.lineReset} numberOfLines={1} maxFontSizeMultiplier={1.2}>{formatShortCountdown(reset, p.now)}</Text>
    </View>
  );
}

/** One account as a single compact row: name on the left, 5 h (top) and 7 d (bottom) bars beside it. */
export function AccountLine(p: {
  account: AccountView; targets: readonly TargetView[]; usage: UsageEntryView | undefined; brief: BriefView | undefined;
  /** Nothing to offer (host locked, or active everywhere it could go): not pressable. */
  disabled: boolean; pending: boolean; onPress(): void;
  now: number; styles: Styles; theme: PluginTheme;
}) {
  const { account: a, styles, theme, now } = p;
  const meters = metersFor(p.usage, p.brief);
  const activeIn = p.targets.filter((t) => t.activeId === a.id);
  const stale = p.usage?.kind === "ok" && p.usage.stale !== null;
  const markers = accountMarkers(a, p.usage, now);
  const alert = markers.find((m) => m.tone === "danger") ?? markers.find((m) => m.tone === "warning");
  const s = seriesColors(theme);
  const describe = (label: string, raw: MeterView | null) => {
    const m = live(raw, now);
    return `${label} ${formatPercent(m?.percent ?? null)}${m?.resetsAt ? `, reinicio ${formatCountdown(m.resetsAt, now)}` : ""}`;
  };
  const a11y = [
    a.label,
    activeIn.length ? `en uso en ${activeIn.map((t) => t.label).join(" y ")}` : null,
    describe("5 horas", meters.session),
    describe("7 días", meters.weekly),
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
      style={({ pressed }) => [styles.line, activeIn.length ? { borderLeftColor: theme.colors.accent } : null, pressed ? { opacity: 0.7 } : null]}
    >
      <View style={styles.lineName}>
        <View style={styles.row}>
          {p.pending ? <ActivityIndicator size="small" color={theme.colors.accent} style={{ transform: [{ scale: 0.6 }], width: 12, height: 12 }} /> : null}
          <Text style={[styles.lineLabel, activeIn.length ? { color: theme.colors.accent } : null]} numberOfLines={1}>{a.label}</Text>
        </View>
        {/* an alert wins even on the account in use: its accent border and name already say it is active */}
        {alert ? (
          <Text style={[styles.tiny, { color: toneColor(theme, alert.tone) }]} numberOfLines={1}>{alert.short}</Text>
        ) : activeIn.length ? (
          <Text style={[styles.tiny, { color: theme.colors.accent }]} numberOfLines={2}>{activeIn.map((t) => t.label).join(" · ")}</Text>
        ) : null}
      </View>
      <View style={styles.lineBars}>
        <HBar meter={meters.session} windowMs={SESSION_WINDOW_MS} series={s.session} dim={meters.cached || stale} now={now} styles={styles} theme={theme} />
        <HBar meter={meters.weekly} windowMs={WEEKLY_WINDOW_MS} series={s.weekly} dim={meters.cached || stale} now={now} styles={styles} theme={theme} />
      </View>
    </Pressable>
  );
}
