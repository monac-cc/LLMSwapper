import { createSerialGate } from "../../shared/gate.ts";
import { realClock } from "../bridge/poll.ts";

/** Spacing between /api/usage/all reads of different devices (judgment call; tune here). */
export const USAGE_SPACING_MS = 20_000;
export const usageGate = createSerialGate(USAGE_SPACING_MS, realClock);
