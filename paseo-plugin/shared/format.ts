import type { Severity } from "./views.ts";

/** <50 normal, 50-79 medium, 80-94 high, >=95 critical; null = unknown (render "—", never 0 %). */
export function severityOf(percent: number | null): Severity {
  if (percent === null || !Number.isFinite(percent)) return "unknown";
  if (percent >= 95) return "critical";
  if (percent >= 80) return "high";
  if (percent >= 50) return "medium";
  return "normal";
}

export function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function clampPercent(p: number): number {
  return Math.min(100, Math.max(0, Math.round(p * 10) / 10));
}

export function formatPercent(p: number | null): string {
  if (p === null) return "—";
  return (Number.isInteger(p) ? String(p) : p.toFixed(1).replace(".", ",")) + " %";
}

/** "hace 12 s", "hace 3 min", "hace 2 h", "hace 4 d". */
export function formatAgo(atMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

/** Compact countdown for tight tiles: "1h 33m", "4d 11h", "33m", "45s"; past => "ya", null => "—". */
export function formatShortCountdown(atMs: number | null, nowMs: number): string {
  if (atMs === null) return "—";
  const s = Math.round((atMs - nowMs) / 1000);
  if (s <= 0) return "ya";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Whole percent for tiles: "2%", "100%"; null => "—". */
export function formatPercentShort(p: number | null): string {
  return p === null || !Number.isFinite(p) ? "—" : `${Math.round(p)}%`;
}

/** "en 2 h 14 min", "en 3 d 4 h", "en 45 s"; past or null => "—". */
export function formatCountdown(atMs: number | null, nowMs: number): string {
  if (atMs === null) return "—";
  const s = Math.round((atMs - nowMs) / 1000);
  if (s <= 0) return "ya";
  if (s < 60) return `en ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `en ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `en ${h} h ${m % 60} min`;
  return `en ${Math.floor(h / 24)} d ${h % 24} h`;
}
