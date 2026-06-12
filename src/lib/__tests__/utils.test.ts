import { describe, it, expect } from 'vitest';
import { cn, formatRelativeDate, type WithElementRef, type WithoutChildren } from '../utils';

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('px-4', 'py-2')).toBe('px-4 py-2');
  });

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  it('merges tailwind classes correctly', () => {
    expect(cn('px-4', 'px-6')).toBe('px-6');
  });
});

describe('formatRelativeDate', () => {
  it('returns "just now" for < 2 minutes', () => {
    expect(formatRelativeDate(Date.now())).toBe('just now');
  });

  it('returns "Xm ago" for < 1 hour', () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    expect(formatRelativeDate(fiveMinAgo)).toBe('5m ago');
  });

  it('returns "Xh ago" for < 24 hours', () => {
    const threeHoursAgo = Date.now() - 3 * 3600 * 1000;
    expect(formatRelativeDate(threeHoursAgo)).toBe('3h ago');
  });

  it('returns "yesterday" for 24-48 hours', () => {
    const yesterday = Date.now() - 30 * 3600 * 1000;
    expect(formatRelativeDate(yesterday)).toBe('yesterday');
  });

  it('returns "Xd ago" for < 7 days', () => {
    const fiveDaysAgo = Date.now() - 5 * 86_400_000;
    expect(formatRelativeDate(fiveDaysAgo)).toBe('5d ago');
  });

  it('returns formatted date for older timestamps', () => {
    const old = new Date('2024-03-15').getTime();
    const result = formatRelativeDate(old);
    expect(result).toContain('Mar');
    expect(result).toContain('15');
  });
});

describe('type helpers', () => {
  it('WithElementRef adds ref property', () => {
    type Props = { title: string };
    type WithRef = WithElementRef<Props>;
    const x: WithRef = { title: 'hi', ref: null };
    expect(x.ref).toBeNull();
  });

  it('WithoutChildren strips children', () => {
    type Props = { name: string; children?: unknown };
    type NoKids = WithoutChildren<Props>;
    const x: NoKids = { name: 'test' };
    expect(x.name).toBe('test');
  });
});
