import { z } from "zod";

/** One HTTP exchange with LLMswapper, already whitelisted. s=0 means no HTTP response (see e). */
export const RawResult = z.object({ s: z.number().int(), j: z.unknown(), e: z.string().nullable() });
export type RawResult = z.infer<typeof RawResult>;
/** Keyed by PlanRequest.key. Produced by server/executor.ts (fetch) or by the bridge script. */
export type ExecResults = Readonly<Record<string, RawResult>>;
