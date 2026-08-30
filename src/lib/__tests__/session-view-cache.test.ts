import { describe, expect, it, beforeEach } from 'vitest';
import { SessionViewCache } from '../session-view-cache';

describe('SessionViewCache', () => {
  let cache: SessionViewCache;
  beforeEach(() => (cache = new SessionViewCache()));

  it('returns null for uncached sessions', () => {
    expect(cache.restore('s1')).toBeNull();
  });

  it('round-trips a draft', () => {
    cache.save('s1', 'hello world', {}, {});
    const restored = cache.restore('s1');
    expect(restored).not.toBeNull();
    expect(restored!.draft).toBe('hello world');
  });

  it('does not cache blank drafts', () => {
    cache.save('s1', '', {}, {});
    expect(cache.restore('s1')).toBeNull();
    cache.save('s1', '   ', {}, {});
    expect(cache.restore('s1')).toBeNull();
  });

  it('round-trips expansion flags', () => {
    cache.save('s1', '', { msg1: true }, { msg2: true });
    const restored = cache.restore('s1')!;
    expect(restored.expandedUserMsgs).toEqual({ msg1: true });
    expect(restored.truncatedUserMsgs).toEqual({ msg2: true });
  });

  it('keeps sessions independent', () => {
    cache.save('a', 'draft A', { x: true }, {});
    cache.save('b', 'draft B', {}, { y: true });

    expect(cache.restore('a')!.draft).toBe('draft A');
    expect(cache.restore('a')!.expandedUserMsgs).toEqual({ x: true });
    expect(cache.restore('a')!.truncatedUserMsgs).toEqual({});

    expect(cache.restore('b')!.draft).toBe('draft B');
    expect(cache.restore('b')!.expandedUserMsgs).toEqual({});
    expect(cache.restore('b')!.truncatedUserMsgs).toEqual({ y: true });
  });

  it('evict drops a single session', () => {
    cache.save('a', 'keep me', {}, {});
    cache.save('b', 'drop me', {}, {});
    cache.evict('b');
    expect(cache.restore('a')).not.toBeNull();
    expect(cache.restore('b')).toBeNull();
  });

  it('clear drops everything', () => {
    cache.save('a', 'x', {}, {});
    cache.save('b', 'y', {}, {});
    cache.clear();
    expect(cache.restore('a')).toBeNull();
    expect(cache.restore('b')).toBeNull();
  });

  it('overwrites a previous save for the same session', () => {
    cache.save('s1', 'first', {}, {});
    cache.save('s1', 'second', { m: true }, {});
    const restored = cache.restore('s1')!;
    expect(restored.draft).toBe('second');
    expect(restored.expandedUserMsgs).toEqual({ m: true });
  });

  it('tracks size across mixed content', () => {
    expect(cache.size).toBe(0);
    cache.save('a', 'text', {}, {});
    expect(cache.size).toBe(1);
    cache.save('b', '', { m: true }, {});
    expect(cache.size).toBe(2); // b cached via expansion even though draft empty
    cache.evict('a');
    expect(cache.size).toBe(1);
  });
});
