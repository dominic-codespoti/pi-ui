/**
 * Minimal TUI stubs + Component tree parser for calling extension factories
 * on the server side and extracting structured data for the web UI.
 *
 * This lets us call `custom()` factories that build pi-tui Component trees,
 * then parse the tree to extract SelectList items, Input fields, and text
 * content — serializable shapes the web client can render natively.
 */

// ── Stubs ────────────────────────────────────────────────────────────────────

/** Strips ANSI escape codes from a string. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** No-op theme — fg/bg/bold all return the text unchanged. */
export const stubTheme = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    if (prop === 'fg' || prop === 'bg') {
      return (_color: string, text: string) => text;
    }
    if (prop === 'bold' || prop === 'italic' || prop === 'underline' || prop === 'inverse' || prop === 'strikethrough') {
      return (text: string) => text;
    }
    return undefined;
  },
});

/** Minimal TUI stub — satisfies `tui` parameter of extension factories. */
export const stubTui = {
  requestRender() {},
  showOverlay() { return { hide() {}, setHidden() {}, isHidden() { return false; }, focus() {}, unfocus() {}, isFocused() { return false; } }; },
  hideOverlay() {},
  hasOverlay() { return false; },
  addChild() {},
  removeChild() {},
  clear() {},
  children: [] as unknown[],
  render() { return []; },
  invalidate() {},
};

/** Minimal keybindings stub. */
export const stubKeybindings = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    if (prop === 'matches') return () => false;
    if (prop === 'getKeys') return () => [];
    return undefined;
  },
});

// ── Parsed component types ────────────────────────────────────────────────────

export interface ParsedSelect {
  kind: 'select';
  label: string;
  options: { value: string; label: string; description?: string }[];
}

export interface ParsedInput {
  kind: 'input';
  label: string;
  placeholder?: string;
  value?: string;
  multiline?: boolean;
}

export interface ParsedText {
  kind: 'text';
  label: string;
  content: string;
}

export interface ParsedButton {
  kind: 'button';
  label: string;
  variant?: 'default' | 'primary' | 'danger';
}

export interface ParsedCheckbox {
  kind: 'checkbox';
  label: string;
  checked: boolean;
}

export interface ParsedContainer {
  kind: 'container';
  children: ParsedComponent[];
  direction?: 'vertical' | 'horizontal';
}

export type ParsedComponent = ParsedContainer | ParsedSelect | ParsedInput | ParsedText | ParsedButton | ParsedCheckbox;

// ── Component tree walker ─────────────────────────────────────────────────────

/**
 * Duck-type check: does this object look like a SelectList?
 * SelectList has: items (array of {value, label}), onSelect (function), setFilter (function)
 */
function isSelectList(comp: Record<string, unknown>): boolean {
  return (
    Array.isArray(comp.items) &&
    comp.items.length > 0 &&
    typeof comp.items[0] === 'object' &&
    comp.items[0] !== null &&
    'value' in comp.items[0] &&
    'label' in comp.items[0] &&
    typeof comp.onSelect === 'function'
  );
}

/**
 * Duck-type check: does this object look like an Input?
 * Input has: getValue (function), onSubmit (function), focused (boolean)
 */
function isInput(comp: Record<string, unknown>): boolean {
  return (
    typeof comp.getValue === 'function' &&
    typeof comp.handleSubmit === 'function' ||
    typeof comp.onSubmit === 'function'
  );
}

/**
 * Duck-type check: does this object look like a Container/Box?
 * Container has: children (array), addChild (function)
 */
function isContainer(comp: Record<string, unknown>): boolean {
  return (
    Array.isArray(comp.children) &&
    typeof comp.addChild === 'function'
  );
}

/**
 * Duck-type check: does this object look like a Text?
 * Text has: text (string), paddingX (number), paddingY (number)
 */
function isText(comp: Record<string, unknown>): boolean {
  return (
    typeof comp.text === 'string' &&
    typeof comp.paddingX === 'number' &&
    typeof comp.paddingY === 'number'
  );
}

/**
 * Duck-type check: does this object look like a Button?
 * Button has: label (string), onClick (function), optionally variant (string)
 */
function isButton(comp: Record<string, unknown>): boolean {
  return (
    typeof comp.label === 'string' &&
    typeof comp.onClick === 'function'
  );
}

/**
 * Duck-type check: does this object look like a Checkbox / toggle?
 * Checkbox has: checked (boolean), onToggle (function), optionally label (string)
 */
function isCheckbox(comp: Record<string, unknown>): boolean {
  return (
    typeof comp.checked === 'boolean' &&
    typeof comp.onToggle === 'function'
  );
}

/**
 * Duck-type check: does this object look like a Spacer (used for layout gaps)?
 * Spacer has: size (number), render returns empty lines.
 */
function isSpacer(comp: Record<string, unknown>): boolean {
  return (
    typeof comp.size === 'number' &&
    typeof comp.addChild !== 'function' &&
    !isText(comp)
  );
}

/**
 * Duck-type check: does this object look like a Markdown block?
 * Markdown has: markdown (string), options (object)
 */
function isMarkdownBlock(comp: Record<string, unknown>): boolean {
  return (
    typeof comp.markdown === 'string' &&
    typeof comp.invalidate === 'function'
  );
}

/**
 * Walk a pi-tui Component tree and extract structured data for web rendering.
 *
 * Unlike the previous version which returned only the first interactive element,
 * this version returns a recursive container tree that preserves the full layout:
 * - Containers with children are returned as ParsedContainer 
 * - Leaf components are returned as their respective types
 * - Direction (vertical/horizontal) is inferred from container properties
 */
export function parseComponentTree(
  comp: Record<string, unknown>,
  width: number = 80,
): ParsedComponent {
  // ── Leaf: SelectList ──────────────────────────────────────────────────
  if (isSelectList(comp)) {
    const items = comp.items as { value: string; label: string; description?: string }[];
    const label = extractLabel(comp);
    return { kind: 'select', label, options: items };
  }

  // ── Leaf: Input ───────────────────────────────────────────────────────
  if (isInput(comp)) {
    const value = typeof comp.getValue === 'function' ? comp.getValue() as string : '';
    const label = extractLabel(comp);
    return { kind: 'input', label, placeholder: 'Type your response…', value };
  }

  // ── Leaf: Text ────────────────────────────────────────────────────────
  if (isText(comp)) {
    const rawText = comp.text as string;
    const content = stripAnsi(rawText);
    return { kind: 'text', label: '', content };
  }

  // ── Leaf: Button ──────────────────────────────────────────────────────
  if (isButton(comp)) {
    const label = typeof comp.label === 'string' ? comp.label : '';
    const variant = typeof comp.variant === 'string' ? comp.variant as 'default' | 'primary' | 'danger' : undefined;
    return { kind: 'button', label, variant };
  }

  // ── Leaf: Checkbox ────────────────────────────────────────────────────
  if (isCheckbox(comp)) {
    const label = extractLabel(comp) || '';
    return { kind: 'checkbox', label, checked: !!comp.checked };
  }

  // ── Composite: Spacer (skip — no visual content) ──────────────────────
  if (isSpacer(comp)) {
    return { kind: 'text', label: '', content: '' };
  }

  // ── Composite: Markdown ───────────────────────────────────────────────
  if (isMarkdownBlock(comp)) {
    return { kind: 'text', label: '', content: comp.markdown as string };
  }

  // ── Composite: Container/Box — recurse into children ──────────────────
  if (isContainer(comp)) {
    const children = comp.children as Record<string, unknown>[];
    const direction = typeof comp.direction === 'string'
      ? (comp.direction === 'row' ? 'horizontal' as const : 'vertical' as const)
      : typeof comp.align === 'string'
        ? 'horizontal' as const
        : 'vertical' as const;

    const parsedChildren: ParsedComponent[] = [];
    for (const child of children) {
      const parsed = parseComponentTree(child, width);
      // Skip empty text results (from spacers, empty containers)
      if (parsed.kind === 'text' && !parsed.content) continue;
      parsedChildren.push(parsed);
    }
    if (parsedChildren.length === 0) {
      return { kind: 'text', label: '', content: '' };
    }
    if (parsedChildren.length === 1) {
      return parsedChildren[0];
    }
    return { kind: 'container', children: parsedChildren, direction };
  }

  // ── Fallback: try render() for unknown components ─────────────────────
  if (typeof comp.render === 'function') {
    try {
      const lines = comp.render(width) as string[];
      if (Array.isArray(lines) && lines.length > 0) {
        const content = lines.map((l) => stripAnsi(l)).join('\n').trim();
        if (content) return { kind: 'text', label: '', content };
      }
    } catch { /* render may fail without real TUI */ }
  }

  return { kind: 'text', label: '', content: '' };
}

/**
 * Try to extract a label from a component or its surrounding context.
 * Looks for a `title` property, or extracts the first line of text content.
 */
function extractLabel(comp: Record<string, unknown>): string {
  // Direct title property
  if (typeof comp.title === 'string') return comp.title;
  if (typeof comp.label === 'string') return comp.label;

  // Check children for Text components
  if (isContainer(comp)) {
    const children = comp.children as Record<string, unknown>[];
    for (const child of children) {
      if (isText(child)) {
        const raw = stripAnsi(child.text as string).trim();
        if (raw.length > 0 && raw.length <= 80) return raw;
      }
    }
  }

  return '';
}

// ── Factory executor ──────────────────────────────────────────────────────────

/**
 * Safely call a pi-tui extension factory with stubs and parse the result.
 *
 * @param factory - The factory function from the extension's custom() call
 * @param title - Title hint from the extension
 * @param options - The options object from custom() (overlay, overlayOptions, etc.)
 * @returns Parsed component tree for web rendering, or null on failure
 */
export async function callFactoryAndParse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: (...args: any[]) => any | Promise<any>,
  title: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: Record<string, any>,
): Promise<ParsedComponent | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let component: any;
    if (options) {
      component = await factory(stubTui, stubTheme, stubKeybindings, () => {});
    } else {
      component = await factory(stubTui, stubTheme, stubKeybindings, () => {});
    }

    if (!component || typeof component !== 'object') return null;

    const parsed = parseComponentTree(component);
    // Inject title if the component didn't provide one
    if (title && parsed.kind !== 'container') {
      const p = parsed as unknown as { label?: string };
      if (!p.label) p.label = title;
    }
    return parsed;
  } catch {
    return null;
  }
}
