/**
 * Per-phase timing for long, non-cancellable async work (SDK session
 * construction runs extensions, package loading and session_start handlers,
 * none of which can be aborted safely). Instead of a timeout it names the
 * phase that is stuck: a periodic warning while a phase runs, and a summary of
 * slow phases at the end.
 */
export interface PhaseTimerOptions {
  /** Phases at least this slow are listed by `slowPhases()`. */
  slowPhaseMs?: number;
  /** While a phase is running, warn at this interval. */
  stallWarnMs?: number;
  warn: (message: string) => void;
  now?: () => number;
}

export interface PhaseTimer {
  phase<T>(name: string, work: () => Promise<T>): Promise<T>;
  /** `" (slow: a 6000ms, b 9000ms)"`, or `''` when nothing was slow. */
  slowPhases(): string;
}

export function createPhaseTimer(label: string, options: PhaseTimerOptions): PhaseTimer {
  const { slowPhaseMs = 5_000, stallWarnMs = 30_000, warn, now = Date.now } = options;
  const phases: Array<[string, number]> = [];
  return {
    async phase<T>(name: string, work: () => Promise<T>): Promise<T> {
      const started = now();
      const stall = setInterval(() => {
        warn(`${label}: still in ${name} after ${Math.round((now() - started) / 1000)}s`);
      }, stallWarnMs);
      try {
        return await work();
      } finally {
        clearInterval(stall);
        phases.push([name, now() - started]);
      }
    },
    slowPhases(): string {
      const slow = phases.filter(([, ms]) => ms >= slowPhaseMs);
      return slow.length ? ` (slow: ${slow.map(([n, ms]) => `${n} ${ms}ms`).join(', ')})` : '';
    },
  };
}
