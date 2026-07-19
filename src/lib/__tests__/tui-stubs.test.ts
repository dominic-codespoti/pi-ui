import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  ansiToHtml,
  stubTheme,
  StubTui,
  parseComponentTree,
  callFactoryAndParse,
} from '../tui-stubs';
import {
  Text,
  Markdown,
  SelectList,
  SettingsList,
  Input,
  Loader,
  CancellableLoader,
  Image,
  Box,
  Spacer,
} from '@earendil-works/pi-tui';

const noop = (t: string) => t;
const markdownTheme = {
  heading: noop,
  link: noop,
  linkUrl: noop,
  code: noop,
  codeBlock: noop,
  codeBlockBorder: noop,
  quote: noop,
  quoteBorder: noop,
  hr: noop,
  listBullet: noop,
  bold: noop,
  italic: noop,
  strikethrough: noop,
  underline: noop,
};
const selectTheme = {
  selectedPrefix: noop,
  selectedText: noop,
  description: noop,
  scrollInfo: noop,
  noMatch: noop,
};
const settingsTheme = {
  label: (t: string) => t,
  value: (t: string) => t,
  description: noop,
  cursor: '>',
  hint: noop,
};
const imageTheme = { fallbackColor: noop };

describe('stripAnsi', () => {
  it('removes SGR color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('passes plain text through unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('removes OSC-8 hyperlink sequences', () => {
    const withLink = '\x1b]8;;https://example.com\x07click\x1b]8;;\x07';
    expect(stripAnsi(withLink)).toBe('click');
  });

  it('removes cursor-movement CSI sequences', () => {
    expect(stripAnsi('\x1b[2Ktext\x1b[1A')).toBe('text');
  });
});

describe('ansiToHtml', () => {
  it('renders plain text with no escapes as escaped text', () => {
    expect(ansiToHtml('plain text')).toBe('plain text');
  });

  it('escapes HTML-significant characters', () => {
    expect(ansiToHtml('a & b <tag>')).toBe('a &amp; b &lt;tag&gt;');
  });

  it('applies bold + basic foreground color as inline style', () => {
    expect(ansiToHtml('\x1b[1;31mbold red\x1b[0m')).toBe(
      '<span style="color:#cc0000;font-weight:bold">bold red</span>'
    );
  });

  it('renders bare inverse (selection cursor) as a visible highlight instead of nothing', () => {
    const html = ansiToHtml('\x1b[7mselected\x1b[0m');
    expect(html).toContain('background-color:rgba(127,127,127,0.35)');
    expect(html).toContain('selected');
  });

  it('swaps fg/bg for inverse with explicit colors', () => {
    const html = ansiToHtml('\x1b[7;31mcursor\x1b[0m');
    expect(html).toContain('background-color:#cc0000');
  });

  it('resolves 256-color codes to hex', () => {
    expect(ansiToHtml('\x1b[38;5;208morange\x1b[0m')).toContain('color:#ff8700');
  });

  it('resolves truecolor codes to rgb()', () => {
    expect(ansiToHtml('\x1b[38;2;10;20;30mtc\x1b[0m')).toContain('color:rgb(10,20,30)');
  });

  it('strips non-SGR escapes (cursor movement) without leaving style spans', () => {
    expect(ansiToHtml('\x1b[2Ktext\x1b[1A')).toBe('text');
  });

  it('drops OSC hyperlink sequences', () => {
    const withLink = '\x1b]8;;https://example.com\x07click\x1b]8;;\x07';
    expect(ansiToHtml(withLink)).toBe('click');
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

describe('parseComponentTree — hand-rolled shapes', () => {
  it('parses a SelectList-shaped component', () => {
    const comp = {
      items: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      setFilter: () => {},
    };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    expect(result.kind).toBe('select');
    if (result.kind === 'select') {
      expect(result.options).toHaveLength(2);
      expect(result.options[0].value).toBe('a');
    }
  });

  it('parses an Input-shaped component without onSubmit assigned', () => {
    const comp = {
      getValue: () => 'test value',
      setValue: () => {},
      handleInput: () => {},
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
      expect(result.direction).toBe('vertical');
    }
  });

  it('tags container children with their index path', () => {
    const comp = {
      children: [
        { label: 'A', onClick: () => {} },
        { label: 'B', onClick: () => {} },
      ],
      addChild: () => {},
    };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    if (result.kind === 'container') {
      expect(result.children[0].path).toEqual([0]);
      expect(result.children[1].path).toEqual([1]);
    }
  });

  it('does NOT infer horizontal direction from an `align` field', () => {
    const comp = {
      children: [{ label: 'A', onClick: () => {} }, { label: 'B', onClick: () => {} }],
      addChild: () => {},
      align: 'center',
    };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    if (result.kind === 'container') {
      expect(result.direction).toBe('vertical');
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

  it('parses ProgressBar component', () => {
    const comp = { progress: 0.75, render: () => ['███████░░░'], label: 'Building…' };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    expect(result.kind).toBe('progress');
    if (result.kind === 'progress') {
      expect(result.progress).toBe(0.75);
      expect(result.label).toBe('Building…');
    }
  });

  it('sets monoPreserve on render() fallback', () => {
    const comp = { render: () => ['output line'] };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.monoPreserve).toBe(true);
    }
  });

  it('accepts base64Data as the Image data field', () => {
    const comp = { base64Data: 'AAAA', mimeType: 'image/png' };
    const result = parseComponentTree(comp as unknown as Record<string, unknown>);
    expect(result.kind).toBe('image');
    if (result.kind === 'image') {
      expect(result.data).toBe('AAAA');
    }
  });
});

describe('parseComponentTree — real pi-tui component instances', () => {
  it('detects a real Text component', () => {
    const text = new Text('hello there', 0, 0);
    const result = parseComponentTree(text as unknown as Record<string, unknown>);
    expect(result.kind).toBe('text');
    if (result.kind === 'text') expect(result.content).toBe('hello there');
  });

  it('detects a real Markdown component and does NOT collapse it to plain text', () => {
    const md = new Markdown('# Heading\n\nSome *text*', 0, 0, markdownTheme);
    const result = parseComponentTree(md as unknown as Record<string, unknown>);
    expect(result.kind).toBe('markdown');
    if (result.kind === 'markdown') expect(result.content).toContain('Heading');
  });

  it('detects a real SelectList even before onSelect is assigned', () => {
    const list = new SelectList(
      [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }],
      10,
      selectTheme,
    );
    const result = parseComponentTree(list as unknown as Record<string, unknown>);
    expect(result.kind).toBe('select');
    if (result.kind === 'select') expect(result.options).toHaveLength(2);
  });

  it('detects a real SettingsList (previously undetected)', () => {
    const settings = new SettingsList(
      [
        { id: 'theme', label: 'Theme', currentValue: 'dark', values: ['light', 'dark'] },
        { id: 'model', label: 'Model', currentValue: 'gpt-4' },
      ],
      10,
      settingsTheme,
      () => {},
      () => {},
    );
    const result = parseComponentTree(settings as unknown as Record<string, unknown>);
    expect(result.kind).toBe('settings');
    if (result.kind === 'settings') {
      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe('theme');
      expect(result.items[0].currentValue).toBe('dark');
    }
  });

  it('detects a real Input even before onSubmit is assigned', () => {
    const input = new Input();
    input.setValue('prefilled');
    const result = parseComponentTree(input as unknown as Record<string, unknown>);
    expect(result.kind).toBe('input');
    if (result.kind === 'input') expect(result.value).toBe('prefilled');
  });

  it('detects a real Loader (previously misdetected as Text)', () => {
    const loader = new Loader({ requestRender() {} } as never, noop, noop, 'Working…');
    const result = parseComponentTree(loader as unknown as Record<string, unknown>);
    expect(result.kind).toBe('loader');
    if (result.kind === 'loader') expect(result.label).toBe('Working…');
  });

  it('marks a CancellableLoader as cancellable', () => {
    const loader = new CancellableLoader({ requestRender() {} } as never, noop, noop, 'Working…');
    const result = parseComponentTree(loader as unknown as Record<string, unknown>);
    expect(result.kind).toBe('loader');
    if (result.kind === 'loader') expect(result.cancellable).toBe(true);
  });

  it('detects a real Image component via base64Data', () => {
    const img = new Image('AAAA', 'image/png', imageTheme);
    const result = parseComponentTree(img as unknown as Record<string, unknown>);
    expect(result.kind).toBe('image');
    if (result.kind === 'image') expect(result.mimeType).toBe('image/png');
  });

  it('recurses into a real Box container', () => {
    const box = new Box(0, 0);
    box.addChild(new Text('child one', 0, 0));
    box.addChild(new Text('child two', 0, 0));
    const result = parseComponentTree(box as unknown as Record<string, unknown>);
    expect(result.kind).toBe('container');
    if (result.kind === 'container') expect(result.children).toHaveLength(2);
  });

  it('skips a real Spacer (renders as empty, filtered by parent)', () => {
    const box = new Box(0, 0);
    box.addChild(new Text('before', 0, 0));
    box.addChild(new Spacer(2));
    box.addChild(new Text('after', 0, 0));
    const result = parseComponentTree(box as unknown as Record<string, unknown>);
    expect(result.kind).toBe('container');
    if (result.kind === 'container') {
      expect(result.children).toHaveLength(2);
      expect(result.children.map((c) => c.kind === 'text' && c.content)).toEqual(['before', 'after']);
    }
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
