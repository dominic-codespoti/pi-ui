import { describe, expect, it } from 'vitest';
import { usageBreakdownTitle } from '../message-row-helpers.ts';
import type { UIMessage } from '#lib/client-messages.js';

describe('usageBreakdownTitle', () => {
  it('renders legacy usage without a per-field cost breakdown instead of throwing', () => {
    // Shape persisted by <=0.22 cold-start snapshots: only cost.total.
    const legacy = { input: 5, output: 7, totalTokens: 12, cost: { total: 0.01 } } as never;
    expect(usageBreakdownTitle(legacy)).toContain('total $0.010000');
    expect(usageBreakdownTitle(legacy)).toContain('cache read $0.000000');
  });

  it('formats a complete breakdown and omits reasoning when absent', () => {
    const usage: NonNullable<UIMessage['usage']> = {
      input: 10,
      output: 20,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 37,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.003, cacheWrite: 0.004, total: 0.307 },
    };
    const title = usageBreakdownTitle(usage);
    expect(title).toContain(
      'Input 10 · Output 20 · Cache read 3 · Cache write 4 · Total 37 tokens'
    );
    expect(title).toContain('total $0.307000');
    expect(title).not.toContain('Reasoning');
    expect(usageBreakdownTitle(undefined)).toBe('');
  });
});
