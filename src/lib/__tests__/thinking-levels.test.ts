import { describe, expect, it } from 'vitest';
import {
  clampThinkingLevelForModel,
  getSupportedThinkingLevels,
  isThinkingLevel,
  type ThinkingLevel,
} from '../thinking-levels';
import type { ModelInfo } from '#lib/ws/protocol.js';

function model(partial: Partial<ModelInfo>): ModelInfo {
  return {
    provider: 'test',
    id: 'm',
    name: 'M',
    reasoning: false,
    contextWindow: 128_000,
    ...partial,
  };
}

const ALL: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

describe('getSupportedThinkingLevels', () => {
  it('offers only off for non-reasoning models', () => {
    expect(getSupportedThinkingLevels(model({ reasoning: false }))).toEqual(['off']);
    expect(getSupportedThinkingLevels(null)).toEqual(['off']);
  });

  it('includes unadvertised standard levels but not xhigh/max', () => {
    // No thinkingLevelMap at all — standard rungs pass, extended rungs need
    // explicit advertisement.
    expect(getSupportedThinkingLevels(model({ reasoning: true }))).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });

  it('honors null (disabled) and advertised extended levels', () => {
    const m = model({
      reasoning: true,
      thinkingLevelMap: { low: null, xhigh: 'xhigh' },
    });
    expect(getSupportedThinkingLevels(m)).toEqual(['off', 'minimal', 'medium', 'high', 'xhigh']);
  });
});

describe('clampThinkingLevelForModel', () => {
  it('keeps a supported level as-is', () => {
    expect(clampThinkingLevelForModel(model({ reasoning: true }), 'low')).toBe('low');
  });

  it('clamps an unsupported level to the nearest available rung downward', () => {
    // max is unavailable without advertisement — falls to high.
    expect(clampThinkingLevelForModel(model({ reasoning: true }), 'max')).toBe('high');
  });

  it('walks upward first when nothing at/below the request is available', () => {
    const m = model({ reasoning: true, thinkingLevelMap: { low: null, medium: null } });
    // Requesting low: disabled → medium: disabled → high wins.
    expect(clampThinkingLevelForModel(m, 'low')).toBe('high');
  });

  it('falls back to the highest available level for unknown strings', () => {
    expect(clampThinkingLevelForModel(model({ reasoning: true }), 'turbo')).toBe('high');
    expect(clampThinkingLevelForModel(model({ reasoning: false }), 'turbo')).toBe('off');
  });
});

describe('isThinkingLevel', () => {
  it('accepts canonical levels only', () => {
    for (const level of ALL) expect(isThinkingLevel(level)).toBe(true);
    expect(isThinkingLevel('ultra')).toBe(false);
  });
});
