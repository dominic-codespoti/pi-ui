import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCompactionWatchdog } from '../compaction-watchdog';

describe('createCompactionWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onTimeout exactly once when the deadline expires', () => {
    const onTimeout = vi.fn();
    const w = createCompactionWatchdog({ timeoutMs: 1000, onTimeout });

    w.start('s1');
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith('s1');
  });

  it('clear() before expiry disarms the deadline (normal compaction_end)', () => {
    const onTimeout = vi.fn();
    const w = createCompactionWatchdog({ timeoutMs: 1000, onTimeout });

    w.start('s1');
    w.clear('s1');
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('start() is idempotent — duplicate compaction_start events do not extend or duplicate the deadline', () => {
    const onTimeout = vi.fn();
    const w = createCompactionWatchdog({ timeoutMs: 1000, onTimeout });

    w.start('s1');
    w.start('s1');
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('tracks sessions independently', () => {
    const onTimeout = vi.fn();
    const w = createCompactionWatchdog({ timeoutMs: 1000, onTimeout });

    w.start('s1');
    w.start('s2');
    w.clear('s1');
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith('s2');
  });

  it('a cleared session can be re-armed (user triggers compaction again after a timeout)', () => {
    const onTimeout = vi.fn();
    const w = createCompactionWatchdog({ timeoutMs: 1000, onTimeout });

    w.start('s1');
    w.clear('s1');
    w.start('s1');
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith('s1');
  });
});
