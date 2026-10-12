/** Minimal clock so the gate is unit-testable without timers. */
export interface GateClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * FIFO gate: one task at a time, at least `spacingMs` between the END of one task and the START of
 * the next. Aborted tasks leave the queue without running and without pushing later tasks back.
 * Used for /api/usage/all across devices (they may share Anthropic's per-IP/per-token limit).
 */
export function createSerialGate(spacingMs: number, clock: GateClock) {
  let tail: Promise<void> = Promise.resolve();
  let lastEnd = Number.NEGATIVE_INFINITY;
  let queued = 0;
  async function run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const prev = tail;
    let release: () => void = () => undefined;
    tail = new Promise<void>((resolve) => (release = resolve));
    let inQueue = true;
    queued++;
    const leave = () => {
      if (inQueue) {
        inQueue = false;
        queued--;
      }
    };
    try {
      await prev;
      if (signal?.aborted) throw new Error("Cancelado");
      const wait = lastEnd + spacingMs - clock.now();
      if (wait > 0) await clock.sleep(wait, signal);
      leave();
      try {
        return await fn();
      } finally {
        lastEnd = clock.now();
      }
    } finally {
      leave();
      release();
    }
  }
  /** Tasks waiting for their turn (not the running one). */
  return { run, queued: () => queued };
}
