import { describe, it, expect } from 'vitest';
import {
  providerColor,
  versionText,
  sourceLabel,
  canRemove,
  fmtTokens,
  fmtCost,
  fmtDuration,
} from '../utils';

describe('providerColor', () => {
  it('returns color for known provider', () => {
    expect(providerColor('openai')).toBe('#10A37F');
    expect(providerColor('anthropic')).toBe('#C06A3A');
  });

  it('handles case-insensitive match', () => {
    expect(providerColor('OpenAI')).toBe('#10A37F');
  });

  it('returns default color for unknown provider', () => {
    expect(providerColor('unknown')).toBe('#6B7280');
  });
});

describe('versionText', () => {
  it('formats version string', () => {
    expect(versionText('1.2.3')).toBe('v1.2.3');
  });

  it('returns unknown for undefined', () => {
    expect(versionText(undefined)).toBe('unknown');
  });

  it('returns unknown for "unknown"', () => {
    expect(versionText('unknown')).toBe('unknown');
  });
});

describe('sourceLabel', () => {
  it('returns env for environment', () => {
    expect(sourceLabel('environment')).toBe('env');
  });

  it('returns config for config sources', () => {
    expect(sourceLabel('models_json_key')).toBe('config');
    expect(sourceLabel('fallback')).toBe('config');
  });

  it('returns undefined for unknown', () => {
    expect(sourceLabel('unknown')).toBeUndefined();
  });
});

describe('canRemove', () => {
  it('returns true only for stored', () => {
    expect(canRemove('stored')).toBe(true);
    expect(canRemove('environment')).toBe(false);
    expect(canRemove('runtime')).toBe(false);
  });
});

describe('fmtTokens', () => {
  it('formats values < 1000 as-is', () => {
    expect(fmtTokens(500)).toBe('500');
  });

  it('formats values >= 1000 with k suffix', () => {
    expect(fmtTokens(1500)).toBe('1.5k');
  });
});

describe('fmtCost', () => {
  it('returns null for zero', () => {
    expect(fmtCost(0)).toBeNull();
  });

  it('formats very small costs', () => {
    expect(fmtCost(0.00005)).toBe('<$0.0001');
  });

  it('formats normal costs', () => {
    expect(fmtCost(0.015)).toBe('$0.0150');
  });
});

describe('fmtDuration', () => {
  it('formats milliseconds', () => {
    expect(fmtDuration(500)).toBe('500ms');
  });

  it('formats seconds', () => {
    expect(fmtDuration(5500)).toBe('5.5s');
  });

  it('formats minutes', () => {
    expect(fmtDuration(125000)).toBe('2m');
  });
});
