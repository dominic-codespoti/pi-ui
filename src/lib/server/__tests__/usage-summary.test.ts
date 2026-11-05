import { describe, expect, it } from 'vitest';
import type { SessionUsageBuckets } from '../session-scan';
import { clampUsageDays, summarizeUsage } from '../usage-summary';

describe('summarizeUsage', () => {
  const now = new Date(2026, 10, 5, 15, 0, 0); // 2026-11-05 local
  const files: Array<{ cwd: string; usage: SessionUsageBuckets }> = [
    {
      cwd: '/a',
      usage: {
        '2026-11-05': { 'p/m1': [1, 100, 90, 10, 2] },
        '2026-11-01': { 'p/m2': [0.5, 50, 40, 10, 1] },
        '2026-09-01': { 'p/m1': [9, 900, 800, 100, 5] },
      },
    },
    {
      cwd: '/b',
      usage: {
        '2026-11-04': { 'p/m1': [2, 10, 5, 5, 1] },
      },
    },
    { cwd: '/c', usage: {} },
  ];

  it('totals only the window and fills every day', () => {
    const s = summarizeUsage(files, 7, now);
    expect(s.since).toBe('2026-10-30');
    expect(s.until).toBe('2026-11-05');
    expect(s.byDay).toHaveLength(7);
    expect(s.byDay.at(-1)).toMatchObject({ day: '2026-11-05', cost: 1, messages: 2 });
    expect(s.totals).toEqual({
      cost: 3.5,
      tokens: 160,
      inputTokens: 135,
      outputTokens: 25,
      messages: 4,
    });
    expect(s.sessionsWithUsage).toBe(2);
  });

  it('ranks models and projects by cost', () => {
    const s = summarizeUsage(files, 7, now);
    expect(s.byModel.map((m) => [m.model, m.cost])).toEqual([
      ['p/m1', 3],
      ['p/m2', 0.5],
    ]);
    expect(s.byProject.map((p) => p.cwd)).toEqual(['/b', '/a']);
  });

  it('clamps the window', () => {
    expect(clampUsageDays(0)).toBe(1);
    expect(clampUsageDays(10_000)).toBe(366);
    expect(clampUsageDays('x')).toBe(30);
    expect(summarizeUsage(files, 120, now).totals.cost).toBe(12.5);
  });
});
