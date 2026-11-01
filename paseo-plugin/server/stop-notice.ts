// What a stopped session is told when it starts again on the new account. Pure and self-contained (no
// imports, no outer references): the quiet helper embeds these functions with Function.prototype.toString.

/** A background launch that was still running when the session was stopped, as found in its transcript. */
export type Launch =
  | { readonly kind: "workflow"; readonly name: string; readonly runId: string; readonly scriptPath: string; readonly args?: string | null }
  | { readonly kind: "agent"; readonly description: string; readonly agentId: string };

/** What a session's transcript says about the work Paseo still lists as running. */
export interface TranscriptFacts {
  /** By the tool_use id of the Workflow/Agent/SendMessage call that started it. */
  readonly launches: Map<string, Launch>;
  /** A workflow's original `args` (JSON), by the Workflow call's tool_use id: a resume needs the same ones. */
  readonly args: Map<string, string>;
  /** Background shells launched and not yet reported finished. */
  readonly openShells: Set<string>;
}

/**
 * Folds one line of a Claude Code transcript (JSONL) into `acc`. `toolUseIds`: the Workflow/Agent calls
 * Paseo still lists as running. Claude Code records a workflow's run id and script, and a background
 * agent's id (or, once continued with SendMessage, its resumedAgentId), in the call's `toolUseResult`;
 * the call's input holds a workflow's args; a background shell is open from its `backgroundTaskId`
 * until a task notification names it.
 */
export function readTranscriptLine(line: string, toolUseIds: ReadonlySet<string>, acc: TranscriptFacts): void {
  const hasResult = line.includes("toolUseResult"), hasUse = line.includes("tool_use"), hasNote = line.includes("task-id");
  if (!hasResult && !hasUse && !hasNote) return;
  let o: { type?: unknown; content?: unknown; attachment?: { prompt?: unknown }; message?: { content?: unknown }; toolUseResult?: Record<string, unknown> };
  try { o = JSON.parse(line); } catch { return; }
  if (!o || typeof o !== "object") return;
  const content = o.message && Array.isArray(o.message.content) ? (o.message.content as Record<string, unknown>[]) : [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (hasNote) {
    // A notification is a user message, or, when it arrives mid-turn, a queued command (attachment) or a queue line.
    const texts = (v: unknown): string => typeof v === "string" ? v
      : Array.isArray(v) ? v.map((c) => (c && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n") : "";
    const text = [texts(o.message && o.message.content), texts(o.attachment && o.attachment.prompt), texts(o.content)].join("\n");
    // One block per notification. A Monitor reports each event with an <event> and no <status>: still running.
    const blocks = text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? [text];
    for (const b of blocks) {
      if (/<event>/.test(b) && !/<status>/.test(b)) continue;
      for (const m of b.matchAll(/<task-id>([^<]+)<\/task-id>/g)) acc.openShells.delete(m[1]);
    }
  }
  for (const c of content) {
    if (c && c.type === "tool_use" && typeof c.id === "string" && toolUseIds.has(c.id) && /workflow/i.test(str(c.name))) {
      const input = c.input as { args?: unknown } | undefined;
      if (input && input.args !== undefined) acc.args.set(c.id, JSON.stringify(input.args));
    }
  }
  const r = o.toolUseResult;
  if (!r || typeof r !== "object") return;
  if (str(r.backgroundTaskId)) acc.openShells.add(str(r.backgroundTaskId)); // a background Bash/PowerShell command
  else if (str(r.taskId) && typeof r.persistent === "boolean") acc.openShells.add(str(r.taskId)); // a Monitor (workflows have a taskId too, not this flag)
  const call = content.find((c) => c && c.type === "tool_result" && typeof c.tool_use_id === "string" && toolUseIds.has(c.tool_use_id));
  if (!call) return;
  const toolUseId = call.tool_use_id as string;
  if (str(r.runId) && str(r.scriptPath)) acc.launches.set(toolUseId, { kind: "workflow", name: str(r.workflowName) || "workflow", runId: str(r.runId), scriptPath: str(r.scriptPath) });
  else if (str(r.agentId)) acc.launches.set(toolUseId, { kind: "agent", description: str(r.description), agentId: str(r.agentId) });
  else if (r.success === true && str(r.resumedAgentId)) acc.launches.set(toolUseId, { kind: "agent", description: "", agentId: str(r.resumedAgentId) });
}

export interface CutWork {
  /** A turn was running (or waiting for a permission) and was interrupted. */
  readonly turn: boolean;
  readonly launches: readonly Launch[];
  /** Running background tasks Paseo listed but the transcript did not explain (their descriptions). */
  readonly others: readonly string[];
  /** Background shells (servers, monitors, scripts) were running and were stopped. */
  readonly shells: boolean;
  /** Marks this notice, so the helper can tell it reached the conversation. */
  readonly nonce: string;
}

/** The message that sends a stopped session on: what was cut and how to pick each part up again. */
export function continuationMessage(cut: CutWork): string {
  const q = (s: string) => s.replace(/[\r\n]+/g, " ").slice(0, 200);
  const lines = [
    `[LLMswapper · aviso ${cut.nonce}] Se ha cambiado la cuenta de Claude de este equipo. Para no gastar más de la cuenta anterior, esta sesión se ha parado y ha vuelto a arrancar con la cuenta nueva, y lo que estaba en marcha se cortó:`,
  ];
  if (cut.turn) lines.push("- Tu respuesta en curso: retómala donde se quedó.");
  for (const l of cut.launches) {
    if (l.kind === "workflow") {
      const args = l.args == null ? "" : l.args.length <= 4000 ? ` y los mismos args que la primera vez (${l.args})` : " y los mismos args que la primera vez (están en esta conversación)";
      lines.push(`- El workflow «${q(l.name)}» (runId ${l.runId}): reanúdalo con la herramienta Workflow pasando scriptPath "${l.scriptPath}", resumeFromRunId "${l.runId}"${args}. Lo que ya terminó se reutiliza sin volver a ejecutarse; no lo relances desde cero.`);
    } else lines.push(`- El agente en segundo plano «${q(l.description || "agente")}» (id ${l.agentId}): continúalo con SendMessage a ese id, que retoma su contexto; si no se puede, vuelve a lanzarlo.`);
  }
  for (const d of cut.others) lines.push(`- La tarea en segundo plano «${q(d)}»: búscala en esta conversación. Si es un workflow, reanúdalo con resumeFromRunId; si es un agente, continúalo con SendMessage; si la lanzó uno de tus agentes, deja que él decida al retomarlo. Vuelve a lanzarla desde cero solo si no hay otra forma.`);
  if (cut.shells) lines.push("- Los comandos en segundo plano (servidores, monitores, scripts) se han detenido: vuelve a lanzar los que sigan haciendo falta.");
  if (lines.length === 1) lines.push("- Nada que se pudiera identificar: revisa si quedó algo a medias.");
  lines.push(`Antes de rehacer algo que pudo quedar a medias (ediciones, commits, despliegues), comprueba en qué estado quedó. Después sigue con lo que estabas haciendo. Si te llega otra copia de este aviso (${cut.nonce}), ignórala.`);
  return lines.join("\n");
}
