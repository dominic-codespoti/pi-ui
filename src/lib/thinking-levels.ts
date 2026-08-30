/**
 * Thinking-level canonical ordering and per-model support rules.
 *
 * Mirrors the SDK's ModelThinkingLevel semantics: a model advertises which
 * levels it supports via `thinkingLevelMap`; `null` disables a level,
 * `undefined` means "not advertised" (only fatal for xhigh/max).
 */
import type { ModelInfo } from '#lib/ws/protocol.js';

/** Canonical order for sorting thinking levels — derives from SDK's ModelThinkingLevel. */
export const THINKING_LEVEL_CANONICAL = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ThinkingLevel = (typeof THINKING_LEVEL_CANONICAL)[number];

export function isThinkingLevel(level: string): level is ThinkingLevel {
  return (THINKING_LEVEL_CANONICAL as readonly string[]).includes(level);
}

/** Derive supported levels with the same null/undefined rules as pi-ai. */
export function getSupportedThinkingLevels(m: ModelInfo | null): ThinkingLevel[] {
  if (!m?.reasoning) return ['off'];
  return THINKING_LEVEL_CANONICAL.filter((level) => {
    const mapped = m.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/** Clamp upward/downward for known levels; unknown levels fall to the highest rung. */
export function clampThinkingLevelForModel(m: ModelInfo | null, level: string): ThinkingLevel {
  const available = getSupportedThinkingLevels(m);
  const fallback = available[available.length - 1] ?? 'off';
  if (isThinkingLevel(level) && available.includes(level)) return level;

  const requestedIndex = THINKING_LEVEL_CANONICAL.indexOf(level as ThinkingLevel);
  if (requestedIndex < 0) return fallback;
  for (let i = requestedIndex; i < THINKING_LEVEL_CANONICAL.length; i += 1) {
    if (available.includes(THINKING_LEVEL_CANONICAL[i])) return THINKING_LEVEL_CANONICAL[i];
  }
  for (let i = requestedIndex - 1; i >= 0; i -= 1) {
    if (available.includes(THINKING_LEVEL_CANONICAL[i])) return THINKING_LEVEL_CANONICAL[i];
  }
  return fallback;
}
