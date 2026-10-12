// Burn rate of a usage window: how much of it is spent vs how much of its time has passed. Pure.

export const SESSION_WINDOW_MS = 5 * 3600_000;
export const WEEKLY_WINDOW_MS = 7 * 24 * 3600_000;

/** % of the window already elapsed, derived from its reset instant; null when the reset is unknown. */
export function elapsedPercent(resetsAt: number | null, windowMs: number, now: number): number | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const left = Math.min(windowMs, Math.max(0, resetsAt - now));
  return Math.round((1 - left / windowMs) * 100);
}

/**
 * series    on or under pace: the window's own colour
 * ahead     spending faster than time passes (>= 10 points ahead, from 25 %): warning colour
 * exhausted at or near the cap (>= 95 %, LLMswapper's "critical"): danger colour
 */
export type PaceTone = "series" | "ahead" | "exhausted" | "unknown";

export function paceTone(percent: number | null, elapsed: number | null): PaceTone {
  if (percent === null || !Number.isFinite(percent)) return "unknown";
  if (percent >= 95) return "exhausted";
  if (elapsed !== null && percent >= 25 && percent - elapsed >= 10) return "ahead";
  return "series";
}
