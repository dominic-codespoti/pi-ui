import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolUpdateCoalescer } from '../tool-update-coalescer';

afterEach(() => {
  vi.useRealTimers();
});

describe('tool-update-coalescer', () => {
  it('keeps the latest cumulative update independently for each tool call', () => {
    vi.useFakeTimers();
    const flushed: Array<[string, string]> = [];
    const coalescer = createToolUpdateCoalescer<string>((toolCallId, update) =>
      flushed.push([toolCallId, update])
    );

    coalescer.enqueue('tool-a', 'a1');
    coalescer.enqueue('tool-b', 'b1');
    coalescer.enqueue('tool-a', 'a2');
    expect(flushed).toEqual([]);

    vi.advanceTimersByTime(49);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([
      ['tool-a', 'a2'],
      ['tool-b', 'b1'],
    ]);
    coalescer.dispose();
  });

  it('contains timer callback failures and remains reusable for later schedules', () => {
    vi.useFakeTimers();
    const flushed: string[] = [];
    const coalescer = createToolUpdateCoalescer<string>((toolCallId, update) => {
      if (toolCallId === 'tool-a') throw new Error('render failed');
      flushed.push(`${toolCallId}:${update}`);
    });

    coalescer.enqueue('tool-a', 'a1');
    coalescer.enqueue('tool-b', 'b1');
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
    expect(flushed).toEqual(['tool-b:b1']);
    expect(vi.getTimerCount()).toBe(0);

    coalescer.enqueue('tool-c', 'c1');
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
    expect(flushed).toEqual(['tool-b:b1', 'tool-c:c1']);
    expect(vi.getTimerCount()).toBe(0);
    coalescer.dispose();
  });

  it('contains explicit flush callback failures before final event processing', () => {
    vi.useFakeTimers();
    const processed: string[] = [];
    const coalescer = createToolUpdateCoalescer<string>((toolCallId, update) => {
      if (toolCallId === 'tool-a') throw new Error('broadcast failed');
      processed.push(`${toolCallId}:${update}`);
    });

    coalescer.enqueue('tool-a', 'a1');
    coalescer.enqueue('tool-b', 'b1');
    expect(() => {
      coalescer.flush('tool-a');
      processed.push('final');
    }).not.toThrow();
    expect(processed).toEqual(['final']);

    coalescer.flush('tool-b');
    expect(processed).toEqual(['final', 'tool-b:b1']);
    expect(vi.getTimerCount()).toBe(0);
    coalescer.dispose();
  });

  it('flushes a pending partial before its final event can be forwarded', () => {
    const flushed: string[] = [];
    const coalescer = createToolUpdateCoalescer<string>((_, update) => flushed.push(update));

    coalescer.enqueue('tool-a', 'latest');
    coalescer.flush('tool-a');
    expect(flushed).toEqual(['latest']);
    coalescer.dispose();
  });

  it('cancels pending updates and leaves no timer after disposal', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const coalescer = createToolUpdateCoalescer(onFlush);

    coalescer.enqueue('tool-a', 'partial');
    expect(vi.getTimerCount()).toBe(1);
    coalescer.dispose();
    vi.runAllTimers();

    expect(onFlush).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    coalescer.enqueue('tool-a', 'ignored');
    vi.runAllTimers();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('bounds concurrent tool calls by flushing the oldest pending update', () => {
    const flushed: Array<[string, string]> = [];
    const coalescer = createToolUpdateCoalescer(
      (toolCallId, update: string) => flushed.push([toolCallId, update]),
      { maxPending: 2, cadenceMs: 1000 }
    );

    coalescer.enqueue('tool-a', 'a1');
    coalescer.enqueue('tool-b', 'b1');
    coalescer.enqueue('tool-c', 'c1');
    expect(flushed).toEqual([['tool-a', 'a1']]);

    coalescer.flushAll();
    expect(flushed).toEqual([
      ['tool-a', 'a1'],
      ['tool-b', 'b1'],
      ['tool-c', 'c1'],
    ]);
    coalescer.dispose();
  });
});
