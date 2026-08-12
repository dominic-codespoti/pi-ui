import { describe, expect, it, vi } from 'vitest';
import { TerminalInputRegistry } from '../terminal-input';

describe('TerminalInputRegistry', () => {
  it('returns an unconsumed verdict when no handlers are registered', () => {
    const registry = new TerminalInputRegistry();

    expect(registry.dispatch('session', 'a')).toEqual({ consumed: false });
  });

  it('stops processing when the first handler consumes input', () => {
    const registry = new TerminalInputRegistry();
    const first = vi.fn(() => ({ consume: true }));
    const second = vi.fn();
    registry.register('session', first);
    registry.register('session', second);

    expect(registry.dispatch('session', 'a')).toEqual({ consumed: true });
    expect(first).toHaveBeenCalledWith('a');
    expect(second).not.toHaveBeenCalled();
  });

  it('passes rewritten data to later handlers', () => {
    const registry = new TerminalInputRegistry();
    const first = vi.fn(() => ({ data: 'X' }));
    const second = vi.fn();
    registry.register('session', first);
    registry.register('session', second);

    expect(registry.dispatch('session', 'a')).toEqual({ consumed: false, data: 'X' });
    expect(second).toHaveBeenCalledWith('X');
  });

  it('treats a final empty rewrite as consumed', () => {
    const registry = new TerminalInputRegistry();
    registry.register('session', () => ({ data: '' }));

    expect(registry.dispatch('session', 'a')).toEqual({ consumed: true });
  });

  it('continues after a handler throws', () => {
    const registry = new TerminalInputRegistry();
    const later = vi.fn(() => ({ data: 'handled' }));
    registry.register('session', () => {
      throw new Error('broken handler');
    });
    registry.register('session', later);

    expect(registry.dispatch('session', 'a')).toEqual({ consumed: false, data: 'handled' });
    expect(later).toHaveBeenCalledWith('a');
  });

  it('unregisters a handler through the returned cleanup function', () => {
    const registry = new TerminalInputRegistry();
    const handler = vi.fn();
    const unregister = registry.register('session', handler);

    unregister();

    expect(registry.has('session')).toBe(false);
    expect(registry.dispatch('session', 'a')).toEqual({ consumed: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it('clears an owner set and reports its active state', () => {
    const registry = new TerminalInputRegistry();
    registry.register('session', () => undefined);
    expect(registry.has('session')).toBe(true);

    registry.clear('session');

    expect(registry.has('session')).toBe(false);
    expect(registry.dispatch('session', 'a')).toEqual({ consumed: false });
  });

  it('keeps owners isolated', () => {
    const registry = new TerminalInputRegistry();
    const handler = vi.fn(() => ({ consume: true }));
    registry.register('a', handler);

    expect(registry.dispatch('b', 'a')).toEqual({ consumed: false });
    expect(handler).not.toHaveBeenCalled();
    expect(registry.dispatch('a', 'a')).toEqual({ consumed: true });
  });
});
