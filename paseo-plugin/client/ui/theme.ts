import type { PluginTheme } from "@getpaseo/plugin";
import { StyleSheet } from "react-native";
import type { Tone } from "../../shared/markers.ts";

export function toneColor(theme: PluginTheme, tone: Tone): string {
  const c = theme.colors;
  return tone === "danger" ? c.statusDanger : tone === "warning" ? c.statusWarning : tone === "success" ? c.statusSuccess : c.foregroundMuted;
}

/** Relative luminance (0..1) of "#rgb", "#rrggbb" or "rgb(a)(r, g, b…)"; null when unparseable. */
function luminance(color: string): number | null {
  const c = color.trim();
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((x) => x + x).join("") : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
    if (m) rgb = [m[1], m[2], m[3]].map(Number);
  }
  if (!rgb || rgb.some((v) => !Number.isFinite(v))) return null;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Data-series colours. The plugin theme has no categorical tokens, so these are fixed hues with a
 * light and a dark variant (picked from the panel background) to keep contrast in both.
 */
export function seriesColors(theme: PluginTheme): { session: string; weekly: string } {
  const l = luminance(theme.colors.surface0);
  return l !== null && l > 0.5 ? { session: "#0891b2", weekly: "#7c3aed" } : { session: "#22d3ee", weekly: "#a78bfa" };
}

export function makeStyles(theme: PluginTheme, compact: boolean) {
  const c = theme.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.surface0 },
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    wrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    text: { color: c.foreground, fontSize: 13 },
    strong: { color: c.foreground, fontSize: 13, fontWeight: "600" },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    small: { color: c.foregroundMuted, fontSize: 11 },
    button: {
      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: c.border,
      backgroundColor: c.surface2, flexDirection: "row", alignItems: "center", gap: 6,
    },
    buttonPrimary: { backgroundColor: c.accent, borderColor: c.accent },
    buttonText: { color: c.foreground, fontSize: 12, fontWeight: "500" },
    buttonPrimaryText: { color: c.accentForeground },
    disabled: { opacity: 0.45 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    // --- compact layout ---
    hostBlock: { gap: 6 },
    hostHeader: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
    hostName: { color: c.foreground, fontSize: 12, fontWeight: "600" },
    envChip: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: c.surface2, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
    envText: { color: c.foregroundMuted, fontSize: 10 },
    tiny: { color: c.foregroundMuted, fontSize: 9 },
    iconButton: { padding: 4, borderRadius: 4 },
    pill: { borderRadius: 4, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 1, flexDirection: "row", alignItems: "center", gap: 3 },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    tile: {
      width: 122, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8,
      paddingHorizontal: 8, paddingTop: 7, paddingBottom: 6, gap: 5, alignItems: "center",
    },
    tileName: { color: c.foreground, fontSize: 12, fontWeight: "600", textAlign: "center", maxWidth: 106 },
    tileBadges: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 3, minHeight: 13 },
    tileBadge: { borderRadius: 3, borderWidth: 1, paddingHorizontal: 4 },
    tileBadgeText: { fontSize: 8, fontWeight: "600" },
    pct: { fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },
  });
}
export type Styles = ReturnType<typeof makeStyles>;
