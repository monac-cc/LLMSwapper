import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostSummary } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { describeError } from "../../shared/error-text.ts";
import { formatAgo } from "../../shared/format.ts";
import type { BriefView, StateView } from "../../shared/views.ts";
import { forgetHost, opErrorOf, refreshHost, useHostBusy, useHostState, useHostUsage } from "../data/queries.ts";
import type { Transport } from "../data/transport.ts";
import { useHostActions } from "../data/use-host-actions.ts";
import { AccountTile } from "./AccountTile.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { AutoPill, CompactWarnings, EnvChips, IconBtn, InlineNotice } from "./HostSections.tsx";
import type { Styles } from "./theme.ts";

const STATUS_TEXT: Record<PluginHostSummary["status"], string> = {
  online: "en línea", connecting: "conectando…", idle: "inactivo", offline: "desconectado", error: "error de conexión",
};

function briefFor(state: StateView, id: string): BriefView | undefined {
  const a = state.auto;
  if (!a) return undefined;
  return a.current?.id === id ? a.current : a.queue.find((q) => q.id === id);
}

/** One host: a single header line, a few one-line notices, then a wrapping row of account tiles. */
export function HostCard(p: {
  host: PluginHostSummary; isPluginHost: boolean; transport: Transport; refreshMs: number | false; now: number; styles: Styles; theme: PluginTheme;
}) {
  const { host, styles, theme, now, transport: t } = p;
  const id = host.serverId;
  const qc = useQueryClient();
  const state = useHostState(t, host, p.refreshMs);
  const usage = useHostUsage(t, host, p.refreshMs);
  const busy = useHostBusy(id);
  const a = useHostActions(t, host);

  const online = host.status === "online" || p.isPluginHost;
  const enabled = t.enabled(id);
  // Not opted in (or settings unreadable): no cached accounts, swap buttons or auto switch. The transport
  // refuses the ops anyway; this keeps the card from offering them.
  const data = enabled ? state.data : undefined;
  const stateError = enabled ? opErrorOf(state.error) : null;
  const usageError = opErrorOf(usage.error);
  const fetching = state.isFetching || usage.isFetching;
  const locked = !enabled || !online || busy || data?.health.staleMount === true;
  const optedOut = t.settingsReady && !enabled; // definitive (not "settings still loading")
  useEffect(() => {
    if (optedOut) forgetHost(qc, id);
  }, [optedOut, qc, id]);
  const refresh = () => void refreshHost(qc, id);
  const dot = online ? theme.colors.statusSuccess : host.status === "connecting" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  const usable = (data?.targets ?? []).filter((x) => x.swappable);

  return (
    <View style={styles.hostBlock}>
      <View style={styles.hostHeader}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <Text style={styles.hostName} numberOfLines={1}>{host.label}</Text>
        {t.kind(id) === "bridge" && enabled ? <Text style={styles.tiny}>· terminal</Text> : null}
        {data ? <EnvChips targets={data.targets} accounts={data.accounts} styles={styles} theme={theme} /> : null}
        {data ? <AutoPill auto={data.auto} disabled={locked} onToggle={(v) => a.toggleAuto(v, data)} styles={styles} theme={theme} /> : null}
        <View style={{ flex: 1 }} />
        <Text style={styles.tiny}>{data && state.dataUpdatedAt ? formatAgo(state.dataUpdatedAt, now) : STATUS_TEXT[host.status]}</Text>
        {enabled ? (
          <IconBtn icon="RefreshCw" label={`Actualizar ${host.label}`} busy={fetching} disabled={!online} onPress={refresh} styles={styles} theme={theme} />
        ) : null}
      </View>

      {!enabled ? (
        <View style={styles.row}>
          <Text style={[styles.tiny, { flex: 1 }]} numberOfLines={2}>
            {a.optInBlocked ?? "Sin el plugin en este equipo. Para verlo, el panel ejecuta un script corto con «node» en una terminal temporal."}
          </Text>
          <Pressable accessibilityRole="button" disabled={!a.canOptIn || !online} onPress={a.askOptIn}
            style={[styles.pill, { borderColor: theme.colors.accent }, !a.canOptIn || !online ? styles.disabled : null]}>
            <Text style={[styles.tiny, { color: theme.colors.accent }]}>Activar</Text>
          </Pressable>
        </View>
      ) : null}

      {enabled && !online ? (
        <InlineNotice tone="muted" styles={styles} theme={theme}
          text={data ? `Sin conexión: datos de ${formatAgo(state.dataUpdatedAt, now)}, cambios desactivados.` : "Sin conexión con el equipo."} />
      ) : null}

      {enabled && online && !data && state.isFetching ? (
        <View style={styles.row}>
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          <Text style={styles.tiny}>{t.kind(id) === "rpc" ? "Leyendo LLMswapper…" : "Leyendo por terminal remota…"}</Text>
        </View>
      ) : null}

      {!data && stateError ? (() => {
        const d = describeError(stateError);
        return <InlineNotice tone="danger" text={d.hint ? `${d.title}. ${d.hint}` : d.title} styles={styles} theme={theme}
          action={online ? { label: "Reintentar", onPress: refresh } : undefined} />;
      })() : null}

      {data ? (
        <>
          {stateError ? (
            <InlineNotice tone="warning" text={`No se pudo actualizar (${describeError(stateError).title}); datos de ${formatAgo(state.dataUpdatedAt, now)}.`} styles={styles} theme={theme} />
          ) : null}
          {a.notice ? (
            <InlineNotice tone={a.notice.tone} text={[a.notice.title, ...a.notice.lines].join(" · ")} onClose={a.clearNotice} styles={styles} theme={theme}
              action={a.notice.restoreDir ? { label: "Copiar ruta", onPress: () => void copyText(a.notice?.restoreDir ?? "") } : undefined} />
          ) : null}
          <CompactWarnings warnings={data.warnings} styles={styles} theme={theme} />
          {usageError ? <InlineNotice tone="muted" text={`Consumo no disponible: ${describeError(usageError).title}.`} styles={styles} theme={theme} /> : null}
          {data.accounts.length === 0 ? <Text style={styles.tiny}>LLMswapper no tiene cuentas guardadas en este equipo.</Text> : null}
          <View style={styles.tiles}>
            {data.accounts.map((acc) => (
              <AccountTile key={acc.id} account={acc} targets={data.targets} usage={usage.data?.byId[acc.id]} brief={briefFor(data, acc.id)}
                disabled={locked || !acc.swappable || usable.every((x) => x.activeId === acc.id)}
                pending={a.pendingSwap?.accountId === acc.id} onPress={() => a.chooseSwap(acc, data)}
                now={now} styles={styles} theme={theme} />
            ))}
          </View>
        </>
      ) : null}

      <ConfirmDialog request={a.confirm} onClose={a.closeConfirm} styles={styles} theme={theme} />
    </View>
  );
}
