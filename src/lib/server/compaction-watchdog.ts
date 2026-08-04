/**
 * Watchdog for stuck context compaction.
 *
 * The pi SDK's `AgentSession.compact()` emits `compaction_end` on every normal
 * path — success, error, and abort. A compaction that never settles means the
 * promise is wedged (e.g. the summary LLM call or an extension hook such as
 * `session_before_compact`/`session_compact` never completing). Without a
 * watchdog the client's "compacting…" spinner and the session's `isCompacting`
 * flag stay stuck forever.
 *
 * The server starts a per-session deadline when `compaction_start` is seen and
 * clears it on `compaction_end`. If the deadline expires the session is
 * aborted and a synthetic `compaction_end` is broadcast so the client seals
 * its spinner.
 */
export interface CompactionWatchdog {
  /** Arm (or re-arm) the deadline for a session. Idempotent per session. */
  start(sid: string): void;
  /** Disarm the deadline for a session (normal compaction_end). */
  clear(sid: string): void;
}

export function createCompactionWatchdog(opts: {
  /** Max wall-clock time a compaction may run before it is considered stuck. */
  timeoutMs: number;
  /** Called when the deadline expires for a session. */
  onTimeout: (sid: string) => void;
}): CompactionWatchdog {
  const { timeoutMs, onTimeout } = opts;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    start(sid) {
      // Already watched — a compaction cannot legitimately restart mid-run;
      // keep the original deadline so a runaway loop cannot keep pushing it.
      if (timers.has(sid)) return;
      timers.set(
        sid,
        setTimeout(() => {
          timers.delete(sid);
          onTimeout(sid);
        }, timeoutMs)
      );
    },
    clear(sid) {
      const t = timers.get(sid);
      if (t) clearTimeout(t);
      timers.delete(sid);
    },
  };
}
