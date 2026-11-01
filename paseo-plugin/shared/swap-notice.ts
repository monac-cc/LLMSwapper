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
    else if (s.reloading + (s.stopped ?? 0) + s.deferred + (s.unseen ?? 0) + (s.unchecked ?? 0) === 0) lines.push("Ninguna sesión de Paseo tenía Claude en marcha: la próxima vez que escribas en una, ya irá con la cuenta nueva.");
    else {
      const stopped = s.stopped ?? 0, unseen = s.unseen ?? 0, unchecked = s.unchecked ?? 0;
      const now = s.reloading + stopped;
      if (now) {
        const parts = [
          s.reloading ? `${plural(s.reloading, "sesión de Paseo se recarga", "sesiones de Paseo se recargan")} ya` : "",
          stopped ? `${plural(stopped, "sesión con trabajo en marcha se para", "sesiones con trabajo en marcha se paran")} y lo retoma${stopped === 1 ? "" : "n"}` : "",
        ].filter(Boolean);
        lines.push(`${parts.join(" y ")}: ${now === 1 ? "conserva la conversación y sigue" : "conservan la conversación y siguen"} con la cuenta nueva.`);
      }
      if (s.deferred) {
        const n = s.deferred === 1 ? "" : "n";
        lines.push(`${plural(s.deferred, "sesión sigue", "sesiones siguen")} con la cuenta anterior hasta que termine${n} lo que está${n} haciendo, también en segundo plano; después cambia${n} sola${n ? "s" : ""}.`);
      }
      if (unchecked) {
        const n = unchecked === 1 ? "" : "n";
        lines.push(s.mode === "wait"
          ? `${plural(unchecked, "sesión no se pudo comprobar", "sesiones no se pudieron comprobar")}: se mira${n} de nuevo en segundo plano y cambia${n} a la cuenta nueva en cuanto no tenga${n} trabajo en marcha.`
          : `${plural(unchecked, "sesión no se pudo comprobar", "sesiones no se pudieron comprobar")}: se mira${n} de nuevo en segundo plano y, si tiene${n} trabajo en marcha, se para${n} y lo retoma${n} con la cuenta nueva.`);
      }
      if (unseen) lines.push(`${plural(unseen, "sesión corre", "sesiones corren")} fuera de la vista del plugin (WSL, docker, ssh): sigue${unseen === 1 ? "" : "n"} con la cuenta anterior hasta que la${unseen === 1 ? "" : "s"} reinicies.`);
      if (stopped) {
        lines.push(s.deferred || unseen || unchecked
          ? `Lo que se cortó en ${stopped === 1 ? "la sesión parada" : "las sesiones paradas"} sigue con la cuenta nueva, y sus workflows se reanudan sin repetir los pasos terminados.`
          : "Las sesiones de Paseo de este equipo ya no gastan de la cuenta anterior: lo que se cortó sigue con la nueva, y los workflows se reanudan sin repetir los pasos terminados.");
      }
    }
    if (open) lines.push("Si tienes Claude Code abierto fuera de Paseo, sigue con la cuenta anterior hasta reiniciarlo («claude -c» continúa la conversación).");
  } else if (open) {
    lines.push(`Claude Code abierto en ${r.targetLabel} (${plural(Number(open[1]), "proceso", "procesos")}) sigue con la cuenta anterior hasta reiniciarlo: sal con /exit y vuelve con «claude -c» para continuar la misma conversación.`);
  }
  if (!r.verified && r.warnings.length === 0) lines.push("Credenciales escritas (este tipo de cuenta no se puede verificar contra la API de uso).");
  return lines;
}
