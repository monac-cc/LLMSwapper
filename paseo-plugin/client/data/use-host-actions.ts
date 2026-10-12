import type { PluginHostSummary } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { describeError } from "../../shared/error-text.ts";
import { swapNoticeLines } from "../../shared/swap-notice.ts";
import type { AccountView, StateView, TargetView } from "../../shared/views.ts";
import type { ConfirmRequest } from "../ui/ConfirmDialog.tsx";
import { useHostEntryUpdater } from "./host-settings.ts";
import { opErrorOf, useSetAuto, useSwap } from "./queries.ts";
import type { Transport } from "./transport.ts";

export interface HostNotice {
  readonly tone: "success" | "warning" | "danger";
  readonly title: string;
  readonly lines: readonly string[];
  /** Absolute backup dir when LLMswapper could not restore the config ("restaura a mano desde <dir>"). */
  readonly restoreDir: string | null;
}

const RESTORE_RE = /restaura a mano desde (.+)$/;

/** Swap / auto / opt-in flows of one host card. Every mutating action goes through a confirmation. */
export function useHostActions(t: Transport, host: PluginHostSummary) {
  const id = host.serverId;
  const toast = useToast();
  const swap = useSwap(t, id);
  const setAuto = useSetAuto(t, id);
  const hostSettings = useHostEntryUpdater();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [notice, setNotice] = useState<HostNotice | null>(null);

  const runSwap = (account: AccountView, target: TargetView) =>
    swap.mutate({ accountId: account.id, target: target.id }, {
      onSuccess: (r) => {
        const lines = swapNoticeLines(r);
        const warn = r.warnings.some((w) => !/Claude Code está abierto/.test(w)) || r.sessions?.note != null;
        setNotice({ tone: warn ? "warning" : "success", title: `«${r.accountLabel ?? account.label}» activa en ${r.targetLabel}`, lines, restoreDir: null });
        toast.show(`Cuenta cambiada en ${host.label} · ${r.targetLabel}`, { variant: warn ? "warning" : "success" });
      },
      onError: (e) => {
        const err = opErrorOf(e) ?? { code: "rpc_failed" as const, message: String(e) };
        const d = describeError(err);
        const restoreDir = RESTORE_RE.exec(err.message)?.[1]?.trim() ?? null;
        setNotice({ tone: "danger", title: d.title, lines: [d.detail, ...(d.hint ? [d.hint] : [])], restoreDir });
        toast.error(`${host.label}: ${d.title}`);
      },
    });

  /** Tile press: one dialog where picking an environment IS the confirmation. */
  const chooseSwap = (account: AccountView, s: StateView) => {
    const usable = s.targets.filter((t) => t.swappable);
    const notes: string[] = [];
    for (const t of usable) {
      if (t.running && t.activeId !== account.id) notes.push(`Claude Code está abierto en ${t.label}: el cambio se aplica a las sesiones NUEVAS.`);
    }
    if (s.health.overridingEnv.length > 0) notes.push(`${s.health.overridingEnv.join(", ")} anula el fichero de credenciales: puede no tener efecto.`);
    if (account.tokenExpired) notes.push("El token de esta cuenta ha caducado; LLMswapper intentará renovarlo.");
    setConfirm({
      title: `Usar «${account.label}»`,
      message: usable.length > 1 ? `¿En qué entorno de ${host.label}?` : `¿Cambiar la cuenta de ${host.label}?`,
      notes,
      options: usable.map((t) => t.activeId === account.id
        ? { label: `Ya activa en ${t.label}`, disabled: true, onSelect: () => undefined }
        : { label: `Usar en ${t.label}`, onSelect: () => runSwap(account, t) }),
    });
  };

  const toggleAuto = (enabled: boolean, s: StateView) => {
    const run = () =>
      setAuto.mutate(enabled, { onError: (e) => toast.error(describeError(opErrorOf(e) ?? { code: "rpc_failed", message: String(e) }).title) });
    if (!enabled) return run();
    const probes = s.accounts.filter((a) => !a.canReadUsage).length;
    const notes = [
      "Cada 3 minutos LLMswapper lee el consumo de la cuenta activa y, al superar el umbral, el de todas las demás.",
      probes === s.accounts.length
        ? "Tus cuentas se leen por sonda: cada lectura gasta ~9 tokens de la suscripción."
        : probes > 0
          ? "Las cuentas con login completo gastan la API de uso (~5 lecturas / 5 min); las de token pegado, ~9 tokens por lectura."
          : "Gasta parte del presupuesto de la API de uso (~5 lecturas / 5 min, compartido con Paseo).",
    ];
    if (s.auto && s.auto.current === null) notes.push("LLMswapper no tiene cuenta activa registrada en ese entorno: no rotará hasta el primer cambio de cuenta.");
    setConfirm({
      title: "Activar rotación automática",
      message: `LLMswapper de ${host.label} cambiará de cuenta solo al superar el ${s.auto?.threshold ?? "?"} %.`,
      notes,
      confirmLabel: "Activar",
      onConfirm: run,
    });
  };

  const askOptIn = () =>
    setConfirm({
      title: `Activar LLMswapper en ${host.label}`,
      message: "Para leer LLMswapper en ese equipo, el panel abrirá durante unos segundos una terminal en uno de sus workspaces y ejecutará «node» con un script que solo habla con 127.0.0.1 de ese equipo.",
      notes: [
        "Mientras dura, puede aparecer una pestaña «LLMswapper» en ese workspace en los clientes que lo tengan abierto.",
        "Solo se leen datos públicos de LLMswapper (sin tokens). Puedes elegir el workspace y desactivarlo en Ajustes > LLMswapper.",
      ],
      confirmLabel: "Activar",
      onConfirm: () =>
        void hostSettings.update(id, { bridge: true }).then((ok) => {
          if (!ok) toast.error(hostSettings.saveError ?? "No se pudieron guardar los ajustes");
        }),
    });

  return {
    confirm, closeConfirm: () => setConfirm(null), notice, clearNotice: () => setNotice(null),
    chooseSwap, toggleAuto, askOptIn, canOptIn: hostSettings.ready,
    /** Why "Activar en …" is disabled when the settings document cannot be read (null while loading/ready). */
    optInBlocked: hostSettings.status === "error" || hostSettings.status === "invalid"
      ? "No se pueden leer los ajustes del plugin: revísalos en Ajustes > LLMswapper."
      : null,
    pendingSwap: swap.isPending ? swap.variables : undefined,
  };
}
