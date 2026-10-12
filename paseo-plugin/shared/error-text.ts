import type { ErrorCode, OpError } from "./views.ts";

const TITLES: Record<ErrorCode, { title: string; hint?: string }> = {
  host_offline: { title: "Host desconectado", hint: "Comprueba que Paseo está abierto en ese equipo y conectado." },
  no_workspace: { title: "Ese host no tiene workspaces", hint: "Abre cualquier carpeta en Paseo en ese equipo o elige un workspace en Ajustes > LLMswapper." },
  workspace_unusable: { title: "La carpeta del workspace no está disponible en ese equipo", hint: "Elige otro workspace para el puente en Ajustes > LLMswapper." },
  node_missing: { title: "Node.js no encontrado en ese equipo", hint: "El puente necesita «node» en el PATH del daemon de Paseo de ese equipo, o su ruta absoluta en Ajustes > LLMswapper." },
  terminal_failed: { title: "No se pudo abrir la terminal remota" },
  permission_denied: { title: "Sin permiso en ese host", hint: "El panel necesita daemon.manage en el host del plugin y workspace.read/write en los demás." },
  sdk_unsupported: { title: "Paseo de ese host es demasiado antiguo", hint: "Actualiza Paseo en ese equipo (terminales por SDK desde 0.7.3)." },
  bridge_timeout: { title: "El puente por terminal no respondió a tiempo", hint: "Vuelve a intentarlo; a través del relay puede tardar unos segundos." },
  bridge_exited: { title: "El proceso remoto terminó sin respuesta" },
  bridge_corrupt: { title: "La salida del puente llegó dañada", hint: "Vuelve a intentarlo." },
  rpc_failed: { title: "El plugin no respondió" },
  host_busy: { title: "Ya hay una operación en curso en este host" },
  invalid_input: { title: "Datos no válidos" },
  bridge_disabled: { title: "Lectura por terminal desactivada en este equipo", hint: "No se ha ejecutado nada en él. Actívala con «Activar en …» en el panel o en Ajustes > LLMswapper." },
  swapper_down: { title: "LLMswapper no está en marcha", hint: "Arranca LLMswapper en ese equipo (o revisa el puerto en Ajustes)." },
  swapper_timeout: { title: "LLMswapper no respondió a tiempo" },
  swapper_unreachable: { title: "No se pudo conectar con LLMswapper" },
  swapper_forbidden: { title: "LLMswapper rechazó la petición" },
  endpoint_missing: { title: "Versión de LLMswapper no compatible", hint: "Actualiza LLMswapper en ese equipo." },
  bad_request: { title: "LLMswapper rechazó la operación" },
  swapper_failed: { title: "LLMswapper devolvió un error" },
  bad_response: { title: "Respuesta inesperada de LLMswapper" },
  swap_busy: { title: "Ya hay un cambio de cuenta en curso" },
  swap_unknown_result: { title: "Resultado del cambio desconocido", hint: "Pulsa Actualizar para ver qué cuenta quedó activa antes de reintentar." },
};

export function describeError(e: OpError): { title: string; detail: string; hint: string | null } {
  const t = TITLES[e.code];
  return { title: t.title, detail: e.message, hint: t.hint ?? null };
}
