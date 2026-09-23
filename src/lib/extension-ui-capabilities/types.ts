/**
 * Contract types for the extension UI capability catalog.
 *
 * The catalog (`catalog.ts`) describes how every `ctx.ui` capability appears
 * in Pi UI; the examples (`examples/*.ts`) prove the component claims against
 * the real parser; `render-skill.ts` turns both into the bundled
 * `skills/pi-ui-extension-ui/` skill. Everything here is type-only so the
 * module stays importable from any boundary element.
 */

import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import type * as PiTui from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';
import type { ParsedComponent } from '../tui-stubs.ts';

/** Where a capability appears in Pi UI. Closed set; the renderer maps each to prose. */
export type Surface =
  | 'modal-dialog'
  | 'rich-dialog'
  | 'terminal-overlay'
  | 'widget'
  | 'header'
  | 'footer'
  | 'status-bar'
  | 'toast'
  | 'composer'
  | 'document-title'
  | 'working-indicator'
  | 'thinking-block'
  | 'tool-output'
  | 'theme-catalog'
  | 'browser-theme'
  | 'keyboard-shortcuts'
  /** Colors and text styles of every extension-rendered surface. */
  | 'extension-styling';

export type Support =
  | { level: 'native'; surface: Surface }
  | { level: 'degraded'; surface: Surface; degradation: string }
  /** Accepted by Pi UI, but has no visible effect. */
  | { level: 'ignored'; behavior: string };

export type UiMethodName = keyof ExtensionUIContext;

export interface UiMethodCapability {
  support: Support;
  /** One sentence: what the user sees. */
  summary: string;
  useWhen?: string;
  avoidWhen?: string;
  /** Option names the SDK accepts that Pi UI does not honor. */
  ignoredOptions?: readonly string[];
}

export type ComponentKind = ParsedComponent['kind'];
export type PiTuiExportName = keyof typeof PiTui;

/** How an author produces a parsed kind: a real pi-tui export, or a Pi UI duck-typed shape. */
export type ComponentSource =
  | { via: 'pi-tui'; exports: readonly PiTuiExportName[] }
  | { via: 'shape'; requiredFields: readonly string[]; optionalFields?: readonly string[] };

export type ComponentInteraction = 'none' | 'select' | 'submit' | 'toggle' | 'click' | 'cycle';

export interface ComponentCapability {
  sources: readonly ComponentSource[];
  /** What the browser shows. */
  rendersAs: string;
  interaction: ComponentInteraction;
  notes?: readonly string[];
  /** An example whose `expected` equals this kind. */
  example: ExampleId;
}

/** How a pi-tui runtime component export is presented when an extension uses it. */
export interface PiTuiExportCapability {
  parsesAs: ComponentKind | 'terminal-fallback' | 'dropped';
  note: string;
}

export interface CapabilityLimits {
  maxNodes: number;
  maxItemsPerNode: number;
  maxDepth: number;
  maxTreeChars: number;
  maxImageChars: number;
  widgetRefreshMs: number;
  customRefreshMs: number;
}

/**
 * How `ctx.ui.custom()` chooses its presentation. Mirrors `custom()` in
 * server.ts and `shouldUseInteractiveCustom` in tui-stubs.ts; the examples
 * test proves both branches against the real parser.
 */
export interface CustomDialogBehavior {
  /** When the factory result is shown as a native rich dialog, and how it stays live. */
  richDialog: string;
  /** When Pi UI falls back to the keyboard-forwarding terminal overlay. */
  terminalFallback: string;
}

/** Everything the renderer needs from the catalog, as one value so rendering stays pure. */
export interface SkillCatalog {
  uiMethods: Readonly<Record<UiMethodName, UiMethodCapability>>;
  components: Readonly<Record<ComponentKind, ComponentCapability>>;
  piTuiExports: Readonly<Partial<Record<PiTuiExportName, PiTuiExportCapability>>>;
  limits: CapabilityLimits;
  themeColors: readonly string[];
  /** Parser behaviors that apply to every component kind. */
  parserRules: readonly string[];
  customDialog: CustomDialogBehavior;
}

// ── Examples ──────────────────────────────────────────────────────────────────

/**
 * Registered example ids. Each id `x` has a module at `examples/x.ts` whose
 * published region is embedded verbatim in the generated skill.
 */
export const EXAMPLE_IDS = [
  'select-list',
  'settings-list',
  'text-input',
  'multiline-editor',
  'markdown-summary',
  'plain-text',
  'loader',
  'image',
  'hstack-layout',
  'button-shape',
  'checkbox-shape',
  'live-progress-widget',
  'keyboard-overlay',
] as const;
export type ExampleId = (typeof EXAMPLE_IDS)[number];

/** Factory accepted by `ctx.ui.custom()`. */
export type CustomFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: Parameters<Parameters<ExtensionUIContext['custom']>[0]>[2],
  done: (result: unknown) => void
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

/** Factory accepted by `ctx.ui.setWidget()`. */
export type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

/** Expected outcome: the root parsed kind, or the keyboard-driven terminal fallback. */
export type ExampleExpectation = ComponentKind | 'terminal-fallback';

interface ExampleBase {
  id: ExampleId;
  /** Imperative, user-facing: what this example lets an extension do. */
  title: string;
}

export type ExampleModule =
  | (ExampleBase & { surface: 'custom'; expected: ExampleExpectation; factory: CustomFactory })
  | (ExampleBase & {
      surface: 'widget';
      expected: ComponentKind;
      placement?: 'aboveEditor' | 'belowEditor';
      factory: WidgetFactory;
    });

/** Markers delimiting the part of an example file that is published in the skill. */
export const PUBLISHED_REGION_START = '// #region published';
export const PUBLISHED_REGION_END = '// #endregion published';

/** One file of generated skill output, relative to the skill directory. */
export interface GeneratedFile {
  path: string;
  content: string;
}
