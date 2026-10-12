import type { HealthView, TargetView, WarningView } from "./views.ts";

export function deriveWarnings(health: HealthView, targets: readonly TargetView[], extra: readonly WarningView[] = []): WarningView[] {
  const w: WarningView[] = [];
  if (health.overridingEnv.length > 0) {
    w.push({
      code: "overriding_env", level: "danger",
      message: `${health.overridingEnv.join(", ")} está definido en el entorno de LLMswapper y tiene prioridad sobre el fichero de credenciales: los cambios de cuenta no tendrán efecto en Claude Code.`,
    });
  }
  if (health.staleMount) {
    w.push({ code: "stale_mount", level: "danger", message: "El montaje del contenedor de LLMswapper está desconectado: rechazará los cambios. Reinicia el contenedor." });
  }
  if (health.credentialsError) {
    w.push({ code: "credentials_backend", level: "danger", message: `No se puede leer el almacén de credenciales (${health.credentialsKind}): ${health.credentialsError}` });
  }
  if (health.container || health.unavailable.length > 0) {
    w.push({ code: "container", level: "warning", message: "LLMswapper corre en un contenedor: no ve los procesos del host ni los entornos WSL; «Claude abierto» no es fiable." });
  }
  const running = targets.filter((t) => t.running).map((t) => t.label);
  if (running.length === 0 && health.claudeRunning) running.push(targets.find((t) => t.kind === "host")?.label ?? "el sistema anfitrión");
  if (running.length > 0) {
    w.push({ code: "claude_running", level: "info", message: `Claude Code está abierto en ${running.join(", ")}: un cambio de cuenta se aplica a las sesiones NUEVAS.` });
  }
  for (const t of targets) {
    if (!t.swappable) w.push({ code: "target_readonly", level: "info", message: `El entorno «${t.label}» tiene un id no admitido: se muestra solo en lectura.` });
  }
  return [...w, ...extra];
}
