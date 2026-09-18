/**
 * Bounded coalescing for cumulative tool execution updates.
 *
 * Tool update payloads are cumulative, so retaining only the newest payload for
 * each tool call is sufficient. A single short timer gives bursts one render /
 * wire frame while explicit flushes preserve lifecycle ordering.
 */
export interface ToolUpdateCoalescer<T> {
  /** Retain the newest cumulative update and schedule a cadence flush. */
  enqueue(toolCallId: string, update: T): void;
  /** Flush one tool call immediately, if it has a pending update. */
  flush(toolCallId: string): void;
  /** Flush every pending tool call in insertion order. */
  flushAll(): void;
  /** Drop one pending update, or all pending updates when no id is supplied. */
  cancel(toolCallId?: string): void;
  /** Cancel the timer and drop all pending updates permanently. */
  dispose(): void;
}

export interface ToolUpdateCoalescerOptions {
  /** Delay between the first update in a burst and its flush. Defaults to 50ms. */
  cadenceMs?: number;
  /** Maximum number of tool-call updates retained at once. Defaults to 128. */
  maxPending?: number;
}

const DEFAULT_CADENCE_MS = 50;
const DEFAULT_MAX_PENDING = 128;

export function createToolUpdateCoalescer<T>(
  onFlush: (toolCallId: string, update: T) => void,
  options: ToolUpdateCoalescerOptions = {}
): ToolUpdateCoalescer<T> {
  const cadenceMs = normalizePositiveInt(options.cadenceMs, DEFAULT_CADENCE_MS, true);
  const maxPending = normalizePositiveInt(options.maxPending, DEFAULT_MAX_PENDING, false);
  const pending = new Map<string, T>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = (toolCallId: string): void => {
    if (!pending.has(toolCallId)) return;
    const update = pending.get(toolCallId) as T;
    pending.delete(toolCallId);
    try {
      onFlush(toolCallId, update);
    } catch {
      // The update has already been removed, so a failed callback cannot
      // strand this entry or prevent other pending entries from flushing.
    }
    if (pending.size === 0) clearTimer();
  };

  const flushAll = (): void => {
    // Snapshot ids first: onFlush may synchronously enqueue a newer update.
    const ids = [...pending.keys()];
    for (const toolCallId of ids) flush(toolCallId);
    if (pending.size === 0) clearTimer();
  };

  const schedule = (): void => {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      flushAll();
    }, cadenceMs);
  };

  return {
    enqueue(toolCallId, update) {
      if (disposed) return;
      if (!pending.has(toolCallId) && pending.size >= maxPending) {
        // Preserve the oldest update rather than silently dropping it. The map
        // remains bounded even if many tools stream concurrently.
        const oldest = pending.keys().next().value as string | undefined;
        if (oldest !== undefined) flush(oldest);
      }
      pending.set(toolCallId, update);
      schedule();
    },
    flush(toolCallId) {
      if (disposed) return;
      flush(toolCallId);
    },
    flushAll() {
      if (disposed) return;
      flushAll();
    },
    cancel(toolCallId) {
      if (toolCallId === undefined) pending.clear();
      else pending.delete(toolCallId);
      if (pending.size === 0) clearTimer();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending.clear();
      clearTimer();
    },
  };
}

function normalizePositiveInt(
  value: number | undefined,
  fallback: number,
  allowZero: boolean
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  if (normalized < (allowZero ? 0 : 1)) return fallback;
  return normalized;
}
