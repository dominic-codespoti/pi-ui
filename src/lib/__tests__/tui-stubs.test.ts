import { describe, it, expect } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import {
  stripAnsi,
  ansiToHtml,
  stubTheme,
  StubTui,
  HeadlessTerminal,
  parseComponentTree,
  customEntriesForWire,
  applyMarkdownTransformers,
  renderTerminalLines,
  renderCustomMessage,
  stubKeybindings,
  callFactoryAndParse,
  shouldUseInteractiveCustom,
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
  HStack,
  VStack,
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
  it('fg wraps text in a real SGR truecolor sequence carrying the semantic color', () => {
    const styled = stubTheme.fg('success', 'hello');
    expect(styled).not.toBe('hello');
    expect(stripAnsi(styled)).toBe('hello');
    expect(ansiToHtml(styled)).toBe('<span style="color:rgb(79,204,146)">hello</span>');
  });

  it('fg falls back to the base text color for an unrecognized name', () => {
    const styled = stubTheme.fg('not-a-real-theme-color', 'hello');
    expect(stripAnsi(styled)).toBe('hello');
    expect(ansiToHtml(styled)).toBe('<span style="color:rgb(215,214,223)">hello</span>');
  });

  it('bg wraps text in a real SGR truecolor background sequence', () => {
    const styled = stubTheme.bg('selectedBg', 'world');
    expect(stripAnsi(styled)).toBe('world');
    expect(ansiToHtml(styled)).toBe('<span style="background-color:rgb(49,48,57)">world</span>');
  });

  it('bold wraps text in a real SGR bold sequence', () => {
    const styled = stubTheme.bold('bold text');
    expect(stripAnsi(styled)).toBe('bold text');
    expect(ansiToHtml(styled)).toBe('<span style="font-weight:bold">bold text</span>');
  });

  it('composes fg + bold on the same text (extension nesting pattern)', () => {
    const styled = stubTheme.fg('error', stubTheme.bold('failed'));
    expect(stripAnsi(styled)).toBe('failed');
    expect(ansiToHtml(styled)).toBe(
      '<span style="color:rgb(246,108,109);font-weight:bold">failed</span>'
    );
  });
});
describe('HeadlessTerminal', () => {
  it('updates size and clamps the virtual viewport', () => {
    const terminal = new HeadlessTerminal();
    const resized: number[] = [];
    terminal.start(
      () => {},
      () => resized.push(terminal.columns, terminal.rows)
    );

    terminal.setSize(90, 30);
    expect(terminal.columns).toBe(90);
    expect(terminal.rows).toBe(30);

    terminal.setSize(10, 500);
    expect(terminal.columns).toBe(20);
    expect(terminal.rows).toBe(80);
    expect(resized).toEqual([90, 30, 20, 80]);
  });

  it('does not fire resize for unchanged values and never enables kitty protocol', () => {
    const terminal = new HeadlessTerminal(90, 30);
    let resizeCount = 0;
    terminal.start(
      () => {},
      () => resizeCount++
    );

    terminal.setSize(90, 30);
    expect(resizeCount).toBe(0);
    expect(terminal.kittyProtocolActive).toBe(false);
  });
});

describe('renderTerminalLines', () => {
  it('strips ANSI for clean lines and preserves styled HTML', () => {
    const tui = new StubTui();
    tui.addChild({
      render() {
        return ['\x1b[31mred\x1b[0m', 'plain'];
      },
    });

    expect(renderTerminalLines(tui)).toEqual({
      cleanLines: ['red', 'plain'],
      htmlLines: ['<span style="color:#cc0000">red</span>', 'plain'],
    });
  });

  it('drops non-string lines and returns null when rendering throws', () => {
    const mixed = new StubTui();
    mixed.addChild({
      render() {
        return ['kept', 42, null] as unknown as string[];
      },
    });
    expect(renderTerminalLines(mixed)).toEqual({
      cleanLines: ['kept'],
      htmlLines: ['kept'],
    });

    const broken = new StubTui();
    broken.addChild({
      render() {
        throw new Error('render failed');
      },
    });
    expect(renderTerminalLines(broken)).toBeNull();
  });
});

describe('StubTui', () => {
  it('addChild registers children', () => {
    const tui = new StubTui();
    const child = {
      render() {
        return ['line'];
      },
    };
    tui.addChild(child);
    expect(tui.children).toHaveLength(1);
    expect(tui.children[0]).toBe(child);
  });

  it('render() calls render on children', () => {
    const tui = new StubTui();
    const child1 = {
      render() {
        return ['a'];
      },
    };
    const child2 = {
      render() {
        return ['b'];
      },
    };
    tui.addChild(child1);
    tui.addChild(child2);
    expect(tui.render()).toEqual(['a', 'b']);
  });
  it('renders children at the terminal column width', () => {
    const tui = new StubTui();
    let renderedWidth = 0;
    tui.addChild({
      render(width: number) {
        renderedWidth = width;
        return ['line'];
      },
    });
    tui.terminal.setSize(40, 24);

    expect(tui.render()).toEqual(['line']);
    expect(renderedWidth).toBe(40);
  });

  it('requestRender invokes the host callback', () => {
    const tui = new StubTui();
    let called = 0;
    tui.onRequestRender = () => called++;

    tui.requestRender();

    expect(called).toBe(1);
  });

  it('removeChild removes from children', () => {
    const tui = new StubTui();
    const child = {
      render() {
        return [];
      },
    };
    tui.addChild(child);
    tui.removeChild(child);
    expect(tui.children).toHaveLength(0);
  });

  it('clear() empties children', () => {
    const tui = new StubTui();
    tui.addChild({
      render() {
        return [];
      },
    });
    tui.addChild({
      render() {
        return [];
      },
    });
    tui.clear();
    expect(tui.children).toHaveLength(0);
  });

  it('handleInput forwards to focused child', () => {
    const tui = new StubTui();
    const handled: unknown[] = [];
    const child = {
      render() {
        return [];
      },
      handleInput(k: unknown) {
        handled.push(k);
      },
    };
    tui.addChild(child);
    tui.handleInput({ key: 'enter' });
    expect(handled).toEqual([{ key: 'enter' }]);
  });
});

describe('parseComponentTree — hand-rolled shapes', () => {
  it('parses a SelectList-shaped component', () => {
    const comp = {
      items: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
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
      children: [
        { label: 'A', onClick: () => {} },
        { label: 'B', onClick: () => {} },
      ],
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

  it('keeps keyboard-driven render wrappers interactive', () => {
    const component = {
      render: () => ['Paste the redirect URL below', '>'],
      handleInput: () => {},
    };
    const parsed = parseComponentTree(component as unknown as Record<string, unknown>);
    expect(shouldUseInteractiveCustom(component, parsed)).toBe(true);
  });

  it('keeps structured inputs in native web rendering', () => {
    const component = {
      getValue: () => '',
      setValue: () => {},
      handleInput: () => {},
    };
    const parsed = parseComponentTree(component as unknown as Record<string, unknown>);
    expect(shouldUseInteractiveCustom(component, parsed)).toBe(false);
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
      [
        { value: 'a', label: 'Option A' },
        { value: 'b', label: 'Option B' },
      ],
      10,
      selectTheme
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
      () => {}
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
      expect(result.children.map((c) => c.kind === 'text' && c.content)).toEqual([
        'before',
        'after',
      ]);
    }
  });
});

describe('parseComponentTree — pi-tui stacks', () => {
  it('detects a real HStack as a horizontal container via layoutType', () => {
    const stack = new HStack();
    stack.addChild(new Text('left', 0, 0));
    stack.addChild(new Text('right', 0, 0));
    const result = parseComponentTree(stack as unknown as Record<string, unknown>);
    expect(result.kind).toBe('container');
    if (result.kind === 'container') {
      expect(result.direction).toBe('horizontal');
      expect(result.children).toHaveLength(2);
    }
  });

  it('detects a real VStack as a vertical container', () => {
    const stack = new VStack();
    stack.addChild(new Text('top', 0, 0));
    stack.addChild(new Text('bottom', 0, 0));
    const result = parseComponentTree(stack as unknown as Record<string, unknown>);
    expect(result.kind).toBe('container');
    if (result.kind === 'container') {
      expect(result.direction).toBe('vertical');
      expect(result.children).toHaveLength(2);
    }
  });

  it('keeps hand-rolled direction:"row" containers horizontal (back-compat)', () => {
    const row = {
      children: [
        { text: 'a', paddingX: 0, paddingY: 0 },
        { text: 'b', paddingX: 0, paddingY: 0 },
      ],
      addChild: () => {},
      direction: 'row',
    };
    const result = parseComponentTree(row);
    expect(result.kind).toBe('container');
    if (result.kind === 'container') expect(result.direction).toBe('horizontal');
  });

  it('recurses into stacks nested inside Box containers', () => {
    const box = new Box(0, 0);
    const row = new HStack();
    row.addChild(new Text('one', 0, 0));
    row.addChild(new Text('two', 0, 0));
    box.addChild(row);
    box.addChild(new Text('tail', 0, 0));
    const result = parseComponentTree(box as unknown as Record<string, unknown>);
    expect(result.kind).toBe('container');
    if (result.kind === 'container') {
      expect(result.children).toHaveLength(2);
      expect(result.children[0].kind).toBe('container');
      if (result.children[0].kind === 'container') {
        expect(result.children[0].direction).toBe('horizontal');
      }
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
    const factory = () => {
      throw new Error('fail');
    };
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

describe('custom entries + markdown transformers', () => {
  const fakeSess = (parts: {
    entries?: unknown[];
    entryRenderer?: unknown;
    messageRenderer?: unknown;
    transformers?: unknown[];
  }) =>
    ({
      sessionManager: { getEntries: () => parts.entries ?? [] },
      extensionRunner: {
        getEntryRenderer: () => parts.entryRenderer,
        getMessageRenderer: () => parts.messageRenderer,
        getMarkdownTransformers: () => parts.transformers ?? [],
      },
    }) as unknown as AgentSession;

  it('projects a rendered CustomEntry as a synthetic custom notice', () => {
    const sess = fakeSess({
      entryRenderer: () => ({ render: () => ['todo: 2 open'] }),
      entries: [
        {
          type: 'custom',
          customType: 'todos',
          data: { open: 2 },
          timestamp: '2026-08-25T10:00:00Z',
        },
      ],
    });
    const out = customEntriesForWire(sess, []);
    expect(out).toHaveLength(1);
    const msg = out[0] as Record<string, unknown>;
    expect(msg.role).toBe('custom');
    expect(msg.customType).toBe('todos');
    expect(msg.fromEntry).toBe(true);
    expect(msg.details).toEqual({ open: 2 });
    expect(Array.isArray(msg.renderedNoticeHtml)).toBe(true);
  });

  it('hides renderer-less and empty-render entries (matches TUI behavior)', () => {
    const sess = fakeSess({
      entries: [
        { type: 'custom', customType: 'state' },
        { type: 'custom', customType: 'blank', timestamp: '2026-08-25T10:00:00Z' },
      ],
      entryRenderer: () => ({ render: () => [] }),
    });
    expect(customEntriesForWire(sess, [])).toHaveLength(0);
  });

  it('interleaves synthetic notices by timestamp between messages', () => {
    const sess = fakeSess({
      entryRenderer: () => ({ render: () => ['entry'] }),
      entries: [{ type: 'custom', customType: 'note', timestamp: 2000 }],
    });
    const messages = [
      { role: 'user', content: 'first', timestamp: 1000 },
      { role: 'assistant', content: 'second', timestamp: 3000 },
    ];
    const out = customEntriesForWire(sess, messages);
    expect(out.map((m) => (m as { role: string }).role)).toEqual(['user', 'custom', 'assistant']);
  });

  it('returns the input array identity when there is nothing to merge', () => {
    const sess = fakeSess({});
    const messages = [{ role: 'user', content: 'hi' }];
    expect(customEntriesForWire(sess, messages)).toBe(messages);
  });

  it('never routes entry-derived notices through the message renderer', () => {
    const sess = fakeSess({
      entryRenderer: () => ({ render: () => ['entry html'] }),
      messageRenderer: () => ({ render: () => ['WRONG'] }),
      entries: [{ type: 'custom', customType: 'dup', timestamp: 1 }],
    });
    const [merged] = customEntriesForWire(sess, []);
    const rendered = renderCustomMessage(sess, merged) as Record<string, unknown>;
    expect(rendered.fromEntry).toBe(true);
  });

  it('applies transformers in order to string and block text', () => {
    const sess = fakeSess({
      transformers: [(md: string) => `<wrap>${md}</wrap>`, (md: string) => md.toUpperCase()],
    });
    const out = applyMarkdownTransformers(sess, { role: 'user', content: 'hello' }) as {
      content: string;
    };
    expect(out.content).toBe('<WRAP>HELLO</WRAP>');

    const blockOut = applyMarkdownTransformers(sess, {
      role: 'assistant',
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'keep' },
      ],
      thinking: 'thought',
    }) as { content: { type: string; text?: string; data?: string }[]; thinking: string };
    expect(blockOut.content[0].text).toBe('<WRAP>A</WRAP>');
    expect(blockOut.content[1].data).toBe('keep');
    expect(blockOut.thinking.startsWith('<WRAP>')).toBe(true);
  });

  it('is copy-on-write and identity-preserving without transformers', () => {
    const msg = { role: 'user', content: 'plain' };
    expect(applyMarkdownTransformers(fakeSess({}), msg)).toBe(msg);
    const throwing = fakeSess({
      transformers: [
        () => {
          throw new Error('boom');
        },
      ],
    });
    expect(applyMarkdownTransformers(throwing, msg)).toBe(msg);
  });
});

describe('callFactoryAndParse thirdArg (footer factories)', () => {
  it('passes thirdArg instead of keybindings as the factory’s third argument', async () => {
    const footerData = { getGitBranch: () => 'main' };
    let seenThird: unknown;
    const factory = (_tui: unknown, _theme: unknown, third: unknown) => {
      seenThird = third;
      return {
        text: `branch: ${(third as typeof footerData).getGitBranch()}`,
        paddingX: 0,
        paddingY: 0,
      };
    };
    const result = await callFactoryAndParse(factory, '', undefined, footerData);
    expect(seenThird).toBe(footerData);
    expect(result && 'content' in result ? result.content : '').toContain('branch: main');
  });

  it('defaults the third argument to the keybindings stub', async () => {
    let seenThird: unknown;
    await callFactoryAndParse((_tui: unknown, _theme: unknown, third: unknown) => {
      seenThird = third;
      return { text: 'x', paddingX: 0, paddingY: 0 };
    }, '');
    expect(seenThird).toBe(stubKeybindings);
  });
});

describe('parseComponentTree — pi-tui Editor duck-type', () => {
  it('parses a getText/setText/handleInput editor as an input with live value', () => {
    const editor = {
      getText: () => 'draft text',
      setText: () => {},
      handleInput: () => {},
      render: (width: number) => ['x'.repeat(width)],
    };
    const result = parseComponentTree(editor);
    expect(result.kind).toBe('input');
    if (result.kind === 'input') expect(result.value).toBe('draft text');
  });

  it('still prefers getValue/setValue Input when both shapes are present', () => {
    const hybrid = {
      getValue: () => 'input-value',
      setValue: () => {},
      getText: () => 'editor-text',
      setText: () => {},
      handleInput: () => {},
    };
    const result = parseComponentTree(hybrid);
    expect(result.kind).toBe('input');
    if (result.kind === 'input') expect(result.value).toBe('input-value');
  });
});
