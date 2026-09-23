import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundParsedComponentTree,
  parseComponentTree,
  shouldUseInteractiveCustom,
  StubTui,
  stubKeybindings,
  stubTheme,
} from '../../tui-stubs.ts';
import { exampleById, EXAMPLES } from '../examples/index.ts';
import type { ExampleModule } from '../types.ts';

function invokeExample(module: ExampleModule, tui: StubTui, done: (value: unknown) => void) {
  if (module.surface === 'widget') return module.factory(tui as never, stubTheme as never);
  return module.factory(tui as never, stubTheme as never, stubKeybindings as never, done);
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('extension UI examples', () => {
  it.each(EXAMPLES)('$id produces its documented parsed component', async (module) => {
    if (module.surface === 'widget') vi.useFakeTimers();
    const tui = new StubTui();
    const done = vi.fn();
    const component = await invokeExample(module, tui, done);
    const parsed = boundParsedComponentTree(
      parseComponentTree(component as unknown as Record<string, unknown>)
    );

    if (module.expected === 'terminal-fallback') {
      expect(shouldUseInteractiveCustom(component as never, parsed)).toBe(true);
    } else {
      if (module.surface === 'custom') {
        expect(shouldUseInteractiveCustom(component as never, parsed)).toBe(false);
      }
      expect(parsed.kind).toBe(module.expected);
      if (module.id === 'hstack-layout' && parsed.kind === 'container') {
        expect(parsed.direction).toBe('horizontal');
      }
    }

    if ('dispose' in component && typeof component.dispose === 'function') component.dispose();
  });

  it('updates the live progress widget state between widget ticks', () => {
    vi.useFakeTimers();
    const module = exampleById('live-progress-widget');
    if (module.surface !== 'widget')
      throw new Error('Progress example must use the widget surface');
    const component = module.factory(new StubTui() as never, stubTheme as never);
    const readProgress = () => {
      const parsed = boundParsedComponentTree(
        parseComponentTree(component as unknown as Record<string, unknown>)
      );
      if (parsed.kind !== 'progress') throw new Error(`Expected progress, received ${parsed.kind}`);
      return parsed.progress;
    };
    const before = readProgress();
    vi.advanceTimersByTime(500);
    expect(readProgress()).toBeGreaterThan(before);
    component.dispose?.();
  });
});
