import type { SwapView } from "./views.ts";

/** LLMswapper's own "Claude Code está abierto… (N proceso(s)). El cambio se aplicará a sesiones NUEVAS." */
const OPEN_RE = /Claude Code está abierto.*?\((\d+) proceso\(s\)\)/;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The notice lines after a swap. LLMswapper's "sesiones NUEVAS" warning is replaced by what actually
 * happens: Paseo sessions of the plugin host are reloaded (same conversation, new account); any Claude
 * Code opened OUTSIDE Paseo keeps the old account until restarted. Pure (unit-tested).
 */
export function swapNoticeLines(r: SwapView): string[] {
  const open = r.warnings.map((w) => OPEN_RE.exec(w)).find((m) => m !== null) ?? null;
  const lines = r.warnings.filter((w) => !OPEN_RE.test(w));
  const s = r.sessions;
  if (s) {
    if (s.note) lines.push(s.note);
    else if (s.reloading + s.deferred === 0) lines.push("No había sesiones de Paseo abiertas que recargar.");
    else {
      const parts = [
        s.reloading ? `${plural(s.reloading, "sesión de Paseo se recarga", "sesiones de Paseo se recargan")} ya` : "",
        s.deferred ? `${plural(s.deferred, "sesión", "sesiones")} al terminar su turno` : "",
      ].filter(Boolean);
      lines.push(`${parts.join(" y ")}: conservan la conversación y siguen con la cuenta nueva.`);
    }
    if (open) lines.push("Si tienes Claude Code abierto fuera de Paseo, sigue con la cuenta anterior hasta reiniciarlo («claude -c» continúa la conversación).");
  } else if (open) {
    lines.push(`Claude Code abierto en ${r.targetLabel} (${plural(Number(open[1]), "proceso", "procesos")}) sigue con la cuenta anterior hasta reiniciarlo: sal con /exit y vuelve con «claude -c» para continuar la misma conversación.`);
  }
  if (!r.verified && r.warnings.length === 0) lines.push("Credenciales escritas (este tipo de cuenta no se puede verificar contra la API de uso).");
  return lines;
}
