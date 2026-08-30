import { describe, it, expect, beforeEach } from 'vitest';
import { SessionViewCache } from './session-view-cache.js';

describe('SessionViewCache', () => {
  let cache: SessionViewCache;

  beforeEach(() => {
    cache = new SessionViewCache();
  });

  it('saves and restores draft, expandedUserMsgs, and truncatedUserMsgs', () => {
    cache.save('session-1', 'hello world', { m1: true }, { m2: true });

    const restored = cache.restore('session-1');
    expect(restored).toEqual({
      draft: 'hello world',
      expandedUserMsgs: { m1: true },
      truncatedUserMsgs: { m2: true },
    });
  });

  it('returns null when session is not in cache', () => {
    expect(cache.restore('unknown-session')).toBeNull();
  });

  it('cleans up empty fields when saving', () => {
    cache.save('s1', 'draft', { m1: true }, { m2: true });
    expect(cache.size).toBe(1);

    // Overwrite with empty draft and empty objects
    cache.save('s1', '   ', {}, {});
    expect(cache.restore('s1')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('evicts cached state for a specific session', () => {
    cache.save('s1', 'draft 1', { m1: true }, {});
    cache.save('s2', 'draft 2', {}, { m2: true });

    cache.evict('s1');
    expect(cache.restore('s1')).toBeNull();
    expect(cache.restore('s2')).not.toBeNull();
  });

  it('clears all entries on clear()', () => {
    cache.save('s1', 'd1', {}, {});
    cache.save('s2', 'd2', {}, {});
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.restore('s1')).toBeNull();
  });
});
