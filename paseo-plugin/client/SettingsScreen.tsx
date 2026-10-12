import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { getPaseoClient, useHosts, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { swapperSettings, type HostEntry, type SwapperSettings } from "../shared/contracts.ts";
import { NODE_COMMAND_RE } from "../shared/ids.ts";
import { messageOf } from "./bridge/errors.ts";
import { listBridgeWorkspaces, type BridgeWorkspace } from "./bridge/workspace.ts";
import { mergeHostEntry } from "./data/host-settings.ts";
import { publishRouting } from "./data/transport.ts";

const REFRESH_OPTIONS = [
  { label: "Desactivada", value: "0" }, { label: "Cada 5 min", value: "5" }, { label: "Cada 10 min", value: "10" },
  { label: "Cada 15 min", value: "15" }, { label: "Cada 30 min", value: "30" },
] as const;
type RefreshValue = (typeof REFRESH_OPTIONS)[number]["value"];

// ---- text fields: what is on screen is either in the draft or flagged (never a silently different value) ----
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function parsePort(text: string): Parsed<number> {
  const s = text.trim();
  const n = Number(s);
  return /^\d{1,5}$/.test(s) && n >= 1 && n <= 65535 ? { ok: true, value: n } : { ok: false, error: "Puerto no válido: un número entre 1 y 65535." };
}

/** "" or "node" = default (key removed); otherwise an absolute path accepted by NODE_COMMAND_RE. */
function parseNodeCommand(text: string): Parsed<string | undefined> {
  const s = text.trim();
  if (s === "" || s === "node") return { ok: true, value: undefined };
  if (NODE_COMMAND_RE.test(s)) return { ok: true, value: s };
  return { ok: false, error: s.includes("\"") ? "Quita las comillas: escribe la ruta tal cual." : "Escribe «node» o la ruta absoluta del ejecutable (C:\\… o /…)." };
}

// ---- draft ----
interface Form {
  readonly draft: SwapperSettings;
  /** Revision the draft was seeded from. Saves go against it: a change made elsewhere is a conflict, never a silent overwrite. */
  readonly base: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  /** Field -> error of text that does not parse. Guardar is blocked while any is present. */
  readonly invalid: Readonly<Record<string, string>>;
  /** Bumped on every (re)seed: keys the uncontrolled inputs so they always show the draft. */
  readonly gen: number;
}

const seed = (prev: Form | null, values: SwapperSettings, revision: string): Form =>
  ({ draft: values, base: revision, dirty: false, saving: false, invalid: {}, gen: (prev?.gen ?? 0) + 1 });

function flag(f: Form, field: string, error: string | null): Form {
  const invalid: Record<string, string> = { ...f.invalid };
  if (error) invalid[field] = error;
  else delete invalid[field];
  return { ...f, invalid, dirty: true };
}

const withEntry = (d: SwapperSettings, id: string, patch: Partial<HostEntry>): SwapperSettings =>
  ({ ...d, hosts: { ...d.hosts, [id]: mergeHostEntry(d.hosts[id], patch) } });

/** Workspaces of a remote host for the bridge picker (a read: no terminal is created). */
function useRemoteWorkspaces(serverId: string, online: boolean) {
  const [state, setState] = useState<{ list: BridgeWorkspace[]; error: string | null }>({ list: [], error: null });
  useEffect(() => {
    if (!online) return;
    let alive = true;
    Promise.resolve()
      .then(() => listBridgeWorkspaces(getPaseoClient(serverId).workspaces)) // getPaseoClient throws synchronously when offline
      .then((list) => alive && setState({ list, error: null }))
      .catch((e: unknown) => alive && setState({ list: [], error: messageOf(e) }));
    return () => {
      alive = false;
    };
  }, [serverId, online]);
  return state;
}

function HostSettings(p: {
  serverId: string; label: string; online: boolean; entry: HostEntry; gen: number; disabled: boolean;
  portError: string | null; nodeError: string | null;
  onChange(patch: Partial<HostEntry>): void; onPortText(text: string): void; onNodeText(text: string): void;
}) {
  const ws = useRemoteWorkspaces(p.serverId, p.online && p.entry.bridge);
  const options = [{ label: "Automático (el menos usado)", value: "" }, ...ws.list.map((w) => ({ label: w.label, value: w.workspaceId }))];
  if (p.entry.workspaceId && !ws.list.some((w) => w.workspaceId === p.entry.workspaceId)) {
    options.push({ label: `${p.entry.workspaceId} (no disponible ahora)`, value: p.entry.workspaceId });
  }
  return (
    <SettingsSection title={p.label}>
      <SettingsSwitch label="Leer LLMswapper por terminal" hint="Ejecuta «node» unos segundos en una terminal temporal de ese equipo."
        value={p.entry.bridge} disabled={p.disabled} onValueChange={(v) => p.onChange({ bridge: v })} />
      <SettingsInput key={`port:${p.gen}`} label="Puerto de LLMswapper" initialValue={String(p.entry.port)} error={p.portError}
        disabled={p.disabled} onChangeText={p.onPortText} />
      <SettingsSelect<string> label="Workspace para el puente" hint="Puede aparecer brevemente una pestaña «LLMswapper» en él."
        error={ws.error} value={p.entry.workspaceId ?? ""} options={options} disabled={p.disabled || !p.entry.bridge}
        onValueChange={(v) => p.onChange({ workspaceId: v || undefined })} />
      <SettingsInput key={`node:${p.gen}`} label="Node.js" hint="«node» o ruta absoluta si el daemon de ese equipo no lo tiene en el PATH"
        initialValue={p.entry.nodeCommand ?? "node"} error={p.nodeError} disabled={p.disabled} onChangeText={p.onNodeText} />
      <SettingsSwitch label="Ocultar en el panel" value={p.entry.hidden} disabled={p.disabled} onValueChange={(v) => p.onChange({ hidden: v })} />
    </SettingsSection>
  );
}

export function SettingsScreen({ host }: PluginSurfaceProps) {
  const settings = useSettings(swapperSettings);
  const hosts = useHosts();
  const [form, setForm] = useState<Form | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const revision = settings.status === "ready" ? settings.revision : null;
  // Panels that already queued a bridge read must see an opt-out saved here even if they have unmounted.
  if (settings.status === "ready") publishRouting(host.id, settings.values);

  // Seed, and re-seed after a save (here or elsewhere), ONLY while there are no unsaved edits.
  useEffect(() => {
    if (settings.status !== "ready") return;
    const { values, revision: rev } = settings;
    setForm((f) => (f && (f.dirty || f.saving || f.base === rev) ? f : seed(f, values, rev)));
  }, [revision, form?.dirty, form?.saving]);

  if (settings.status === "loading" || (settings.status === "ready" && !form)) {
    return (
      <SettingsSection title="LLMswapper">
        <SettingsRow label="Cargando ajustes…" />
      </SettingsSection>
    );
  }
  if (settings.status === "error") {
    return (
      <SettingsSection title="LLMswapper">
        <SettingsAction label="No se pudieron leer los ajustes" hint="Comprueba que este host está conectado y que tienes permiso daemon.manage."
          error={settings.error} actionLabel="Reintentar" onPress={() => void settings.reload()} />
      </SettingsSection>
    );
  }
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="LLMswapper">
        <SettingsAction label="Los ajustes guardados no son válidos" hint="Puede que los guardara una versión más nueva del plugin."
          error={settings.error} actionLabel="Recargar" disabled={settings.saving} onPress={() => void settings.reload()} />
        <SettingsAction label="Restablecer valores por defecto"
          hint={resetArmed ? "Pulsa otra vez para confirmar: se pierden los ajustes guardados y la lectura por terminal queda desactivada en todos los equipos." : "Borra el documento guardado."}
          error={settings.saveError} actionLabel={settings.saving ? "Restableciendo…" : resetArmed ? "Confirmar" : "Restablecer"} disabled={settings.saving}
          onPress={() => {
            if (!resetArmed) return setResetArmed(true);
            setResetArmed(false);
            void settings.reset();
          }} />
      </SettingsSection>
    );
  }
  if (!form) return null; // unreachable: narrowed above

  const current = settings; // status "ready"
  const update = (fn: (f: Form) => Form) => setForm((f) => (f ? fn(f) : f));
  const setDraft = (fn: (d: SwapperSettings) => SwapperSettings) => update((f) => ({ ...f, draft: fn(f.draft), dirty: true }));
  const portText = (field: string, text: string, apply: (d: SwapperSettings, port: number) => SwapperSettings) => {
    const r = parsePort(text);
    update((f) => flag(r.ok ? { ...f, draft: apply(f.draft, r.value) } : f, field, r.ok ? null : r.error));
  };
  const nodeText = (id: string, text: string) => {
    const r = parseNodeCommand(text);
    update((f) => flag(r.ok ? { ...f, draft: withEntry(f.draft, id, { nodeCommand: r.value }) } : f, `${id}.node`, r.ok ? null : r.error));
  };
  const save = async () => {
    if (form.saving) return;
    const { draft, base } = form;
    setForm({ ...form, saving: true });
    const ok = await current.save(draft, base);
    if (ok) publishRouting(host.id, draft); // before the revision push re-renders anyone
    // ok: pristine again, the effect re-seeds from the saved document (its new revision is already in place).
    update((f) => ({ ...f, saving: false, dirty: ok ? false : f.dirty }));
  };

  const { draft } = form;
  const conflict = !form.saving && form.dirty && current.revision !== form.base;
  const others = hosts.filter((h) => h.serverId !== host.id);
  const fields = ["localPort", ...others.flatMap((h) => [`${h.serverId}.port`, `${h.serverId}.node`])];
  const invalid = fields.some((k) => form.invalid[k] !== undefined); // only fields on screen can block Guardar
  const busy = form.saving;

  return (
    <View>
      <SettingsSection title={`${host.label} (host del plugin)`}>
        <SettingsInput key={`localPort:${form.gen}`} label="Puerto de LLMswapper" hint="127.0.0.1, por defecto 7373" initialValue={String(draft.localPort)}
          error={form.invalid.localPort ?? null} disabled={busy}
          onChangeText={(t) => portText("localPort", t, (d, port) => ({ ...d, localPort: port }))} />
        <SettingsSelect<RefreshValue> label="Actualización automática" hint="Solo con el panel abierto; el consumo nunca se fuerza."
          value={String(draft.autoRefreshMinutes) as RefreshValue} options={REFRESH_OPTIONS} disabled={busy}
          onValueChange={(v) => setDraft((d) => ({ ...d, autoRefreshMinutes: Number(v) as SwapperSettings["autoRefreshMinutes"] }))} />
        <SettingsSwitch label="Diagnóstico: usar el puente por terminal también aquí" hint="Para probar el puente sin otro equipo. Abre pestañas temporales en este equipo."
          value={draft.bridgeForLocal} disabled={busy} onValueChange={(v) => setDraft((d) => ({ ...d, bridgeForLocal: v }))} />
      </SettingsSection>
      {others.map((h) => (
        <HostSettings key={h.serverId} serverId={h.serverId} label={h.label} online={h.status === "online"}
          entry={mergeHostEntry(draft.hosts[h.serverId])} gen={form.gen} disabled={busy}
          portError={form.invalid[`${h.serverId}.port`] ?? null} nodeError={form.invalid[`${h.serverId}.node`] ?? null}
          onChange={(patch) => setDraft((d) => withEntry(d, h.serverId, patch))}
          onPortText={(t) => portText(`${h.serverId}.port`, t, (d, port) => withEntry(d, h.serverId, { port }))}
          onNodeText={(t) => nodeText(h.serverId, t)} />
      ))}
      <SettingsSection title="Guardar">
        {conflict ? (
          <>
            <SettingsAction label="Los ajustes cambiaron en otro cliente" hint="Tus cambios sin guardar parten de la versión anterior."
              actionLabel="Descartar los míos" onPress={() => setForm(seed(form, current.values, current.revision))} />
            <SettingsAction label="Mantener mis cambios" hint="Al guardar se sobrescribe lo que se guardó desde el otro cliente."
              actionLabel="Mantener" onPress={() => update((f) => ({ ...f, base: current.revision }))} />
          </>
        ) : null}
        <SettingsAction label="Guardar ajustes" hint={form.dirty ? "Hay cambios sin guardar." : undefined}
          actionLabel={busy ? "Guardando…" : "Guardar"} disabled={busy || !form.dirty || invalid || conflict}
          error={invalid ? "Corrige los campos marcados antes de guardar." : current.saveError} onPress={() => void save()} />
        {current.saveError && !busy ? (
          <SettingsAction label="Volver a leer los ajustes guardados" hint="Tus cambios sin guardar se conservan."
            actionLabel="Recargar" onPress={() => void current.reload()} />
        ) : null}
      </SettingsSection>
    </View>
  );
}
