// Field whitelist applied to every LLMswapper response before it leaves the device or the server.
// shared/bridge-script.ts carries a line-for-line JS copy of clip/red/prim/pick;
// test/script.integration.test.ts asserts both produce identical output.

/** 1 = copy a primitive (or array of primitives); [spec] = array of spec; {k: spec} = object; {"*": spec} = record. */
export type PickSpec = 1 | readonly [PickSpec] | { readonly [key: string]: PickSpec };

export const MAX_STR = 1500;
export const MAX_ITEMS = 200;
export const RECORD_KEY_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const SECRET_RE = /sk-ant-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Keeps head AND tail: LLMswapper puts the manual-restore backup path at the END of its worst error. */
export function clip(text: string, max = MAX_STR): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  return text.slice(0, head) + " … " + text.slice(text.length - (max - head - 3));
}

export function redact(text: string, max = MAX_STR): string {
  return clip(text.replace(SECRET_RE, "[oculto]"), max);
}

function prim(v: unknown): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => (x !== null && typeof x === "object" ? null : prim(x)));
  return null; // objects in a primitive slot are dropped, never copied
}

export function pick(v: unknown, spec: PickSpec): unknown {
  if (v === undefined) return undefined;
  if (spec === 1) return prim(v);
  if (Array.isArray(spec)) {
    const item = (spec as readonly [PickSpec])[0];
    return Array.isArray(v) ? v.slice(0, MAX_ITEMS).map((x) => pick(x, item) ?? null) : null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const obj = spec as { readonly [key: string]: PickSpec };
  const out: Record<string, unknown> = {};
  const star = obj["*"];
  if (star !== undefined) {
    let n = 0;
    for (const k of Object.keys(src)) {
      if (n++ >= MAX_ITEMS) break;
      if (RECORD_KEY_RE.test(k) && k.slice(0, 2) !== "__") out[k] = pick(src[k], star) ?? null;
    }
    return out;
  }
  for (const k of Object.keys(obj)) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const p = pick(src[k], obj[k]);
    if (p !== undefined) out[k] = p;
  }
  return out;
}
