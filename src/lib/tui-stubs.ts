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
/* eslint-disable no-control-regex -- matching literal ESC/BEL control bytes is the point */
export function stripAnsi(s: string): string {
  return s
    // OSC sequences (hyperlinks, titles): ESC ] ... (BEL | ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS/APC/PM/SOS sequences (kitty graphics, etc.): ESC [P_^X] ... ESC \
    .replace(/\x1b[PX^_].*?\x1b\\/g, '')
    // CSI sequences (cursor moves, erase, SGR colors, etc.)
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '')
    // Remaining 2-byte escapes
    .replace(/\x1b[@-Z\\-_]/g, '');
}
/* eslint-enable no-control-regex */

/**
 * Converts ANSI SGR (color/style) codes to safe inline-styled HTML spans,
 * preserving selection highlights (bg color) that `stripAnsi` throws away —
 * used ONLY for the interactive-terminal fallback (genuinely keyboard-driven
 * components pi-tui's real renderer draws, which static parsing can't
 * reproduce). All non-SGR escapes (cursor moves, OSC, kitty graphics) are
 * dropped since they have no meaning in a static HTML line.
 */
/* eslint-disable no-control-regex -- matching literal ESC control bytes is the point */
const ANSI_BASIC_COLORS: Record<number, string> = {
  0: '#000000', 1: '#cc0000', 2: '#4e9a06', 3: '#c4a000', 4: '#3465a4', 5: '#75507b', 6: '#06989a', 7: '#d3d7cf',
  8: '#555753', 9: '#ef2929', 10: '#8ae234', 11: '#fce94f', 12: '#729fcf', 13: '#ad7fa8', 14: '#34e2e2', 15: '#eeeeec',
};

function ansi256ToHex(n: number): string {
  if (n < 16) return ANSI_BASIC_COLORS[n] ?? '#000000';
  if (n < 232) {
    const i = n - 16;
    const scale = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    const r = scale(Math.floor(i / 36));
    const g = scale(Math.floor((i % 36) / 6));
    const b = scale(i % 6);
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  const gray = (8 + (n - 232) * 10).toString(16).padStart(2, '0');
  return `#${gray}${gray}${gray}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface AnsiStyleState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
}

function styleDeclaration(s: AnsiStyleState): string {
  const fg = s.inverse ? s.bg : s.fg;
  let bg = s.inverse ? s.fg : s.bg;
  // Bare inverse (no explicit colors) means "swap the terminal's default
  // fg/bg" — we don't know those, so fall back to a visible highlight
  // instead of rendering invisibly (this is exactly how selection cursors
  // in SelectList/SettingsList themes commonly render).
  if (s.inverse && !fg && !bg) bg = 'rgba(127,127,127,0.35)';
  const decl: string[] = [];
  if (fg) decl.push(`color:${fg}`);
  if (bg) decl.push(`background-color:${bg}`);
  if (s.bold) decl.push('font-weight:bold');
  if (s.italic) decl.push('font-style:italic');
  if (s.underline && s.strikethrough) decl.push('text-decoration:underline line-through');
  else if (s.underline) decl.push('text-decoration:underline');
  else if (s.strikethrough) decl.push('text-decoration:line-through');
  return decl.join(';');
}

export function ansiToHtml(line: string): string {
  // Drop non-SGR escapes first, keep SGR (`...m`) sequences intact for parsing.
  const cleaned = line
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/g, '')
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-ln-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');

  let out = '';
  let style: AnsiStyleState = {};
  let lastIndex = 0;
  const sgrRe = /\x1b\[([0-9;]*)m/g;
  let match: RegExpExecArray | null;

  const emit = (text: string) => {
    if (!text) return;
    const decl = styleDeclaration(style);
    out += decl ? `<span style="${decl}">${escapeHtml(text)}</span>` : escapeHtml(text);
  };

  while ((match = sgrRe.exec(cleaned))) {
    emit(cleaned.slice(lastIndex, match.index));
    const params = (match[1] || '0').split(';').map(Number);
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) style = {};
      else if (p === 1) style.bold = true;
      else if (p === 3) style.italic = true;
      else if (p === 4) style.underline = true;
      else if (p === 7) style.inverse = true;
      else if (p === 9) style.strikethrough = true;
      else if (p === 22) style.bold = false;
      else if (p === 23) style.italic = false;
      else if (p === 24) style.underline = false;
      else if (p === 27) style.inverse = false;
      else if (p === 29) style.strikethrough = false;
      else if (p >= 30 && p <= 37) style.fg = ANSI_BASIC_COLORS[p - 30];
      else if (p === 38 && params[i + 1] === 5) { style.fg = ansi256ToHex(params[i + 2]); i += 2; }
      else if (p === 38 && params[i + 1] === 2) { style.fg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`; i += 4; }
      else if (p === 39) style.fg = undefined;
      else if (p >= 40 && p <= 47) style.bg = ANSI_BASIC_COLORS[p - 40];
      else if (p === 48 && params[i + 1] === 5) { style.bg = ansi256ToHex(params[i + 2]); i += 2; }
      else if (p === 48 && params[i + 1] === 2) { style.bg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`; i += 4; }
      else if (p === 49) style.bg = undefined;
      else if (p >= 90 && p <= 97) style.fg = ANSI_BASIC_COLORS[p - 90 + 8];
      else if (p >= 100 && p <= 107) style.bg = ANSI_BASIC_COLORS[p - 100 + 8];
    }
    lastIndex = sgrRe.lastIndex;
  }
  emit(cleaned.slice(lastIndex));
  return out;
}
/* eslint-enable no-control-regex */

interface ThemeFn {
  fg: (_color: string, text: string) => string;
  bg: (_color: string, text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  underline: (text: string) => string;
  inverse: (text: string) => string;
  strikethrough: (text: string) => string;
  [key: string]: unknown;
}

/** No-op theme — fg/bg/bold all return the text unchanged. */
export const stubTheme: ThemeFn = new Proxy({} as ThemeFn, {
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
export interface StubComponent {
  tui?: unknown;
  render?: (width: number) => string[];
  unfocus?: () => void;
  focus?: () => void;
  handleInput?: (keyData: unknown) => void;
  isFocused?: () => boolean;
  _focused?: boolean;
  children?: StubComponent[];
  [key: string]: unknown;
}

/** Minimal TUI stub — satisfies `tui` parameter of extension factories. */
export class StubTui {
  children: StubComponent[] = [];
  private focused: StubComponent | null = null;

  requestRender() {}
  showOverlay() { return { hide() {}, setHidden() {}, isHidden() { return false; }, focus() {}, unfocus() {}, isFocused() { return false; } }; }
  hideOverlay() {}
  hasOverlay() { return false; }
  addChild(child: StubComponent) {
    if (child && !this.children.includes(child)) {
      this.children.push(child);
      child.tui = this;
      if (!this.focused) this.focus(child);
    }
  }
  removeChild(child: StubComponent) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      if (this.focused === child) this.focused = this.children[0] || null;
    }
  }
  clear() {
    this.children = [];
    this.focused = null;
  }
  render() {
    return this.children.flatMap(c => c.render?.(80) || []);
  }
  invalidate() {}
  focus(child: StubComponent) {
    if (this.focused === child) return;
    this.focused?.unfocus?.();
    this.focused = child;
    child.focus?.();
  }
  unfocus(child: StubComponent) {
    if (this.focused === child) {
      child.unfocus?.();
      this.focused = null;
    }
  }
  isFocused(child: StubComponent) {
    return this.focused === child;
  }
  handleInput(keyData: unknown) {
    if (this.focused?.handleInput) {
      this.focused.handleInput(keyData);
    } else {
      // Fallback: try to find something focused in the tree
      const target = this.findFocused(this.children);
      target?.handleInput?.(keyData);
    }
  }
  private findFocused(children: StubComponent[]): StubComponent | null {
    for (const child of children) {
      if (child.isFocused?.() || child._focused) return child;
      if (child.children) {
        const f = this.findFocused(child.children);
        if (f) return f;
      }
    }
    return null;
  }
}

export const stubTui = new StubTui();

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
  path?: number[];
}

export interface ParsedInput {
  kind: 'input';
  label: string;
  placeholder?: string;
  value?: string;
  multiline?: boolean;
  path?: number[];
}

export interface ParsedText {
  kind: 'text';
  label: string;
  content: string;
  monoPreserve?: boolean; // true when content came from render() fallback
  path?: number[];
}

export interface ParsedButton {
  kind: 'button';
  label: string;
  variant?: 'default' | 'primary' | 'danger';
  path?: number[];
}

export interface ParsedCheckbox {
  kind: 'checkbox';
  label: string;
  checked: boolean;
  path?: number[];
}

export interface ParsedProgressBar {
  kind: 'progress';
  label: string;
  progress: number; // 0..1
  path?: number[];
}

export interface ParsedLoader {
  kind: 'loader';
  label: string;
  cancellable?: boolean;
  path?: number[];
}

export interface ParsedImage {
  kind: 'image';
  label: string;
  data: string; // base64
  mimeType: string;
  path?: number[];
}

export interface ParsedMarkdown {
  kind: 'markdown';
  content: string;
  path?: number[];
}

export interface ParsedSettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
}

export interface ParsedSettings {
  kind: 'settings';
  items: ParsedSettingItem[];
  path?: number[];
}

export interface ParsedContainer {
  kind: 'container';
  children: ParsedComponent[];
  direction?: 'vertical' | 'horizontal';
  path?: number[];
}

export type ParsedComponent =
  | ParsedContainer
  | ParsedSelect
  | ParsedInput
  | ParsedText
  | ParsedButton
  | ParsedCheckbox
  | ParsedProgressBar
  | ParsedLoader
  | ParsedImage
  | ParsedMarkdown
  | ParsedSettings;


// ── Component tree walker ─────────────────────────────────────────────────────

/**
 * Duck-type check: does this object look like a SettingsList?
 * SettingsList has: items (array of {id, label, currentValue}), updateValue (function)
 */
function isSettingsList(comp: Record<string, unknown>): boolean {
  return (
    Array.isArray(comp.items) &&
    comp.items.length > 0 &&
    typeof comp.items[0] === 'object' &&
    comp.items[0] !== null &&
    'id' in comp.items[0] &&
    'currentValue' in comp.items[0] &&
    typeof comp.updateValue === 'function'
  );
}

/**
 * Duck-type check: does this object look like a SelectList?
 * SelectList has: items (array of {value, label}), setFilter (function).
 * `onSelect` is an optional field assigned post-construction by the
 * extension — NOT required for detection.
 */
function isSelectList(comp: Record<string, unknown>): boolean {
  return (
    Array.isArray(comp.items) &&
    comp.items.length > 0 &&
    typeof comp.items[0] === 'object' &&
    comp.items[0] !== null &&
    'value' in comp.items[0] &&
    'label' in comp.items[0] &&
    typeof comp.setFilter === 'function'
  );
}

/**
 * Duck-type check: does this object look like an Input?
 * Input has: getValue/setValue/handleInput (functions). `onSubmit` is an
 * optional field assigned post-construction — NOT required for detection.
 */
function isInput(comp: Record<string, unknown>): boolean {
  return (
    typeof comp.getValue === 'function' &&
    typeof comp.setValue === 'function' &&
    typeof comp.handleInput === 'function'
  );
}

/**
 * Duck-type check: does this object look like a Container/Box?
 * Container has: children (array), addChild (function)
 */
function isContainer(comp: Record<string, unknown>): boolean {
  return (
    (Array.isArray(comp.children) && typeof comp.addChild === 'function') ||
    (Array.isArray(comp.children) && comp.children.length > 0 && typeof comp.render === 'function')
  );
}

/**
 * Duck-type check: does this object look like a Markdown block?
 * Markdown has the SAME text/paddingX/paddingY fields as Text (must be
 * checked first) plus a `theme` object and `setText` method.
 */
function isMarkdown(comp: Record<string, unknown>): boolean {
  return (
    typeof comp.text === 'string' &&
    typeof comp.paddingX === 'number' &&
    typeof comp.paddingY === 'number' &&
    typeof comp.theme === 'object' &&
    comp.theme !== null &&
    typeof comp.setText === 'function'
  );
}

/**
 * Duck-type check: does this object look like a Text?
 * Text has: text (string), paddingX (number), paddingY (number).
 * Must be checked AFTER isMarkdown and isLoader (both share these fields
 * via inheritance/structural overlap).
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
 * Duck-type check: does this object look like a ProgressBar?
 * ProgressBar has: progress (number 0..1), render (function), optionally label (string)
 */
function isProgressBar(comp: Record<string, unknown>): boolean {
  return typeof comp.progress === 'number' && typeof comp.render === 'function';
}

/**
 * Duck-type check: does this object look like a Loader / Spinner (or
 * CancellableLoader)? Loader extends Text but carries `frames` + `setMessage`
 * — must be checked BEFORE isText since it structurally matches it too.
 */
function isLoader(comp: Record<string, unknown>): boolean {
  return (
    Array.isArray(comp.frames) &&
    typeof comp.setMessage === 'function' &&
    typeof comp.render === 'function'
  );
}

/**
 * Duck-type check: does this object look like a Spacer (used for layout gaps)?
 * Spacer has: lines (number), setLines (function), no text field.
 */
function isSpacer(comp: Record<string, unknown>): boolean {
  return (
    typeof comp.lines === 'number' &&
    typeof comp.setLines === 'function' &&
    !isText(comp)
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
  path: number[] = [],
  nodeMap?: Map<string, Record<string, unknown>>,
): ParsedComponent {
  const register = (node: ParsedComponent): ParsedComponent => {
    if (nodeMap) nodeMap.set(path.join('.'), comp);
    (node as { path?: number[] }).path = path;
    return node;
  };

  // ── Leaf: SettingsList — checked before SelectList (items shape differs
  // by field names, but check order still matters for clarity) ──────────
  if (isSettingsList(comp)) {
    const items = comp.items as { id: string; label: string; description?: string; currentValue: string; values?: string[] }[];
    return register({ kind: 'settings', items });
  }

  // ── Leaf: SelectList ──────────────────────────────────────────────────
  if (isSelectList(comp)) {
    const items = comp.items as { value: string; label: string; description?: string }[];
    const label = extractLabel(comp);
    return register({ kind: 'select', label, options: items });
  }

  // ── Leaf: Input ───────────────────────────────────────────────────────
  if (isInput(comp)) {
    const value = typeof comp.getValue === 'function' ? comp.getValue() as string : '';
    const label = extractLabel(comp);
    return register({ kind: 'input', label, placeholder: 'Type your response…', value });
  }

  // ── Leaf: Loader / Spinner — checked before Text (Loader extends Text) ─
  if (isLoader(comp)) {
    const label = (typeof comp.message === 'string' ? comp.message : extractLabel(comp)) || '';
    const cancellable = typeof comp.onAbort !== 'undefined' || 'abortController' in comp;
    return register({ kind: 'loader', label, cancellable });
  }

  // ── Composite: Markdown — checked before Text (shares text/paddingX/Y) ─
  if (isMarkdown(comp)) {
    return register({ kind: 'markdown', content: comp.text as string });
  }

  // ── Leaf: Text ────────────────────────────────────────────────────────
  if (isText(comp)) {
    const rawText = comp.text as string;
    const content = stripAnsi(rawText);
    return register({ kind: 'text', label: '', content });
  }

  // ── Leaf: Button ──────────────────────────────────────────────────────
  if (isButton(comp)) {
    const label = typeof comp.label === 'string' ? comp.label : '';
    const variant = typeof comp.variant === 'string' ? comp.variant as 'default' | 'primary' | 'danger' : undefined;
    return register({ kind: 'button', label, variant });
  }

  // ── Leaf: Checkbox ────────────────────────────────────────────────────
  if (isCheckbox(comp)) {
    const label = extractLabel(comp) || '';
    return register({ kind: 'checkbox', label, checked: !!comp.checked });
  }

  // ── Leaf: ProgressBar ─────────────────────────────────────────────────
  if (isProgressBar(comp)) {
    const label = extractLabel(comp) || '';
    return register({ kind: 'progress', label, progress: comp.progress as number });
  }

  // ── Composite: Spacer (skip — no visual content) ──────────────────────
  if (isSpacer(comp)) {
    return { kind: 'text', label: '', content: '' };
  }

  // ── Composite: Container/Box — recurse into children ───────────────────
  if (isContainer(comp)) {
    const children = comp.children as Record<string, unknown>[];
    const direction: 'vertical' | 'horizontal' =
      typeof comp.direction === 'string' && comp.direction === 'row' ? 'horizontal' : 'vertical';

    const parsedChildren: ParsedComponent[] = [];
    children.forEach((child, i) => {
      const parsed = parseComponentTree(child, width, [...path, i], nodeMap);
      // Skip empty text results (from spacers, empty containers)
      if (parsed.kind === 'text' && !parsed.content) return;
      parsedChildren.push(parsed);
    });
    if (parsedChildren.length === 0) {
      return { kind: 'text', label: '', content: '' };
    }
    if (parsedChildren.length === 1) {
      return parsedChildren[0];
    }
    return register({ kind: 'container', children: parsedChildren, direction });
  }

  // ── Leaf: Image ────────────────────────────────────────────────────────
  // Real Image components carry base64Data + mimeType; hand-rolled ones
  // may use data + mimeType directly — accept both.
  {
    const imgData = (comp.base64Data ?? comp.data) as unknown;
    if (typeof imgData === 'string' && typeof comp.mimeType === 'string') {
      return register({ kind: 'image', label: extractLabel(comp), data: imgData, mimeType: comp.mimeType });
    }
  }
  // ── Fallback: try render() for unknown components ─────────────────────
  if (typeof comp.render === 'function') {
    try {
      const lines = comp.render(width) as string[];
      if (Array.isArray(lines) && lines.length > 0) {
        const content = lines.map((l) => stripAnsi(l)).join('\n').trim();
        if (content) return register({ kind: 'text', label: '', content, monoPreserve: true });
      }
    } catch { /* render may fail without real TUI */ }
  }
  return { kind: 'text', label: '', content: '' };
}

/**
 * Keyboard-driven wrapper components often hide their actual controls in closures
 * and expose only render() + handleInput(). Their parsed text is a terminal snapshot,
 * not a static web component, so they must retain terminal input forwarding.
 */
export function shouldUseInteractiveCustom(
  component: Record<string, unknown>,
  parsed: ParsedComponent | null,
): boolean {
  if (typeof component.handleInput !== 'function') return false;
  if (!parsed) return true;
  return parsed.kind === 'text' && (!parsed.content || parsed.monoPreserve === true);
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
