import { formatAgo, formatCountdown, formatShortCountdown, severityOf } from "./format.ts";
import type { AccountView, BriefView, MeterView, UsageEntryView } from "./views.ts";

export type Tone = "muted" | "success" | "warning" | "danger";
export interface Marker {
  readonly key: string;
  readonly label: string;
  /** Fits a ~78 px, 9 px column (about 14 characters). The full `label` goes to the accessibility label. */
  readonly short: string;
  readonly tone: Tone;
}

const THREE_DAYS = 3 * 24 * 3600_000;

/** Badges under an account row. Pure (unit-tested). */
export function accountMarkers(a: AccountView, u: UsageEntryView | undefined, now: number): Marker[] {
  const m: Marker[] = [];
  if (a.tokenExpired) m.push({ key: "expired", label: "Token caducado", short: "Token caducado", tone: "danger" });
  if (u?.kind === "error") {
    if (u.needsRelogin) m.push({ key: "relogin", label: "Hay que volver a añadir la cuenta (token rechazado)", short: "Volver a añadir", tone: "danger" });
    else if (u.rateLimited) m.push({ key: "429", label: `API de uso limitada${u.retryInS ? `, reintento en ${Math.ceil(u.retryInS / 60)} min` : ""}`, short: u.retryInS ? `API 429 · ${Math.ceil(u.retryInS / 60)} min` : "API 429", tone: "warning" });
    else if (u.throttled) m.push({ key: "throttled", label: "Lectura de consumo en cola", short: "En cola", tone: "muted" });
    else m.push({ key: "usage-error", label: `Sin datos de consumo: ${u.message}`, short: "Sin consumo", tone: "warning" });
  }
  if (u?.kind === "ok" && u.stale) {
    m.push({ key: "stale", label: `Datos antiguos${u.stale.since ? ` (${formatAgo(u.stale.since, now)})` : ""}`, short: u.stale.since ? `Antiguo, ${formatAgo(u.stale.since, now)}` : "Datos antiguos", tone: "warning" });
  }
  if (u?.kind === "ok" && u.queuedRetryInS !== null) m.push({ key: "queued", label: "Actualización en cola", short: "En cola", tone: "muted" });
  if (a.sessionEndsAt !== null && a.sessionEndsAt - now < THREE_DAYS) {
    m.push({ key: "session-ends", label: `La sesión caduca ${formatCountdown(a.sessionEndsAt, now)}`, short: a.sessionEndsAt <= now ? "Sesión caducada" : `Caduca ${formatShortCountdown(a.sessionEndsAt, now)}`, tone: a.sessionEndsAt <= now ? "danger" : "warning" });
  }
  if (!a.canReadUsage) m.push({ key: "probe", label: "Consumo vía sonda (~9 tokens por lectura)", short: "Sonda", tone: "muted" });
  if (!a.renewable) m.push({ key: "pasted", label: "Token pegado: no se renueva solo", short: "Token pegado", tone: "muted" });
  return m;
}

export interface Meters {
  readonly session: MeterView | null;
  readonly weekly: MeterView | null;
  /** true = values from /api/auto cached readings (no Anthropic call), shown while usage loads. */
  readonly cached: boolean;
}

/** /api/auto briefs copy LLMswapper's meter percent, which is 0 for an UNKNOWN reading: show "—", not a green 0 %. */
const fromBrief = (raw: number | null, resetsAt: number | null): MeterView => {
  const percent = raw === null || raw === 0 ? null : raw;
  return { percent, resetsAt, severity: severityOf(percent) };
};

export function metersFor(u: UsageEntryView | undefined, brief: BriefView | undefined): Meters {
  if (u?.kind === "ok") return { session: u.session, weekly: u.weekly, cached: false };
  if (brief) {
    return { session: fromBrief(brief.sessionPercent, brief.sessionResetsAt), weekly: fromBrief(brief.weeklyPercent, brief.weeklyResetsAt), cached: true };
  }
  return { session: null, weekly: null, cached: false };
}

/** Never re-poll queued entries sooner than this, whatever retryInS says (a bridge read spawns a terminal). */
export const MIN_QUEUED_REPOLL_MS = 60_000;
/** Longer waits are left to the regular refresh / Actualizar. */
const MAX_QUEUED_REPOLL_MS = 10 * 60_000;

/**
 * LLMswapper's 80 s floor answers some entries `throttled` (no reading yet) or `queued` (old reading)
 * with retryInS and expects the frontend to ask again once it lifts. Returns the delay of ONE follow-up
 * read: the longest wait + 5 s, never below MIN_QUEUED_REPOLL_MS. null = nothing queued, a wait that is
 * out of range, or any entry hit a real 429 (never auto-chained, like LLMswapper's own UI). Pure.
 */
/** Entries LLMswapper still owes a reading for (queued behind its rate floor, or throttled). */
export function queuedCount(byId: Readonly<Record<string, UsageEntryView>>): number {
  let n = 0;
  for (const u of Object.values(byId)) if (u.kind === "ok" ? u.queuedRetryInS !== null : u.throttled) n++;
  return n;
}

export function queuedRepollDelayMs(byId: Readonly<Record<string, UsageEntryView>>): number | null {
  let wait = -1;
  for (const u of Object.values(byId)) {
    if (u.kind === "error" && (u.rateLimited || u.status === 429)) return null;
    const s = u.kind === "ok" ? u.queuedRetryInS : u.throttled ? u.retryInS : null;
    if (s !== null && Number.isFinite(s) && s >= 0) wait = Math.max(wait, s);
  }
  if (wait < 0) return null;
  const ms = Math.max(MIN_QUEUED_REPOLL_MS, Math.ceil(wait + 5) * 1000);
  return ms > MAX_QUEUED_REPOLL_MS ? null : ms;
}
