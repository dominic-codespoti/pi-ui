import { describe, expect, it } from 'vitest';
import type { ComponentSource } from '../types.ts';
import { exampleById } from '../examples/index.ts';
import { COMPONENTS, PI_TUI_EXPORTS } from '../catalog.ts';

describe('extension UI capability catalog', () => {
  it('maps each component kind to an example that produces that kind', () => {
    for (const [kind, capability] of Object.entries(COMPONENTS)) {
      expect(exampleById(capability.example).expected).toBe(kind);
    }
  });

  it('classifies every runtime pi-tui component export', async () => {
    // Inspect runtime exports so the contract covers classes available to extensions.
    const runtimeExports = await import('@earendil-works/pi-tui');
    const sources: readonly ComponentSource[] = Object.values(COMPONENTS).flatMap(
      (capability): readonly ComponentSource[] => capability.sources
    );
    const unclassified = Object.entries(runtimeExports)
      .filter(
        ([, value]) => typeof value === 'function' && typeof value.prototype?.render === 'function'
      )
      .map(([name]) => name)
      .filter(
        (name) =>
          !sources.some(
            (source) =>
              source.via === 'pi-tui' && source.exports.some((exported) => exported === name)
          ) && !(name in PI_TUI_EXPORTS)
      );

    expect(
      unclassified,
      `Unclassified pi-tui component exports: ${unclassified.join(', ')}`
    ).toEqual([]);
  });
});
