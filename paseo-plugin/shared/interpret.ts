import type { z } from "zod";
import type { ExecResults, RawResult } from "./exec.ts";
import { clampPercent, isoToMs, severityOf } from "./format.ts";
import { isAccountId, isTargetId } from "./ids.ts";
import {
  RawAccounts, RawAuto, RawError, RawHealth, RawSwap, RawTargets, RawUsage,
  type RawUsageOk, type RawUsageErr,
} from "./llmswapper-schemas.ts";
import type { SwapperOp } from "./plan.ts";
import type {
  AccountView, AutoView, BriefView, HealthView, MeterView, OpError, OpResult, StateView, SwapView,
  TargetView, UsageEntryView, UsageView, WarningView,
} from "./views.ts";
import { deriveWarnings } from "./warnings.ts";

export interface InterpretContext {
  readonly now: number;
  readonly port: number;
}

export interface OpData {
  state: StateView;
  usage: UsageView;
  swap: SwapView;
  auto: AutoView;
}

const fail = (error: OpError): { ok: false; error: OpError } => ({ ok: false, error });

function errorText(j: unknown): string | null {
  const p = RawError.safeParse(j);
  return p.success ? p.data.error : null;
}

/** Maps transport/HTTP failure of one exchange to an OpError; null when it is a usable 200. */
export function exchangeError(r: RawResult | undefined, what: string, port: number): OpError | null {
  if (!r) return { code: "bad_response", message: `Falta la respuesta de ${what}.` };
  if (r.s === 0) {
    if (r.e === "ECONNREFUSED") return { code: "swapper_down", message: `LLMswapper no está en marcha: nadie escucha en 127.0.0.1:${port}.` };
    if (r.e === "timeout") return { code: "swapper_timeout", message: `LLMswapper no respondió a tiempo (${what}).` };
    return { code: "swapper_unreachable", message: `No se pudo hablar con LLMswapper (${r.e ?? "error de red"}).` };
  }
  if (r.s === 200) return r.e !== null ? { code: "bad_response", message: `Respuesta ilegible de ${what} (${r.e}).` } : null;
  const msg = errorText(r.j) ?? `HTTP ${r.s}`;
  if (r.s === 403) return { code: "swapper_forbidden", status: 403, message: `LLMswapper rechazó la petición: ${msg}` };
  if (r.s === 404) return { code: "endpoint_missing", status: 404, message: `Esta versión de LLMswapper no ofrece ${what}.` };
  if (r.s === 409) {
    return { code: "swap_busy", status: 409, message: "Ya hay un cambio de cuenta en curso en este equipo (otra ventana o la rotación automática). Espera unos segundos." };
  }
  if (r.s >= 400 && r.s < 500) return { code: "bad_request", status: r.s, message: msg };
  return { code: "swapper_failed", status: r.s, message: msg };
}

function parseExchange<S extends z.ZodType>(r: RawResult | undefined, schema: S, what: string, port: number): OpResult<z.output<S>> {
  const err = exchangeError(r, what, port);
  if (err) return fail(err);
  const parsed = schema.safeParse(r?.j);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : fail({ code: "bad_response", message: `Respuesta inesperada de ${what} (¿versión de LLMswapper distinta?).` });
}

const strings = (xs: readonly (string | null)[] | undefined): string[] => (xs ?? []).filter((x): x is string => typeof x === "string");
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function toMeter(m: { percent: number; resetsAt: string | null; severity: string }): MeterView {
  const percent = m.severity === "unknown" ? null : clampPercent(m.percent);
  return { percent, resetsAt: isoToMs(m.resetsAt), severity: severityOf(percent) };
}

export function toUsageEntry(u: z.output<typeof RawUsageOk> | z.output<typeof RawUsageErr>): UsageEntryView {
  if (u.ok) {
    return {
      kind: "ok", fetchedAt: u.fetchedAt, session: toMeter(u.session), weekly: toMeter(u.weekly), probe: u.viaProbe === true,
      stale: u.stale ? { since: u.staleSince ?? null, reason: u.staleReason ?? null } : null,
      queuedRetryInS: u.queued ? (u.retryInS ?? null) : null,
    };
  }
  return {
    kind: "error", message: u.error, status: u.status, needsRelogin: u.needsRelogin,
    rateLimited: u.rateLimited === true || u.status === 429, throttled: u.throttled === true, retryInS: u.retryInS ?? null,
  };
}

function toBrief(b: { id: string; label: string; sessionPercent: number | null; weeklyPercent: number | null; sessionResetsAt: string | null; weeklyResetsAt: string | null }): BriefView {
  return {
    id: b.id, label: b.label, sessionPercent: b.sessionPercent, weeklyPercent: b.weeklyPercent,
    sessionResetsAt: isoToMs(b.sessionResetsAt), weeklyResetsAt: isoToMs(b.weeklyResetsAt),
  };
}

function toAutoView(a: z.output<typeof RawAuto>): AutoView {
  return {
    enabled: a.enabled, target: a.target, threshold: a.threshold,
    current: a.current ? toBrief(a.current) : null, next: a.next ? toBrief(a.next) : null,
    queue: a.queue.map((q) => ({ ...toBrief(q), eligible: q.eligible, reason: q.reason })),
  };
}

export function interpretState(results: ExecResults, ctx: InterpretContext): OpResult<StateView> {
  const h = parseExchange(results.health, RawHealth, "/api/health", ctx.port);
  if (!h.ok) return h;
  const t = parseExchange(results.targets, RawTargets, "/api/targets", ctx.port);
  if (!t.ok) return t;
  const a = parseExchange(results.accounts, RawAccounts, "/api/accounts", ctx.port);
  if (!a.ok) return a;
  const au = parseExchange(results.auto, RawAuto, "/api/auto", ctx.port);
  const extra: WarningView[] = [];
  if (!au.ok && au.error.code !== "endpoint_missing") {
    extra.push({ code: "auto_unavailable", level: "warning", message: `No se pudo leer la rotación automática: ${au.error.message}` });
  }
  if (au.ok && au.data.enabled && au.data.current === null) {
    extra.push({ code: "auto_idle", level: "warning", message: "La rotación automática está activada pero LLMswapper no tiene una cuenta activa registrada en ese entorno: no hará nada hasta el primer cambio de cuenta desde LLMswapper." });
  }
  const hd = h.data;
  const health: HealthView = {
    claudeRunning: hd.claudeRunning, claudeProcesses: hd.pids.length, node: hd.node, platform: hd.platform,
    credentialsKind: hd.credentialsBackend?.kind ?? "file", credentialsError: hd.credentialsBackend?.error ?? null,
    overridingEnv: strings(hd.overridingEnv), container: hd.container === true, unavailable: strings(hd.unavailable),
    build: hd.build ?? "", staleMount: hd.staleMount === true,
  };
  const targets: TargetView[] = t.data.targets.map((x) => ({ ...x, swappable: isTargetId(x.id) }));
  const accounts: AccountView[] = a.data.accounts.map((x) => ({
    id: x.id, label: x.label, email: x.email, color: COLOR_RE.test(x.color) ? x.color : "#888888", plan: x.plan,
    tokenExpired: x.tokenExpired, sessionEndsAt: x.sessionEndsAt ?? null, canReadUsage: x.canReadUsage ?? true,
    renewable: x.renewable ?? true, expiresAt: x.expiresAt, swappable: isAccountId(x.id),
  }));
  return {
    ok: true,
    data: {
      receivedAt: ctx.now, health, targets, accounts, auto: au.ok ? toAutoView(au.data) : null,
      warnings: deriveWarnings(health, targets, extra),
    },
  };
}

export function interpretUsage(results: ExecResults, ctx: InterpretContext): OpResult<UsageView> {
  const err = exchangeError(results.usage, "/api/usage/all", ctx.port);
  if (err) return fail(err);
  const j = results.usage?.j;
  if (j === null || typeof j !== "object" || Array.isArray(j)) return fail({ code: "bad_response", message: "Respuesta inesperada de /api/usage/all." });
  const byId: Record<string, UsageEntryView> = {};
  for (const [id, raw] of Object.entries(j as Record<string, unknown>)) {
    const p = RawUsage.safeParse(raw);
    if (p.success) byId[id] = toUsageEntry(p.data);
  }
  return { ok: true, data: { receivedAt: ctx.now, byId } };
}

export function interpretSwap(results: ExecResults, ctx: InterpretContext): OpResult<SwapView> {
  const r = results.swap;
  // Request may have reached LLMswapper: the outcome is unknown. Never retry automatically.
  // Lost or unreadable answer after the request may have reached LLMswapper: outcome unknown, never retry.
  if (r && ((r.s === 0 && r.e !== "ECONNREFUSED") || (r.s === 200 && r.e !== null))) {
    return fail({ code: "swap_unknown_result", message: "LLMswapper no respondió a tiempo. El cambio puede haberse aplicado: actualiza para comprobarlo antes de reintentar." });
  }
  const p = parseExchange(r, RawSwap, "/api/swap", ctx.port);
  if (!p.ok) return p;
  const d = p.data;
  return {
    ok: true,
    data: {
      target: d.target, targetLabel: d.targetLabel, accountId: d.account?.id ?? null, accountLabel: d.account?.label ?? null,
      verified: d.verified, warnings: strings(d.warnings), usage: d.usage ? toUsageEntry(d.usage) : null,
      sessions: null, // filled by the plugin host's server when it reloads its Paseo sessions
    },
  };
}

export function interpretAuto(results: ExecResults, ctx: InterpretContext): OpResult<AutoView> {
  const p = parseExchange(results.auto, RawAuto, "/api/auto", ctx.port);
  return p.ok ? { ok: true, data: toAutoView(p.data) } : p;
}

type Interpreter<K extends keyof OpData> = (r: ExecResults, ctx: InterpretContext) => OpResult<OpData[K]>;
const TABLE: { [K in keyof OpData]: Interpreter<K> } = {
  state: interpretState, usage: interpretUsage, swap: interpretSwap, auto: interpretAuto,
};

export function interpret<K extends SwapperOp["kind"]>(kind: K, results: ExecResults, ctx: InterpretContext): OpResult<OpData[K]> {
  return (TABLE[kind] as Interpreter<K>)(results, ctx);
}
