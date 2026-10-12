import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { Btn } from "./primitives.tsx";
import type { Styles } from "./theme.ts";

export interface ConfirmOption {
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
}

/** Either one confirm button (`onConfirm`) or a choice where each option IS the confirmation (`options`). */
export interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  readonly notes: readonly string[];
  readonly confirmLabel?: string;
  readonly onConfirm?: () => void;
  readonly options?: readonly ConfirmOption[];
}

export function ConfirmDialog(p: { request: ConfirmRequest | null; onClose(): void; styles: Styles; theme: PluginTheme }) {
  const r = p.request;
  const pick = (fn: () => void) => { fn(); p.onClose(); };
  return (
    <Modal title={r?.title ?? ""} open={r !== null} onOpenChange={(open) => { if (!open) p.onClose(); }}>
      <Modal.Content>
        <Text style={p.styles.text}>{r?.message}</Text>
        {r?.notes.map((n) => <Text key={n} style={p.styles.muted}>{`• ${n}`}</Text>)}
        {r?.options ? (
          <View style={[p.styles.wrap, { justifyContent: "flex-end" }]}>
            {r.options.map((o) => (
              <Btn key={o.label} label={o.label} primary={!o.disabled} disabled={o.disabled} onPress={() => pick(o.onSelect)} styles={p.styles} theme={p.theme} />
            ))}
            <Btn label="Cancelar" onPress={p.onClose} styles={p.styles} theme={p.theme} />
          </View>
        ) : (
          <View style={[p.styles.row, { justifyContent: "flex-end" }]}>
            <Btn label="Cancelar" onPress={p.onClose} styles={p.styles} theme={p.theme} />
            <Btn label={r?.confirmLabel ?? "Aceptar"} primary onPress={() => pick(() => r?.onConfirm?.())} styles={p.styles} theme={p.theme} />
          </View>
        )}
      </Modal.Content>
    </Modal>
  );
}
