import {
  CUSTOM_DIALOG_REFRESH_MS,
  FG_PALETTE,
  MAX_COMPONENT_TREE_DEPTH,
  MAX_PARSED_COMPONENT_ITEMS,
  MAX_PARSED_COMPONENT_NODES,
  WIDGET_REFRESH_MS,
} from '../tui-stubs.ts';
import { MAX_WIRE_AUX_TOTAL_CHARS, MAX_WIRE_IMAGE_CHARS } from '../wire-limits.ts';
import type {
  CapabilityLimits,
  ComponentCapability,
  ComponentKind,
  CustomDialogBehavior,
  PiTuiExportCapability,
  PiTuiExportName,
  SkillCatalog,
  UiMethodCapability,
  UiMethodName,
} from './types.ts';

export const UI_METHODS = {
  select: {
    support: { level: 'native', surface: 'modal-dialog' },
    summary:
      'Shows a choice dialog and returns the selected value or undefined when cancelled, timed out, or aborted.',
    useWhen: 'Use for a small list of mutually exclusive choices.',
  },
  confirm: {
    support: { level: 'native', surface: 'modal-dialog' },
    summary:
      'Shows a confirmation dialog and returns whether the user confirmed; timeout or abort resolves false.',
    useWhen: 'Use when an action needs an explicit yes-or-no decision.',
  },
  input: {
    support: { level: 'native', surface: 'modal-dialog' },
    summary:
      'Shows a single-line text input dialog and returns its value or undefined when cancelled, timed out, or aborted.',
    useWhen: 'Use to collect a short, single-line value.',
  },
  notify: {
    support: { level: 'native', surface: 'toast' },
    summary: 'Shows an in-app toast with the requested info, warning, or error level.',
    useWhen: 'Use for brief, non-blocking feedback.',
  },
  onTerminalInput: {
    support: { level: 'native', surface: 'composer' },
    summary: 'Routes composer keystrokes to the registered handler until it is unsubscribed.',
    useWhen: 'Use when a keyboard-driven custom interaction needs raw input.',
  },
  setStatus: {
    support: { level: 'native', surface: 'status-bar' },
    summary: 'Sets or clears a keyed status message in the status bar.',
    useWhen: 'Use for concise persistent session status.',
  },
  setWorkingMessage: {
    support: { level: 'native', surface: 'working-indicator' },
    summary: 'Replaces the working loader message while the assistant is streaming.',
  },
  setWorkingVisible: {
    support: { level: 'native', surface: 'working-indicator' },
    summary: 'Shows or hides the built-in working loader row during streaming.',
  },
  setWorkingIndicator: {
    support: { level: 'native', surface: 'working-indicator' },
    summary: 'Sets the frames and timing of the streaming working indicator.',
  },
  setHiddenThinkingLabel: {
    support: { level: 'native', surface: 'thinking-block' },
    summary: 'Sets the label used for hidden thinking blocks.',
  },
  setWidget: {
    support: { level: 'native', surface: 'widget' },
    summary: 'Shows text lines or a refreshed component factory above or below the composer.',
    useWhen: 'Use for session-scoped content that should remain visible beside the composer.',
  },
  setFooter: {
    support: { level: 'native', surface: 'footer' },
    summary:
      'Renders the factory component tree in the footer and refreshes it live with session footer data.',
    useWhen:
      'Use for compact session-scoped output that benefits from branch, status, or provider data.',
  },
  setHeader: {
    support: { level: 'native', surface: 'header' },
    summary:
      'Renders the factory component tree in the chat header and refreshes it live with session footer data.',
  },
  setTitle: {
    support: { level: 'native', surface: 'document-title' },
    summary: 'Sets the browser document title for the session.',
  },
  custom: {
    support: { level: 'native', surface: 'rich-dialog' },
    summary:
      'Shows a parsed component tree in a rich dialog, or a keyboard-forwarding terminal overlay when required.',
    useWhen:
      'Use for custom dialogs built from supported parsed components or keyboard-driven interfaces.',
  },
  pasteToEditor: {
    support: { level: 'native', surface: 'composer' },
    summary: 'Pastes text into the composer using its paste handling.',
  },
  setEditorText: {
    support: { level: 'native', surface: 'composer' },
    summary: 'Replaces the text in the composer.',
  },
  getEditorText: {
    support: { level: 'native', surface: 'composer' },
    summary: 'Returns the current composer text.',
  },
  editor: {
    support: { level: 'native', surface: 'modal-dialog' },
    summary: 'Shows a multi-line editor dialog and returns its value or undefined when cancelled.',
    useWhen: 'Use to collect or edit multi-line text.',
  },
  addAutocompleteProvider: {
    support: { level: 'native', surface: 'composer' },
    summary: 'Adds an autocomplete provider to the composer suggestions.',
  },
  setEditorComponent: {
    support: { level: 'native', surface: 'composer' },
    summary: 'Shows the parsed factory component in the composer area.',
  },
  getEditorComponent: {
    support: {
      level: 'ignored',
      behavior: 'Returns undefined because Pi UI has no custom editor component.',
    },
    summary: 'Returns undefined; Pi UI uses its built-in web composer.',
  },
  theme: {
    support: {
      level: 'degraded',
      surface: 'extension-styling',
      degradation:
        'Factories receive a stub theme that maps semantic foreground and background colors to Pi UI palette colors.',
    },
    summary: 'Provides the stub theme used by extension UI factories.',
  },
  getAllThemes: {
    support: { level: 'native', surface: 'theme-catalog' },
    summary: 'Returns Pi UI web themes with their names and undefined file paths.',
  },
  getTheme: {
    support: {
      level: 'degraded',
      surface: 'extension-styling',
      degradation:
        'Returns the stub palette for known Pi UI theme names; browser colors are represented by the active CSS theme.',
    },
    summary: 'Returns the stub theme for a known Pi UI theme name, otherwise undefined.',
  },
  setTheme: {
    support: { level: 'native', surface: 'browser-theme' },
    summary: 'Applies a known Pi UI browser theme; unknown names return { success: false, error }.',
  },
  getToolsExpanded: {
    support: { level: 'native', surface: 'tool-output' },
    summary: 'Returns whether tool output is currently expanded.',
  },
  setToolsExpanded: {
    support: { level: 'native', surface: 'tool-output' },
    summary: 'Sets whether tool output is expanded.',
  },
} as const satisfies Record<UiMethodName, UiMethodCapability>;

export const EXTENSION_SHORTCUTS = {
  support: { level: 'native', surface: 'keyboard-shortcuts' },
  summary:
    'Registered extension shortcuts are bound globally, listed with their extension and description in keyboard help, and skipped for browser-reserved Ctrl/Cmd+W and Ctrl/Cmd+T combinations.',
} as const;

export const COMPONENTS = {
  select: {
    sources: [{ via: 'pi-tui', exports: ['SelectList'] }],
    rendersAs: 'A selectable list with an optional label and item descriptions.',
    interaction: 'select',
    example: 'select-list',
  },
  input: {
    sources: [{ via: 'pi-tui', exports: ['Input', 'Editor'] }],
    rendersAs: 'A text field for Input or a multi-line editor for Editor.',
    interaction: 'submit',
    example: 'text-input',
  },
  text: {
    sources: [{ via: 'pi-tui', exports: ['Text'] }],
    rendersAs: 'Plain text or preformatted text when preserving terminal layout.',
    interaction: 'none',
    example: 'plain-text',
  },
  button: {
    sources: [{ via: 'shape', requiredFields: ['label', 'onClick'], optionalFields: ['variant'] }],
    rendersAs: 'A button when interactive, otherwise a non-interactive label.',
    interaction: 'click',
    example: 'button-shape',
  },
  checkbox: {
    sources: [{ via: 'shape', requiredFields: ['checked', 'onToggle'], optionalFields: ['label'] }],
    rendersAs: 'A labeled checkbox or toggle control.',
    interaction: 'toggle',
    example: 'checkbox-shape',
  },
  progress: {
    sources: [{ via: 'shape', requiredFields: ['progress', 'render'], optionalFields: ['label'] }],
    rendersAs: 'A progress bar with an optional label.',
    interaction: 'none',
    example: 'live-progress-widget',
  },
  loader: {
    sources: [{ via: 'pi-tui', exports: ['Loader', 'CancellableLoader'] }],
    rendersAs: 'An animated loading indicator with its message.',
    interaction: 'none',
    example: 'loader',
  },
  image: {
    sources: [{ via: 'pi-tui', exports: ['Image'] }],
    rendersAs: 'An image with its extracted label when available.',
    interaction: 'none',
    notes: ['Images over the wire size limit are replaced with a text notice.'],
    example: 'image',
  },
  markdown: {
    sources: [{ via: 'pi-tui', exports: ['Markdown'] }],
    rendersAs: 'Rendered Markdown content.',
    interaction: 'none',
    example: 'markdown-summary',
  },
  settings: {
    sources: [{ via: 'pi-tui', exports: ['SettingsList'] }],
    rendersAs: 'A list of settings with their current values and available choices.',
    interaction: 'cycle',
    example: 'settings-list',
  },
  container: {
    sources: [{ via: 'pi-tui', exports: ['Box', 'HStack', 'VStack', 'Container'] }],
    rendersAs: 'A vertical stack or horizontal wrapping row containing child components.',
    interaction: 'none',
    notes: [
      'A container with a single parsed child collapses to that child.',
      'HStack becomes a horizontal wrapping row.',
      'Spacer components are dropped.',
    ],
    example: 'hstack-layout',
  },
} as const satisfies Record<ComponentKind, ComponentCapability>;

export const PARSER_RULES: readonly string[] = [
  'Components are detected by shape (duck typing), not class identity; detection order matters, for example ' +
    'SettingsList before SelectList, Editor before Input, and Loader before Markdown before Text.',
  'Component trees beyond the node, item, or depth limits are truncated.',
  'ANSI styling is stripped from Text content in parsed text nodes.',
  'Unrecognised components with render() become preformatted text.',
  'Labels are extracted from title or label, or from the first short Text child.',
];

export const CUSTOM_DIALOG: CustomDialogBehavior = {
  richDialog:
    'When the parsed tree is meaningful and the root is not keyboard-only, Pi UI shows a native rich dialog. ' +
    'It re-parses the live component periodically, invokes the component’s real callbacks ' +
    '(onSelect/onSubmit/onClick/onToggle and so on) on user interaction, and resolves the custom() promise ' +
    'when the extension calls done().',
  terminalFallback:
    'When the root component has handleInput and parsing yields no meaningful content (empty or ' +
    'render-fallback text), Pi UI shows a terminal-style overlay that forwards keystrokes to handleInput ' +
    'and re-renders render() output with ANSI colors.',
};

export const PI_TUI_EXPORTS = {
  TruncatedText: {
    parsesAs: 'text',
    note: 'Its render output is shown as preformatted text.',
  },
  ScrollView: {
    parsesAs: 'container',
    note: 'Its children parse as a container, with single-child containers collapsing to that child.',
  },
  MouseRegion: {
    parsesAs: 'text',
    note: 'Its rendered output is treated as preformatted text by the parser fallback.',
  },
  Spacer: {
    parsesAs: 'dropped',
    note: 'Spacer nodes are omitted from parsed component trees.',
  },
  TuiAltScreen: {
    parsesAs: 'container',
    note: 'It inherits Container and is parsed through its children rather than its terminal-screen render path.',
  },
  TuiMainScreen: {
    parsesAs: 'container',
    note: 'It inherits Container and is parsed through its children rather than its terminal-screen render path.',
  },
} satisfies Partial<Record<PiTuiExportName, PiTuiExportCapability>>;

export const LIMITS: CapabilityLimits = {
  maxNodes: MAX_PARSED_COMPONENT_NODES,
  maxItemsPerNode: MAX_PARSED_COMPONENT_ITEMS,
  maxDepth: MAX_COMPONENT_TREE_DEPTH,
  maxTreeChars: MAX_WIRE_AUX_TOTAL_CHARS,
  maxImageChars: MAX_WIRE_IMAGE_CHARS,
  widgetRefreshMs: WIDGET_REFRESH_MS,
  customRefreshMs: CUSTOM_DIALOG_REFRESH_MS,
};

export const THEME_COLORS: readonly string[] = Object.keys(FG_PALETTE);

export const SKILL_CATALOG: SkillCatalog = {
  uiMethods: UI_METHODS,
  components: COMPONENTS,
  piTuiExports: PI_TUI_EXPORTS,
  parserRules: PARSER_RULES,
  customDialog: CUSTOM_DIALOG,
  limits: LIMITS,
  themeColors: THEME_COLORS,
};
