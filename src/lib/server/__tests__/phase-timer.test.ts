import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPhaseTimer } from '../phase-timer';

describe('createPhaseTimer', () => {
  afterEach(() => vi.useRealTimers());

  it('warns with the phase name while a phase is stuck, then stops', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const timer = createPhaseTimer('create new (/p)', { warn, stallWarnMs: 1_000 });
    let release!: () => void;
    const done = timer.phase('session_start', () => new Promise<void>((r) => (release = r)));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toBe('create new (/p): still in session_start after 2s');
    release();
    await done;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('lists only slow phases and still records failed ones', async () => {
    let t = 0;
    const timer = createPhaseTimer('x', { warn: () => {}, slowPhaseMs: 100, now: () => t });
    await timer.phase('fast', async () => {
      t += 10;
    });
    await timer.phase('slow', async () => {
      t += 250;
    });
    await expect(
      timer.phase('broken', async () => {
        t += 300;
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(timer.slowPhases()).toBe(' (slow: slow 250ms, broken 300ms)');
    expect(createPhaseTimer('y', { warn: () => {} }).slowPhases()).toBe('');
  });
});
