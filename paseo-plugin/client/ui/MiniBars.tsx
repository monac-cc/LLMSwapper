import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import { formatPercentShort, formatShortCountdown } from "../../shared/format.ts";
import { SESSION_WINDOW_MS, WEEKLY_WINDOW_MS, elapsedPercent, paceTone, type PaceTone } from "../../shared/pace.ts";
import type { MeterView } from "../../shared/views.ts";
import { seriesColors, type Styles } from "./theme.ts";

const H = 56; // chart height
const BAR_W = 12;
const COL_W = 42;
/** Dotted guide: LLMswapper's "high" severity starts here. */
const GUIDE = 80;
const LABEL_LINE = 9;

function toneColor(theme: PluginTheme, tone: PaceTone, series: string): string {
  if (tone === "exhausted") return theme.colors.statusDanger;
  if (tone === "ahead") return theme.colors.statusWarning;
  if (tone === "unknown") return theme.colors.foregroundMuted;
  return series;
}

/**
 * The 80 % guide drawn ON the track (after the fill, so it shows over it), from plain Views: iOS cannot
 * draw a dashed border on a single side.
 */
function Guide(p: { color: string }) {
  return (
    <View pointerEvents="none" style={{
      position: "absolute", left: 0, right: 0, top: H * (1 - GUIDE / 100), height: 1,
      flexDirection: "row", justifyContent: "space-between", overflow: "hidden",
    }}>
      {[0, 1, 2].map((i) => <View key={i} style={{ width: 2, height: 1, backgroundColor: p.color, opacity: 0.7 }} />)}
    </View>
  );
}

function Column(p: { meter: MeterView | null; windowMs: number; series: string; dim: boolean; now: number; styles: Styles; theme: PluginTheme }) {
  const c = p.theme.colors;
  const raw = p.meter?.percent ?? null;
  // One value for the label AND its colour: a "95%" is always red, a "0%" never shows a sliver.
  const shown = raw === null ? null : Math.round(raw);
  const elapsed = elapsedPercent(p.meter?.resetsAt ?? null, p.windowMs, p.now);
  const tone = paceTone(shown, elapsed);
  const fill = tone === "exhausted" ? c.statusDanger : p.series;
  const height = shown === null || shown <= 0 ? 0 : Math.min(100, Math.max(2, raw ?? 0));
  return (
    <View style={{ width: COL_W, alignItems: "center", gap: 3 }}>
      <View style={{ height: H, flexDirection: "row", alignItems: "flex-end", gap: 2 }}>
        <View style={{ width: BAR_W, height: H, borderRadius: 2, backgroundColor: c.surface2, justifyContent: "flex-end", overflow: "hidden" }}>
          {height > 0 ? <View style={{ height: `${height}%`, backgroundColor: fill, opacity: p.dim ? 0.55 : 1 }} /> : null}
          <Guide color={c.foregroundMuted} />
        </View>
        {/* thin bar: share of the window's TIME already gone; fill above it = spending ahead of pace */}
        <View style={{ width: 2, height: elapsed === null ? 0 : `${elapsed}%`, borderRadius: 1, backgroundColor: c.foregroundMuted, opacity: 0.55 }} />
      </View>
      <Text style={[p.styles.pct, { color: toneColor(p.theme, tone, p.series) }]}>{formatPercentShort(shown)}</Text>
      <Text style={p.styles.tiny} numberOfLines={1}>{formatShortCountdown(p.meter?.resetsAt ?? null, p.now)}</Text>
    </View>
  );
}

/** Two vertical meters (5 h, 7 d) on a 0-100 axis, as in the reference tile. */
export function MiniBars(p: { session: MeterView | null; weekly: MeterView | null; dim: boolean; now: number; styles: Styles; theme: PluginTheme }) {
  const s = seriesColors(p.theme);
  return (
    <View style={{ flexDirection: "row" }}>
      {/* axis labels centred on their gridline (100 = bar top, 0 = bar bottom) */}
      <View style={{ height: H, width: 16, marginRight: 2 }}>
        {[100, 50, 0].map((v) => (
          <Text key={v} style={[p.styles.tiny, {
            position: "absolute", right: 0, top: H * (1 - v / 100) - LABEL_LINE / 2,
            fontSize: 8, lineHeight: LABEL_LINE, opacity: 0.8,
          }]}>{String(v)}</Text>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 4 }}>
        <Column meter={p.session} windowMs={SESSION_WINDOW_MS} series={s.session} dim={p.dim} now={p.now} styles={p.styles} theme={p.theme} />
        <Column meter={p.weekly} windowMs={WEEKLY_WINDOW_MS} series={s.weekly} dim={p.dim} now={p.now} styles={p.styles} theme={p.theme} />
      </View>
    </View>
  );
}
