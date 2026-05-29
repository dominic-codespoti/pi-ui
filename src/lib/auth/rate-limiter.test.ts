import { describe, it, expect, beforeEach } from 'bun:test';
import { checkRateLimit, recordFailure, clearRecord } from './rate-limiter';

const IP = '1.2.3.4';
const IP6_MAPPED = '::ffff:1.2.3.4';
const IP_B = '10.0.0.99';

function resetStore() {
  (globalThis as Record<string, unknown>).__piRateLimit = new Map();
}

// Manually inject a record into the shared store for time-travel tests.
function injectRecord(ip: string, rec: { count: number; firstAttempt: number; blockedUntil: number | null }) {
  const map = (globalThis as Record<string, unknown>).__piRateLimit as Map<string, typeof rec>;
  map.set(ip, rec);
}

describe('checkRateLimit — fresh IP', () => {
  beforeEach(resetStore);

  it('is unblocked with MAX_ATTEMPTS remaining', () => {
    const r = checkRateLimit(IP);
    expect(r.blocked).toBe(false);
    expect(r.remaining).toBe(5);
    expect(r.retryAfterSecs).toBeNull();
  });
});

describe('recordFailure', () => {
  beforeEach(resetStore);

  it('decrements remaining on each failure', () => {
    expect(recordFailure(IP).remaining).toBe(4);
    expect(recordFailure(IP).remaining).toBe(3);
    expect(recordFailure(IP).remaining).toBe(2);
    expect(recordFailure(IP).remaining).toBe(1);
  });

  it('blocks on the 5th failure', () => {
    for (let i = 0; i < 4; i++) recordFailure(IP);
    const r = recordFailure(IP);
    expect(r.blocked).toBe(true);
    expect(r.remaining).toBe(0);
    expect(r.retryAfterSecs).toBeGreaterThan(0);
  });

  it('retryAfterSecs is approximately BLOCK_MS / 1000 (900 s)', () => {
    for (let i = 0; i < 5; i++) recordFailure(IP);
    const { retryAfterSecs } = checkRateLimit(IP);
    // Allow a small margin for elapsed time
    expect(retryAfterSecs).toBeGreaterThanOrEqual(895);
    expect(retryAfterSecs).toBeLessThanOrEqual(900);
  });
});

describe('clearRecord', () => {
  beforeEach(resetStore);

  it('resets a blocked IP to unblocked with full remaining', () => {
    for (let i = 0; i < 5; i++) recordFailure(IP);
    clearRecord(IP);
    const r = checkRateLimit(IP);
    expect(r.blocked).toBe(false);
    expect(r.remaining).toBe(5);
  });

  it('is a no-op for an IP with no record', () => {
    expect(() => clearRecord('9.9.9.9')).not.toThrow();
  });
});

describe('IPv6-mapped IPv4 normalisation', () => {
  beforeEach(resetStore);

  it('::ffff:x.x.x.x and bare x.x.x.x share the same record', () => {
    recordFailure(IP6_MAPPED);
    const r = checkRateLimit(IP);
    expect(r.remaining).toBe(4);
  });

  it('clearRecord via bare IP also clears the mapped-form record', () => {
    for (let i = 0; i < 5; i++) recordFailure(IP6_MAPPED);
    clearRecord(IP);
    expect(checkRateLimit(IP6_MAPPED).blocked).toBe(false);
  });
});

describe('IP isolation', () => {
  beforeEach(resetStore);

  it('failures for one IP do not affect another', () => {
    for (let i = 0; i < 5; i++) recordFailure(IP);
    expect(checkRateLimit(IP_B).blocked).toBe(false);
    expect(checkRateLimit(IP_B).remaining).toBe(5);
  });
});

describe('time-based expiry (injected records)', () => {
  beforeEach(resetStore);

  it('expired block is treated as fresh', () => {
    injectRecord(IP, {
      count: 5,
      firstAttempt: Date.now() - 20 * 60 * 1000,
      blockedUntil: Date.now() - 1, // 1 ms in the past
    });
    const r = checkRateLimit(IP);
    expect(r.blocked).toBe(false);
    expect(r.remaining).toBe(5);
  });

  it('expired window (no block) is treated as fresh', () => {
    injectRecord(IP, {
      count: 4,
      firstAttempt: Date.now() - 6 * 60 * 1000, // > 5-min window
      blockedUntil: null,
    });
    const r = checkRateLimit(IP);
    expect(r.blocked).toBe(false);
    expect(r.remaining).toBe(5);
  });

  it('active window carries over correctly', () => {
    injectRecord(IP, {
      count: 3,
      firstAttempt: Date.now() - 60_000, // 1 min ago — still within 5-min window
      blockedUntil: null,
    });
    const r = checkRateLimit(IP);
    expect(r.blocked).toBe(false);
    expect(r.remaining).toBe(2);
  });
});
