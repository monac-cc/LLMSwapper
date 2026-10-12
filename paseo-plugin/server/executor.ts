import type { ExecResults, RawResult } from "../shared/exec.ts";
import { pick } from "../shared/pick.ts";
import type { Plan, PlanRequest } from "../shared/plan.ts";
import { PICK } from "../shared/whitelist.ts";

/** Daemon->plugin RPC times out at 30 s; stay well below it. */
const SERVER_REQUEST_CAP_MS = 25_000;
/** Same cap as the device script: anything listening on the port must not make this process buffer GBs. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Structural view of the WHATWG body stream (the client typecheck uses React Native's fetch types, which lack it). */
type BodyReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
type StreamingResponse = { readonly body: { getReader(): BodyReader } | null };

function networkCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : "network";
}

/** The body as text, or null (request aborted) once it exceeds MAX_BODY_BYTES. */
async function readCapped(res: Response, ctrl: AbortController): Promise<string | null> {
  const reader = (res as unknown as StreamingResponse).body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      reader.cancel().catch(() => undefined);
      ctrl.abort();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new Response(all).text(); // UTF-8 decode exactly like res.text()
}

async function executeRequest(r: PlanRequest, port: number): Promise<RawResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(r.timeoutMs, SERVER_REQUEST_CAP_MS));
  try {
    const headers: Record<string, string> = { "X-Swapper": "1" }; // no Origin, host 127.0.0.1 (IPv4 only)
    if (r.body) headers["Content-Type"] = "application/json";
    // Never follow redirects (the device script's http.request does not either). Not a literal: RN's RequestInit lacks `redirect`.
    const init = { method: r.method, headers, body: r.body ? JSON.stringify(r.body) : undefined, signal: ctrl.signal, redirect: "manual" as const };
    const res = await fetch(`http://127.0.0.1:${port}${r.path}`, init);
    const text = await readCapped(res, ctrl);
    if (text === null) return { s: res.status, j: null, e: "too_large" };
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (json === null) return { s: res.status, j: null, e: "bad_json" };
    return { s: res.status, j: pick(json, res.status === 200 ? r.pick : PICK.error), e: null };
  } catch (err) {
    return { s: 0, j: null, e: ctrl.signal.aborted ? "timeout" : networkCode(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function executePlan(plan: Plan, port: number): Promise<ExecResults> {
  const pairs = await Promise.all(plan.requests.map(async (r) => [r.key, await executeRequest(r, port)] as const));
  return Object.fromEntries(pairs);
}
