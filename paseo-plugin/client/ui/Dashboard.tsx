import type { PluginTheme } from "@getpaseo/plugin";
import { useHosts, useSettings, type PluginHostProps, type PluginHostSummary } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useIsFetching, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { swapperSettings } from "../../shared/contracts.ts";
import { describeError } from "../../shared/error-text.ts";
import { globalAuto, type GlobalAuto } from "../../shared/panel.ts";
import { usePanelFlags } from "../data/host-settings.ts";
import { dropQueuedUsage, markForReread, qk, refreshAll, useCachedStates, useSetAutoMany, type AutoAllInput } from "../data/queries.ts";
import { useTransport } from "../data/transport.ts";
import { useNow } from "../data/use-now.ts";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog.tsx";
import { DevicesDialog } from "./DevicesDialog.tsx";
import { HostCard } from "./HostCard.tsx";
import { GlobalAutoPill, IconBtn } from "./HostSections.tsx";
import { makeStyles, seriesColors, type Styles } from "./theme.ts";

/** Which bar is which: top = 5 h session, bottom = 7 d week. */
function SeriesLegend(p: { styles: Styles; theme: PluginTheme }) {
  const s = seriesColors(p.theme);
  return (
    <View style={[p.styles.row, { gap: 6 }]} accessibilityLabel="Barra superior: 5 horas. Barra inferior: 7 días. Las cuentas Ultra no tienen límite de 5 horas: solo muestran la de 7 días.">
      {[["5h", s.session], ["7d", s.weekly]].map(([label, color]) => (
        <View key={label} style={[p.styles.row, { gap: 3 }]}>
          <View style={{ width: 8, height: 3, borderRadius: 1, backgroundColor: color }} />
          <Text style={p.styles.tiny}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The confirmation for turning automatic rotation on in several devices at once. */
function autoAllRequest(summary: GlobalAuto, onConfirm: () => void): ConfirmRequest {
  const idle = summary.targets.filter((t) => t.auto?.current === null).map((t) => t.label);
  return {
    title: "Activar rotación automática",
    message: `LLMswapper cambiará de cuenta solo al superar el umbral en ${plural(summary.targets.length, "equipo", "equipos")}: ${summary.targets.map((t) => `${t.label} (${t.auto?.threshold ?? "?"} %)`).join(", ")}.`,
    notes: [
      "Cada 3 minutos el LLMswapper de cada equipo lee el consumo de su cuenta activa y, al superar el umbral, el de todas las demás: gasta parte del presupuesto de la API de uso, o ~9 tokens por lectura en las cuentas de token pegado.",
      "Cada equipo rota por su cuenta, con su propio umbral.",
      ...(idle.length ? [`${idle.join(", ")}: sin cuenta activa registrada; no rotará${idle.length === 1 ? "" : "n"} hasta el primer cambio de cuenta.`] : []),
    ],
    confirmLabel: "Activar",
    onConfirm,
  };
}

const RANK: Record<PluginHostSummary["status"], number> = { online: 0, connecting: 1, idle: 2, error: 3, offline: 4 };

/** Every device: local host first (even if useHosts lacks it), then by status, then label. */
export function sortHosts(all: readonly PluginHostSummary[], local: { id: string; label: string }): PluginHostSummary[] {
  const list = all.some((h) => h.serverId === local.id) ? [...all] : [{ serverId: local.id, label: local.label, status: "online" as const }, ...all];
  return list.sort((a, b) => (a.serverId === local.id ? -1 : b.serverId === local.id ? 1 : RANK[a.status] - RANK[b.status] || a.label.localeCompare(b.label)));
}

/** The devices the panel shows: hidden ones dropped (the local host always shows). */
export function orderHosts(all: readonly PluginHostSummary[], local: { id: string; label: string }, hidden: (serverId: string) => boolean): PluginHostSummary[] {
  return sortHosts(all, local).filter((h) => h.serverId === local.id || !hidden(h.serverId));
}

export function Dashboard(p: { theme: PluginTheme; layout: PluginHostProps["layout"]; host: { id: string; label: string }; variant: "panel" | "screen" }) {
  const styles = useMemo(() => makeStyles(p.theme, p.layout.compact), [p.theme, p.layout.compact]);
  const hosts = useHosts();
  const settings = useSettings(swapperSettings);
  const values = settings.status === "ready" ? settings.values : null;
  const transport = useTransport(p.host.id);
  const qc = useQueryClient();
  const now = useNow(15_000);
  const fetching = useIsFetching({ queryKey: qk.all }) > 0;
  const refreshMs = values && values.autoRefreshMinutes > 0 ? values.autoRefreshMinutes * 60_000 : false;
  const flags = usePanelFlags();
  const [devicesOpen, setDevicesOpen] = useState(false);
  // A device in the middle of a swap or an auto change stays until it settles, so its outcome is still shown.
  const swapping = useMutationState({ filters: { status: "pending", mutationKey: qk.mutations }, select: (m) => String(m.options.mutationKey?.[2] ?? "") });
  const autoAll = useMutationState({ filters: { status: "pending", mutationKey: qk.autoAll }, select: (m) => (m.state.variables as AutoAllInput | undefined)?.ids ?? [] });
  const busy = new Set([...swapping, ...autoAll.flat()]);
  const list = orderHosts(hosts, p.host, (id) => flags.hidden(id) && !busy.has(id));
  const toggleHidden = (id: string) => {
    const hide = !flags.hidden(id);
    flags.toggle(id, "hidden");
    if (hide) void dropQueuedUsage(qc, id);
    else void markForReread(qc, id);
  };
  const isOnline = (h: PluginHostSummary) => h.status === "online" || h.serverId === p.host.id;
  const online = list.filter(isOnline).length;
  const toast = useToast();

  // One switch for automatic rotation on every device shown here (each card keeps its own).
  const states = useCachedStates(list.map((h) => h.serverId));
  const summary = globalAuto(list.map((h, i) => {
    const st = states[i];
    return { id: h.serverId, label: h.label, auto: st?.auto ?? null, usable: !!st && transport.enabled(h.serverId) && isOnline(h) && !st.health.staleMount };
  }));
  const setAutoMany = useSetAutoMany(transport);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const runAutoAll = () => {
    const { targets, turnOn } = summary;
    setAutoMany.mutate({ ids: targets.map((t) => t.id), enabled: turnOn }, {
      onSuccess: (results) => {
        const failed = results.filter((r) => r.error);
        const done = results.length - failed.length;
        const skipped = summary.skipped ? `; ${plural(summary.skipped, "equipo sin conexión no cambia", "equipos sin conexión no cambian")}` : "";
        if (done) toast.show(`Rotación automática ${turnOn ? "activada" : "desactivada"} en ${plural(done, "equipo", "equipos")}${skipped}`, { variant: "success" });
        for (const r of failed) {
          const label = targets.find((t) => t.id === r.id)?.label ?? r.id;
          toast.error(`${label}: ${r.error ? describeError(r.error).title : "no se pudo cambiar"}`);
        }
      },
    });
  };
  const pressAutoAll = () => (summary.turnOn ? setConfirm(autoAllRequest(summary, runAutoAll)) : runAutoAll());

  return (
    <View style={styles.root}>
      <View style={[styles.row, { paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.theme.colors.border }]}>
        {/* In a narrow sidebar the title gives way first: the tab already says LLMswapper. */}
        <Text style={[styles.hostName, { flex: 1, minWidth: 0 }]} numberOfLines={1}>LLMswapper</Text>
        <GlobalAutoPill summary={summary} busy={setAutoMany.isPending} onPress={pressAutoAll} styles={styles} theme={p.theme} />
        <SeriesLegend styles={styles} theme={p.theme} />
        <Text style={[styles.tiny, { flexShrink: 0 }]} accessibilityLabel={`${online} de ${list.length} equipos en línea`}>{`${online}/${list.length}`}</Text>
        <IconBtn icon="RefreshCw" label="Actualizar todo" busy={fetching} onPress={() => void refreshAll(qc)} styles={styles} theme={p.theme} />
        <IconBtn icon="Settings" label="Dispositivos del panel" onPress={() => setDevicesOpen(true)} styles={styles} theme={p.theme} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 10, gap: 14 }}>
        {list.map((h) => (
          <HostCard key={h.serverId} host={h} isPluginHost={h.serverId === p.host.id} transport={transport} refreshMs={refreshMs} now={now}
            collapsed={flags.collapsed(h.serverId)} onToggleCollapsed={() => flags.toggle(h.serverId, "collapsed")} styles={styles} theme={p.theme} />
        ))}
        {list.length === 0 ? <Text style={styles.tiny}>No hay hosts configurados en Paseo.</Text> : null}
      </ScrollView>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} styles={styles} theme={p.theme} />
      <DevicesDialog open={devicesOpen} onClose={() => setDevicesOpen(false)} hosts={sortHosts(hosts, p.host)} localId={p.host.id}
        hidden={flags.hidden} onToggle={toggleHidden} styles={styles} theme={p.theme} />
    </View>
  );
}
