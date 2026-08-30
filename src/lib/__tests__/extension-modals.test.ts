import { describe, expect, it } from 'vitest';
import {
  customModalNeedsTextInput,
  extensionOptionParts,
  parsedComponentHasAction,
  parsedComponentHasCheckbox,
  parsedComponentHasInput,
  parsedComponentIsDisplayOnly,
} from '../extension-modals';
import type { ParsedComponent } from '#lib/tui-stubs.js';

describe('component classification', () => {
  it('detects interactive kinds', () => {
    expect(parsedComponentHasAction({ kind: 'button', label: 'Go' })).toBe(true);
    expect(parsedComponentHasAction({ kind: 'select', label: '', options: [] })).toBe(true);
    expect(
      parsedComponentHasAction({
        kind: 'settings',
        items: [{ id: 'a', label: 'A', currentValue: 'x', values: ['x', 'y'] }],
      })
    ).toBe(true);
    expect(parsedComponentHasAction({ kind: 'text', label: '', content: 'hi' })).toBe(false);
  });

  it('recurses into containers', () => {
    const comp: ParsedComponent = {
      kind: 'container',
      children: [{ kind: 'checkbox', label: 'c', checked: false }],
    };
    expect(parsedComponentHasAction(comp)).toBe(true);
    expect(parsedComponentHasCheckbox(comp)).toBe(true);
    expect(parsedComponentHasInput(comp)).toBe(false);
  });

  it('treats value-less settings and leaves as display-only', () => {
    expect(
      parsedComponentIsDisplayOnly({
        kind: 'settings',
        items: [{ id: 'a', label: 'A', currentValue: 'x' }],
      })
    ).toBe(true);
    expect(parsedComponentIsDisplayOnly({ kind: 'loader', label: 'working' })).toBe(true);
    expect(parsedComponentIsDisplayOnly({ kind: 'input', label: '' })).toBe(false);
  });

  it('treats an empty container as display-only', () => {
    expect(parsedComponentIsDisplayOnly({ kind: 'container', children: [] })).toBe(true);
  });

  it('needs a free-text input only when nothing else is presentable', () => {
    expect(customModalNeedsTextInput(undefined)).toBe(true);
    expect(customModalNeedsTextInput({ kind: 'input', label: '' })).toBe(false);
    expect(customModalNeedsTextInput({ kind: 'text', label: '', content: 'hi' })).toBe(false);
    expect(
      customModalNeedsTextInput({
        kind: 'settings',
        items: [{ id: 'a', label: 'A', currentValue: 'x', values: ['1'] }],
      })
    ).toBe(false);
  });
});

describe('extensionOptionParts', () => {
  it('splits numbered options with an em-dash description', () => {
    expect(extensionOptionParts('2. Deploy — push to prod', 1)).toEqual({
      index: '2',
      label: 'Deploy',
      description: 'push to prod',
    });
  });

  it('falls back to position index and keeps the whole text as label', () => {
    expect(extensionOptionParts('just a choice', 4)).toEqual({
      index: '5',
      label: 'just a choice',
    });
  });
});
