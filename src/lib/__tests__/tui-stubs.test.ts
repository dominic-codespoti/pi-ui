import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  stubTheme,
  StubTui,
  parseComponentTree,
  callFactoryAndParse,
} from '../tui-stubs';

describe('stripAnsi', () => {
  it('removes ANSI escape codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('passes plain text through unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
});

describe('stubTheme', () => {
  it('fg returns text unchanged', () => {
    expect(stubTheme.fg('red', 'hello')).toBe('hello');
  });

  it('bg returns text unchanged', () => {
    expect(stubTheme.bg('blue', 'world')).toBe('world');
  });

  it('bold returns text unchanged', () => {
    expect(stubTheme.bold('bold text')).toBe('bold text');
  });
});

describe('StubTui', () => {
  it('addChild registers children', () => {
    const tui = new StubTui();
    const child = { render() { return ['line']; } };
    tui.addChild(child);
    expect(tui.children).toHaveLength(1);
    expect(tui.children[0]).toBe(child);
  });

  it('render() calls render on children', () => {
    const tui = new StubTui();
    const child1 = { render() { return ['a']; } };
    const child2 = { render() { return ['b']; } };
    tui.addChild(child1);
    tui.addChild(child2);
    expect(tui.render()).toEqual(['a', 'b']);
  });

  it('removeChild removes from children', () => {
    const tui = new StubTui();
    const child = { render() { return []; } };
    tui.addChild(child);
    tui.removeChild(child);
    expect(tui.children).toHaveLength(0);
  });

  it('clear() empties children', () => {
    const tui = new StubTui();
    tui.addChild({ render() { return []; } });
    tui.addChild({ render() { return []; } });
    tui.clear();
    expect(tui.children).toHaveLength(0);
  });

  it('handleInput forwards to focused child', () => {
    const tui = new StubTui();
    const handled: unknown[] = [];
    const child = { render() { return []; }, handleInput(k: unknown) { handled.push(k); } };
    tui.addChild(child);
    tui.handleInput({ key: 'enter' });
    expect(handled).toEqual([{ key: 'enter' }]);
  });
});

describe('parseComponentTree', () => {
  it('parses a SelectList component', () => {
    const comp = {
      items: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      onSelect: () => {},
      setFilter: () => {},
    };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    expect(result.kind).toBe('select');
    if (result.kind === 'select') {
      expect(result.options).toHaveLength(2);
      expect(result.options[0].value).toBe('a');
    }
  });

  it('parses an Input component', () => {
    const comp = {
      getValue: () => 'test value',
      handleSubmit: () => {},
      onSubmit: () => {},
    };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    expect(result.kind).toBe('input');
  });

  it('parses a Text component', () => {
    const comp = { text: 'Hello', paddingX: 1, paddingY: 0 };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.content).toBe('Hello');
    }
  });

  it('parses a Button component', () => {
    const comp = { label: 'Click me', onClick: () => {} };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    expect(result.kind).toBe('button');
    if (result.kind === 'button') {
      expect(result.label).toBe('Click me');
    }
  });

  it('parses a Checkbox component', () => {
    const comp = { checked: true, onToggle: () => {} };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    expect(result.kind).toBe('checkbox');
    if (result.kind === 'checkbox') {
      expect(result.checked).toBe(true);
    }
  });

  it('parses a Container with multiple children', () => {
    const comp = {
      children: [
        { text: 'child1', paddingX: 0, paddingY: 0 },
        { text: 'child2', paddingX: 0, paddingY: 0 },
      ],
      addChild: () => {},
    };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    expect(result.kind).toBe('container');
    if (result.kind === 'container') {
      expect(result.children).toHaveLength(2);
      expect(result.children[0].kind).toBe('text');
      expect(result.children[1].kind).toBe('text');
    }
  });

  it('returns fallback text for unknown component with render()', () => {
    const comp = { render: () => ['output line'] };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    expect(result.kind).toBe('text');
  });

  it('returns empty text for unknown non-renderable', () => {
    const result = parseComponentTree({ foo: 'bar' } as unknown as Record<string, unknown>);
    expect(result.kind).toBe('text');
  });
});

describe('callFactoryAndParse', () => {
  it('calls factory with stubs and parses result', async () => {
    const factory = (tui: StubTui) => {
      const child = { text: 'factory output', paddingX: 0, paddingY: 0 };
      tui.addChild(child);
      return child;
    };
    const result = await callFactoryAndParse(factory, 'Test');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('text');
  });

  it('returns null on factory failure', async () => {
    const factory = () => { throw new Error('fail'); };
    const result = await callFactoryAndParse(factory, 'Fail');
    expect(result).toBeNull();
  });

  it('injects title when component has no label', async () => {
    const factory = () => ({ text: 'content', paddingX: 0, paddingY: 0 });
    const result = await callFactoryAndParse(factory, 'My Title');
    if (result && 'label' in result) {
      expect((result as { label?: string }).label).toBe('My Title');
    }
  });
});
