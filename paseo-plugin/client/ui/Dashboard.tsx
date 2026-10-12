import type { PluginTheme } from "@getpaseo/plugin";
import { useHosts, useSettings, type PluginHostProps, type PluginHostSummary } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { swapperSettings, type SwapperSettings } from "../../shared/contracts.ts";
import { qk, refreshAll } from "../data/queries.ts";
import { useTransport } from "../data/transport.ts";
import { useNow } from "../data/use-now.ts";
import { HostCard } from "./HostCard.tsx";
import { IconBtn } from "./HostSections.tsx";
import { makeStyles, seriesColors, type Styles } from "./theme.ts";

/** Which bar is which: top = 5 h session, bottom = 7 d week. */
function SeriesLegend(p: { styles: Styles; theme: PluginTheme }) {
  const s = seriesColors(p.theme);
  return (
    <View style={[p.styles.row, { gap: 6 }]} accessibilityLabel="Barra superior: 5 horas. Barra inferior: 7 días.">
      {[["5h", s.session], ["7d", s.weekly]].map(([label, color]) => (
        <View key={label} style={[p.styles.row, { gap: 3 }]}>
          <View style={{ width: 8, height: 3, borderRadius: 1, backgroundColor: color }} />
          <Text style={p.styles.tiny}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

const RANK: Record<PluginHostSummary["status"], number> = { online: 0, connecting: 1, idle: 2, error: 3, offline: 4 };

/** Local host first (even if useHosts lacks it), then by status, then label. Hidden hosts dropped. */
export function orderHosts(all: readonly PluginHostSummary[], local: { id: string; label: string }, settings: SwapperSettings | null): PluginHostSummary[] {
  const list = all.some((h) => h.serverId === local.id) ? [...all] : [{ serverId: local.id, label: local.label, status: "online" as const }, ...all];
  return list
    .filter((h) => h.serverId === local.id || !settings?.hosts[h.serverId]?.hidden)
    .sort((a, b) => (a.serverId === local.id ? -1 : b.serverId === local.id ? 1 : RANK[a.status] - RANK[b.status] || a.label.localeCompare(b.label)));
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
  const list = orderHosts(hosts, p.host, values);
  const online = list.filter((h) => h.status === "online" || h.serverId === p.host.id).length;

  return (
    <View style={styles.root}>
      <View style={[styles.row, { paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.theme.colors.border }]}>
        <Text style={[styles.hostName, { flex: 1 }]}>LLMswapper</Text>
        <SeriesLegend styles={styles} theme={p.theme} />
        <Text style={styles.tiny} numberOfLines={1}>{`${online}/${list.length} en línea`}</Text>
        <IconBtn icon="RefreshCw" label="Actualizar todo" busy={fetching} onPress={() => void refreshAll(qc)} styles={styles} theme={p.theme} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 10, gap: 14 }}>
        {list.map((h) => (
          <HostCard key={h.serverId} host={h} isPluginHost={h.serverId === p.host.id} transport={transport} refreshMs={refreshMs} now={now} styles={styles} theme={p.theme} />
        ))}
        {list.length === 0 ? <Text style={styles.tiny}>No hay hosts configurados en Paseo.</Text> : null}
      </ScrollView>
    </View>
  );
}
