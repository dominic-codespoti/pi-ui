<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';

  import type { ServerMessage, ClientMessage, ModelInfo, ProviderInfo, SkillSummary, PromptSummary, ExtensionSummary, WidgetContent, TreeNode, UpdateStatus, UpdateTarget } from '$lib/ws/protocol';
  import type { PiEvent } from '$lib/ws/protocol';
  import { renderMarkdown, highlightCode } from '$lib/markdown';
  import { formatRelativeDate as formatDate } from '$lib/utils';
  import { projectsState } from '$lib/state/projects-state.svelte';
  import { rawMessagesToUI, uid, formatToolInput, extractTextContent, reconnectDelay, type UIMessage, type MsgUsage } from '$lib/client-messages';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { Switch } from '$lib/components/ui/switch';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import * as Select from '$lib/components/ui/select';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import * as Card from '$lib/components/ui/card';
  import * as Tabs from '$lib/components/ui/tabs';
  import SidebarPanel from '$lib/components/sidebar-panel.svelte';
  import DiffViewer from '$lib/components/diff-viewer.svelte';
  import FileViewerModal from '$lib/components/file-viewer-modal.svelte';
  import ProjectsSidebar from '$lib/components/projects/projects-sidebar.svelte';
  import ProjectPicker from '$lib/components/projects/project-picker.svelte';

  import Terminal from '@lucide/svelte/icons/terminal';
  import FileText from '@lucide/svelte/icons/file-text';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Search from '@lucide/svelte/icons/search';
  import List from '@lucide/svelte/icons/list';
  import Cog from '@lucide/svelte/icons/cog';
  import Brain from '@lucide/svelte/icons/brain';
  import Send from '@lucide/svelte/icons/send';
  import Trash from '@lucide/svelte/icons/trash';
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Loader from '@lucide/svelte/icons/loader';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import X from '@lucide/svelte/icons/x';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Square from '@lucide/svelte/icons/square';
  import SquareCheck from '@lucide/svelte/icons/square-check';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import Blocks from '@lucide/svelte/icons/blocks';
import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import PiIcon from '@lucide/svelte/icons/pi';
  import CornerDownLeft from '@lucide/svelte/icons/corner-down-left';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Bell from '@lucide/svelte/icons/bell';

  // ── Provider colour chips ────────────────────────────────────────────────────

  function providerColor(id: string): string {
    const map: Record<string, string> = {
      anthropic:  '#C06A3A',
      openai:     '#10A37F',
      google:     '#4285F4',
      gemini:     '#4285F4',
      mistral:    '#FF7000',
      groq:       '#F55036',
      cohere:     '#39D3C3',
      deepseek:   '#4D90FE',
      xai:        '#888888',
      grok:       '#888888',
      openrouter: '#6E56CF',
      meta:       '#0668E1',
      llama:      '#0668E1',
      bedrock:    '#FF9900',
      aws:        '#FF9900',
    };
    const lower = id.toLowerCase();
    for (const [key, color] of Object.entries(map)) {
      if (lower.includes(key)) return color;
    }
    return '#6B7280';
  }

  function versionText(version?: string): string {
    return version && version !== 'unknown' ? `v${version}` : 'unknown';
  }

  // ── Tool output language detection ──────────────────────────────────────────

  function getToolLang(toolName: string | undefined, toolInput: string | undefined): string {
    const name = (toolName ?? '').toLowerCase();
    if (name === 'bash' || name === 'execute_bash' || name === 'shell') return 'bash';
    if (name === 'read' || name === 'read_file' || name === 'cat') {
      const path = (toolInput ?? '').split(' ')[0];
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const extMap: Record<string, string> = {
        ts: 'typescript', tsx: 'typescript',
        js: 'javascript', jsx: 'javascript',
        py: 'python',
        sh: 'bash', bash: 'bash',
        json: 'json',
        yaml: 'yaml', yml: 'yaml',
        html: 'html', xml: 'xml',
        css: 'css',
        sql: 'sql',
        md: 'markdown',
        rs: 'rust',
        go: 'go',
        cs: 'csharp',
        svelte: 'html',
      };
      return extMap[ext] ?? '';
    }
    return '';
  }

  // ── Tool registry: icons, labels, colors ─────────────────────────────────────
  //
  // Maps tool names to display metadata. Unknown tools fall back to heuristics.
  // To add a custom extension tool, just add an entry here.

  type ToolMetaEntry = { icon: typeof Terminal; label: string; color: string };

  const toolMeta: Record<string, ToolMetaEntry> = {
    // Shell
    bash:         { icon: Terminal, label: 'Shell',  color: 'var(--color-info)' },
    execute_bash: { icon: Terminal, label: 'Shell',  color: 'var(--color-info)' },
    shell:        { icon: Terminal, label: 'Shell',  color: 'var(--color-info)' },
    // File read
    read:         { icon: FileText, label: 'Read',   color: 'color-mix(in oklch, var(--color-base-content) 45%, transparent)' },
    read_file:    { icon: FileText, label: 'Read',   color: 'color-mix(in oklch, var(--color-base-content) 45%, transparent)' },
    cat:          { icon: FileText, label: 'Read',   color: 'color-mix(in oklch, var(--color-base-content) 45%, transparent)' },
    // File write
    write:        { icon: Pencil, label: 'Write',  color: 'var(--color-success)' },
    write_file:   { icon: Pencil, label: 'Write',  color: 'var(--color-success)' },
    // Edit
    edit:         { icon: Pencil, label: 'Edit',   color: 'var(--color-success)' },
    // Search
    grep:         { icon: Search, label: 'Search', color: 'var(--color-secondary)' },
    find:         { icon: Search, label: 'Find',   color: 'var(--color-secondary)' },
    // List
    ls:           { icon: List,   label: 'List',   color: 'var(--color-primary)' },
  };

  // Heuristic icon map for unknown tool name patterns
  const HEURISTIC_ICONS: [RegExp, typeof Terminal][] = [
    [/search|find|grep|query|lookup/i, Search],
    [/write|create|save|store|generate/i, Pencil],
    [/delete|remove|trash|drop/i, Trash],
    [/send|post|publish|deploy|push/i, Send],
    [/read|fetch|load|get|download/i, FileText],
    [/run|exec|shell|bash|spawn/i, Terminal],
    [/list|ls|dir|enumerate/i, List],
  ];

  /** Lookup tool metadata with fallback heuristics for unknown tools. */
  function getToolMeta(name: string | undefined): ToolMetaEntry {
    const key = (name ?? '').toLowerCase();
    if (toolMeta[key]) return toolMeta[key];

    // Try to find description from toolsList
    const desc = toolsList.find((t) => t.name.toLowerCase() === key)?.description
      // Also check extension-provided tool lists for richer metadata
      ?? extensionsList.flatMap((ext) => ext.tools).find((t) => t.name.toLowerCase() === key)?.description;

    // Heuristic icon from name patterns
    let icon = Cog;
    for (const [pattern, component] of HEURISTIC_ICONS) {
      if (pattern.test(key)) { icon = component; break; }
    }

    // Label: short description → snake_case name → title-cased name
    let label: string;
    if (desc && desc.length <= 24) {
      label = desc;
    } else if (key.includes('_') || key.includes('-')) {
      label = key.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    } else {
      label = key.charAt(0).toUpperCase() + key.slice(1);
    }

    return { icon, label, color: 'var(--color-primary)' };
  }

  /** Generate a detail string for any tool using heuristics on raw args. */
  function inferDetail(name: string | undefined, args: Record<string, unknown> | undefined): string {
    if (!args) return '';
    const key = (name ?? '').toLowerCase();

    // Known tools: use formatToolInput (already handles args intelligently).
    // If formatToolInput returns undefined (e.g. unexpected arg keys), fall
    // through to heuristic extraction below rather than returning empty.
    const known = ['bash', 'execute_bash', 'shell', 'read', 'read_file', 'cat',
      'write', 'write_file', 'edit', 'grep', 'find', 'ls'];
    if (known.includes(key)) {
      const r = formatToolInput(key, args);
      if (r) return r;
    }

    // Unknown tools: heuristic arg extraction
    const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
    const detailKeys = [
      'command', 'cmd',
      'path', 'file', 'filePath', 'file_path',
      'query', 'search', 'q',
      'pattern', 'glob',
      'url', 'href',
      'message', 'text', 'prompt',
      'name', 'title',
      'description',
    ];

    for (const dk of detailKeys) {
      const val = str(args[dk]);
      if (!val || val.length === 0) continue;
      if (dk === 'command' || dk === 'cmd') {
        const first = val.split('\n')[0].trim();
        return first.length > 55 ? `$ ${first.slice(0, 52)}…` : `$ ${first}`;
      }
      if (dk === 'path' || dk === 'file' || dk === 'filePath' || dk === 'file_path') {
        const base = val.split('/').pop() ?? val;
        return base.length > 55 ? base.slice(0, 52) + '…' : base;
      }
      return val.length > 55 ? val.slice(0, 52) + '…' : val;
    }

    // Last resort: first short string value
    for (const v of Object.values(args)) {
      if (typeof v === 'string' && v.length > 0 && v.length < 120) {
        return v.length > 55 ? v.slice(0, 52) + '…' : v;
      }
    }
    return '';
  }

  // ── Builtin slash commands (from pi SDK) ────────────────────────────────────

  const SLASH_COMMANDS = [
    { name: 'reload',        description: 'Reload extensions, skills, prompts, and themes' },
    { name: 'compact',       description: 'Manually compact the session context' },
    { name: 'name',          description: 'Set session display name' },
    { name: 'new',           description: 'Start a new session' },
    { name: 'fork',          description: 'Create a new fork from a previous user message' },
    { name: 'clone',         description: 'Duplicate the current session at the current position' },
    { name: 'resume',        description: 'Resume a different session' },
    { name: 'export',        description: 'Export session (.html/.jsonl)' },
    { name: 'share',         description: 'Share session as a secret GitHub gist' },
    { name: 'session',       description: 'Show session info and stats' },
    { name: 'login',         description: 'Configure provider authentication' },
    { name: 'logout',        description: 'Remove provider authentication' },
    { name: 'tree',          description: 'Navigate session tree (switch branches)' },
    { name: 'model',         description: 'Select model' },
    { name: 'copy',          description: 'Copy last agent message to clipboard' },
    { name: 'changelog',     description: 'Show changelog entries' },
    { name: 'hotkeys',       description: 'Show all keyboard shortcuts' },
  ] as const;

  type ShortcutTrigger = '/' | '@' | '!' | '#';
  type ComposerShortcut = {
    trigger: ShortcutTrigger;
    label: string;
    description: string;
    insert: string;
    muted?: boolean;
  };

  const SHELL_SHORTCUTS = [
    { label: 'shell command', description: 'Ask pi to run a terminal command', insert: '! ' },
    { label: 'git status', description: 'Check the working tree', insert: '! git status' },
    { label: 'list files', description: 'Inspect the current directory', insert: '! ls' },
  ] as const;

  const SNIPPET_SHORTCUTS = [
    { label: 'review', description: 'Ask for a concise code review', insert: '#review ' },
    { label: 'fix', description: 'Ask pi to diagnose and fix an issue', insert: '#fix ' },
    { label: 'explain', description: 'Ask pi to explain selected code or output', insert: '#explain ' },
  ] as const;

  // ── UI message model ────────────────────────────────────────────────────────
  // (MsgUsage and UIMessage types imported from $lib/client-messages)

  // ── Extension UI modal state ─────────────────────────────────────────────────

  type ParsedSelect = { kind: 'select'; label: string; options: { value: string; label: string; description?: string }[] };
  type ParsedInput = { kind: 'input'; label: string; placeholder?: string; value?: string; multiline?: boolean };
  type ParsedText = { kind: 'text'; label: string; content: string };
  type ParsedButton = { kind: 'button'; label: string; variant?: 'default' | 'primary' | 'danger' };
  type ParsedCheckbox = { kind: 'checkbox'; label: string; checked: boolean };
  type ParsedContainer = { kind: 'container'; children: ParsedComponent[]; direction?: 'vertical' | 'horizontal' };
  type ParsedComponent = ParsedSelect | ParsedInput | ParsedText | ParsedButton | ParsedCheckbox | ParsedContainer;

  type ModalState =
    | { method: 'confirm'; id: string; title: string; message: string }
    | { method: 'input'; id: string; title: string; placeholder?: string }
    | { method: 'select'; id: string; title: string; options: string[] }
    | { method: 'editor'; id: string; title: string; prefill?: string }
    | { method: 'custom'; id: string; title: string; parsed?: ParsedComponent; lines?: string[]; interactive?: true };

  let modalQueue = $state<ModalState[]>([]);
  let modal = $derived(modalQueue[0] ?? null);
  let modalInput = $state('');
  let modalFocusEl = $state<HTMLElement | undefined>(undefined);

  $effect(() => {
    if (modal && modalFocusEl) {
      modalFocusEl.focus();
    }
  });

  // ── File viewer modal state ──────────────────────────────────────────────

  let fileViewerOpen = $state(false);
  let fileViewerPath = $state('');
  let fileViewerLine = $state<number | undefined>(undefined);
  let fileViewerContent = $state('');
  let fileViewerLoading = $state(false);
  let fileViewerError = $state<string | null>(null);
  let fileSaving = $state(false);

  function openFileViewer(path: string, line?: number) {
    fileViewerPath = path;
    fileViewerLine = line;
    fileViewerOpen = true;
    fileViewerContent = '';
    fileViewerError = null;
    fileViewerLoading = true;
    send({ type: 'read_file', path });
  }

  function handleFileSave(content: string) {
    fileSaving = true;
    send({ type: 'write_file', path: fileViewerPath, content });
  }

  // ── Mobile detection ──────────────────────────────────────────────────────

  let isMobile = $state(false);
  let _mq: MediaQueryList | null = null;
  let _mqHandler: ((e: MediaQueryListEvent) => void) | null = null;

  // ── Swipe gesture state ──────────────────────────────────────────────────

  let touchStartX = 0;
  let touchStartY = 0;

  function handleTouchStart(e: TouchEvent) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }

  function handleTouchEnd(e: TouchEvent) {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    if (dy > 40 || Math.abs(dx) < 50) return;
    if (dx > 0 && touchStartX < 40) {
      // Swipe right from left edge → open session panel
      showSessionPanel = true;
      showRightPanel = false;
    } else if (dx < 0 && touchStartX > window.innerWidth - 40) {
      // Swipe left from right edge → open model picker
      openTab('models');
    }
  }

  // ── Sidebar resize handlers (desktop only, pointer capture) ──────────────────

  function startSessionResize(e: PointerEvent) {
    if (isMobile) return;
    sessionResizing = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onSessionResizeMove(e: PointerEvent) {
    if (!sessionResizing) return;
    sessionPanelWidth = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, e.clientX));
  }
  function stopSessionResize() {
    if (!sessionResizing) return;
    sessionResizing = false;
    try { localStorage.setItem('pifrontier:session-w', String(sessionPanelWidth)); } catch { /* quota */ }
  }

  function startRightResize(e: PointerEvent) {
    if (isMobile) return;
    rightResizing = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onRightResizeMove(e: PointerEvent) {
    if (!rightResizing) return;
    rightPanelWidth = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, window.innerWidth - e.clientX));
  }
  function stopRightResize() {
    if (!rightResizing) return;
    rightResizing = false;
    try { localStorage.setItem('pifrontier:right-w', String(rightPanelWidth)); } catch { /* quota */ }
  }

  // ── Core state ───────────────────────────────────────────────────────────────

  let messages = $state<UIMessage[]>([]);
  let expandedUserMsgs = $state<Record<string, boolean>>({});
  let truncatedUserMsgs = $state<Record<string, boolean>>({});

  function checkOverflow(node: HTMLElement, msgId: string) {
    const update = () => {
      if (!expandedUserMsgs[msgId]) {
        truncatedUserMsgs[msgId] = node.scrollHeight > node.clientHeight + 2;
      }
    };
    const ro = new ResizeObserver(update);
    ro.observe(node);
    update();
    return {
      destroy() { ro.disconnect(); }
    };
  }
  let input = $state('');
  /** Images staged for the next prompt (base64 data + display src). */
  let attachedImages = $state<Array<{ data: string; mimeType: string; name: string; src: string }>>([]);
  /** Text files staged for the next prompt (content read as text). */
  let attachedFiles = $state<Array<{ name: string; content: string; size: number }>>([]);
  let fileInputEl = $state<HTMLInputElement | undefined>(undefined);

  // ── Extension UI state ───────────────────────────────────────────────────────

  type Toast = { id: string; message: string; type: 'info' | 'warning' | 'error' };
  let toasts = $state<Toast[]>([]);
  /** Keyed status texts from extension setStatus() calls. */
  let extensionStatuses = $state<Record<string, string>>({});
  /** Keyed widget panels from extension setWidget() calls. */
  let extensionWidgets = $state<Record<string, WidgetContent>>({});
  /** Widget placement mapping (aboveEditor / belowEditor). */
  let extensionWidgetPlacement = $state<Record<string, string>>({});
  /** Custom working message from extension setWorkingMessage() calls. */
  let workingMessage = $state<string | undefined>(undefined);
  /** Whether the streaming working indicator is visible (setWorkingVisible). */
  let workingVisible = $state(true);
  /** Frames for the working indicator animation (setWorkingIndicator). */
  let workingIndicatorFrames = $state<string[]>([]);
  /** Interval in ms between frame ticks (setWorkingIndicator). */
  let workingIndicatorMs = $state(80);
  /** Current frame index for the working indicator animation. */
  let workingFrameIndex = $state(0);
  /** Label shown for collapsed thinking blocks (setHiddenThinkingLabel). */
  let hiddenThinkingLabel = $state('thinking');
  /** Global tool output expansion state (setToolsExpanded). */
  let toolsExpandedGlobal = $state(false);
  /** Argument completions for the current extension command (subcommands). */
  let commandArgCompletions = $state<{ value: string; label: string; description?: string }[]>([]);
  let commandArgCommand = $state('');
  let commandArgPrefix = $state('');
  let commandCompletionsPending = $state(false);
  /** Live elapsed-seconds tick for streaming tool timers. */
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(id);
  });
  /** Extension-injected header content (setHeader). */
  let extensionHeader = $state('');
  /** Extension-injected footer content (setFooter). */
  let extensionFooter = $state('');
  /** Extension-injected editor component panel (setEditorComponent). */
  let editorComponentPanel = $state<ParsedComponent | null>(null);
  /** Whether the composer shortcut menu is open. */
  let showSlashMenu = $state(false);
  /** Currently highlighted index in the composer shortcut menu (-1 = none). */
  let slashMenuIndex = $state(-1);
  const shortcutTrigger = $derived.by<ShortcutTrigger | null>(() => {
    const first = input[0];
    return first === '/' || first === '@' || first === '!' || first === '#' ? first : null;
  });
  const shortcutQuery = $derived.by(() => {
    if (!shortcutTrigger) return '';
    return input.slice(1).trimStart().toLowerCase();
  });
  /** When query has a space, detect if it's an extension command with subcommand arg prefix. */
  const commandArgMode = $derived.by<{ command: string; prefix: string } | null>(() => {
    if (shortcutTrigger !== '/') return null;
    const trimmed = input.slice(1).trimStart();
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) return null;
    const cmdName = parts[0].toLowerCase();
    const extCmd = extensionCommands.find((c) => c.name.toLowerCase() === cmdName);
    if (!extCmd) return null;
    return { command: cmdName, prefix: parts.slice(1).join(' ') };
  });
  const filteredSlashCommands = $derived.by<ComposerShortcut[]>(() => {
    if (!shortcutTrigger) return [];
    const q = shortcutQuery;
    const match = (value: string) => value.toLowerCase().includes(q);

    if (shortcutTrigger === '/') {
      // Show subcommand completions when typing past an extension command
      if (commandArgMode && commandArgCompletions.length > 0) {
        const cmdName = commandArgMode.command;
        return commandArgCompletions
          .filter((c) => !commandArgMode.prefix || c.value.toLowerCase().startsWith(commandArgMode.prefix))
          .map((c) => ({
            trigger: '/' as const,
            label: `/${cmdName} ${c.value}`,
            description: c.description ?? '',
            insert: `/${cmdName} ${c.value} `,
          })).slice(0, 14);
      }
      const commands = SLASH_COMMANDS
        .filter((c) => !q || c.name.startsWith(q))
        .map((c) => ({ trigger: '/' as const, label: `/${c.name}`, description: c.description, insert: `/${c.name} ` }));
      const extCmds = extensionCommands
        .filter((c) => typeof c.name === 'string' && (!q || c.name.startsWith(q)))
        .slice(0, 8)
        .map((c) => ({ trigger: '/' as const, label: `/${c.name}`, description: c.description || `${c.source} command`, insert: `/${c.name} ` }));
      const skills = resourcesSkills
        .filter((s) => !q || match(s.name) || match(s.description))
        .slice(0, 8)
        .map((s) => ({ trigger: '/' as const, label: `/skill:${s.name}`, description: s.description || `${s.scope} skill`, insert: `/skill:${s.name} `, muted: s.isBuiltin }));
      const prompts = resourcesPrompts
        .filter((p) => !q || match(p.name) || match(p.description))
        .slice(0, 8)
        .map((p) => ({ trigger: '/' as const, label: `/${p.name}`, description: p.description || p.argumentHint || `${p.scope} prompt`, insert: `/${p.name} `, muted: p.isBuiltin }));
      const extAuto = extensionCompletions
        .filter((c) => !q || match(c.label) || match(c.description ?? ''))
        .slice(0, 8)
        .map((c) => ({ trigger: '/' as const, label: `/${c.label}`, description: c.description ?? 'extension', insert: `/${c.value} ` }));
      return [...commands, ...extCmds, ...skills, ...prompts, ...extAuto].slice(0, 14);
    }

    if (shortcutTrigger === '@') {
      const refs = [
        ...fileCompletions.map((path) => ({ label: `@${path}`, description: 'workspace file', insert: `@${path} ` })),
        ...(cwd ? [{ label: '@current', description: cwd, insert: `@${cwd} ` }] : []),
        ...projectsState.groups.map((p) => ({ label: `@${p.name}`, description: p.cwd, insert: `@${p.cwd} ` })),
        ...projectsState.allSessions.slice(0, 24).map((s) => ({
          label: `@${s.name || s.firstMessage || '(empty)'}`,
          description: s.cwd,
          insert: `@${s.path} `,
        })),
        ...extensionCompletions
          .filter((c) => !q || match(c.label) || match(c.description ?? ''))
          .map((c) => ({ label: `@${c.label}`, description: c.description ?? 'extension', insert: `@${c.value} ` })),
      ];
      return refs
        .filter((r) => !q || match(r.label) || match(r.description))
        .slice(0, 12)
        .map((r) => ({ trigger: '@' as const, ...r }));
    }

    if (shortcutTrigger === '!') {
      const extAuto = extensionCompletions
        .filter((c) => !q || match(c.label) || match(c.description ?? ''))
        .map((c) => ({ label: c.label, description: c.description ?? 'extension', insert: `!${c.value} ` }));
      return [
        ...SHELL_SHORTCUTS
          .filter((s) => !q || match(s.label) || match(s.description) || match(s.insert))
          .map((s) => ({ trigger: '!' as const, ...s })),
        ...extAuto.map((c) => ({ trigger: '!' as const, ...c })),
      ];
    }

    const extAuto = extensionCompletions
      .filter((c) => !q || match(c.label) || match(c.description ?? ''))
      .map((c) => ({ label: c.label, description: c.description ?? 'extension', insert: `#${c.value} `, muted: false }));
    return [
      ...SNIPPET_SHORTCUTS,
      ...resourcesPrompts.map((p) => ({ label: p.name, description: p.description || p.argumentHint || `${p.scope} prompt`, insert: `#${p.name} `, muted: p.isBuiltin })),
      ...extAuto,
    ]
      .filter((s) => !q || match(s.label) || match(s.description))
      .slice(0, 12)
      .map((s) => ({ trigger: '#' as const, ...s }));
  });
  let isStreaming = $state(false);
  let wsState = $state<'connecting' | 'open' | 'closed'>('connecting');
  /** True from server_restarting until the WS successfully reconnects. */
  let isRestarting = $state(false);
  let sessionId = $state<string | null>(null);
  let thinkingLevel = $state('off');
  let model = $state<ModelInfo | null>(null);
  let availableModels = $state<ModelInfo[]>([]);
  /** Server working directory */
  let cwd = $state('');
  /** pi SDK version reported by server */
  let piVersion = $state('');
  /** pi-ui version reported by server */
  let uiVersion = $state('');
  /** Display name of the current session */
  let sessionName = $state<string | undefined>(undefined);
  /** Session storage mode reported by server */
  let sessionMode = $state<string | undefined>(undefined);
  /** Real-time context usage from the pi SDK (via getContextUsage()). */
  let contextUsageTokens = $state<number | null>(null);
  let contextUsageWindow = $state(0);
  /** Timestamp (epoch ms) when the current session was loaded — for elapsed display. */
  let sessionStartTime = $state(0);
  /** Pending steered messages (queue_update) */
  let queuedSteering = $state<string[]>([]);
  /** Pending follow-up messages (queue_update) */
  let queuedFollowUp = $state<string[]>([]);
  /** Whether context compaction is currently running */
  let isCompacting = $state(false);
  /** Whether auto-compaction is enabled */
  let autoCompactionEnabled = $state(true);
  /** Whether auto-retry on transient errors is enabled */
  let autoRetryEnabled = $state(true);
  /** STT: true while SpeechRecognition is active. */
  let isRecording = $state(false);
  /** STT: active SpeechRecognition instance (not reactive — plain ref). */
  let speechRec: { stop(): void } | null = null;
  /** STT: true when the user manually stopped recording (so onend does NOT auto-submit). */
  let sttManualStop = false;
  /**
   * Conversation mode: when on, the mic auto-restarts after each assistant response so the
   * user can speak → send → listen → speak again without touching the UI.
   */
  let conversationMode = $state(false);

  /** Selected daisyUI theme — persisted in localStorage. */
  let selectedTheme = $state('pi');
  function setTheme(t: string) {
    selectedTheme = t;
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('pifrontier:theme', t); } catch { /* noop */ }
  }

  // ── Panel state ──────────────────────────────────────────────────────────────

  let showRightPanel = $state(urlParam('rp', '') === '1');
  let rightPanelTab = $state<'models' | 'tools' | 'skills'>(
    (['models', 'tools', 'skills'] as const).includes(urlParam('rpt', '') as 'models' | 'tools' | 'skills')
      ? (urlParam('rpt', '') as 'models' | 'tools' | 'skills')
      : 'models'
  );
  let showSessionPanel = $state(urlParam('sp', '') === '1');

  // ── Sidebar resize ────────────────────────────────────────────────────────────

  const PANEL_MIN_W = 180;
  const PANEL_MAX_W = 560;
  /** Left sidebar (session panel) pixel width. */
  let sessionPanelWidth = $state(320);
  /** Right sidebars (model picker / tools / resources) pixel width — shared. */
  let rightPanelWidth = $state(320);
  /** True while the user is dragging the session panel resize handle. */
  let sessionResizing = $state(false);
  /** True while the user is dragging a right panel resize handle. */
  let rightResizing = $state(false);
  // Project / session list state lives in projectsState
  // (src/lib/state/projects-state.svelte.ts) — shared with the sidebar and picker.

  /** Whether the project picker dropdown is visible in the empty chat state. */
  let projectPickerOpen = $state(false);
  /** Workspace file completions shown for composer @ references. */
  let fileCompletions = $state<string[]>([]);
  /** Extension-registered autocomplete items for the current trigger menu. */
  let extensionCompletions = $state<{ value: string; label: string; description?: string }[]>([]);
  /** Last trigger we requested extension completions for. */
  let lastExtensionTrigger = $state('');
  let lastFileCompleteQuery = '';

  const SETTINGS_SECTIONS = [
    { id: 'session', label: 'Session', icon: SlidersHorizontal },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
    { id: 'extensions', label: 'Extensions', icon: Blocks },
    { id: 'updates', label: 'Updates', icon: RefreshCw },
    { id: 'about', label: 'About', icon: PiIcon },
  ] as const;

  const THEMES: { id: string; name: string }[] = [
    { id: 'pi',        name: 'Pi' },
    { id: 'night',     name: 'Night' },
    { id: 'dark',      name: 'Dark' },
    { id: 'dracula',   name: 'Dracula' },
    { id: 'synthwave', name: 'Synthwave' },
    { id: 'forest',    name: 'Forest' },
    { id: 'luxury',    name: 'Luxury' },
    { id: 'coffee',    name: 'Coffee' },
    { id: 'sunset',    name: 'Sunset' },
    { id: 'dim',       name: 'Dim' },
    { id: 'black',     name: 'Black' },
    { id: 'nord',      name: 'Nord' },
    { id: 'abyss',     name: 'Abyss' },
    { id: 'winter',    name: 'Winter' },
    { id: 'emerald',   name: 'Emerald' },
  ];

  const SHORTCUTS = [
    { keys: 'Ctrl / Cmd + /', action: 'Toggle sessions' },
    { keys: 'Ctrl / Cmd + K', action: 'Toggle model picker' },
    { keys: 'Ctrl / Cmd + T', action: 'Open thinking level' },
    { keys: 'Ctrl / Cmd + Shift + T', action: 'Cycle thinking level' },
    { keys: 'Escape', action: 'Close modal or panel' },
    { keys: 'Enter', action: 'Send from composer' },
    { keys: 'Shift + Enter', action: 'New line in composer' },
    { keys: '/', action: 'Open slash menu' },
    { keys: '@', action: 'Attach file context' },
  ];

  /** All tools reported by the server */
  let toolsList = $state<{ name: string; description: string; isBuiltin: boolean }[]>([]);
  /** Names of currently active/enabled tools */
  let activeToolNames = $state<string[]>([]);
  /** Registered slash commands from extensions */
  let extensionCommands = $state<{ name: string; description?: string; source: string }[]>([]);

  /** PWA install prompt (beforeinstallprompt event). Non-reactive — event fires once. */
  let deferredInstallPrompt: Event | null = null;
  let installReady = $state(false);

  async function handleInstallClick() {
    if (!deferredInstallPrompt) return;
    const e = deferredInstallPrompt as Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
    e.preventDefault();
    await e.prompt();
    const result = await e.userChoice;
    if (result.outcome === 'accepted') installReady = false;
    deferredInstallPrompt = null;
  }

  /** Whether the settings modal is open */
  let showSettingsPanel = $state(false);
  interface NotificationPrefs { enabled: boolean; onComplete: boolean; onSessionFinish: boolean }
  const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { enabled: true, onComplete: true, onSessionFinish: true };
  function loadNotificationPrefs(): NotificationPrefs {
    try { const raw = localStorage.getItem('pifrontier:notifications'); if (raw) return { ...DEFAULT_NOTIFICATION_PREFS, ...JSON.parse(raw) }; } catch { /* ignore */ }
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
  let notificationPrefs = $state<NotificationPrefs>(loadNotificationPrefs());
  $effect(() => { const p = notificationPrefs; try { localStorage.setItem('pifrontier:notifications', JSON.stringify(p)); } catch { /* ignore */ } });

  // Sync panel layout state to URL params so refreshes restore the same view.
  $effect(() => {
    const entries: Record<string, string | null> = {
      sp: showSessionPanel ? '1' : null,
      rp: showRightPanel ? '1' : null,
      rpt: showRightPanel ? rightPanelTab : null,
      mt: modelTab !== 'models' ? modelTab : null,
      ss: settingsSection !== 'session' ? settingsSection : null,
    };
    setUrlParams(entries);
  });

  function initSettingsSection(): 'session' | 'notifications' | 'shortcuts' | 'extensions' | 'updates' | 'about' {
    const v = urlParam('ss', 'session');
    const valid = ['session', 'notifications', 'shortcuts', 'extensions', 'updates', 'about'] as const;
    return (valid as readonly string[]).includes(v) ? v as typeof valid[number] : 'session';
  }
  let settingsSection = $state(initSettingsSection());
  /** Skills returned by the server */
  let resourcesSkills = $state<SkillSummary[]>([]);
  /** Prompt templates returned by the server */
  let resourcesPrompts = $state<PromptSummary[]>([]);
  /** True once resources_list has been received (distinguishes "loading" from "empty") */
  let resourcesLoaded = $state(false);
  /** Loaded extensions from the server */
  let extensionsList = $state<ExtensionSummary[]>([]);
  let extensionErrors = $state<{ path: string; error: string }[]>([]);
  /** True once extensions_list has been received */
  let extensionsLoaded = $state(false);

  /** Update tab state */
  let updateStatus = $state<UpdateStatus | null>(null);
  let updateLoading = $state(false);
  let updateRunning = $state(false);
  let updateTarget = $state<UpdateTarget | null>(null);
  let updateLog = $state('');
  let updateFeedback = $state<{ success: boolean; message: string; restartRequired?: boolean; reloadRequired?: boolean } | null>(null);
  let reloadAfterRestart = false;

  /** Install skill form state */
  let skillInstallUrl = $state('');
  let skillInstallScope = $state<'project' | 'user'>('user');
  let skillInstalling = $state(false);
  let skillInstallFeedback = $state<{ success: boolean; message: string } | null>(null);

  /** Which tab is active inside the model picker panel */
  let modelTab = $state<'models' | 'providers'>(urlParam('mt', 'models') === 'providers' ? 'providers' : 'models');
  let providers = $state<ProviderInfo[]>([]);
  /** Staged key text per provider id — cleared on successful save */
  let providerKeyInputs = $state<Record<string, string>>({});
  /** Filter text for the providers list */
  let providerFilter = $state('');
  /** Filter text for the models list */
  let modelFilter = $state('');
  /** Filter text for the tools list */
  let toolFilter = $state('');
  /** Filter text for the skills/prompts list */
  let skillFilter = $state('');
  /** Last error from set/remove provider key operations */
  let providerError = $state<string | null>(null);

  // ── Fork dialog state ─────────────────────────────────────────────────────────

  /** Whether the fork-point picker dialog is open */
  let showForkDialog = $state(false);
  /** Raw session tree data for the visual tree modal. */
  let treeData = $state<TreeNode[]>([]);
  let showTreeModal = $state(false);
  let treeLoading = $state(false);
  /** Fork-able user message entries returned by the server */
  let forkPoints = $state<{ entryId: string; text: string }[]>([]);
  /** True while waiting for the server to return fork_points */
  let forkLoading = $state(false);

  const filteredProviders = $derived(
    providerFilter.trim()
      ? providers.filter((p) =>
          p.name.toLowerCase().includes(providerFilter.toLowerCase()) ||
          p.id.toLowerCase().includes(providerFilter.toLowerCase())
        )
      : providers
  );

  const configuredProviderCount = $derived(providers.filter((p) => p.configured).length);

  const sessionTokens = $derived(messages.reduce((s, m) => s + (m.usage?.totalTokens ?? 0), 0));
  const sessionCostTotal = $derived(messages.reduce((s, m) => s + (m.usage?.cost?.total ?? 0), 0));
  const sessionDuration = $derived(sessionStartTime > 0 ? fmtDuration(Date.now() - sessionStartTime) : '');
  /** Context tokens from the client-side messages — last assistant's totalTokens is the context size. */
  const clientContextTokens = $derived.by(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && m.usage?.totalTokens && m.usage.totalTokens > 0) {
        return m.usage.totalTokens;
      }
    }
    return 0;
  });
  /** Best available context token count: SDK contextUsage when present, else client-side estimate. */
  const effectiveContextTokens = $derived(contextUsageTokens ?? clientContextTokens);
  /** Context window fill percentage (0 if unknown) */
  const contextPercent = $derived(
    contextUsageTokens != null && contextUsageWindow > 0
      ? Math.round((contextUsageTokens / contextUsageWindow) * 100)
      : effectiveContextTokens > 0 && model?.contextWindow && model.contextWindow > 0
        ? Math.round((effectiveContextTokens / model.contextWindow) * 100)
        : 0
  );
  /** Display name of the active project (custom name → directory basename). */
  const activeProjectName = $derived(projectsState.activeProjectName);

  // ── Derived ──────────────────────────────────────────────────────────────────

  const modelsByProvider = $derived.by(() => {
    const map = new SvelteMap<string, ModelInfo[]>();
    for (const m of availableModels) {
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider)!.push(m);
    }
    return [...map.entries()];
  });

  const filteredModelsByProvider = $derived.by(() => {
    const q = modelFilter.trim().toLowerCase();
    if (!q) return modelsByProvider;
    return modelsByProvider
      .map(([provider, models]) => [
        provider,
        models.filter((m) => m.name.toLowerCase().includes(q) || provider.toLowerCase().includes(q)),
      ] as [string, ModelInfo[]])
      .filter(([, models]) => models.length > 0);
  });

  const filteredTools = $derived.by(() => {
    const q = toolFilter.trim().toLowerCase();
    if (!q) return toolsList;
    return toolsList.filter((t) => t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q));
  });

  const filteredSkills = $derived.by(() => {
    const q = skillFilter.trim().toLowerCase();
    if (!q) return { skills: resourcesSkills, prompts: resourcesPrompts };
    return {
      skills: resourcesSkills.filter((s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)),
      prompts: resourcesPrompts.filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q)),
    };
  });

  // ── DOM refs ─────────────────────────────────────────────────────────────────

  let scrollEl = $state<HTMLElement | undefined>(undefined);
  let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectCountdown = $state(0);
  let reconnectInterval: ReturnType<typeof setInterval> | null = null;
  let sendHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let sendHoldSubmitted = false;
  /** True when the scroll container is at (or near) the bottom */
  let isAtBottom = $state(true);
  /** The message id whose copy action is in the "copied" confirmation state */
  let copiedId = $state<string | null>(null);

  // ── Refresh project/session lists when the sidebar opens ────────────────────

  $effect(() => {
    if (showSessionPanel) projectsState.refresh();
  });

  // ── Load providers when models tab is active ──────────────────────────────────

  $effect(() => {
    if (showRightPanel && rightPanelTab === 'models') {
      send({ type: 'get_providers' });
      modelFilter = '';
    }
  });

  // ── Load tools when tools tab is active ─────────────────────────────────────

  $effect(() => {
    if (showRightPanel && rightPanelTab === 'tools') {
      send({ type: 'get_tools' });
    }
  });

  // ── Load resources when skills tab is active ─────────────────────────────────

  $effect(() => {
    if (showRightPanel && rightPanelTab === 'skills') {
      resourcesLoaded = false;
      send({ type: 'get_resources' });
    }
  });

  // ── Working indicator frame animation ──────────────────────────────────────

  $effect(() => {
    const frames = workingIndicatorFrames;
    const ms = workingIndicatorMs;
    if (frames.length === 0) return;
    workingFrameIndex = 0;
    const id = setInterval(() => {
      workingFrameIndex = (workingFrameIndex + 1) % frames.length;
    }, ms);
    return () => clearInterval(id);
  });

  // ── Load extensions when settings extensions tab is active ──────────────────

  $effect(() => {
    if (showSettingsPanel && settingsSection === 'extensions') {
      extensionsLoaded = false;
      send({ type: 'get_extensions' });
    }
  });

  // ── Load update status when settings updates tab is active ──────────────────

  $effect(() => {
    if (showSettingsPanel && settingsSection === 'updates' && wsState === 'open') {
      refreshUpdateStatus();
    }
  });

  // ── WebSocket ───────────────────────────────────────────────────────────────

  let _intentionalClose = false;
  let _reconnectAttempt = 0;
  /** Set to true when server_restarting is received — cleared and reloaded on next successful connect. */
  let _reloadPending = false;
  /** When the page was last hidden (we stop reconnecting while hidden). */
  let _pageHiddenAt = 0;

  function getReconnectDelay(): number {
    return reconnectDelay(_reconnectAttempt);
  }

  function cancelReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
    reconnectCountdown = 0;
  }

  function scheduleReconnect() {
    if (_intentionalClose) return;
    if (document.hidden) {
      _pageHiddenAt = Date.now();
      return; // pause reconnection while page is hidden
    }
    if (!navigator.onLine) return; // wait for online event
    cancelReconnect();
    const delay = getReconnectDelay();
    _reconnectAttempt++;
    wsState = 'connecting';
    reconnectCountdown = Math.ceil(delay / 1000);
    reconnectInterval = setInterval(() => {
      reconnectCountdown = Math.max(0, reconnectCountdown - 1);
    }, 1000);
    reconnectTimer = setTimeout(() => {
      if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
      connect();
    }, delay);
  }

  function connect() {
    if (document.hidden) return;
    if (ws) {
      try { ws.onclose = null; ws.onerror = null; ws.close(); } catch { /* ignore */ }
      ws = null;
    }
    cancelReconnect();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      wsState = 'open';
      _reconnectAttempt = 0;
      cancelReconnect();
      if (reloadAfterRestart) {
        reloadAfterRestart = false;
        if (_reloadPending) {
          _reloadPending = false;
          location.reload();
        }
      }
    };

    ws.onmessage = ({ data }: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(data) as ServerMessage & Record<string, unknown>;
        handleServer(parsed);
      } catch (e) {
        console.warn('[pi-ui] Failed to parse WS message:', e);
      }
    };

    ws.onclose = () => {
      if (_intentionalClose) return;
      wsState = 'connecting';
      scheduleReconnect();
    };

    ws.onerror = () => {
      try { ws?.close(); } catch { /* ignore */ }
    };
  }

  /** Read the persisted session path from URL params (?session=). */
  function getSessionParam(): string | null {
    const p = new URLSearchParams(window.location.search).get('session');
    return p ? decodeURIComponent(p) : null;
  }

  /** Persist the active session path to URL params without navigation. */
  function setSessionParam(path: string): void {
    const url = new URL(window.location.href);
    url.searchParams.set('session', encodeURIComponent(path));
    history.replaceState(null, '', url.pathname + url.search);
  }

  /** Read a URL param with a default fallback. */
  function urlParam(key: string, fallback: string): string {
    try {
      return new URLSearchParams(window.location.search).get(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  /** Set one or more URL params without navigation. */
  function setUrlParams(entries: Record<string, string | null>): void {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(entries)) {
      if (value == null) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    history.replaceState(null, '', url.pathname + url.search);
  }

  /** Gracefully close the WS without reconnecting. */
  function disconnect() {
    _intentionalClose = true;
    wsState = 'closed';
    cancelReconnect();
    try { ws?.close(); } catch { /* ignore */ }
    ws = null;
  }

  function send(msg: ClientMessage): boolean {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function notifyPiEvent(title: string, body: string, tag: string, data?: Record<string, unknown>) {
    if (!notificationPrefs.enabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const msg = { type: 'show_notification' as const, title, body, tag, data };
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage(msg);
    } else {
      try { new Notification(title, { body, tag, icon: '/pwa-192x192.png' }); } catch { /* fail silently */ }
    }
  }

  /** PWA app badge for unseen session count. */
  function updateAppBadge() {
    if ('setAppBadge' in navigator) {
      const count = projectsState.uncheckedSessions.size;
      if (count > 0) navigator.setAppBadge(count).catch(() => {});
      else navigator.clearAppBadge().catch(() => {});
    }
  }

  /** Screen Wake Lock — keeps the display on during agent responses. */
  let wakeLock: WakeLockSentinel | null = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* wake lock unavailable */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  // Give the shared projects store access to the live socket.
  projectsState.send = send;

  // ── Server event handling ────────────────────────────────────────────────────

  function applySessionState(payload: Record<string, unknown>) {
    sessionId = payload.sessionId as string ?? sessionId;
    isStreaming = payload.isStreaming as boolean;
    thinkingLevel = payload.thinkingLevel as string ?? thinkingLevel;
    const newModel = payload.model as ModelInfo | null | undefined;
    if (newModel !== undefined) model = newModel;
    if (payload.availableModels !== undefined) {
      availableModels = (payload.availableModels as ModelInfo[]) ?? [];
    }
    if (payload.cwd) cwd = payload.cwd as string;
    if ('sessionName' in payload) sessionName = payload.sessionName as string | undefined;
    if ('messages' in payload) {
      messages = rawMessagesToUI(payload.messages as unknown[] ?? []);
    }
    // Sync the shared projects store with the active session.
    projectsState.cwd = cwd;
    if ('sessionId' in payload) projectsState.activeSessionId = payload.sessionId as string;
    projectsState.isStreaming = isStreaming;
    // Restore queue state from payload (present on connected/session_loaded)
    if ('queuedSteering' in payload || 'queuedFollowUp' in payload) {
      queuedSteering = (payload.queuedSteering as string[]) ?? [];
      queuedFollowUp = (payload.queuedFollowUp as string[]) ?? [];
    } else if ('sessionId' in payload) {
      // Full session reset — clear queues
      queuedSteering = [];
      queuedFollowUp = [];
    }
    // Context usage and window — keep in sync with model's contextWindow.
    // Server may provide real-time contextUsage on connected / session_loaded / message_end.
    // When only the model changes, fall back to the new model's contextWindow.
    let newWindow: number | undefined;
    if ('contextUsage' in payload) {
      const cu = payload.contextUsage as { tokens?: number | null; contextWindow?: number } | undefined;
      if (cu) {
        contextUsageTokens = cu.tokens ?? null;
        if (cu.contextWindow) newWindow = cu.contextWindow;
      }
    }
    if (newWindow == null) {
      const m = newModel ?? model;
      if (m?.contextWindow) newWindow = m.contextWindow;
    }
    if (newWindow != null) contextUsageWindow = newWindow;
    // Session-level settings (optional — present on connected/session_loaded)
    if ('isCompacting' in payload) isCompacting = Boolean(payload.isCompacting);
    if ('autoCompactionEnabled' in payload) autoCompactionEnabled = Boolean(payload.autoCompactionEnabled ?? true);
    if ('autoRetryEnabled' in payload) autoRetryEnabled = Boolean(payload.autoRetryEnabled ?? true);
  }

  function handleServer(msg: ServerMessage) {
    switch (msg.type) {
      case 'connected': {
        const c = msg as import('$lib/ws/protocol').ConnectedMessage;
        applySessionState(c as unknown as Record<string, unknown>);
        sessionStartTime = Date.now();
        if (c.piVersion) piVersion = c.piVersion;
        if (c.uiVersion) uiVersion = c.uiVersion;
        if (c.sessionMode) sessionMode = c.sessionMode;
        // Warm the project/session lists so pickers have data immediately.
        projectsState.refresh();
        updateAppBadge();
        // Restore persisted session from URL param
        const savedPath = getSessionParam();
        if (savedPath) {
          projectsState.pendingSwitchPath = savedPath;
          send({ type: 'switch_session', path: savedPath });
        }
        break;
      }

      case 'session_loaded': {
        const sl = msg as Record<string, unknown>;
        applySessionState(sl);
        sessionStartTime = Date.now();
        if (sl.piVersion) piVersion = sl.piVersion as string;
        if (sl.uiVersion) uiVersion = sl.uiVersion as string;
        if (sl.sessionMode) sessionMode = sl.sessionMode as string;
        if (projectsState.onSessionLoaded()) showSessionPanel = false;
        projectPickerOpen = false;
        // Persist session path to URL param
        if (projectsState.pendingSwitchPath) {
          setSessionParam(projectsState.pendingSwitchPath);
          projectsState.pendingSwitchPath = null;
        }
        break;
      }

      case 'model_changed': {
        applySessionState({ model: (msg as { type: string; model: ModelInfo | null }).model ?? null });
        break;
      }

      case 'thinking_level_changed': {
        applySessionState({ thinkingLevel: (msg as { type: string; level: string }).level ?? 'off' });
        break;
      }

      case 'sessions_list':
      case 'projects_list': {
        projectsState.handleMessage(msg as PiEvent);
        break;
      }

      case 'sessions_error': {
        const errMsg = (msg as Record<string, unknown>).message ?? 'Unknown session error';
        addToast(errMsg as string, 'warning');
        projectsState.handleMessage(msg as PiEvent);
        break;
      }

      case 'providers_list': {
        providers = (msg as { type: string; providers: ProviderInfo[] }).providers ?? [];
        providerError = null; // clear any prior error on success
        break;
      }

      case 'providers_error': {
        providerError = (msg as { type: string; message: string }).message ?? 'Unknown error';
        break;
      }

      case 'available_models_changed': {
        applySessionState({ availableModels: (msg as { type: string; availableModels: ModelInfo[] }).availableModels ?? [] });
        break;
      }

      case 'agent_start':
        isStreaming = true;
        projectsState.isStreaming = true;
        requestWakeLock();
        break;

      case 'message_start':
        // Fires for user, assistant, AND toolResult messages — only create a
        // bubble for the assistant turn.
        if ((msg.message as { role?: string } | undefined)?.role === 'assistant') {
          messages.push(freshAssistant());
        }
        break;

      case 'agent_end': {
        const { willRetry } = msg as { type: 'agent_end'; willRetry?: boolean };
        isStreaming = false;
        projectsState.isStreaming = false;
        sealStreaming();
        if (sessionId) projectsState.markUnchecked(sessionId);
        if (conversationMode && !willRetry && wsState === 'open') {
          toggleSTT();
        }
        releaseWakeLock();
        updateAppBadge();
        if (notificationPrefs.onComplete && document.hidden && !willRetry) {
          notifyPiEvent('Response Complete', 'pi finished responding.', 'pi-agent-end');
        }
        break;
      }

      case 'agent_error': {
        // Server-side error during prompt/steer/followUp — unfreeze the UI.
        isStreaming = false;
        projectsState.isStreaming = false;
        sealStreaming();
        releaseWakeLock();
        const errMsg = (msg as { error?: string }).error ?? 'Unknown error';
        addToast(`Agent error: ${errMsg}`, 'error');
        break;
      }

      case 'message_update': {
        const event = msg.assistantMessageEvent as { type: string; delta?: string } | undefined;
        if (event?.type === 'text_delta' && typeof event.delta === 'string') {
          const a = lastStreaming('assistant');
          if (a) {
            a.content += event.delta;
            scrollBottom();
          }
        } else if (event?.type === 'thinking_delta' && typeof event.delta === 'string') {
          const a = lastStreaming('assistant');
          if (a) {
            if (!a.thinkingStartMs) a.thinkingStartMs = Date.now();
            a.thinking = (a.thinking ?? '') + event.delta;
          }
        }
        break;
      }

      case 'message_end': {
        const endMsg = msg.message as { role?: string; usage?: { input: number; output: number; totalTokens: number; cost: { total: number } }; content?: { type: string; data?: string; mimeType?: string }[]; stopReason?: string } | undefined;
        if (endMsg?.role === 'assistant') {
          const a = lastStreaming('assistant');
          if (a) {
            a.endMs = Date.now();
            a.streaming = false;
            if (endMsg.stopReason === 'aborted') {
              a.aborted = true;
              a.content = 'Operation aborted';
            } else if (endMsg.usage) {
              a.usage = {
                input: endMsg.usage.input,
                output: endMsg.usage.output,
                totalTokens: endMsg.usage.totalTokens,
                cost: { total: endMsg.usage.cost?.total ?? 0 },
              };
              // Extract any image blocks from the final message content
              if (endMsg.content) {
                const imgBlocks = endMsg.content.filter((b) => b.type === 'image' && b.data && b.mimeType);
                if (imgBlocks.length > 0) {
                  a.images = imgBlocks.map((b) => `data:${b.mimeType};base64,${b.data}`);
                }
              }
            }
          }
        }
        // Use real context usage from the SDK (server enriches message_end with this)
        const cu = (msg as Record<string, unknown>).contextUsage as { tokens?: number | null; contextWindow?: number } | undefined;
        if (cu) {
          applySessionState({ contextUsage: cu });
        }
        break;
      }

      case 'tool_execution_start': {
        const toolName = (msg.toolName as string | undefined) ?? 'tool';
        const toolCallId = msg.toolCallId as string | undefined;
        const details = (msg.args ?? msg.input ?? msg.details) as Record<string, unknown> | undefined;
        messages.push({
          id: uid(),
          role: 'tool',
          content: '',
          toolName,
          toolCallId,
          toolInput: formatToolInput(toolName, details),
          toolArgs: details,
          streaming: true,
          expanded: toolsExpandedGlobal,
          startMs: Date.now(),
          createdAt: Date.now(),
        });
        break;
      }

      case 'tool_execution_update': {
        const updateId = msg.toolCallId as string | undefined;
        const t = updateId ? findToolMessage(updateId) : lastStreaming('tool');
        if (t) {
          const partial = msg.partialResult as { content?: { type: string; text?: string }[] } | undefined;
          if (partial?.content) {
            t.content = extractTextContent(partial.content);
          }
        }
        break;
      }

      case 'tool_execution_end': {
        const endId = msg.toolCallId as string | undefined;
        const t = endId ? findToolMessage(endId) : lastStreaming('tool');
        if (t) {
          t.streaming = false;
          t.isError = (msg.isError as boolean | undefined) ?? false;
          const result = msg.result as {
            content?: { type: string; text?: string; data?: string; mimeType?: string }[];
            details?: { diff?: string; patch?: string };
          } | undefined;
          if (result?.content) {
            t.content = extractTextContent(result.content);
            const imgBlocks = result.content.filter((b) => b.type === 'image' && b.data && b.mimeType);
            if (imgBlocks.length > 0) {
              t.images = imgBlocks.map((b) => `data:${b.mimeType};base64,${b.data}`);
            }
          }
          // Capture diff for edit tool
          const diff = result?.details?.diff;
          if (diff) {
            t.diff = diff;
            t.lineCount = diff.split('\n').length;
            // Auto-expand diff so it's immediately visible
            t.expanded = true;
          } else if (t.content) {
            const lines = t.content.split('\n').length;
            t.lineCount = lines;
            // Auto-expand short outputs (≤ 8 lines and ≤ 400 chars)
            if (!t.isError && lines <= 8 && t.content.length <= 400) {
              t.expanded = true;
            }
          }
        }
        break;
      }

      case 'extension_ui_request': {
        const id = msg.id as string;
        const method = msg.method as string;
        const newModal = (() => {
        switch (method) {
          case 'confirm':
            return {
              method: 'confirm' as const,
              id,
              title: (msg.title as string | undefined) ?? 'Confirm',
              message: (msg.message as string | undefined) ?? '',
            };

          case 'input':
            return {
              method: 'input' as const,
              id,
              title: (msg.title as string | undefined) ?? 'Input',
              placeholder: msg.placeholder as string | undefined,
            };

          case 'select':
            return {
              method: 'select' as const,
              id,
              title: (msg.title as string | undefined) ?? 'Select',
              options: (msg.options as string[] | undefined) ?? [],
            };

          case 'editor':
            return {
              method: 'editor' as const,
              id,
              title: (msg.title as string | undefined) ?? 'Editor',
              prefill: msg.prefill as string | undefined,
            };

          case 'custom': {
            const parsed = msg.parsed as ParsedComponent | undefined;
            const lines = msg.lines as string[] | undefined;
            const interactive = msg.interactive as boolean | undefined;
            return {
              method: 'custom' as const,
              id,
              title: (msg.title as string | undefined) ?? 'Extension Request',
              parsed,
              ...(lines ? { lines } : {}),
              ...(interactive ? { interactive: true as const } : {}),
            };
          }

          default:
            return null;
        }
        })();
        if (newModal) {
          modalQueue = [...modalQueue, newModal];
          if (newModal.method === 'custom' && newModal.interactive) {
            modalInput = '';
          } else if (newModal.method === 'editor') {
            modalInput = newModal.prefill ?? '';
          } else if (newModal.method !== 'confirm') {
            modalInput = '';
          }
        }

        // Non-blocking extension methods (fire-and-forget, no modal response needed):
        if (method === 'notify') {
          addToast(
            (msg.message as string | undefined) ?? '',
            (msg.notifyType as Toast['type'] | undefined) ?? 'info'
          );
        } else if (method === 'setStatus') {
          const key = msg.statusKey as string | undefined;
          const text = msg.statusText as string | undefined;
          if (key) {
            if (text == null) {
              delete extensionStatuses[key];
            } else {
              extensionStatuses[key] = text;
            }
          }
        } else if (method === 'setWidget') {
          const key = msg.widgetKey as string | undefined;
          if (key) {
            const widgetType = (msg.widgetType as string | undefined) ?? 'text';
            const widgetLines = msg.widgetLines as string[] | undefined;
            const widgetData = msg.widgetData as Record<string, unknown> | undefined;
            const widgetPlacement = msg.widgetPlacement as string | undefined;
            if (widgetType === 'text' && (!widgetLines || widgetLines.length === 0)) {
              delete extensionWidgets[key];
            } else if (widgetType === 'table') {
              const headers = (widgetData?.headers as string[]) ?? [];
              const rows = (widgetData?.rows as string[][]) ?? [];
              extensionWidgets[key] = { type: 'table', headers, rows };
            } else if (widgetType === 'badge') {
              const text = (widgetData?.text as string) ?? '';
              const variant = (widgetData?.variant as WidgetContent extends { variant: infer V } ? V : never) ?? 'info';
              extensionWidgets[key] = { type: 'badge', text, variant };
            } else {
              extensionWidgets[key] = { type: 'text', lines: widgetLines ?? [] };
            }
            if (widgetPlacement) {
              extensionWidgetPlacement[key] = widgetPlacement;
            } else {
              delete extensionWidgetPlacement[key];
            }
          }
        } else if (method === 'setTitle') {
          document.title = (msg.title as string | undefined) ?? 'pi UI';
        } else if (method === 'set_editor_text') {
          input = (msg.text as string | undefined) ?? '';
          tick().then(() => { autoResizeTextarea(); inputEl?.focus(); });
        } else if (method === 'paste_to_editor') {
          const textToInsert = (msg.text as string | undefined) ?? '';
          if (inputEl) {
            const start = inputEl.selectionStart ?? input.length;
            const end = inputEl.selectionEnd ?? input.length;
            input = input.slice(0, start) + textToInsert + input.slice(end);
            tick().then(() => {
              if (inputEl) {
                inputEl.selectionStart = inputEl.selectionEnd = start + textToInsert.length;
                autoResizeTextarea();
                inputEl.focus();
              }
            });
          } else {
            input += textToInsert;
          }
        } else if (method === 'request_editor_text') {
          const requestId = msg.id as string | undefined;
          if (requestId) {
            send({ type: 'editor_text_response', id: requestId, text: input });
          }
        } else if (method === 'setWorkingMessage') {
          workingMessage = (msg.message as string | undefined) ?? undefined;
        } else if (method === 'setWorkingVisible') {
          workingVisible = (msg.visible as boolean | undefined) ?? true;
        } else if (method === 'setWorkingIndicator') {
          const frames = (msg.frames as string[] | undefined) ?? [];
          workingIndicatorFrames = frames;
          workingIndicatorMs = (msg.intervalMs as number | undefined) ?? 80;
          workingFrameIndex = 0;
        } else if (method === 'setHiddenThinkingLabel') {
          hiddenThinkingLabel = (msg.label as string | undefined) ?? 'thinking';
        } else if (method === 'setToolsExpanded') {
          const exp = (msg.expanded as boolean | undefined) ?? false;
          toolsExpandedGlobal = exp;
          for (const m of messages) {
            if (m.role === 'tool' && !m.streaming) m.expanded = exp;
          }
        } else if (method === 'set_header') {
          extensionHeader = (msg.content as string | undefined) ?? '';
        } else if (method === 'set_footer') {
          extensionFooter = (msg.content as string | undefined) ?? '';
        } else if (method === 'set_editor_component') {
          editorComponentPanel = (msg.parsed as ParsedComponent | null) ?? null;
        }

        break;
      }

      case 'extension_ui_request_replay': {
        // Reconnect replay marker — the server still has a pending promise for
        // this modal. If we already have a modal with this id, it's still visible.
        // If not, re-create a placeholder so the user can respond.
        const replayId = msg.id as string;
        const replayMethod = (msg.method as string | undefined) ?? 'select';
        if (replayMethod === 'request_editor_text') break; // handled silently
        const alreadyQueued = modalQueue.some((m) => m.id === replayId);
        if (!alreadyQueued) {
          modalQueue = [...modalQueue, {
            method: 'input' as const,
            id: replayId,
            title: 'Pending Request',
            placeholder: 'Reconnect — please respond to continue',
          }];
        }
        break;
      }

      case 'queue_update': {
        queuedSteering = (msg.steering as string[] | undefined) ?? [];
        queuedFollowUp = (msg.followUp as string[] | undefined) ?? [];
        break;
      }

      case 'queue_restored': {
        const restoredText = (msg.text as string | undefined) ?? '';
        if (restoredText) {
          // Append restored queued text to the composer so the user can re-submit it.
          const prefix = input.trim() ? input + '\n\n' : '';
          input = prefix + restoredText;
          tick().then(() => { autoResizeTextarea(); inputEl?.focus(); });
        }
        break;
      }

      case 'compaction_start': {
        isCompacting = true;
        const reason = (msg.reason as string | undefined) ?? '';
        messages.push({
          id: uid(),
          role: 'notice',
          content: reason === 'manual' ? 'compacting context…' : `auto-compacting context (${reason})…`,
          noticeKind: 'compaction',
          streaming: true,
          createdAt: Date.now(),
        });
        break;
      }

      case 'compaction_end': {
        isCompacting = false;
        // Seal the in-progress compaction notice
        const notice = [...messages].reverse().find((m) => m.role === 'notice' && m.noticeKind === 'compaction' && m.streaming);
        if (notice) {
          notice.streaming = false;
          const aborted = (msg.aborted as boolean | undefined) ?? false;
          const errMsg = msg.errorMessage as string | undefined;
          notice.content = aborted
            ? `compaction ${errMsg ? `failed: ${errMsg}` : 'aborted'}`
            : 'context compacted';
        }
        break;
      }

      case 'auto_retry_start': {
        const attempt = (msg.attempt as number | undefined) ?? 1;
        const max = (msg.maxAttempts as number | undefined) ?? 1;
        const delayS = Math.round(((msg.delayMs as number | undefined) ?? 0) / 1000);
        const errMsg = (msg.errorMessage as string | undefined) ?? '';
        messages.push({
          id: uid(),
          role: 'notice',
          content: `retrying (${attempt}/${max}${delayS > 0 ? `, ${delayS}s` : ''})${errMsg ? ` — ${errMsg}` : ''}`,
          noticeKind: 'retry',
          streaming: true,
          createdAt: Date.now(),
        });
        break;
      }

      case 'auto_retry_end': {
        const notice = [...messages].reverse().find((m) => m.role === 'notice' && m.noticeKind === 'retry' && m.streaming);
        if (notice) {
          notice.streaming = false;
          const success = (msg.success as boolean | undefined) ?? false;
          const finalErr = msg.finalError as string | undefined;
          notice.content = success ? 'retry succeeded' : `retry failed${finalErr ? `: ${finalErr}` : ''}`;
        }
        break;
      }

      case 'session_info_changed': {
        sessionName = (msg.name as string | undefined);
        break;
      }

      case 'fork_points': {
        forkPoints = (msg.entries as { entryId: string; text: string }[] | undefined) ?? [];
        forkLoading = false;
        break;
      }

      case 'session_tree': {
        treeData = (msg.tree as TreeNode[] | undefined) ?? [];
        treeLoading = false;
        break;
      }

      case 'tools_list': {
        toolsList = (msg.tools as { name: string; description: string; isBuiltin: boolean }[] | undefined) ?? [];
        activeToolNames = (msg.activeToolNames as string[] | undefined) ?? [];
        break;
      }

      case 'resources_list': {
        resourcesSkills = (msg.skills as SkillSummary[] | undefined) ?? [];
        resourcesPrompts = (msg.prompts as PromptSummary[] | undefined) ?? [];
        resourcesLoaded = true;
        break;
      }

      case 'extensions_list': {
        extensionsList = (msg.extensions as ExtensionSummary[] | undefined) ?? [];
        extensionErrors = (msg.errors as { path: string; error: string }[] | undefined) ?? [];
        extensionsLoaded = true;
        break;
      }

      case 'commands_list': {
        extensionCommands = (msg.commands as { name: string; description?: string; source: string }[] | undefined) ?? [];
        break;
      }

      case 'skill_install_result': {
        skillInstalling = false;
        if (msg.success) {
          skillInstallFeedback = { success: true, message: `Installed "${msg.name as string}"` };
          skillInstallUrl = '';
          // Reload the resources list so the new skill appears immediately.
          send({ type: 'get_resources' });
          resourcesLoaded = false;
        } else {
          skillInstallFeedback = { success: false, message: (msg.error as string) ?? 'Installation failed.' };
        }
        break;
      }

      case 'update_status': {
        const status = { ...(msg as unknown as UpdateStatus & { type?: string }) };
        delete status.type;
        updateStatus = status;
        updateLoading = false;
        updateRunning = status.busy;
        break;
      }

      case 'update_progress': {
        const progress = msg as { type: 'update_progress'; target: UpdateTarget; command?: string; message: string };
        updateRunning = true;
        updateTarget = progress.target;
        updateFeedback = null;
        updateLog = updateLog ? `${updateLog}\n\n${progress.message}` : progress.message;
        break;
      }

      case 'update_result': {
        const result = msg as { type: 'update_result'; target: UpdateTarget; success: boolean; message: string; output?: string; restartRequired?: boolean; reloadRequired?: boolean };
        updateRunning = false;
        updateTarget = null;
        updateFeedback = {
          success: result.success,
          message: result.message,
          restartRequired: result.restartRequired,
          reloadRequired: result.reloadRequired,
        };
        if (result.output) updateLog = result.output;
        if (result.success && result.target === 'ui' && result.restartRequired) {
          requestServerRestart(Boolean(result.reloadRequired));
        } else if (result.success) {
          refreshUpdateStatus();
        }
        break;
      }

      case 'all_sessions_list':
      case 'dir_completions': {
        projectsState.handleMessage(msg as PiEvent);
        break;
      }

      case 'file_completions': {
        const fileMsg = msg as { type: string; query: string; entries: string[] };
        if (fileMsg.query === shortcutQuery) fileCompletions = fileMsg.entries ?? [];
        break;
      }

      case 'extension_completions': {
        const extMsg = msg as unknown as { trigger: string; items: { value: string; label: string; description?: string }[] };
        if (extMsg.trigger === shortcutTrigger) extensionCompletions = extMsg.items ?? [];
        break;
      }

      case 'command_completions': {
        const cc = msg as unknown as { command: string; prefix: string; items: { value: string; label: string; description?: string }[] };
        if (cc.command === commandArgCommand && cc.prefix === commandArgPrefix) {
          commandArgCompletions = cc.items ?? [];
          commandCompletionsPending = false;
        }
        break;
      }

      case 'custom_render': {
        const renderId = msg.id as string | undefined;
        const renderLines = msg.lines as string[] | undefined;
        if (renderId && modal?.method === 'custom' && modal.id === renderId && modal.interactive && renderLines && modalQueue.length > 0) {
          modalQueue[0] = { ...modalQueue[0], lines: renderLines };
        }
        break;
      }

      case 'slash_result': {
        const result = msg as { type: 'slash_result'; command: string; message: string; level?: 'info' | 'warning' | 'error' };
        messages.push({
          id: uid(),
          role: 'notice',
          content: result.message,
          noticeKind: result.level === 'error' ? 'retry' : undefined,
          customType: 'slash_result',
          streaming: false,
          createdAt: Date.now(),
        });
        if (result.level && result.level !== 'info') addToast(result.message.split('\n')[0], result.level);
        break;
      }

      case 'file_content': {
        const fc = msg as { type: 'file_content'; path: string; content: string; error?: string };
        if (fc.path === fileViewerPath) {
          fileViewerContent = fc.content;
          fileViewerError = fc.error ?? null;
          fileViewerLoading = false;
        }
        break;
      }

      case 'file_saved': {
        const fs = msg as { type: 'file_saved'; path: string; error?: string };
        fileSaving = false;
        if (fs.error) {
          addToast(`Failed to save ${fs.path}: ${fs.error}`, 'error');
        } else {
          addToast(`Saved ${fs.path}`, 'info');
          fileViewerContent = ''; // trigger re-read on next open
        }
        break;
      }

      case 'server_restarting': {
        isRestarting = true;
        _reloadPending = true;
        break;
      }

      case 'restart_nonce': {
        const nonce = (msg as { type: 'restart_nonce'; nonce: string }).nonce;
        send({ type: 'restart_server', nonce });
        break;
      }

      case 'session_runtime': {
        const rt = msg as unknown as { sessionId: string; isRunning: boolean; unseen: boolean; lastActivity: number };
        // Ignore stale updates from a previously-active session after switching
        if (rt.sessionId === sessionId) {
          isStreaming = rt.isRunning;
          projectsState.isStreaming = rt.isRunning;
          if (rt.isRunning) requestWakeLock();
          else releaseWakeLock();
        }
        if ((rt.isRunning || rt.unseen) && rt.sessionId !== sessionId) {
          projectsState.markUnchecked(rt.sessionId);
        }
        if (rt.isRunning) projectsState.runningSessions.add(rt.sessionId);
        else projectsState.runningSessions.delete(rt.sessionId);
        if (notificationPrefs.onSessionFinish && !rt.isRunning && rt.unseen && rt.sessionId !== sessionId && document.hidden) {
          notifyPiEvent('Session Finished', `Session ${rt.sessionId.slice(0, 8)} has new results.`, `pi-session-${rt.sessionId}`);
        }
        updateAppBadge();
        break;
      }

    }

    scrollBottom();
  }

  // ── Modal actions ────────────────────────────────────────────────────────────

  function modalConfirm(confirmed: boolean) {
    if (!modal) return;
    if (send({ type: 'extension_ui_response', id: modal.id, confirmed })) {
      modalQueue = modalQueue.slice(1);
    }
  }

  function modalSubmitValue() {
    if (!modal) return;
    if (send({ type: 'extension_ui_response', id: modal.id, value: modalInput })) {
      modalQueue = modalQueue.slice(1);
      modalInput = '';
    }
  }

  function modalSelectOption(value: string) {
    if (!modal) return;
    if (send({ type: 'extension_ui_response', id: modal.id, value })) {
      modalQueue = modalQueue.slice(1);
    }
  }

  function modalCancel() {
    if (!modal) return;
    if (send({ type: 'extension_ui_response', id: modal.id, cancelled: true })) {
      modalQueue = modalQueue.slice(1);
      modalInput = '';
    }
  }

  /** Handles keydown inside the modal (Enter submits, Esc cancels, interactive custom gets forwarded). */
  function modalContentKeydown(e: KeyboardEvent) {
    if (modal?.method === 'custom' && modal.interactive) {
      // Forward ALL key events to the server for the interactive component
      e.preventDefault();
      const keyMap: Record<string, string> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
        PageUp: 'pageup',
        PageDown: 'pagedown',
        Home: 'home',
        End: 'end',
        Escape: 'escape',
        Enter: 'enter',
        ' ': 'space',
      };
      send({
        type: 'extension_custom_input',
        id: modal.id,
        key: keyMap[e.key] || e.key,
        alt: e.altKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
      });
      if (e.key === 'Escape') {
        modalCancel();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && modal?.method !== 'editor') {
      e.preventDefault();
      if (modal?.method === 'confirm') modalConfirm(true);
      else if (modal?.method === 'input' || modal?.method === 'custom') modalSubmitValue();
    }
  }

  // ── Model & session actions ──────────────────────────────────────────────────

  function selectModel(m: ModelInfo) {
    send({ type: 'set_model', provider: m.provider, modelId: m.id });
    showRightPanel = false;
  }

  function pickThinkingLevel(level: string) {
    thinkingLevel = level; // optimistic
    send({ type: 'set_thinking_level', level });
  }

  function openTab(tab: 'models' | 'tools' | 'skills') {
    if (showRightPanel && rightPanelTab === tab) {
      showRightPanel = false;
    } else {
      showRightPanel = true;
      rightPanelTab = tab;
    }
    showSessionPanel = false;
    showSettingsPanel = false;
  }

  function openForkDialog() {
    forkPoints = [];
    forkLoading = true;
    showForkDialog = true;
    send({ type: 'get_fork_points' });
  }

  function forkAt(entryId: string) {
    send({ type: 'fork_session', entryId });
    showForkDialog = false;
  }

  // ── Provider actions ─────────────────────────────────────────────────────────

  function setProviderKey(providerId: string) {
    const key = (providerKeyInputs[providerId] ?? '').trim();
    if (!key) return;
    send({ type: 'set_provider_key', provider: providerId, key });
    providerKeyInputs[providerId] = '';
  }

  function removeProviderKey(providerId: string) {
    send({ type: 'remove_provider_key', provider: providerId });
  }

  /** Human-readable label for auth source (undefined = no label needed). */
  function sourceLabel(source?: string): string | undefined {
    switch (source) {
      case 'environment': return 'env';
      case 'models_json_key':
      case 'models_json_command': return 'config';
      case 'fallback': return 'config';
      case 'runtime': return 'runtime';
      default: return undefined;
    }
  }

  /** True only when the credential was stored by the user and can be removed via the UI. */
  function canRemove(source?: string): boolean {
    return source === 'stored';
  }

  function fmtTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return `${n}`;
  }

  function fmtCost(c: number): string | null {
    if (!c) return null;
    if (c < 0.0001) return '<$0.0001';
    return `$${c.toFixed(4)}`;
  }

  function fmtDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    return `${Math.round(s / 60)}m`;
  }

  // ── Message helpers ──────────────────────────────────────────────────────────

  function freshAssistant(): UIMessage {
    return { id: uid(), role: 'assistant', content: '', thinking: '', thinkingExpanded: false, streaming: true, startMs: Date.now(), createdAt: Date.now() };
  }

  function lastStreaming(role: UIMessage['role']): UIMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === role && messages[i].streaming) return messages[i];
    }
  }

  function sealStreaming() {
    // Drop empty streaming assistant bubbles (LLM turns that produced only tool calls, no text/thinking).
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.streaming && m.role === 'assistant' && !m.content && !m.thinking) {
        messages.splice(i, 1);
      } else if (m.streaming) {
        m.streaming = false;
      }
    }
  }

  function findToolMessage(toolCallId: string): UIMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'tool' && messages[i].toolCallId === toolCallId) return messages[i];
    }
    return undefined;
  }

  async function scrollBottom() {
    await tick();
    if (!isAtBottom || !scrollEl) return;
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
  }

  function handleScroll() {
    if (!scrollEl) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollEl;
    isAtBottom = scrollHeight - scrollTop - clientHeight < 80;
  }

  function scrollToBottom() {
    isAtBottom = true;
    scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
  }

  async function copyMessage(msg: UIMessage) {
    const text = msg.content || msg.thinking;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copiedId = msg.id;
      setTimeout(() => { copiedId = null; }, 2000);
    } catch {
      // clipboard not available (non-HTTPS or unsupported)
    }
  }

  /** Delegated handler for copy buttons injected by the markdown renderer. */
  function handleCodeCopy(e: MouseEvent | KeyboardEvent) {
    if (e instanceof KeyboardEvent && e.key !== 'Enter' && e.key !== ' ') return;
    const btn = (e.target as Element).closest('.code-copy-btn');
    if (!btn) return;
    if (e instanceof KeyboardEvent) e.preventDefault();
    const code = btn.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    if (!code) return;
    navigator.clipboard.writeText(code).catch(() => {});
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = prev; }, 2000);
  }

  /** Handle clicks on file links rendered by the markdown renderer. */
  function handleFileLink(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const link = target.closest('.file-link') as HTMLElement | null;
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    const path = link.dataset.filepath;
    const lineStr = link.dataset.fileline;
    if (path) openFileViewer(path, lineStr ? parseInt(lineStr) : undefined);
  }

  function handleMessageAreaClick(e: MouseEvent) {
    handleCodeCopy(e);
    handleFileLink(e);
  }

  /** Global keyboard shortcut handler — runs on every keydown in the document. */
  function handleGlobalKeydown(e: KeyboardEvent) {
    const inEditable = () => {
      const el = document.activeElement as HTMLElement | null;
      return el?.tagName === 'TEXTAREA' || el?.tagName === 'INPUT' || el?.isContentEditable;
    };

    // Escape — dismiss modal or close open panels
    if (e.key === 'Escape') {
      if (modal) return; // modal's own onkeydown handles this
      if (showSessionPanel) { e.preventDefault(); showSessionPanel = false; return; }
      if (showRightPanel) { e.preventDefault(); showRightPanel = false; return; }
      if (showSettingsPanel) { e.preventDefault(); showSettingsPanel = false; return; }
      return;
    }

    // Ctrl+/ — toggle sessions panel
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      showSessionPanel = !showSessionPanel;
      if (showSessionPanel && showRightPanel) showRightPanel = false;
      if (showSessionPanel && showSettingsPanel) showSettingsPanel = false;
      return;
    }

    // Ctrl+K — toggle model picker
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      openTab('models');
      return;
    }

    // Ctrl+T — open thinking level selector
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 't') {
      e.preventDefault();
      openTab('models');
      return;
    }

    // Ctrl+Shift+T — cycle thinking level
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      const cycle = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
      const current = thinkingLevel;
      const idx = cycle.indexOf(current);
      const next = cycle[(idx + 1) % cycle.length];
      pickThinkingLevel(next);
      addToast(`Thinking level: ${next}`, 'info');
      return;
    }

    // Any printable character when no input is focused → focus textarea
    if (!inEditable() && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      inputEl?.focus();
    }
  }

  // ── User input ───────────────────────────────────────────────────────────────

  const TEXT_FILE_EXTENSIONS = new Set([
    'txt', 'md', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'jsx', 'tsx',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'cs',
    'sh', 'bash', 'zsh', 'fish', 'toml', 'ini', 'cfg', 'conf', 'env', 'gitignore',
    'svelte', 'vue', 'sass', 'scss', 'less', 'sql', 'graphql', 'r', 'mjs', 'cjs',
    'npmrc', 'editorconfig', 'prettierrc', 'eslintrc',
  ]);

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { resolve((reader.result as string).split(',')[1]); };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function fileToText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { resolve(reader.result as string); };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  async function handleFileInput(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const data = await fileToBase64(file);
        attachedImages.push({ data, mimeType: file.type, name: file.name, src: `data:${file.type};base64,${data}` });
      } else {
        const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
        if (!TEXT_FILE_EXTENSIONS.has(ext)) {
          addToast(`Unsupported file type: ${file.name} (only text files and images are supported)`, 'warning');
          continue;
        }
        if (file.size > 1024 * 1024) {
          addToast(`File too large: ${file.name} (max 1MB)`, 'warning');
          continue;
        }
        const content = await fileToText(file);
        attachedFiles.push({ name: file.name, content, size: file.size });
      }
    }
    (e.target as HTMLInputElement).value = '';
  }

  function removeAttachment(idx: number) {
    attachedImages.splice(idx, 1);
  }

  function removeFileAttachment(idx: number) {
    attachedFiles.splice(idx, 1);
  }

  function addToast(message: string, type: Toast['type'] = 'info') {
    const id = uid();
    toasts.push({ id, message, type });
    setTimeout(() => {
      const idx = toasts.findIndex((t) => t.id === id);
      if (idx >= 0) toasts.splice(idx, 1);
    }, 5000);
  }

  function dismissToast(id: string) {
    const idx = toasts.findIndex((t) => t.id === id);
    if (idx >= 0) toasts.splice(idx, 1);
  }

  function dismissWidget(key: string) {
    delete extensionWidgets[key];
    delete extensionWidgetPlacement[key];
  }

  function selectSlashCommand(shortcut: ComposerShortcut) {
    input = shortcut.insert;
    showSlashMenu = false;
    tick().then(() => { autoResizeTextarea(); inputEl?.focus(); });
  }

  function steerAgent() {
    const text = input.trim();
    if (!text || wsState !== 'open') return;
    send({ type: 'steer', message: text });
    input = '';
    resetTextareaHeight();
  }

  // ── STT ──────────────────────────────────────────────────────────────────────

  function toggleSTT() {
    if (isRecording) {
      // User manually stopped — flag it so onend does not auto-submit
      sttManualStop = true;
      speechRec?.stop();
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) return; // not supported in this browser
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec: any = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;     // browser ends recognition after a silence gap automatically
    rec.interimResults = true;  // show live transcript while speaking

    sttManualStop = false;      // reset for this session
    let hadFinalResult = false; // becomes true when browser emits a final (non-interim) result

    const baseInput = input;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        text += r[0].transcript;
        if (r.isFinal) hadFinalResult = true;
      }
      const prefix = baseInput ? (baseInput.endsWith(' ') ? baseInput : baseInput + ' ') : '';
      input = prefix + text;
    };

    rec.onend = () => {
      isRecording = false;
      speechRec = null;
      // Auto-submit when silence gap ended recognition and we got a final transcript
      if (!sttManualStop && hadFinalResult && input.trim()) {
        // Tiny delay so Svelte flushes the input state update before submitMessage reads it
        setTimeout(() => submitMessage(), 50);
      }
    };

    rec.onerror = () => { isRecording = false; speechRec = null; };
    rec.start();
    speechRec = rec;
    isRecording = true;
  }

  /**
   * Toggle conversation mode on/off.
   * ON  → starts STT immediately (if idle), auto-restarts mic after each response.
   * OFF → stops STT and clears the mode flag.
   */
  function toggleConversationMode() {
    if (conversationMode) {
      conversationMode = false;
      sttManualStop = true;
      speechRec?.stop();
    } else {
      conversationMode = true;
      if (!isStreaming && !isRecording && wsState === 'open') {
        toggleSTT();
      }
    }
  }

  function canSubmitFollowUp() {
    return wsState === 'open' && !isStreaming && input.trim().length > 0 && attachedImages.length === 0 && attachedFiles.length === 0;
  }

  function runSlashCommand(text: string): boolean {
    // Handle ! shell commands – bypass the AI, execute directly.
    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      if (command) {
        send({ type: 'run_builtin', command: 'shell', args: command });
        input = '';
        resetTextareaHeight();
        return true;
      }
      return false;
    }
    if (!text.startsWith('/')) return false;
    const [rawCommand, ...rest] = text.slice(1).split(/\s+/);
    const command = rawCommand.toLowerCase();
    const args = rest.join(' ').trim();

    switch (command) {
      case 'new':
        projectsState.newSession(args || undefined);
        return true;
      case 'compact':
        compactSession();
        return true;
      case 'fork':
        openForkDialog();
        return true;
      case 'resume':
        showSessionPanel = true;
        showRightPanel = false;
        showSettingsPanel = false;
        return true;
      case 'model':
        openTab('models');
        return true;
      case 'copy': {
        const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
        if (last) copyMessage(last);
        else addToast('No assistant message to copy yet.', 'warning');
        return true;
      }
      case 'hotkeys':
        addToast('Shortcuts: Enter sends, Shift+Enter newline, Cmd/Ctrl+B opens sessions, Cmd/Ctrl+K opens model picker.', 'info');
        return true;
      case 'reload':
      case 'login':
      case 'logout':
      case 'session':
      case 'clone':
      case 'export':
      case 'share':
      case 'changelog':
      case 'name':
        send({ type: 'run_builtin', command, args });
        return true;
      case 'tree':
        send({ type: 'get_session_tree' });
        showTreeModal = true;
        return true;
      default: {
        // Check if it's an extension command — route through the server
        const extCmd = extensionCommands.find((c) => c.name.toLowerCase() === command);
        if (extCmd) {
          send({ type: 'run_builtin', command: 'extension', args: text });
          return true;
        }
        return false;
      }
    }
  }

  function submitMessage(asFollowUp = false) {
    if (wsState !== 'open') return;
    const text = input.trim();

    if (isStreaming) {
      if (!text) return;
      steerAgent();
      return;
    }

    if (!text && attachedImages.length === 0 && attachedFiles.length === 0) return;

    if (attachedImages.length === 0 && attachedFiles.length === 0 && !asFollowUp && runSlashCommand(text)) {
      input = '';
      resetTextareaHeight();
      return;
    }

    const imgs = attachedImages.length > 0
      ? attachedImages.map((img) => ({ data: img.data, mimeType: img.mimeType }))
      : undefined;

    // Prepend file contents as text blocks before the user message
    let fullText = text;
    if (attachedFiles.length > 0) {
      const fileBlocks = attachedFiles.map((f) => `Content of ${f.name}:\n${f.content}`);
      fullText = fileBlocks.join('\n\n---\n\n') + (text ? '\n\n---\n\n' + text : '');
    }

    messages.push({
      id: uid(),
      role: 'user',
      content: fullText,
      images: imgs ? attachedImages.map((img) => img.src) : undefined,
      streaming: false,
      createdAt: Date.now(),
    });

    if (asFollowUp && attachedImages.length === 0 && attachedFiles.length === 0) {
      send({ type: 'follow_up', message: text });
    } else {
      send({ type: 'prompt', message: fullText, ...(imgs ? { images: imgs } : {}) });
    }
    input = '';
    attachedImages = [];
    attachedFiles = [];
    resetTextareaHeight();
    scrollBottom();
  }

  function startSendHold() {
    if (!canSubmitFollowUp()) return;
    sendHoldSubmitted = false;
    if (sendHoldTimer) clearTimeout(sendHoldTimer);
    sendHoldTimer = setTimeout(() => {
      sendHoldSubmitted = true;
      submitMessage(true);
      sendHoldTimer = null;
    }, 550);
  }

  function cancelSendHold() {
    if (!sendHoldTimer) return;
    clearTimeout(sendHoldTimer);
    sendHoldTimer = null;
  }

  function clickSend() {
    if (sendHoldSubmitted) {
      sendHoldSubmitted = false;
      return;
    }
    submitMessage();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (showSlashMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filteredSlashCommands.length === 0) return;
        slashMenuIndex = (slashMenuIndex + 1) % filteredSlashCommands.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filteredSlashCommands.length === 0) return;
        slashMenuIndex = (slashMenuIndex - 1 + filteredSlashCommands.length) % filteredSlashCommands.length;
        return;
      }
      if (e.key === 'Enter' && slashMenuIndex >= 0) {
        e.preventDefault();
        selectSlashCommand(filteredSlashCommands[slashMenuIndex]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  }

  function autoResizeTextarea() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 192)}px`;
  }

  function resetTextareaHeight() {
    if (inputEl) inputEl.style.height = '';
  }

  function abortGeneration() {
    send({ type: 'abort' });
  }

  function compactSession() {
    send({ type: 'compact' });
  }

  function refreshUpdateStatus() {
    if (wsState !== 'open') return;
    updateLoading = true;
    send({ type: 'get_update_status' });
  }

  function runUpdate(target: UpdateTarget) {
    const label = target === 'ui' ? 'pi-ui' : 'pi SDK';
    const suffix = target === 'ui' ? ' The server will restart and the page will reload when it finishes.' : '';
    if (!confirm(`Update ${label}? This will run package commands on the server.${suffix}`)) return;
    updateRunning = true;
    updateTarget = target;
    updateLog = '';
    updateFeedback = null;
    send({ type: 'run_update', target });
  }

  function requestServerRestart(reloadPage = false) {
    if (reloadPage) _reloadPending = true;
    reloadAfterRestart = reloadPage;
    send({ type: 'request_restart' });
  }

  function restartServer(reloadPage = false) {
    if (!confirm('Restart the server? The page will reconnect automatically in a few seconds.')) return;
    requestServerRestart(reloadPage);
  }

  function toggleTool(toolName: string) {
    const idx = activeToolNames.indexOf(toolName);
    if (idx >= 0) {
      activeToolNames = activeToolNames.filter((n) => n !== toolName);
    } else {
      activeToolNames = [...activeToolNames, toolName];
    }
    send({ type: 'set_active_tools', toolNames: activeToolNames });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  $effect(() => {
    const commandLike = !!shortcutTrigger && !input.slice(1).includes('\n');
    showSlashMenu = !isStreaming && commandLike && filteredSlashCommands.length > 0;
    if ((shortcutTrigger === '/' || shortcutTrigger === '#') && !resourcesLoaded && wsState === 'open') {
      resourcesLoaded = true;
      send({ type: 'get_resources' });
    }
    if (shortcutTrigger === '@' && wsState === 'open' && shortcutQuery !== lastFileCompleteQuery) {
      lastFileCompleteQuery = shortcutQuery;
      send({ type: 'file_complete', query: shortcutQuery });
    } else if (shortcutTrigger !== '@') {
      lastFileCompleteQuery = '';
      fileCompletions = [];
    }
    // Request extension autocomplete items when trigger changes
    if (shortcutTrigger && wsState === 'open' && shortcutTrigger !== lastExtensionTrigger) {
      lastExtensionTrigger = shortcutTrigger;
      extensionCompletions = [];
      send({ type: 'get_extension_autocomplete', trigger: shortcutTrigger, query: shortcutQuery });
    } else if (!shortcutTrigger) {
      lastExtensionTrigger = '';
      extensionCompletions = [];
    }
    // Request command argument completions when user continues past a command name
    if (commandArgMode) {
      const needsFetch = commandArgMode.command !== commandArgCommand || commandArgMode.prefix !== commandArgPrefix;
      if (needsFetch && !commandCompletionsPending) {
        commandArgCommand = commandArgMode.command;
        commandArgPrefix = commandArgMode.prefix;
        commandCompletionsPending = true;
        send({ type: 'get_command_completions', command: commandArgMode.command, prefix: commandArgMode.prefix });
      }
    } else {
      commandArgCompletions = [];
      commandArgCommand = '';
      commandArgPrefix = '';
      commandCompletionsPending = false;
    }
  });

  $effect(() => {
    if (!showSlashMenu) slashMenuIndex = -1;
  });

  let _installPromptHandler: ((e: Event) => void) | null = null;
  let _appInstalledHandler: (() => void) | null = null;
  let _onlineHandler: (() => void) | null = null;
  let _offlineHandler: (() => void) | null = null;

  onMount(() => {
    connect();
    inputEl?.focus();
    _mq = window.matchMedia('(max-width: 767px)');
    isMobile = _mq.matches;
    _mqHandler = (e: MediaQueryListEvent) => { isMobile = e.matches; };
    _mq.addEventListener('change', _mqHandler);
    // Request notification permission (PWA push notifications)
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    // Listen for the PWA install prompt
    _installPromptHandler = (e: Event) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      installReady = true;
    };
    window.addEventListener('beforeinstallprompt', _installPromptHandler);
    _appInstalledHandler = () => {
      installReady = false;
      deferredInstallPrompt = null;
    };
    window.addEventListener('appinstalled', _appInstalledHandler);
    // Visibility + online/offline for reconnection resilience
    document.addEventListener('visibilitychange', _onVisibilityChange);
    _onlineHandler = () => {
      if (wsState !== 'open') {
        cancelReconnect();
        connect();
      }
    };
    _offlineHandler = () => {
      // Mark as offline so UI shows disconnected state
      if (wsState === 'open') wsState = 'connecting';
    };
    window.addEventListener('online', _onlineHandler);
    window.addEventListener('offline', _offlineHandler);
    // Restore persisted sidebar widths
    try {
      const sw = parseInt(localStorage.getItem('pifrontier:session-w') ?? '');
      if (!isNaN(sw)) sessionPanelWidth = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, sw));
      const rw = parseInt(localStorage.getItem('pifrontier:right-w') ?? '');
      if (!isNaN(rw)) rightPanelWidth = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, rw));
    } catch { /* localStorage unavailable */ }
    try {
      const savedTheme = localStorage.getItem('pifrontier:theme');
      if (savedTheme) setTheme(savedTheme);
    } catch { /* localStorage unavailable */ }
  });

  onDestroy(() => {
    releaseWakeLock();
    if (sendHoldTimer) clearTimeout(sendHoldTimer);
    disconnect();
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    if (_installPromptHandler) window.removeEventListener('beforeinstallprompt', _installPromptHandler);
    if (_appInstalledHandler) window.removeEventListener('appinstalled', _appInstalledHandler);
    if (_onlineHandler) window.removeEventListener('online', _onlineHandler);
    if (_offlineHandler) window.removeEventListener('offline', _offlineHandler);
    if (_mq && _mqHandler) _mq.removeEventListener('change', _mqHandler);
  });

  /** Single visibility-change handler: pause reconnection + manage wake lock. */
  function _onVisibilityChange() {
    if (document.hidden) {
      _pageHiddenAt = Date.now();
      releaseWakeLock();
    } else {
      // Wake lock: re-acquire if still streaming
      if (isStreaming) requestWakeLock();
      // Reconnection: resume if WS is down
      if (_pageHiddenAt > 0) {
        const wasHidden = Date.now() - _pageHiddenAt;
        _pageHiddenAt = 0;
        if (wsState === 'connecting' && wasHidden > 5000) {
          // Server likely timed us out — reset and connect immediately
          _intentionalClose = false;
          cancelReconnect();
          connect();
        } else if (wsState === 'connecting') {
          scheduleReconnect();
        }
      }
    }
  }
</script>

<svelte:head>
  <title>pi UI</title>
</svelte:head>

<svelte:window onkeydown={handleGlobalKeydown} />

<!-- ── Shared template snippets ──────────────────────────────────────────── -->

<!-- Sticky group header used across the right-panel lists -->
{#snippet sectionHeader(letter: string, badgeClass: string, label: string, bg?: string)}
  <div class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6">
    <span
      class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 {badgeClass}"
      style={bg ? `background: ${bg}` : undefined}
      aria-hidden="true"
    >{letter}</span>
    <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold">{label}</span>
  </div>
{/snippet}

<!-- Prompt row in the skills tab -->
{#snippet promptItem(prompt: PromptSummary)}
  <div class="px-5 py-2.5 flex items-start gap-3 transition-colors hover:bg-base-content/[0.03]">
    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-2 mb-0.5">
        <span class="text-sm font-mono text-base-content/80 truncate">{prompt.name}</span>
        {#if prompt.argumentHint}<span class="shrink-0 text-xs text-base-content/35 font-mono">{prompt.argumentHint}</span>{/if}
      </span>
      {#if prompt.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{prompt.description}</span>{/if}
    </span>
    <button
      onclick={() => { input = `/${prompt.name} `; showRightPanel = false; tick().then(() => inputEl?.focus()); }}
      class="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-primary hover:bg-primary/10 rounded transition-colors"
      title="Use prompt"
      tabindex={showRightPanel ? 0 : -1}
    ><CornerDownLeft class="w-3.5 h-3.5" /></button>
  </div>
{/snippet}

<!--
  Root: flex-row — three columns:
    [session panel] [main content] [model picker panel]
  Sidebars are always in the DOM; their width transitions push/shrink the center.
-->
<Tooltip.Provider delayDuration={400}>
<div
  role="application"
  aria-label="pi UI chat"
  class="flex flex-row w-dvw h-dvh text-base-content font-mono text-base select-none overflow-hidden"
  ontouchstart={handleTouchStart}
  ontouchend={handleTouchEnd}
>

  <!-- ── LEFT SIDEBAR: Session panel ─────────────────────────────────────── -->

  <SidebarPanel
    title={projectsState.groups.length ? `projects (${projectsState.groups.length})` : 'projects'}
    open={showSessionPanel}
    {isMobile}
    width={sessionPanelWidth}
    side="left"
    resizing={sessionResizing}
    closeLabel="Close projects panel"
    onClose={() => (showSessionPanel = false)}
    onResizeStart={startSessionResize}
    onResizeMove={onSessionResizeMove}
    onResizeStop={() => stopSessionResize()}
  >
    {#snippet header()}{/snippet}

    <ProjectsSidebar
      open={showSessionPanel}
      canFork={messages.length > 0 && !isStreaming}
      onFork={() => { showSessionPanel = false; openForkDialog(); }}
    />
  </SidebarPanel>

  <!-- ── MAIN COLUMN ──────────────────────────────────────────────────────── -->
  <div class="flex-1 flex flex-col min-w-0 bg-[color-mix(in_oklch,var(--color-base-200)_86%,black_8%)] relative">

    <!-- Top tab bar -->
    <header
      class="relative shrink-0 h-14 flex items-center gap-2 px-3 bg-[color-mix(in_oklch,var(--color-base-200)_86%,black_8%)] shadow-sm shadow-black/10"
      style="padding-top: env(safe-area-inset-top, 0px);"
    >
      <div class="absolute inset-x-0 bottom-0 hairline-x pointer-events-none"></div>
      <div class="relative z-10 flex items-center gap-1.5 shrink-0">
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                onclick={() => { showSessionPanel = !showSessionPanel; showRightPanel = false; showSettingsPanel = false; }}
                class="h-9 w-9 flex items-center justify-center rounded-lg transition-colors {showSessionPanel ? 'text-primary bg-primary/12' : 'text-base-content/60 hover:text-base-content/90 hover:bg-base-content/8'}"
                aria-label="Toggle session panel"
                aria-expanded={showSessionPanel}
              ><svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg></button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="bottom">Sessions</Tooltip.Content>
        </Tooltip.Root>
        <button
          onclick={() => openTab('models')}
          class="h-9 hidden sm:flex items-center overflow-hidden rounded-xl border border-base-content/8 bg-base-content/[0.045] text-base-content/65 hover:text-base-content/90 hover:bg-base-content/[0.07] transition-colors"
          aria-label="Open model picker"
          aria-expanded={showRightPanel && rightPanelTab === 'models'}
        >
          <span class="w-10 h-full flex items-center justify-center border-r border-base-content/8"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span>
          <span class="w-8 h-full flex items-center justify-center"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>
        </button>
      </div>

      <button
        onclick={() => openTab('models')}
        class="absolute left-1/2 top-0 bottom-0 z-0 w-[min(52rem,calc(100vw-14rem))] sm:w-[min(52rem,calc(100vw-8.5rem))] -translate-x-1/2 min-w-0 flex flex-col items-center justify-center px-3 text-center rounded-t-none sm:rounded-t-xl border-x border-transparent hover:bg-base-content/[0.035] transition-colors"
        aria-label="Open model and provider panel"
        aria-expanded={showRightPanel && rightPanelTab === 'models'}
      >
        <span class="max-w-full text-sm sm:text-[15px] leading-tight text-base-content/82 truncate">
          {sessionName || activeProjectName || 'New chat'}
        </span>
        <span class="hidden sm:flex max-w-full items-center justify-center gap-1.5 text-[11px] leading-tight text-base-content/38 truncate">
          <span class="truncate">{model?.provider || 'no provider'}</span>
          {#if model?.name}<span class="text-base-content/40">›</span><span class="truncate">{model.name}</span>{/if}
          {#if thinkingLevel !== 'off'}<span class="text-success/65">{thinkingLevel}</span>{/if}
        </span>
      </button>

      <div class="relative z-10 flex items-center gap-1.5 shrink-0 ml-auto">
        {#if effectiveContextTokens > 0}
          <Tooltip.Root>
            <Tooltip.Trigger class={[
              'h-9 hidden md:flex items-center gap-2 rounded-xl px-3 border text-xs tabular-nums cursor-default transition-colors',
              contextPercent >= 75
                ? 'bg-error/8 border-error/18 text-error/70'
                : contextPercent >= 50
                  ? 'bg-warning/8 border-warning/18 text-warning/70'
                  : 'bg-base-content/[0.055] border-base-content/8 text-base-content/65'
            ].join(' ')}>
              <span class="relative flex h-4 w-4 items-center justify-center">
                <span class={[
                  'absolute inset-0 rounded-full border-2 transition-colors',
                  contextPercent >= 75
                    ? 'border-error/40'
                    : contextPercent >= 50
                      ? 'border-warning/40'
                      : 'border-success/35'
                ].join(' ')}></span>
                <span class={[
                  'h-1.5 w-1.5 rounded-full transition-colors',
                  contextPercent >= 75
                    ? 'bg-error/70'
                    : contextPercent >= 50
                      ? 'bg-warning/70'
                      : 'bg-success/70'
                ].join(' ')}></span>
              </span>
              <span>{contextPercent > 0 ? `${contextPercent}%` : fmtTokens(effectiveContextTokens)}</span>
            </Tooltip.Trigger>
            <Tooltip.Content sideOffset={8} class="min-w-[180px]">
              <div class="flex flex-col gap-2 py-0.5">
                <div class="flex items-center justify-between gap-3">
                  <span class="text-background/60">Context</span>
                  <span class="font-medium">{contextPercent > 0 ? `${contextPercent}%` : fmtTokens(effectiveContextTokens)}</span>
                </div>
                <div class="w-full h-1.5 rounded-full bg-background/15 overflow-hidden">
                  <div
                    class={[
                      'h-full rounded-full transition-all',
                      contextPercent >= 75 ? 'bg-error/70' : contextPercent >= 50 ? 'bg-warning/70' : 'bg-background/70'
                    ].join(' ')}
                    style="width: {Math.min(contextPercent, 100)}%"
                  ></div>
                </div>
                <div class="flex items-center justify-between text-background/60">
                  <span>{effectiveContextTokens.toLocaleString()}</span>
                  {#if contextUsageWindow > 0 || model?.contextWindow}
                    <span>/ {((contextUsageWindow > 0 ? contextUsageWindow : null) ?? model?.contextWindow ?? 0).toLocaleString()} tokens</span>
                  {/if}
                </div>
                {#if sessionTokens > 0}
                  <div class="flex items-center justify-between border-t border-background/10 pt-1.5 mt-0.5">
                    <span class="text-background/45">Session</span>
                    <span class="text-background/70">{sessionTokens.toLocaleString()} tokens</span>
                  </div>
                {/if}
                {#if sessionCostTotal > 0}
                  <div class="flex items-center justify-between">
                    <span class="text-background/45">Cost</span>
                    <span class="text-background/70">{fmtCost(sessionCostTotal)}</span>
                  </div>
                {/if}
                {#if sessionDuration}
                  <div class="flex items-center justify-between border-t border-background/10 pt-1.5 mt-0.5">
                    <span class="text-background/45">Elapsed</span>
                    <span class="text-background/70">{sessionDuration}</span>
                  </div>
                {/if}
              </div>
            </Tooltip.Content>
          </Tooltip.Root>
        {/if}
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                onclick={() => openTab('skills')}
                class="h-9 w-9 hidden sm:flex items-center justify-center rounded-lg transition-colors {showRightPanel && rightPanelTab === 'skills' ? 'text-primary bg-primary/12' : 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8'}"
                aria-label="Toggle resources panel"
                aria-expanded={showRightPanel && rightPanelTab === 'skills'}
              ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 7l8 4 8-4-8-4Z"/><path d="m4 12 8 4 8-4"/><path d="m4 17 8 4 8-4"/></svg></button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="bottom">Skills &amp; Prompts</Tooltip.Content>
        </Tooltip.Root>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                onclick={() => openTab('tools')}
                class="h-9 w-9 flex items-center justify-center rounded-lg transition-colors {showRightPanel && rightPanelTab === 'tools' ? 'text-primary bg-primary/12' : 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8'}"
                aria-label="Toggle tools panel"
                aria-expanded={showRightPanel && rightPanelTab === 'tools'}
              ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17h16"/><path d="m8 13-4-4 4-4"/><path d="m16 5 4 4-4 4"/></svg></button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="bottom">Tools</Tooltip.Content>
        </Tooltip.Root>
        {#if installReady}
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  onclick={handleInstallClick}
                  class="h-9 w-9 flex items-center justify-center rounded-lg transition-colors text-base-content/45 hover:text-primary hover:bg-primary/12"
                  aria-label="Install app"
                ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13"/><path d="m5 13 7 7 7-7"/><path d="M5 21h14"/></svg></button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content side="bottom">Install App</Tooltip.Content>
          </Tooltip.Root>
        {/if}
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                onclick={() => { showSettingsPanel = !showSettingsPanel; showRightPanel = false; showSessionPanel = false; }}
                class="h-9 w-9 flex items-center justify-center rounded-lg transition-colors {showSettingsPanel ? 'text-primary bg-primary/12' : 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8'}"
                aria-label="Open settings"
                aria-expanded={showSettingsPanel}
              ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.4.2.7.5.9.9.2.3.4.7.4 1.1V11a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"/></svg></button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="bottom">Settings</Tooltip.Content>
        </Tooltip.Root>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                class="h-9 w-9 flex items-center justify-center rounded-lg transition-colors relative {wsState === 'open' ? 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8' : wsState === 'connecting' ? 'text-warning/50 hover:text-warning/70 hover:bg-warning/8' : 'text-error/50 hover:text-error/70 hover:bg-error/8'}"
                aria-label="Connection info"
              ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16"/><path d="M7 5v11a2 2 0 0 0 2 2h2"/><path d="M13 5v11a2 2 0 0 0 2 2h2"/></svg>
                <span class="absolute top-0.5 right-0.5 w-2 h-2 rounded-full border border-base-100 {wsState === 'open' ? 'bg-success' : wsState === 'connecting' ? 'bg-warning animate-pulse' : 'bg-error'}"></span>
              </button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content sideOffset={8} class="min-w-[180px]">
            <div class="flex flex-col gap-2 py-0.5">
              <div class="flex items-center justify-between gap-3">
                <span class="text-background/60">Connection</span>
                <span class="flex items-center gap-1.5 font-medium">
                  <span class="w-1.5 h-1.5 rounded-full {wsState === 'open' ? 'bg-success' : wsState === 'connecting' ? 'bg-warning animate-pulse' : 'bg-error'}"></span>
                  {wsState === 'open' ? 'Connected' : wsState === 'connecting' ? 'Connecting' : 'Disconnected'}
                </span>
              </div>
              {#if sessionMode}
                <div class="flex items-center justify-between gap-3">
                  <span class="text-background/60">Session</span>
                  <span class="font-medium">{sessionMode}</span>
                </div>
              {/if}
              {#if piVersion}
                <div class="flex items-center justify-between gap-3">
                  <span class="text-background/60">SDK</span>
                  <span class="font-medium">v{piVersion}</span>
                </div>
              {/if}
              {#if uiVersion}
                <div class="flex items-center justify-between gap-3">
                  <span class="text-background/60">UI</span>
                  <span class="font-medium">v{uiVersion}</span>
                </div>
              {/if}
            </div>
          </Tooltip.Content>
        </Tooltip.Root>
      </div>
    </header>

    {#if wsState === 'closed'}
      <div class="shrink-0 flex items-center justify-center gap-2 px-3 py-2 text-xs bg-error/10 text-error/80 border-b border-error/15">
        <span class="w-1.5 h-1.5 rounded-full bg-error animate-pulse"></span>
        <span>disconnected{reconnectCountdown > 0 ? ` — reconnecting in ${reconnectCountdown}s` : ''}</span>
      </div>
    {:else if wsState === 'connecting'}
      <div class="shrink-0 flex items-center justify-center gap-2 px-3 py-2 text-xs bg-warning/10 text-warning/80 border-b border-warning/15">
        <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
        <span>connecting…</span>
      </div>
    {/if}

    <!-- Extension header -->
    {#if extensionHeader}
      <div class="shrink-0 px-3 py-1.5 text-xs text-base-content/60 bg-base-200/50 border-b border-base-content/10 font-mono whitespace-pre-wrap flex items-start gap-2">
        <span class="flex-1">{extensionHeader}</span>
        <button onclick={() => { extensionHeader = ''; }} class="text-base-content/30 hover:text-base-content/60 transition-colors shrink-0" aria-label="Dismiss header"><X class="w-3 h-3" /></button>
      </div>
    {/if}

    <!-- Message list -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <main
      bind:this={scrollEl}
      onscroll={handleScroll}
      onclick={handleMessageAreaClick}
      onkeydown={handleCodeCopy}
      role="region"
      aria-label="Conversation"
      class="flex-1 overflow-y-auto scroll-container-mobile pb-4 bg-base-100 rounded-none sm:rounded-xl"
      style="overflow-anchor: none; overscroll-behavior: contain;"
    >
      {#if messages.length === 0 && wsState === 'connecting'}
        <div class="aurora min-h-full flex flex-col items-center justify-center gap-4 select-none pointer-events-none">
          <span class="pi-glyph pi-glyph-breathe text-8xl font-light leading-none">π</span>
          <p class="text-sm text-base-content/50 tracking-wide">connecting…</p>
        </div>
      {:else if messages.length === 0 && wsState === 'open' && !sessionId}
        <div class="aurora min-h-full flex flex-col items-center justify-center gap-4 select-none pointer-events-none">
          <span class="pi-glyph pi-glyph-breathe text-8xl font-light leading-none">π</span>
          <p class="text-sm text-base-content/50 tracking-wide">loading session…</p>
        </div>
      {:else if messages.length === 0 && wsState === 'open'}
        <div
          class="aurora min-h-full flex flex-col items-center justify-center gap-5 select-none px-6"
          role="presentation"
          onclick={(e) => {
            if (projectPickerOpen) {
              const target = e.target as HTMLElement;
              if (!target.closest('[data-project-picker]')) {
                projectPickerOpen = false;
              }
            }
          }}
        >
          <span class="pi-glyph pi-glyph-breathe text-8xl font-light leading-none">π</span>
          <div class="flex flex-col items-center gap-1">
            <p class="text-base text-base-content/75">What should we build?</p>
            <!-- Project picker trigger -->
            <button
              onclick={(e) => { e.stopPropagation(); projectPickerOpen = !projectPickerOpen; }}
              class="text-xs text-base-content/35 hover:text-base-content/60 transition-colors pointer-events-auto flex items-center gap-1"
              aria-expanded={projectPickerOpen}
            >
              <span>{activeProjectName ? `working in ${activeProjectName}` : 'start a conversation'}</span>
              <svg class="w-3 h-3 transition-transform duration-150 {projectPickerOpen ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>
          </div>

          <!-- Project picker dropdown -->
          {#if projectPickerOpen}
            <ProjectPicker onClose={() => (projectPickerOpen = false)} />
          {/if}

          <div class="flex flex-wrap justify-center gap-2 mt-1 max-w-sm pointer-events-auto">
            <button onclick={() => { input = '/compact '; tick().then(() => inputEl?.focus()); }} class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-primary hover:border-primary/35 hover:bg-primary/[0.06] transition-all duration-150 hover:-translate-y-px">/compact</button>
            <button onclick={() => { input = '/fork '; tick().then(() => inputEl?.focus()); }} class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-primary hover:border-primary/35 hover:bg-primary/[0.06] transition-all duration-150 hover:-translate-y-px">/fork</button>
            <button onclick={() => { input = '/clone '; tick().then(() => inputEl?.focus()); }} class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-primary hover:border-primary/35 hover:bg-primary/[0.06] transition-all duration-150 hover:-translate-y-px">/clone</button>
            <button onclick={() => { input = '/session '; tick().then(() => inputEl?.focus()); }} class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-primary hover:border-primary/35 hover:bg-primary/[0.06] transition-all duration-150 hover:-translate-y-px">/session</button>
            <button onclick={() => { input = '! '; tick().then(() => inputEl?.focus()); }} class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-secondary hover:border-secondary/35 hover:bg-secondary/[0.06] transition-all duration-150 hover:-translate-y-px">! run a command</button>
            <button onclick={() => { input = '#review '; tick().then(() => inputEl?.focus()); }} class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-accent hover:border-accent/35 hover:bg-accent/[0.06] transition-all duration-150 hover:-translate-y-px">#review code</button>
          </div>
        </div>
      {:else}
        <div class="w-full max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl mx-auto px-4 md:px-6 flex flex-col gap-1">
          {#each messages as msg (msg.id)}

            {#if msg.role === 'user'}
              {@const isExpanded = expandedUserMsgs[msg.id] ?? false}
              <div class="group msg-in sticky top-0 z-20 bg-base-100 relative pt-2 -mx-4 md:-mx-6">
                <div class="absolute bottom-0 left-0 right-0 h-5 bg-gradient-to-b from-base-100 to-transparent pointer-events-none"></div>
                <div class="flex justify-end px-4 md:px-6">
                <div class="max-w-[82%] space-y-0.5">
                  <div class="bg-[color-mix(in_oklch,var(--color-primary)_11%,transparent)] border border-primary/[0.08] rounded-2xl rounded-br-md px-3.5 py-2.5 space-y-1">
                    {#if msg.images?.length}
                      <div class="flex gap-2 flex-wrap -mx-1">
                        {#each msg.images as src (src)}
                          <img {src} alt="attachment" class="max-h-48 max-w-full rounded-lg object-contain" />
                        {/each}
                      </div>
                    {/if}
                    {#if msg.content}
                      <button
                        type="button"
                        use:checkOverflow={msg.id}
                        class="w-full appearance-none bg-transparent border-0 p-0 text-left whitespace-pre-wrap break-words leading-relaxed text-base-content/90 select-text {isExpanded ? 'block' : 'line-clamp-3'}"
                        onclick={() => { if (truncatedUserMsgs[msg.id] || isExpanded) expandedUserMsgs[msg.id] = !isExpanded; }}
                        aria-expanded={isExpanded}
                      >{msg.content}</button>
                      {#if truncatedUserMsgs[msg.id] || isExpanded}
                        <button
                          onclick={() => { expandedUserMsgs[msg.id] = !isExpanded; }}
                          class="text-[10px] text-base-content/30 hover:text-base-content/55 transition-colors select-none"
                        >{isExpanded ? 'show less' : 'show more'}</button>
                      {/if}
                    {/if}
                  </div>
                  <div class="flex justify-end items-center gap-1 {isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity duration-150">
                    <span class="text-[10px] text-base-content/25">{formatDate(msg.createdAt)}</span>
                    <button
                      onclick={() => copyMessage(msg)}
                      class="flex items-center justify-center w-7 h-7 text-base-content/25 hover:text-base-content/55 rounded transition-colors select-none"
                      aria-label="Copy message"
                    >{#if copiedId === msg.id}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{:else}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>{/if}</button>
                  </div>
                </div>
                </div>
              </div>

            {:else if msg.role === 'assistant'}
              <div class="group msg-in trace-step asst-step">

                <!-- THINKING TOGGLE (compact) -->
                {#if msg.streaming}
                  {#if msg.thinking && msg.thinking.length > 0}
                    <div class="trace-row font-mono w-full min-w-0">
                      <span class="trace-row-icon">
                        <Brain class="w-3.5 h-3.5" style="color:var(--color-secondary);animation:pulse 1.5s ease-in-out infinite" />
                      </span>
                      <span class="trace-row-label shimmer-text">{hiddenThinkingLabel}</span>
                      <span class="trace-row-detail">{msg.thinking.slice(0, 80)}{msg.thinking.length > 80 ? '…' : ''}</span>
                      <span class="trace-row-meta"></span>
                    </div>
                  {:else if !msg.content}
                    <div class="trace-row font-mono">
                      <span class="trace-row-icon">
                        <Loader class="w-3.5 h-3.5 animate-spin text-base-content/55" />
                      </span>
                      <span class="trace-row-label shimmer-text">{hiddenThinkingLabel}</span>
                      <span class="trace-row-detail">…</span>
                      <span class="trace-row-meta"></span>
                    </div>
                  {/if}
                {:else if msg.thinking}
                  {#if msg.content}
                    <!-- Has both thinking and content: compact toggle -->
                    <button
                      onclick={() => { msg.thinkingExpanded = !msg.thinkingExpanded; }}
                      class="trace-row trace-row-toggle font-mono mb-3 w-full min-w-0 text-left"
                      aria-expanded={msg.thinkingExpanded}
                    >
                      <span class="trace-row-icon">
                        <Brain class="w-3.5 h-3.5" style="color:var(--color-secondary)" />
                      </span>
                      <span class="trace-row-label">{hiddenThinkingLabel}</span>
                      <span class="trace-row-detail">{msg.thinking.slice(0, 80)}{msg.thinking.length > 80 ? '…' : ''}</span>
                      <span class="trace-row-meta">
                        {#if msg.endMs && msg.thinkingStartMs}
                          <span>{fmtDuration(msg.endMs - msg.thinkingStartMs)}</span>
                        {/if}
                        <ChevronRight class="w-3 h-3 transition-transform {msg.thinkingExpanded ? 'rotate-90' : ''}" />
                      </span>
                    </button>
                  {:else}
                    <!-- Thinking-only response: show as the main message content -->
                    <div class="trace-body prose text-base-content/80 text-sm leading-relaxed">
                      {@html renderMarkdown(msg.thinking)}
                    </div>
                  {/if}
                {/if}

                <!-- EXPANDED THINKING BLOCK (trailing margin creates gap before body) -->
                {#if msg.thinkingExpanded && msg.thinking && msg.content}
                  <pre class="trace-output text-[11px] text-base-content/60 whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed bg-base-content/[0.04] rounded-r px-2 py-1.5 mb-5 select-text">{msg.thinking}</pre>
                {/if}

                <!-- BODY -->
                {#if msg.content || msg.streaming}
                  <div class="trace-body leading-relaxed select-text">
                    {#if !msg.content && msg.streaming}
                      {#if workingVisible && !(msg.thinking && msg.thinking.length > 0)}
                        <span class="flex items-center gap-1.5 h-5" aria-label={hiddenThinkingLabel}>
                          {#if workingIndicatorFrames.length > 0}
                            <span class="text-base-content/60 text-sm font-mono">{workingIndicatorFrames[workingFrameIndex]}</span>
                          {:else}
                            <span class="typing-dot"></span>
                            <span class="typing-dot"></span>
                            <span class="typing-dot"></span>
                          {/if}
                          {#if workingMessage}
                            <span class="ml-2 text-base-content/40 text-xs">{workingMessage}</span>
                          {/if}
                        </span>
                      {/if}
                    {:else if msg.aborted}
                      <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-warning/10 text-warning text-sm font-medium">
                        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        {msg.content}
                      </div>
                    {:else}
                      <div class="prose text-base-content/90">{@html renderMarkdown(msg.content)}</div>
                      {#if msg.images?.length}
                        <div class="flex gap-2 flex-wrap mt-2">
                          {#each msg.images as src (src)}
                            <img {src} alt="" class="max-h-64 max-w-full rounded-lg object-contain border border-base-content/10" />
                          {/each}
                        </div>
                      {/if}
                      {#if msg.streaming}<span class="text-primary animate-pulse">▌</span>{/if}
                    {/if}
                  </div>
                {/if}

                <!-- META + ACTIONS -->
                {#if !msg.streaming}
                  <div class="trace-meta flex items-center gap-2 text-[10px] py-0.5 select-none">
                    {#if msg.usage}
                      <span class="tabular-nums text-base-content/50">{fmtTokens(msg.usage.totalTokens)}t</span>
                      {#if msg.usage.cost?.total}
                        <span class="tabular-nums text-base-content/45">{fmtCost(msg.usage.cost.total)}</span>
                      {/if}
                    {/if}
                    {#if msg.endMs && msg.startMs}
                      <span class="tabular-nums text-base-content/50">{fmtDuration(msg.endMs - msg.startMs)}</span>
                    {/if}
                    <span class="text-base-content/35">{formatDate(msg.createdAt)}</span>
                    <span class="ml-auto flex items-center gap-0.5">
                      <button
                        onclick={() => copyMessage(msg)}
                        class="flex items-center justify-center w-5 h-5 text-base-content/35 hover:text-base-content/60 rounded transition-colors select-none"
                        aria-label="Copy message"
                      >{#if copiedId === msg.id}<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{:else}<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>{/if}</button>

                    </span>
                  </div>
                {/if}
              </div>

            {:else if msg.role === 'tool'}
              {@const meta = getToolMeta(msg.toolName)}
              {@const detail = msg.toolInput ?? inferDetail(msg.toolName, msg.toolArgs)}
              <div class="group/tool msg-in flex flex-col trace-step tool-step">
                <button
                  onclick={() => { if (msg.content || msg.diff || msg.images?.length) msg.expanded = !msg.expanded; }}
                  class="trace-row trace-row-toggle font-mono text-left w-full disabled:cursor-default"
                  disabled={!msg.content && !msg.diff && !msg.images?.length}
                >
                  <span class="trace-row-icon">
                    <meta.icon class="w-3.5 h-3.5" style="color:{meta.color};{msg.streaming ? 'animation:pulse 1.5s ease-in-out infinite' : ''}" />
                  </span>
                  <span class="trace-row-label">{meta.label}</span>
                  <span class="trace-row-detail">{#if detail}{detail}{/if}</span>
                  <span class="trace-row-meta">
                    {#if msg.streaming && msg.startMs}
                      <span class="text-base-content/55 tabular-nums text-[10px]">{Math.floor((now - msg.startMs) / 1000)}s</span>
                    {:else if msg.streaming}
                      <Loader class="w-3 h-3 text-base-content/55 animate-spin" />
                    {:else if msg.isError}
                      <CircleX class="w-3 h-3 text-destructive" />
                    {:else if msg.content || msg.diff || msg.images?.length}
                      {#if msg.lineCount !== undefined}
                        <span class="text-base-content/45 tabular-nums">{msg.lineCount}L</span>
                      {/if}
                      {#if msg.images?.length}
                        <span class="text-base-content/40 tabular-nums">{msg.images.length}img</span>
                      {/if}
                      <ChevronRight class="w-3 h-3 text-base-content/45 transition-transform {msg.expanded ? 'rotate-90' : ''}" />
                    {:else}
                      <Check class="w-3 h-3 text-success/60" />
                    {/if}
                  </span>
                </button>
                {#if msg.expanded && !msg.streaming}
                  {#if msg.diff}
                    <div class="trace-output mt-1">
                      <DiffViewer diff={msg.diff} />
                    </div>
                  {:else if msg.content}
                    {@const toolLang = getToolLang(msg.toolName, msg.toolInput)}
                    {#if toolLang}
                      <pre class="trace-output mt-1 text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto leading-relaxed select-text py-1"><code class="hljs">{@html highlightCode(msg.content, toolLang)}</code></pre>
                    {:else}
                      <pre class="trace-output mt-1 text-base-content/60 text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto leading-relaxed select-text py-1">{msg.content}</pre>
                    {/if}
                  {/if}
                  {#if msg.images?.length}
                    <div class="trace-output flex gap-2 flex-wrap mt-2">
                      {#each msg.images as src (src)}
                        <img {src} alt="" class="max-h-64 max-w-full rounded-lg object-contain border border-base-content/10" />
                      {/each}
                    </div>
                  {/if}
                {/if}
              </div>

            {:else if msg.role === 'notice'}
              {#if msg.customType === 'slash_result'}
                <div class="msg-in my-2 px-4 py-3 bg-base-content/[0.04] border border-base-content/[0.06] rounded-xl font-mono text-[11px] leading-relaxed text-base-content/70 whitespace-pre-wrap break-words overflow-hidden select-text shadow-inner shadow-black/5">
                  {msg.content}
                </div>
              {:else}
                <div class="msg-in flex items-center gap-2.5 text-[10px] text-base-content/45 select-none py-1">
                  <span class="flex-1 h-px bg-gradient-to-r from-transparent to-base-content/15"></span>
                  <span class="flex items-center gap-1 shrink-0">
                    {#if msg.streaming}
                      <svg class="w-2 h-2 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                    {:else if msg.noticeKind === 'compaction'}
                      <Sparkles class="w-2.5 h-2.5" aria-hidden="true" />
                    {:else if msg.noticeKind === 'retry'}
                      <svg class="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                    {:else if msg.noticeKind === 'custom'}
                      <span class="w-2 h-2 rounded-full bg-secondary inline-block"></span>
                    {/if}
                    <span>{msg.content}</span>
                  </span>
                  <span class="flex-1 h-px bg-gradient-to-l from-transparent to-base-content/15"></span>
                </div>
              {/if}
            {/if}

          {/each}
        </div>
      {/if}
    </main>

    <!-- Extension footer -->
    {#if extensionFooter}
      <div class="shrink-0 px-3 py-1.5 text-xs text-base-content/60 bg-base-200/50 border-t border-base-content/10 font-mono whitespace-pre-wrap flex items-start gap-2">
        <span class="flex-1">{extensionFooter}</span>
        <button onclick={() => { extensionFooter = ''; }} class="text-base-content/30 hover:text-base-content/60 transition-colors shrink-0" aria-label="Dismiss footer"><X class="w-3 h-3" /></button>
      </div>
    {/if}

    <!-- Scroll-to-bottom button — fades in when user scrolls up -->
    <div
      class="absolute right-4 z-10 pointer-events-none transition-all duration-200"
      style="bottom: calc(env(safe-area-inset-bottom, 0px) + 5.5rem);"
      class:opacity-0={isAtBottom}
      class:translate-y-2={isAtBottom}
    >
      <button
        onclick={scrollToBottom}
        class="pointer-events-auto w-9 h-9 rounded-full bg-base-200/85 backdrop-blur-md border border-base-content/15 shadow-lg shadow-black/25 flex items-center justify-center text-base-content/55 hover:text-base-content hover:border-primary/40 transition-colors"
        aria-label="Scroll to bottom"
        tabindex={isAtBottom ? -1 : 0}
      ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14m0 0-7-7m7 7 7-7"/></svg></button>
    </div>

    <!-- Input bar — elevated surface to distinguish from chat -->
    <footer
      class="shrink-0 bg-transparent pt-2 md:pt-3"
      style="padding-bottom: max(0.75rem, env(safe-area-inset-bottom, 0px));"
    >
      <div class="w-full max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl mx-auto px-3 md:px-6">
      {#if queuedSteering.length > 0 || queuedFollowUp.length > 0}
        <div class="flex flex-wrap gap-1.5 mb-2 px-1">
          {#each queuedSteering as m (m)}
            <span class="inline-flex items-center gap-1 text-xs text-base-content/40 bg-base-content/6 px-2 py-1 rounded-lg max-w-[16rem] truncate" title="Queued steer: {m}">
              <svg class="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              <span class="truncate">{m}</span>
            </span>
          {/each}
          {#each queuedFollowUp as m (m)}
            <span class="inline-flex items-center gap-1 text-xs text-base-content/35 bg-base-content/5 px-2 py-1 rounded-lg max-w-[16rem] truncate" title="Queued follow-up: {m}">
              <svg class="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span class="truncate">{m}</span>
            </span>
          {/each}
        </div>
      {/if}

      <!-- Extension editor component panel -->
      {#if editorComponentPanel}
        <div class="mb-2 bg-base-content/5 rounded-xl px-3 py-2 text-xs text-base-content/60 font-mono leading-relaxed flex items-start gap-2">
          <span class="flex-1 whitespace-pre-wrap">
            {#if editorComponentPanel.kind === 'text'}
              {editorComponentPanel.content}
            {:else if editorComponentPanel.kind === 'select'}
              <span class="font-semibold">{editorComponentPanel.label}</span>
              <div class="flex flex-wrap gap-1 mt-1">
                {#each editorComponentPanel.options as opt (opt.value)}
                  <span class="px-2 py-0.5 bg-base-content/10 rounded">{opt.label}</span>
                {/each}
              </div>
            {:else if editorComponentPanel.kind === 'input'}
              <span class="font-semibold">{editorComponentPanel.label}</span>
              {#if editorComponentPanel.placeholder}<span class="text-base-content/40 ml-1">{editorComponentPanel.placeholder}</span>{/if}
            {:else if editorComponentPanel.kind === 'button'}
              <span class="font-semibold" class:text-primary={editorComponentPanel.variant === 'primary'}>{editorComponentPanel.label}</span>
            {:else if editorComponentPanel.kind === 'checkbox'}
              <span class="inline-flex items-center gap-1.5">
                {#if editorComponentPanel.checked}<SquareCheck class="w-3.5 h-3.5 text-primary/70" />{:else}<Square class="w-3.5 h-3.5 text-base-content/35" />{/if}
                {editorComponentPanel.label}
              </span>
            {:else if editorComponentPanel.kind === 'container'}
              {#if editorComponentPanel.direction === 'horizontal'}
                <span class="flex flex-wrap gap-2">
                  {#each editorComponentPanel.children as child (child.kind + (JSON.stringify(child).slice(0, 20)))}
                    <span>{#if child.kind === 'text'}{child.content}{:else if child.kind === 'button'}{child.label}{:else}{child.kind}{/if}</span>
                  {/each}
                </span>
              {:else}
                {#each editorComponentPanel.children as child (child.kind + (JSON.stringify(child).slice(0, 20)))}
                  <div>{#if child.kind === 'text'}{child.content}{:else if child.kind === 'button'}{child.label}{:else}{child.kind}{/if}</div>
                {/each}
              {/if}
            {/if}
          </span>
          <button onclick={() => { editorComponentPanel = null; }} class="text-base-content/30 hover:text-base-content/60 transition-colors shrink-0" aria-label="Dismiss editor panel"><X class="w-3 h-3" /></button>
        </div>
      {/if}

      <!-- Extension widget panels -->
      {#if Object.keys(extensionWidgets).length > 0}
        <div class="mb-2 flex flex-col gap-1">
          {#each Object.entries(extensionWidgets) as [key, widget] (key)}
            <div class="group relative">
              <button
                onclick={() => dismissWidget(key)}
                class="absolute -top-1 -right-1 w-4 h-4 bg-base-content/20 hover:bg-base-content/40 rounded-full flex items-center justify-center text-[9px] leading-none opacity-0 group-hover:opacity-100 transition-opacity z-10"
                aria-label="Dismiss widget"
              ><X class="w-2.5 h-2.5" /></button>
              {#if widget.type === 'text'}
                <div class="bg-base-content/5 rounded-xl px-3 py-2 text-xs text-base-content/45 font-mono whitespace-pre-wrap leading-relaxed">{widget.lines.join('\n')}</div>
              {:else if widget.type === 'table'}
                <div class="bg-base-content/5 rounded-xl px-3 py-2 text-xs text-base-content/45 font-mono overflow-x-auto">
                  <table class="w-full border-collapse">
                    {#if widget.headers.length > 0}
                      <thead>
                        <tr class="border-b border-base-content/10">
                          {#each widget.headers as header (header)}
                            <th class="text-left px-2 py-1 text-base-content/60 font-semibold">{header}</th>
                          {/each}
                        </tr>
                      </thead>
                    {/if}
                    <tbody>
                      {#each widget.rows as row (row)}
                        <tr class="border-b border-base-content/5 last:border-0">
                          {#each row as cell (cell)}
                            <td class="px-2 py-1">{cell}</td>
                          {/each}
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else if widget.type === 'badge'}
                <div class="flex items-center gap-2 px-2">
                  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium
                    {widget.variant === 'success' ? 'bg-success/15 text-success' :
                     widget.variant === 'error' ? 'bg-error/15 text-error' :
                     widget.variant === 'warning' ? 'bg-warning/15 text-warning' :
                     'bg-info/15 text-info'}">{widget.text}</span>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <!-- Slash command dropdown + input box wrapper -->
      <div class="relative">
        {#if showSlashMenu && filteredSlashCommands.length > 0}
          <div class="absolute bottom-full left-0 right-0 mb-1 z-10">
            <div class="bg-base-200/95 backdrop-blur-md border border-base-content/10 rounded-2xl overflow-hidden shadow-xl shadow-black/30 max-h-60 overflow-y-auto" role="listbox" aria-label="Composer shortcuts">
              {#each filteredSlashCommands as cmd, i (cmd.label ?? i)}
                <button
                  onclick={() => selectSlashCommand(cmd)}
                  role="option"
                  aria-selected={slashMenuIndex === i}
                  class="w-full text-left px-3 py-2.5 transition-colors flex items-baseline gap-3 {slashMenuIndex === i ? 'bg-base-content/10' : 'hover:bg-base-content/8'}"
                >
                  <span class="w-5 text-sm font-mono text-primary/75 shrink-0">{cmd.trigger}</span>
                  <span class="min-w-0 flex-1 flex items-baseline gap-2">
                    <span class="text-sm font-mono truncate {cmd.muted ? 'text-base-content/55' : 'text-base-content/82'}">{cmd.label}</span>
                    <span class="text-xs text-base-content/38 truncate">{cmd.description}</span>
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

      <div class="composer rounded-2xl px-3 py-2.5 flex flex-col gap-2.5">
        {#if attachedImages.length > 0 || attachedFiles.length > 0}
          <div class="flex gap-2 flex-wrap pt-1">
            {#each attachedImages as img, i (img.src)}
              <div class="relative group/thumb">
                <img src={img.src} alt={img.name} class="h-16 w-16 object-cover rounded-lg bg-base-content/5" />
                <button
                  onclick={() => removeAttachment(i)}
                  class="absolute -top-1.5 -right-1.5 w-5 h-5 bg-base-content text-base-100 rounded-full flex items-center justify-center text-xs leading-none opacity-0 group-hover/thumb:opacity-100 transition-opacity"
                  aria-label="Remove {img.name}"
                ><X class="w-3 h-3" /></button>
              </div>
            {/each}
            {#each attachedFiles as f, i (f.name)}
              <div class="relative group/thumb">
                <div class="h-16 w-16 flex flex-col items-center justify-center rounded-lg bg-base-content/10 text-center p-1">
                  <svg class="w-5 h-5 text-base-content/40 mb-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <span class="text-[10px] text-base-content/40 leading-tight truncate max-w-full">{f.name}</span>
                </div>
                <button
                  onclick={() => removeFileAttachment(i)}
                  class="absolute -top-1.5 -right-1.5 w-5 h-5 bg-base-content text-base-100 rounded-full flex items-center justify-center text-xs leading-none opacity-0 group-hover/thumb:opacity-100 transition-opacity"
                  aria-label="Remove {f.name}"
                ><X class="w-3 h-3" /></button>
              </div>
            {/each}
          </div>
        {/if}
        <textarea
          bind:this={inputEl}
          bind:value={input}
          onkeydown={handleKeydown}
          oninput={autoResizeTextarea}
          rows={1}
          placeholder={wsState !== 'open' ? wsState + '…' : isStreaming ? 'Steer pi…' : isMobile ? 'Message pi…' : 'Message pi — @ files · / commands · ! shell'}
          aria-label="Message to pi"
          disabled={wsState !== 'open'}
          class="w-full min-h-12 mt-1 bg-transparent resize-none outline-none placeholder-base-content/45 disabled:opacity-40 leading-relaxed max-h-48 overflow-y-auto transition-opacity text-base"
          style="field-sizing: content"
        ></textarea>

        {#if isStreaming}
          <div class="flex items-center justify-end gap-1">
            {#if input.trim()}
              <Tooltip.Root>
                <Tooltip.Trigger>
                  {#snippet child({ props })}
                    <button {...props} onclick={steerAgent} class="w-9 h-9 flex items-center justify-center text-warning/80 hover:text-warning hover:bg-warning/10 rounded-full transition-colors" aria-label="Steer pi"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button>
                  {/snippet}
                </Tooltip.Trigger>
                <Tooltip.Content>Queue steer (Enter)</Tooltip.Content>
              </Tooltip.Root>
            {/if}
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <button {...props} onclick={abortGeneration} class="w-9 h-9 flex items-center justify-center text-base-content/60 hover:text-base-content/90 hover:bg-base-content/8 rounded-full transition-colors" aria-label="Abort generation"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>Abort</Tooltip.Content>
            </Tooltip.Root>
          </div>
        {:else}
          <div class="flex items-center gap-1.5 min-w-0">
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    onclick={() => fileInputEl?.click()}
                    disabled={wsState !== 'open'}
                    class="w-8 h-8 flex items-center justify-center text-base-content/45 hover:text-base-content/70 hover:bg-base-content/8 rounded-full transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default"
                    aria-label="Attach file"
                  ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>Attach file</Tooltip.Content>
            </Tooltip.Root>
            {#if isCompacting}
              <span class="hidden md:flex w-8 h-8 items-center justify-center text-base-content/20 animate-pulse">
                <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              </span>
            {:else}
              <Tooltip.Root>
                <Tooltip.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      onclick={compactSession}
                      disabled={wsState !== 'open'}
                      class="hidden md:flex w-8 h-8 items-center justify-center text-base-content/35 hover:text-base-content/60 hover:bg-base-content/8 rounded-full transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default"
                      aria-label="Compact context"
                    ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg></button>
                  {/snippet}
                </Tooltip.Trigger>
                <Tooltip.Content>Compact context</Tooltip.Content>
              </Tooltip.Root>
            {/if}
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    onclick={toggleConversationMode}
                    disabled={wsState !== 'open'}
                    class="{conversationMode ? 'flex' : 'hidden md:flex'} w-8 h-8 items-center justify-center rounded-full transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default {conversationMode ? 'text-primary bg-primary/12' : 'text-base-content/35 hover:text-base-content/60 hover:bg-base-content/8'}"
                    aria-label={conversationMode ? 'Exit conversation mode' : 'Enter conversation mode'}
                    role="switch"
                    aria-checked={conversationMode}
                  ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg></button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>{conversationMode ? 'Exit conversation mode' : 'Enter conversation mode (voice loop)'}</Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    onclick={toggleSTT}
                    disabled={wsState !== 'open'}
                    class="w-8 h-8 flex items-center justify-center rounded-full transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default {isRecording ? 'text-error bg-error/10 animate-pulse' : 'text-base-content/35 hover:text-base-content/60 hover:bg-base-content/8'}"
                    aria-label={isRecording ? 'Stop recording' : 'Record voice input'}
                  ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg></button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>{isRecording ? 'Stop recording' : 'Record voice input'}</Tooltip.Content>
            </Tooltip.Root>
            <span class="flex-1"></span>
            <button
              onclick={() => openTab('models')}
              class="min-w-0 max-w-[12rem] md:max-w-[20rem] h-8 px-3 flex items-center gap-2 rounded-full text-xs font-medium bg-base-content/[0.045] border border-base-content/[0.07] text-base-content/65 hover:text-base-content/90 hover:border-base-content/15 hover:bg-base-content/[0.07] transition-colors"
              aria-label="Select model"
              aria-expanded={showRightPanel && rightPanelTab === 'models'}
            >
              {#if model?.provider}
                <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background:{providerColor(model.provider)}"></span>
              {/if}
              <span class="truncate">{model?.name ?? 'Select model'}</span>
            </button>
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    onclick={clickSend}
                    onpointerdown={startSendHold}
                    onpointerup={cancelSendHold}
                    onpointerleave={cancelSendHold}
                    onpointercancel={cancelSendHold}
                    oncontextmenu={(e) => e.preventDefault()}
                    disabled={(!input.trim() && attachedImages.length === 0 && attachedFiles.length === 0) || wsState !== 'open'}
                    class="w-8 h-8 flex items-center justify-center rounded-full transition-all duration-200 shrink-0 {(input.trim() || attachedImages.length > 0 || attachedFiles.length > 0) && wsState === 'open' ? 'bg-primary text-primary-content hover:brightness-110 shadow-[0_0_16px_-4px_color-mix(in_oklch,var(--color-primary)_60%,transparent)]' : 'text-base-content/25'} disabled:cursor-default"
                    aria-label="Send message"
                  ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m0 0-7 7m7-7 7 7"/></svg></button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>{canSubmitFollowUp() ? 'Send (Enter). Hold for follow-up.' : 'Send (Enter)'}</Tooltip.Content>
            </Tooltip.Root>
          </div>
        {/if}
      </div>

      <input
        bind:this={fileInputEl}
        type="file"
        accept="image/*,.txt,.md,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.jsx,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.cpp,.h,.hpp,.cs,.sh,.bash,.zsh,.toml,.ini,.cfg,.conf,.env,.gitignore,.svelte,.vue,.sass,.scss,.less,.sql,.graphql,.r,.mjs,.cjs"
        multiple
        class="hidden"
        onchange={handleFileInput}
      />
      </div><!-- end .relative slash/input wrapper -->

      {#if Object.keys(extensionStatuses).length > 0 || effectiveContextTokens > 0 || sessionCostTotal > 0}
        <div class="hidden md:flex mt-1.5 px-1 items-center gap-2 text-xs select-none min-w-0">
          {#if Object.keys(extensionStatuses).length > 0}
            <span class="text-base-content/50 truncate min-w-0">
              {Object.values(extensionStatuses).filter(Boolean).join(' · ')}
            </span>
          {/if}

          <span class="flex-1"></span>

          {#if contextPercent > 0}
            <Tooltip.Root>
              <Tooltip.Trigger
                class={[
                  'tabular-nums cursor-default',
                  contextPercent >= 75
                    ? 'text-error/60'
                    : contextPercent >= 50
                      ? 'text-warning/60'
                      : 'text-base-content/40'
                ].join(' ')}
              >
                ctx {contextPercent}%
              </Tooltip.Trigger>
              <Tooltip.Content sideOffset={6} class="min-w-[160px]">
                <div class="flex flex-col gap-1.5">
                  <!-- mini progress bar -->
                  <div class="w-full h-1 rounded-full bg-background/15 overflow-hidden">
                    <div
                      class="h-full rounded-full bg-background/70 transition-all"
                      style="width: {Math.min(contextPercent, 100)}%"
                    ></div>
                  </div>
                  <!-- token counts -->
                  <p class="text-xs tabular-nums">
                    {effectiveContextTokens.toLocaleString()} / {((contextUsageWindow > 0 ? contextUsageWindow : null) ?? model?.contextWindow ?? 0).toLocaleString()} tokens
                  </p>
                  {#if sessionTokens > 0}
                    <p class="text-xs tabular-nums text-background/60">
                      session total: {sessionTokens.toLocaleString()}
                    </p>
                  {/if}
                </div>
              </Tooltip.Content>
            </Tooltip.Root>
          {:else if effectiveContextTokens > 0}
            <Tooltip.Root>
              <Tooltip.Trigger class="tabular-nums cursor-default text-base-content/40">
                {fmtTokens(effectiveContextTokens)} ctx
              </Tooltip.Trigger>
              <Tooltip.Content sideOffset={6} class="min-w-[140px]">
                <div class="flex flex-col gap-1.5">
                  <p class="text-xs tabular-nums">
                    {effectiveContextTokens.toLocaleString()} tokens
                  </p>
                  {#if sessionTokens > 0}
                    <p class="text-xs tabular-nums text-background/60">
                      session total: {sessionTokens.toLocaleString()}
                    </p>
                  {/if}
                </div>
              </Tooltip.Content>
            </Tooltip.Root>
          {/if}

          {#if sessionCostTotal > 0}
            <span class="text-base-content/40 tabular-nums">{fmtCost(sessionCostTotal)}</span>
          {/if}
        </div>
      {/if}
      </div>
    </footer>
  </div>

  <!-- ── RIGHT SIDEBAR: Unified panel (models / tools / skills) ─────────── -->

  <SidebarPanel
    title={rightPanelTab === 'models' ? 'models' : rightPanelTab === 'tools' ? (toolsList.length ? `tools (${activeToolNames.length}/${toolsList.length})` : 'tools') : 'skills & prompts'}
    open={showRightPanel}
    {isMobile}
    width={rightPanelWidth}
    side="right"
    resizing={rightResizing}
    closeLabel="Close panel"
    surface="default"
    onClose={() => (showRightPanel = false)}
    onResizeStart={startRightResize}
    onResizeMove={onRightResizeMove}
    onResizeStop={() => stopRightResize()}
  >
    {#snippet header()}{/snippet}

    <div class="shrink-0 px-3 py-2.5 border-b border-base-content/8 flex items-center gap-2">
      <div role="tablist" aria-label="Panel sections" class="flex items-center flex-1 bg-base-content/[0.045] border border-base-content/[0.05] rounded-full p-0.5 gap-0.5">
        <button
          role="tab"
          aria-selected={rightPanelTab === 'models'}
          onclick={() => { rightPanelTab = 'models'; }}
          class="flex-1 px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {rightPanelTab === 'models' ? 'text-base-content bg-base-content/12 shadow-sm shadow-black/10' : 'text-base-content/45 hover:text-base-content/70'}"
          tabindex={showRightPanel ? 0 : -1}
        >models</button>
        <button
          role="tab"
          aria-selected={rightPanelTab === 'tools'}
          onclick={() => { rightPanelTab = 'tools'; }}
          class="flex-1 px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {rightPanelTab === 'tools' ? 'text-base-content bg-base-content/12 shadow-sm shadow-black/10' : 'text-base-content/45 hover:text-base-content/70'}"
          tabindex={showRightPanel ? 0 : -1}
        >tools{#if toolsList.length} <span class="text-base-content/30 font-normal ml-0.5">{activeToolNames.length}/{toolsList.length}</span>{/if}</button>
        <button
          role="tab"
          aria-selected={rightPanelTab === 'skills'}
          onclick={() => { rightPanelTab = 'skills'; }}
          class="flex-1 px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {rightPanelTab === 'skills' ? 'text-base-content bg-base-content/12 shadow-sm shadow-black/10' : 'text-base-content/45 hover:text-base-content/70'}"
          tabindex={showRightPanel ? 0 : -1}
        >skills</button>
      </div>
      <button
        onclick={() => (showRightPanel = false)}
        class="w-8 h-8 flex items-center justify-center text-base-content/40 hover:text-base-content hover:bg-base-content/10 rounded-full transition-all duration-150 shrink-0"
        aria-label="Close panel"
      ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
    </div>

    {#if rightPanelTab === 'models'}
      <div class="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-base-200/80 to-transparent z-10"></div>
      <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-base-content/6 to-transparent z-10"></div>

      <div class="shrink-0 px-5 py-2 border-b border-base-content/8 flex items-center gap-3">
        <Tabs.Root bind:value={modelTab} class="flex-1">
          <Tabs.List variant="line">
            <Tabs.Trigger value="models" tabindex={showRightPanel ? 0 : -1}>models</Tabs.Trigger>
            <Tabs.Trigger value="providers" tabindex={showRightPanel ? 0 : -1}>providers{#if providers.length} <span class="text-base-content/30 font-normal text-xs">{configuredProviderCount}/{providers.length}</span>{/if}</Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
      </div>

      {#if modelTab === 'models'}
        {#if model?.reasoning}          <div class="shrink-0 px-5 py-3.5 border-b border-base-content/8">
            <p class="text-[10px] text-base-content/35 uppercase tracking-[0.12em] mb-3 font-semibold">thinking</p>
            <div class="flex flex-wrap gap-1.5">
              {#each ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as lvl (lvl)}
                <button
                  onclick={() => pickThinkingLevel(lvl)}
                  class="px-3 py-1 text-xs font-medium rounded-full border transition-all duration-150 {thinkingLevel === lvl ? 'border-primary/60 text-primary bg-primary/10 glow-primary' : 'border-base-content/12 text-base-content/40 hover:border-base-content/30 hover:text-base-content/70 hover:bg-base-content/5'}"
                  tabindex={showRightPanel ? 0 : -1}
                >{lvl}</button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="flex-1 min-h-0 flex flex-col">
          <div class="shrink-0 px-5 py-3 border-b border-base-content/8">
            <div class="relative">
              <svg class="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/20 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input
                type="search"
                placeholder="filter models…"
                bind:value={modelFilter}
                class="w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35"
                aria-label="Filter models"
                tabindex={showRightPanel ? 0 : -1}
              />
            </div>
          </div>
          <ScrollArea class="flex-1 min-h-0">
            {#if availableModels.length === 0}
              <div class="flex-1 flex items-center justify-center px-5 py-8">
                <p class="text-xs text-base-content/45">no models configured</p>
              </div>
            {:else if filteredModelsByProvider.length === 0}
              <div class="flex-1 flex items-center justify-center px-5 py-8">
                <p class="text-xs text-base-content/20">no match</p>
              </div>
            {:else}
              {#each filteredModelsByProvider as [provider, models] (provider)}
                <div>
                  {@render sectionHeader(provider[0].toUpperCase(), '', provider, providerColor(provider))}
                  {#each models as m (m.id)}
                    {@const isActive = model?.id === m.id && model?.provider === m.provider}
                    <button
                      onclick={() => selectModel(m)}
                      class="w-full text-left px-5 py-2.5 text-sm transition-all duration-150 flex items-center gap-3 relative {isActive ? 'text-primary bg-primary/[0.06]' : 'text-base-content/70 hover:text-base-content hover:bg-base-content/[0.03]'}"
                      aria-pressed={isActive}
                      tabindex={showRightPanel ? 0 : -1}
                    >
                      {#if isActive}<span class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary glow-primary"></span>{/if}
                      <span class="flex-1 truncate">{m.name}</span>
                      {#if m.reasoning}<Sparkles class="w-3 h-3 text-base-content/25 shrink-0" aria-label="Supports reasoning" />{/if}
                      {#if isActive}<span class="text-primary shrink-0"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></span>{/if}
                    </button>
                  {/each}
                </div>
              {/each}
            {/if}
          </ScrollArea>
        </div>

      {:else}
        <div class="flex-1 min-h-0 flex flex-col">
          <div class="shrink-0 px-5 py-3 border-b border-base-content/8">
            <div class="relative">
              <svg class="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/20 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input
                type="search"
                placeholder="filter providers…"
                bind:value={providerFilter}
                class="w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35"
                aria-label="Filter providers"
                tabindex={showRightPanel ? 0 : -1}
              />
            </div>
          </div>

          {#if providerError}
            <div class="shrink-0 px-5 py-2.5 bg-error/[0.07] border-b border-error/20 flex items-center justify-between gap-2">
              <span class="text-xs text-error/80 break-words min-w-0">{providerError}</span>
              <button onclick={() => (providerError = null)} class="w-6 h-6 flex items-center justify-center text-error/50 hover:text-error/80 shrink-0 rounded transition-colors duration-150" aria-label="Dismiss error"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            </div>
          {/if}

          <ScrollArea class="flex-1 min-h-0">
            {#if providers.length === 0}
              <div class="flex-1 flex items-center justify-center px-5 py-8">
                <p class="text-xs text-base-content/45">loading…</p>
              </div>
            {:else if filteredProviders.length === 0}
              <div class="flex-1 flex items-center justify-center px-5 py-8">
                <p class="text-xs text-base-content/20">no match</p>
              </div>
            {:else}
              {#each filteredProviders as p (p.id)}
                {@const isCurrentProvider = model?.provider === p.id}
                {@const label = sourceLabel(p.source)}
                <div class="px-5 py-3 border-b border-base-content/6 transition-colors duration-150 {isCurrentProvider ? 'bg-primary/[0.04]' : 'hover:bg-base-content/[0.02]'}">
                  <div class="flex items-center gap-3 mb-2">
                    <span class="text-sm flex-1 truncate {p.configured ? 'text-base-content/85' : 'text-base-content/40'} {isCurrentProvider ? 'text-primary' : ''}">{p.name}</span>
                    {#if label}<span class="text-[10px] text-base-content/25 shrink-0 font-mono">{label}</span>{/if}
                    <span
                      class="w-2 h-2 rounded-full shrink-0 {p.configured ? 'bg-primary/70 glow-primary' : 'border border-base-content/25'}"
                      role="img"
                      aria-label={p.configured ? 'Configured' : 'Not configured'}
                    ></span>
                    <span class="text-[10px] text-base-content/25 shrink-0">{p.modelCount}m</span>
                  </div>
                  {#if p.configured}
                    {#if canRemove(p.source)}
                      <button onclick={() => removeProviderKey(p.id)} class="text-xs text-base-content/25 hover:text-error transition-colors duration-150" tabindex={showRightPanel ? 0 : -1}>remove key</button>
                    {:else}
                      <span class="text-xs text-base-content/15">set externally</span>
                    {/if}
                  {:else}
                    <div class="flex gap-2 items-center mt-1">
                      <input
                        type="password"
                        placeholder="API key…"
                        bind:value={providerKeyInputs[p.id]}
                        onkeydown={(e) => { if (e.key === 'Enter') setProviderKey(p.id); }}
                        class="flex-1 bg-transparent border-b border-base-content/10 focus:border-base-content/30 outline-none text-sm py-1.5 placeholder-base-content/15 transition-all duration-150 min-w-0"
                        aria-label="API key for {p.name}"
                        tabindex={showRightPanel ? 0 : -1}
                      />
                      <button
                        onclick={() => setProviderKey(p.id)}
                        disabled={!(providerKeyInputs[p.id] ?? '').trim()}
                        class="text-xs text-base-content/35 hover:text-base-content disabled:opacity-20 transition-all duration-150 shrink-0 px-2 py-1.5"
                        tabindex={showRightPanel ? 0 : -1}
                      >save</button>
                    </div>
                  {/if}
                </div>
              {/each}
            {/if}
          </ScrollArea>
        </div>
      {/if}

    {:else if rightPanelTab === 'tools'}
      <div class="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-base-200/80 to-transparent z-10"></div>
      <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-base-content/6 to-transparent z-10"></div>

      <div class="flex-1 min-h-0 flex flex-col">
        <div class="shrink-0 px-5 py-3 border-b border-base-content/8">
          <div class="relative">
            <svg class="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/20 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input
              type="search"
              placeholder="filter tools…"
              bind:value={toolFilter}
              class="w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35"
              aria-label="Filter tools"
              tabindex={showRightPanel ? 0 : -1}
            />
          </div>
        </div>
        <ScrollArea class="flex-1 min-h-0">
          {#if toolsList.length === 0}
            <p class="text-sm text-base-content/45 px-5 py-8">loading…</p>
          {:else if filteredTools.length === 0}
            <div class="flex-1 flex items-center justify-center px-5 py-8">
              <p class="text-xs text-base-content/20">no match</p>
            </div>
          {:else}
            {@const builtinTools = filteredTools.filter((t) => t.isBuiltin)}
            {@const customTools = filteredTools.filter((t) => !t.isBuiltin)}
            {#if builtinTools.length > 0}
              <div class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6">
                <span class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 bg-base-content/30" aria-hidden="true">B</span>
                <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold">built-in</span>
              </div>
              {#each builtinTools as tool (tool.name)}
                {@const isActive = activeToolNames.includes(tool.name)}
                <button
                  onclick={() => toggleTool(tool.name)}
                  class="w-full text-left px-5 py-2.5 text-sm transition-all duration-150 flex items-center gap-3 relative {isActive ? 'hover:bg-base-content/5' : 'opacity-50 hover:opacity-75 hover:bg-base-content/3'}"
                  tabindex={showRightPanel ? 0 : -1}
                  aria-pressed={isActive}
                >
                  {#if isActive}<span class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary glow-primary"></span>{/if}
                  <span class="min-w-0 flex-1">
                    <span class="text-sm font-mono text-base-content/80 block truncate">{tool.name}</span>
                    {#if tool.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{tool.description}</span>{/if}
                  </span>
                  <span class="shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors {isActive ? 'border-primary bg-primary' : 'border-base-content/30 bg-transparent'}">
                    {#if isActive}<svg class="w-2.5 h-2.5 text-primary-content" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{/if}
                  </span>
                </button>
              {/each}
            {/if}
            {#if customTools.length > 0}
              <div class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6">
                <span class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 bg-primary/70" aria-hidden="true">C</span>
                <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold">custom</span>
              </div>
              {#each customTools as tool (tool.name)}
                {@const isActive = activeToolNames.includes(tool.name)}
                <button
                  onclick={() => toggleTool(tool.name)}
                  class="w-full text-left px-5 py-2.5 text-sm transition-all duration-150 flex items-center gap-3 relative {isActive ? 'hover:bg-base-content/5' : 'opacity-50 hover:opacity-75 hover:bg-base-content/3'}"
                  tabindex={showRightPanel ? 0 : -1}
                  aria-pressed={isActive}
                >
                  {#if isActive}<span class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary glow-primary"></span>{/if}
                  <span class="min-w-0 flex-1">
                    <span class="text-sm font-mono text-base-content/80 block truncate">{tool.name}</span>
                    {#if tool.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{tool.description}</span>{/if}
                  </span>
                  <span class="shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors {isActive ? 'border-primary bg-primary' : 'border-base-content/30 bg-transparent'}">
                    {#if isActive}<svg class="w-2.5 h-2.5 text-primary-content" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{/if}
                  </span>
                </button>
              {/each}
            {/if}
          {/if}
        </ScrollArea>
      </div>

      <div class="shrink-0 border-t border-base-content/10 px-5 py-3 flex items-center justify-between">
        <button
          onclick={() => { activeToolNames = toolsList.map((t) => t.name); send({ type: 'set_active_tools', toolNames: activeToolNames }); }}
          class="text-xs text-base-content/35 hover:text-base-content/60 transition-colors py-1"
          tabindex={showRightPanel ? 0 : -1}
        >enable all</button>
        <button
          onclick={() => { activeToolNames = []; send({ type: 'set_active_tools', toolNames: [] }); }}
          class="text-xs text-base-content/35 hover:text-base-content/60 transition-colors py-1"
          tabindex={showRightPanel ? 0 : -1}
        >disable all</button>
      </div>

    {:else}
      <div class="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-base-200/80 to-transparent z-10"></div>
      <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-base-content/6 to-transparent z-10"></div>

      <div class="flex-1 min-h-0 flex flex-col">
        <div class="shrink-0 px-5 py-3 border-b border-base-content/8">
          <div class="relative">
            <svg class="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/20 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input
              type="search"
              placeholder="filter skills & prompts…"
              bind:value={skillFilter}
              class="w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35"
              aria-label="Filter skills and prompts"
              tabindex={showRightPanel ? 0 : -1}
            />
          </div>
        </div>
        <ScrollArea class="flex-1 min-h-0">
          {#if !resourcesLoaded}
            <p class="text-sm text-base-content/45 px-5 py-8">loading…</p>
          {:else if filteredSkills.skills.length === 0 && filteredSkills.prompts.length === 0}
            <div class="flex-1 flex items-center justify-center px-5 py-8">
              <p class="text-xs text-base-content/20">{skillFilter.trim() ? 'no match' : 'no skills or prompts found'}</p>
            </div>
          {:else}
            {#if filteredSkills.skills.length > 0}
              {@const projectSkills = filteredSkills.skills.filter((s) => s.scope === 'project')}
              {@const userSkills = filteredSkills.skills.filter((s) => s.scope === 'user')}
              {@const builtinSkills = filteredSkills.skills.filter((s) => s.isBuiltin && s.scope !== 'project' && s.scope !== 'user')}

              {#snippet skillItem(skill: SkillSummary)}
                <div class="px-5 py-2.5 flex items-start gap-3 transition-colors hover:bg-base-content/[0.03]">
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5 mb-0.5 flex-wrap">
                      <span class="text-sm font-mono text-base-content/80 truncate">{skill.name}</span>
                      {#if skill.isBuiltin}<span class="shrink-0 px-1.5 py-0.5 rounded text-base-content/30 bg-base-content/6" style="font-size:9px">pkg</span>{/if}
                    </span>
                    {#if skill.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{skill.description}</span>{/if}
                  </span>
                  <button
                    onclick={() => { input = `/skill:${skill.name} `; showRightPanel = false; tick().then(() => inputEl?.focus()); }}
                    class="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-primary hover:bg-primary/10 rounded transition-colors"
                    title="Use skill"
                    tabindex={showRightPanel ? 0 : -1}
                   ><CornerDownLeft class="w-3.5 h-3.5" /></button>
                </div>
              {/snippet}

              {#if projectSkills.length > 0}
                {@render sectionHeader('P', 'bg-primary/70', 'project skills')}
                {#each projectSkills as skill (skill.name)}{@render skillItem(skill)}{/each}
              {/if}

              {#if userSkills.length > 0}
                {@render sectionHeader('U', 'bg-accent/70', 'user skills')}
                {#each userSkills as skill (skill.name)}{@render skillItem(skill)}{/each}
              {/if}

              {#if builtinSkills.length > 0}
                {@render sectionHeader('B', 'bg-base-content/30', 'built-in skills')}
                <div class="opacity-70">
                  {#each builtinSkills as skill (skill.name)}{@render skillItem(skill)}{/each}
                </div>
              {/if}
            {/if}

            {#if filteredSkills.prompts.length > 0}
              {@const projectPrompts = filteredSkills.prompts.filter((p) => p.scope === 'project')}
              {@const userPrompts = filteredSkills.prompts.filter((p) => p.scope === 'user')}
              {@const builtinPrompts = filteredSkills.prompts.filter((p) => p.isBuiltin)}

              {#if projectPrompts.length > 0}
                {@render sectionHeader('P', 'bg-primary/70', 'project prompts')}
                {#each projectPrompts as prompt (prompt.name)}{@render promptItem(prompt)}{/each}
              {/if}

              {#if userPrompts.length > 0}
                {@render sectionHeader('U', 'bg-accent/70', 'user prompts')}
                {#each userPrompts as prompt (prompt.name)}{@render promptItem(prompt)}{/each}
              {/if}

              {#if builtinPrompts.length > 0}
                {@render sectionHeader('B', 'bg-base-content/30', 'built-in prompts')}
                <div class="opacity-70">
                  {#each builtinPrompts as prompt (prompt.name)}{@render promptItem(prompt)}{/each}
                </div>
              {/if}
            {/if}
          {/if}
        </ScrollArea>
      </div>

      <div class="shrink-0 border-t border-base-content/10 px-5 py-3 space-y-2">
        <p class="text-xs text-base-content/40 uppercase tracking-wider mb-1">install skill</p>
        <input
          bind:value={skillInstallUrl}
          type="url"
          placeholder="GitHub URL or raw .md URL"
          class="w-full text-xs bg-base-content/5 border border-base-content/10 rounded-lg px-3 py-2 text-base-content/80 placeholder-base-content/30 focus:outline-none focus:border-primary/50"
          tabindex={showRightPanel ? 0 : -1}
          onkeydown={(e) => { if (e.key === 'Enter' && skillInstallUrl.trim() && !skillInstalling) { skillInstalling = true; skillInstallFeedback = null; send({ type: 'install_skill', url: skillInstallUrl.trim(), scope: skillInstallScope }); } }}
        />
        <div class="flex items-center gap-2">
          <select
            bind:value={skillInstallScope}
            class="text-xs bg-base-content/5 border border-base-content/10 rounded-lg px-2 py-1.5 text-base-content/70 focus:outline-none focus:border-primary/50"
            tabindex={showRightPanel ? 0 : -1}
          >
            <option value="user">user (~/.pi)</option>
            <option value="project">project (.pi)</option>
          </select>
          <button
            onclick={() => { if (!skillInstallUrl.trim() || skillInstalling) return; skillInstalling = true; skillInstallFeedback = null; send({ type: 'install_skill', url: skillInstallUrl.trim(), scope: skillInstallScope }); }}
            disabled={!skillInstallUrl.trim() || skillInstalling}
            class="flex-1 text-xs py-1.5 px-3 rounded-lg transition-colors {skillInstalling ? 'bg-base-content/10 text-base-content/30' : 'bg-primary/15 text-primary hover:bg-primary/25'}"
            tabindex={showRightPanel ? 0 : -1}
          >{skillInstalling ? 'installing…' : 'install'}</button>
        </div>
        {#if skillInstallFeedback}
          <p class="text-xs {skillInstallFeedback.success ? 'text-success' : 'text-error'} leading-snug">{skillInstallFeedback.message}</p>
        {/if}
      </div>
    {/if}

  </SidebarPanel>

  <!-- ── MODAL: Settings ───────────────────────────────────────────────────── -->

  <Dialog.Root bind:open={showSettingsPanel}>
    <Dialog.Content class="p-0 overflow-hidden max-w-[calc(100vw-1rem)] sm:max-w-[min(68rem,calc(100vw-2rem))] h-[min(44rem,calc(100dvh-2rem))] bg-base-200 text-base-content border border-base-content/10 shadow-2xl shadow-black/40" showCloseButton={false}>
      <div class="flex h-full min-h-0">
        <aside class="hidden sm:flex w-60 shrink-0 flex-col border-r border-base-content/10 bg-base-300/70">
          <div class="px-5 py-4 border-b border-base-content/8">
            <p class="text-sm font-semibold text-base-content/80">Settings</p>
            <p class="text-xs text-base-content/35 mt-0.5">pi-ui preferences</p>
          </div>
          <nav class="flex-1 p-2 space-y-1">
            {#each SETTINGS_SECTIONS as section (section.id)}
              <button
                onclick={() => (settingsSection = section.id)}
                class="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors {settingsSection === section.id ? 'bg-base-content/10 text-base-content' : 'text-base-content/62 hover:text-base-content/85 hover:bg-base-content/[0.055]'}"
              >
                <span class="w-5 flex items-center justify-center text-base-content/45"><section.icon class="w-4 h-4" /></span>
                <span>{section.label}</span>
              </button>
            {/each}
          </nav>
          <div class="px-5 py-3 border-t border-base-content/8 text-[10px] text-base-content/32 font-mono">
            {uiVersion ? `pi-ui v${uiVersion}` : 'pi-ui'}
          </div>
        </aside>

        <div class="flex-1 min-w-0 min-h-0 flex flex-col bg-[radial-gradient(circle_at_30%_25%,color-mix(in_oklch,var(--color-primary)_8%,transparent),transparent_35%),var(--color-base-200)]">
          <header class="shrink-0 flex items-center gap-3 px-4 sm:px-6 py-4 border-b border-base-content/10">
            <Select.Root type="single" value={settingsSection} onValueChange={(v: string) => { if (v) settingsSection = v as typeof settingsSection; }}>
              <Select.Trigger size="sm" class="sm:hidden w-40 text-xs">
                {SETTINGS_SECTIONS.find((s) => s.id === settingsSection)?.label ?? 'Settings'}
              </Select.Trigger>
              <Select.Content>
                {#each SETTINGS_SECTIONS as section (section.id)}
                  <Select.Item value={section.id}>{section.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <div class="min-w-0 flex-1">
              <Dialog.Title class="text-base font-semibold text-base-content/82">
                {SETTINGS_SECTIONS.find((s) => s.id === settingsSection)?.label ?? 'Settings'}
              </Dialog.Title>
              <Dialog.Description class="text-xs text-base-content/38 mt-0.5">
                {#if settingsSection === 'session'}Defaults and behavior for session runs{:else if settingsSection === 'notifications'}Configure PWA push and page notifications{:else if settingsSection === 'shortcuts'}Keyboard shortcuts available in the chat UI{:else if settingsSection === 'extensions'}Loaded extensions and their tools/commands{:else if settingsSection === 'updates'}Check and apply pi-ui or SDK updates{:else}Runtime information and server controls{/if}
              </Dialog.Description>
            </div>
            <button
              onclick={() => (showSettingsPanel = false)}
              class="w-8 h-8 flex items-center justify-center text-base-content/45 hover:text-base-content hover:bg-base-content/10 rounded-lg transition-colors shrink-0"
              aria-label="Close settings"
            ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
          </header>

          <ScrollArea class="flex-1 min-h-0">
            <div class="max-w-3xl px-4 sm:px-8 py-6 space-y-6">
              {#if settingsSection === 'session'}
                <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
                  <div class="divide-y divide-base-content/8">
                    <div class="flex items-center gap-3 px-4 py-3">
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-base-content/75">Auto-compact</p>
                        <p class="text-xs text-base-content/35 mt-0.5">Let pi compress context before it gets too large.</p>
                      </div>
                      <Switch checked={autoCompactionEnabled} onCheckedChange={(v) => { autoCompactionEnabled = v; send({ type: 'set_auto_compaction', enabled: v }); }} disabled={wsState !== 'open'} aria-label="Toggle auto-compaction" />
                    </div>
                    <div class="flex items-center gap-3 px-4 py-3">
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-base-content/75">Auto-retry</p>
                        <p class="text-xs text-base-content/35 mt-0.5">Retry transient model errors automatically.</p>
                      </div>
                      <Switch checked={autoRetryEnabled} onCheckedChange={(v) => { autoRetryEnabled = v; send({ type: 'set_auto_retry', enabled: v }); }} disabled={wsState !== 'open'} aria-label="Toggle auto-retry" />
                    </div>
                  </div>
                </Card.Root>
              {:else if settingsSection === 'notifications'}
                <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
                  <div class="divide-y divide-base-content/8">
                    <div class="flex items-center gap-3 px-4 py-3">
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-base-content/75">Notifications</p>
                        <p class="text-xs text-base-content/35 mt-0.5">Global toggle for all push and page notifications.</p>
                      </div>
                      <Switch checked={notificationPrefs.enabled} onCheckedChange={(v) => { notificationPrefs.enabled = v; }} aria-label="Toggle all notifications" />
                    </div>
                    <div class="flex items-center gap-3 px-4 py-3 {notificationPrefs.enabled ? '' : 'opacity-40 pointer-events-none'}">
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-base-content/75">Response Complete</p>
                        <p class="text-xs text-base-content/35 mt-0.5">Notify when the active session's agent finishes responding.</p>
                      </div>
                      <Switch checked={notificationPrefs.onComplete} onCheckedChange={(v) => { notificationPrefs.onComplete = v; }} disabled={!notificationPrefs.enabled} aria-label="Toggle response complete notification" />
                    </div>
                    <div class="flex items-center gap-3 px-4 py-3 {notificationPrefs.enabled ? '' : 'opacity-40 pointer-events-none'}">
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-base-content/75">Background Session Finished</p>
                        <p class="text-xs text-base-content/35 mt-0.5">Notify when a session you're not watching finishes.</p>
                      </div>
                      <Switch checked={notificationPrefs.onSessionFinish} onCheckedChange={(v) => { notificationPrefs.onSessionFinish = v; }} disabled={!notificationPrefs.enabled} aria-label="Toggle background session notification" />
                    </div>
                  </div>
                </Card.Root>
              {:else if settingsSection === 'shortcuts'}
                <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
                  <div class="divide-y divide-base-content/8">
                    {#each SHORTCUTS as shortcut (shortcut.keys)}
                      <div class="flex items-center gap-4 px-4 py-3">
                        <kbd class="min-w-32 rounded-lg border border-base-content/12 bg-base-content/[0.055] px-2 py-1 text-xs text-base-content/60 font-mono">{shortcut.keys}</kbd>
                        <span class="text-sm text-base-content/70">{shortcut.action}</span>
                      </div>
                    {/each}
                  </div>
                </Card.Root>
              {:else if settingsSection === 'extensions'}
                {#if !extensionsLoaded}
                  <p class="text-sm text-base-content/45">Loading extensions…</p>
                {:else if extensionsList.length === 0 && extensionErrors.length === 0}
                  <p class="text-sm text-base-content/45">No extensions loaded.</p>
                {:else}
                  {#each ['user', 'project', 'temporary'] as scope (scope)}
                    {@const grouped = extensionsList.filter((e) => e.scope === scope)}
                    {#if grouped.length > 0}
                      <div class="mb-5">
                        <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wider mb-2">{scope}</p>
                        <div class="space-y-2">
                          {#each grouped as ext (ext.path)}
                            <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
                              <div class="divide-y divide-base-content/8">
                                <div class="px-4 py-3">
                                  <div class="flex items-center gap-2">
                                    <p class="text-sm font-medium text-base-content/80">{ext.source}</p>
                                    <span class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-base-content/10 text-base-content/45">{scope === 'user' ? 'User' : scope === 'project' ? 'Project' : 'Temporary'}</span>
                                  </div>
                                  <p class="mt-0.5 text-xs text-base-content/35 font-mono truncate" title={ext.path}>{ext.path}</p>
                                </div>
                                {#if ext.tools.length > 0}
                                  <details class="group px-4 py-2">
                                    <summary class="cursor-pointer text-xs font-medium text-base-content/55 hover:text-base-content/75 transition-colors list-none flex items-center gap-1.5">
                                      <ChevronRight class="w-3 h-3 transition-transform group-open:rotate-90" />
                                      Tools ({ext.tools.length})
                                    </summary>
                                    <div class="mt-1.5 ml-4 space-y-1">
                                      {#each ext.tools as tool (tool.name)}
                                        <div>
                                          <p class="text-xs text-base-content/70 font-mono">{tool.name}</p>
                                          {#if tool.description}
                                            <p class="text-[11px] text-base-content/40 leading-snug">{tool.description}</p>
                                          {/if}
                                        </div>
                                      {/each}
                                    </div>
                                  </details>
                                {/if}
                                {#if ext.commands.length > 0}
                                  <details class="group px-4 py-2">
                                    <summary class="cursor-pointer text-xs font-medium text-base-content/55 hover:text-base-content/75 transition-colors list-none flex items-center gap-1.5">
                                      <ChevronRight class="w-3 h-3 transition-transform group-open:rotate-90" />
                                      Commands ({ext.commands.length})
                                    </summary>
                                    <div class="mt-1.5 ml-4 space-y-1">
                                      {#each ext.commands as cmd (cmd.name)}
                                        <div>
                                          <p class="text-xs text-base-content/70 font-mono">/{cmd.name}</p>
                                          {#if cmd.description}
                                            <p class="text-[11px] text-base-content/40 leading-snug">{cmd.description}</p>
                                          {/if}
                                        </div>
                                      {/each}
                                    </div>
                                  </details>
                                {/if}
                                {#if ext.flags && ext.flags.length > 0}
                                  <div class="px-4 py-2 flex flex-wrap gap-1">
                                    {#each ext.flags as flag (flag)}
                                      <span class="px-1.5 py-0.5 text-[10px] font-mono rounded-full bg-primary/8 text-primary/60">{flag}</span>
                                    {/each}
                                  </div>
                                {/if}
                              </div>
                            </Card.Root>
                          {/each}
                        </div>
                      </div>
                    {/if}
                  {/each}
                  {#if extensionErrors.length > 0}
                    <details class="group">
                      <summary class="cursor-pointer text-xs font-medium text-error/70 hover:text-error transition-colors list-none flex items-center gap-1.5">
                        <ChevronRight class="w-3 h-3 transition-transform group-open:rotate-90" />
                        Errors ({extensionErrors.length})
                      </summary>
                      <div class="mt-2 space-y-1.5">
                        {#each extensionErrors as err (err.path)}
                          <div class="px-3 py-2 rounded-lg bg-error/8 border border-error/15">
                            <p class="text-xs text-error/80 font-mono break-all">{err.path}</p>
                            <p class="text-[11px] text-error/60 mt-0.5">{err.error}</p>
                          </div>
                        {/each}
                      </div>
                    </details>
                  {/if}
                {/if}
              {:else if settingsSection === 'updates'}
                <div class="space-y-4">
                  <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
                    <div class="divide-y divide-base-content/8">
                      <div class="flex items-center gap-3 px-4 py-3">
                        <div class="flex-1 min-w-0">
                          <p class="text-sm text-base-content/75">Update status</p>
                          <p class="text-xs text-base-content/35 mt-0.5">Checks npm for latest versions. Update actions run on the server.</p>
                        </div>
                        <button
                          onclick={refreshUpdateStatus}
                          disabled={wsState !== 'open' || updateLoading || updateRunning}
                          class="px-3 py-1.5 text-xs rounded-lg font-medium transition-colors {wsState === 'open' && !updateLoading && !updateRunning ? 'text-primary hover:bg-primary/10' : 'text-base-content/25 cursor-default'}"
                        >{updateLoading ? 'Checking…' : 'Check'}</button>
                      </div>

                      <div class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-base-content/8">
                        <div class="px-4 py-3 space-y-3">
                          <div>
                            <p class="text-xs text-base-content/35">pi-ui</p>
                            <p class="mt-1 text-sm text-base-content/75 font-mono">{versionText(updateStatus?.ui.current ?? uiVersion)}</p>
                            <p class="mt-0.5 text-xs text-base-content/40">Latest: {versionText(updateStatus?.ui.latest)}</p>
                            {#if updateStatus?.ui.error}
                              <p class="mt-1 text-xs text-warning/80">{updateStatus.ui.error}</p>
                            {:else if updateStatus?.ui.updateAvailable}
                              <p class="mt-1 text-xs text-success/80">Update available</p>
                            {:else if updateStatus?.ui.latest}
                              <p class="mt-1 text-xs text-base-content/35">Up to date</p>
                            {/if}
                          </div>
                          <button
                            onclick={() => runUpdate('ui')}
                            disabled={wsState !== 'open' || updateRunning || !updateStatus?.canUpdateUi}
                            class="w-full px-3 py-2 text-xs rounded-lg font-medium transition-colors {wsState === 'open' && !updateRunning && updateStatus?.canUpdateUi ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'bg-base-content/8 text-base-content/28 cursor-default'}"
                          >{updateRunning && updateTarget === 'ui' ? 'Updating pi-ui…' : 'Update pi-ui'}</button>
                          {#if updateStatus && !updateStatus.canUpdateUi}
                            <p class="text-[11px] text-base-content/35 leading-snug">This run is ephemeral; restart with the latest package instead.</p>
                          {/if}
                        </div>

                        <div class="px-4 py-3 space-y-3">
                          <div>
                            <p class="text-xs text-base-content/35">pi SDK</p>
                            <p class="mt-1 text-sm text-base-content/75 font-mono">{versionText(updateStatus?.sdk.current ?? piVersion)}</p>
                            <p class="mt-0.5 text-xs text-base-content/40">Latest: {versionText(updateStatus?.sdk.latest)}</p>
                            {#if updateStatus?.sdk.error}
                              <p class="mt-1 text-xs text-warning/80">{updateStatus.sdk.error}</p>
                            {:else if updateStatus?.sdk.updateAvailable}
                              <p class="mt-1 text-xs text-success/80">Update available</p>
                            {:else if updateStatus?.sdk.latest}
                              <p class="mt-1 text-xs text-base-content/35">Up to date</p>
                            {/if}
                          </div>
                          <button
                            onclick={() => runUpdate('sdk')}
                            disabled={wsState !== 'open' || updateRunning || !updateStatus?.canUpdateSdk}
                            class="w-full px-3 py-2 text-xs rounded-lg font-medium transition-colors {wsState === 'open' && !updateRunning && updateStatus?.canUpdateSdk ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'bg-base-content/8 text-base-content/28 cursor-default'}"
                          >{updateRunning && updateTarget === 'sdk' ? 'Updating SDK…' : 'Update SDK'}</button>
                          {#if updateStatus && !updateStatus.canUpdateSdk}
                            <p class="text-[11px] text-base-content/35 leading-snug">SDK-only updates are available from source checkouts only. Package installs update the SDK with pi-ui.</p>
                          {/if}
                        </div>
                      </div>

                      {#if updateStatus}
                        <div class="px-4 py-3 space-y-1.5">
                          <p class="text-xs text-base-content/35">App directory</p>
                          <p class="text-xs text-base-content/65 font-mono break-all">{updateStatus.appRoot}</p>
                          <p class="text-xs text-base-content/35">Mode: {updateStatus.mode === 'source' ? 'source checkout' : updateStatus.mode === 'ephemeral' ? 'ephemeral run' : 'package install'}</p>
                          {#if updateStatus.updateCommand}
                            <p class="text-xs text-base-content/35">Update command: <span class="font-mono text-base-content/60">{updateStatus.updateCommand}</span></p>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  </Card.Root>

                  {#if updateFeedback}
                    <Card.Root size="sm" class="py-0 overflow-hidden {updateFeedback.success ? 'bg-success/5 border-success/20' : 'bg-error/5 border-error/20'}">
                      <div class="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                        <div class="flex-1 min-w-0">
                          <p class="text-sm {updateFeedback.success ? 'text-success/85' : 'text-error/85'}">{updateFeedback.message}</p>
                          {#if updateFeedback.restartRequired}
                            <p class="text-xs text-base-content/40 mt-0.5">Restart is required before the new version is loaded.</p>
                          {/if}
                        </div>
                        {#if updateFeedback.restartRequired}
                          <button
                            onclick={() => restartServer(Boolean(updateFeedback?.reloadRequired))}
                            class="px-3 py-1.5 text-xs rounded-lg font-medium text-primary bg-primary/12 hover:bg-primary/20 transition-colors"
                          >{updateFeedback.reloadRequired ? 'Restart + reload' : 'Restart now'}</button>
                        {/if}
                      </div>
                    </Card.Root>
                  {/if}

                  {#if updateStatus?.notes.length}
                    <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/45 border-base-content/10">
                      <div class="px-4 py-3 space-y-1">
                        {#each updateStatus.notes as note (note)}
                          <p class="text-xs text-base-content/42 leading-snug">{note}</p>
                        {/each}
                      </div>
                    </Card.Root>
                  {/if}

                  {#if updateLog}
                    <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-base-content/10 bg-base-300/70 p-3 text-[11px] leading-relaxed text-base-content/60 font-mono">{updateLog}</pre>
                  {/if}
                </div>
              {:else}
                <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
                  <div class="divide-y divide-base-content/8">
                    <div class="px-4 py-3">
                      <p class="text-xs text-base-content/35 mb-2">Theme</p>
                      <div class="flex flex-wrap gap-1.5">
                        {#each THEMES as theme (theme.id)}
                          <button
                            onclick={() => setTheme(theme.id)}
                            class="px-2.5 py-1 text-xs rounded-lg border transition-colors {selectedTheme === theme.id ? 'border-primary/50 bg-primary/12 text-primary' : 'border-base-content/12 text-base-content/50 hover:text-base-content/75 hover:border-base-content/25'}"
                          >{theme.name}</button>
                        {/each}
                      </div>
                    </div>
                    <div class="px-4 py-3">
                      <p class="text-xs text-base-content/35">Working directory</p>
                      <p class="mt-1 text-xs text-base-content/65 font-mono break-all">{cwd || 'unknown'}</p>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-base-content/8">
                      <div class="px-4 py-3">
                        <p class="text-xs text-base-content/35">pi-ui</p>
                        <p class="mt-1 text-sm text-base-content/70 font-mono">{uiVersion ? `v${uiVersion}` : 'unknown'}</p>
                      </div>
                      <div class="px-4 py-3">
                        <p class="text-xs text-base-content/35">pi SDK</p>
                        <p class="mt-1 text-sm text-base-content/70 font-mono">{piVersion ? `v${piVersion}` : 'unknown'}</p>
                      </div>
                    </div>
                    <div class="flex items-center gap-3 px-4 py-3">
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-base-content/75">Restart server</p>
                        <p class="text-xs text-base-content/35 mt-0.5">Reconnects after the Bun process restarts.</p>
                      </div>
                      <button
                        onclick={() => restartServer()}
                        class="px-3 py-1.5 text-xs rounded-lg font-medium transition-colors {wsState === 'open' ? 'text-error/75 hover:text-error hover:bg-error/10' : 'text-base-content/25 cursor-default'}"
                        disabled={wsState !== 'open'}
                        aria-label="Restart server"
                      >Restart</button>
                    </div>
                  </div>
                </Card.Root>
              {/if}
            </div>
          </ScrollArea>
        </div>
      </div>
    </Dialog.Content>
</Dialog.Root>

<!-- ── Interactive custom component full overlay (ConversationViewer etc.) ── -->
{#if modal?.method === 'custom' && modal.interactive}
  <div
    class="fixed inset-0 z-[60] flex flex-col bg-base-100/95 backdrop-blur-sm"
    role="dialog"
    aria-label={modal.title}
    tabindex="-1"
    onkeydown={modalContentKeydown}
    bind:this={modalFocusEl}
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-base-content/10 shrink-0">
      <h2 class="text-sm font-semibold text-base-content/80 truncate">{modal.title}</h2>
      <button onclick={modalCancel} class="text-base-content/40 hover:text-base-content transition-colors p-1" aria-label="Close">
        <X class="w-4 h-4" />
      </button>
    </div>
    <!-- Scrollable content -->
    <div class="flex-1 overflow-y-auto px-4 py-3">
      <pre class="text-xs text-base-content/65 whitespace-pre-wrap leading-relaxed font-mono select-text">
            {#each modal.lines ?? [] as line, i (i)}
{line}
        {/each}
      </pre>
    </div>
    <!-- Footer hints -->
    <div class="shrink-0 px-4 py-2 border-t border-base-content/10 flex items-center justify-between text-[10px] text-muted-foreground/40">
      <span>↑↓ scroll · ↑↓ PgUp/Dn · Esc close</span>
      <span>{modal.lines?.length ?? 0} lines</span>
    </div>
  </div>
{/if}


</div>
</Tooltip.Provider>

<!-- ── Restarting overlay ───────────────────────────────────────────────────── -->
{#if isRestarting}
  <div class="aurora fixed inset-0 z-50 flex flex-col items-center justify-center bg-base-100/92 backdrop-blur-sm gap-4">
    <span class="pi-glyph pi-glyph-breathe text-6xl font-light leading-none select-none">π</span>
    <p class="font-mono text-base-content/70 text-sm">restarting server…</p>
    <p class="font-mono text-base-content/35 text-xs">reconnecting automatically</p>
  </div>
{/if}

<!-- ── Toast notifications ─────────────────────────────────────────────────── -->
{#if toasts.length > 0}
  <div
    class="fixed left-4 right-4 sm:left-auto z-50 flex flex-col items-stretch sm:items-end gap-2 pointer-events-none"
    style="bottom: calc(env(safe-area-inset-bottom, 0px) + 1rem);"
    aria-live="polite"
  >
    {#each toasts as toast (toast.id)}
      <div class="pointer-events-auto msg-in flex items-start gap-2.5 px-4 py-3 rounded-2xl text-sm sm:max-w-xs shadow-xl shadow-black/30 backdrop-blur-md border bg-base-200/92 text-base-content
        {toast.type === 'error' ? 'border-error/35' : toast.type === 'warning' ? 'border-warning/35' : 'border-base-content/12'}">
        <span class="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 {toast.type === 'error' ? 'bg-error' : toast.type === 'warning' ? 'bg-warning' : 'bg-primary'}"></span>
        <span class="flex-1 leading-relaxed">{toast.message}</span>
        <button onclick={() => dismissToast(toast.id)} class="shrink-0 text-base-content/40 hover:text-base-content transition-colors mt-0.5" aria-label="Dismiss"><X class="w-3.5 h-3.5" /></button>
      </div>
    {/each}
  </div>
{/if}

<!-- ── Extension UI modal ─────────────────────────────────────────────────────── -->
<Dialog.Root open={!!modal && !(modal.method === 'custom' && modal.interactive)} onOpenChange={(v) => { if (!v && modal) modalCancel(); }}>
  <Dialog.Content class="font-mono" showCloseButton={false} onkeydown={modalContentKeydown}>
    <Dialog.Header>
      <Dialog.Title>{modal?.title}</Dialog.Title>
      {#if modal?.method === 'confirm' && modal.message}
        <Dialog.Description class="whitespace-pre-wrap leading-relaxed">{modal.message}</Dialog.Description>
      {/if}
    </Dialog.Header>

    {#if modal?.method === 'input'}
      <input bind:this={modalFocusEl} type="text" bind:value={modalInput} placeholder={modal.placeholder ?? ''} class="w-full bg-transparent border-b border-border focus:border-foreground/60 outline-none py-2 text-sm placeholder-muted-foreground transition-colors" />
    {:else if modal?.method === 'select'}
      <div class="space-y-1 max-h-60 overflow-y-auto">
        {#each modal.options as opt (opt)}
          <button class="w-full text-left px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors" onclick={() => modalSelectOption(opt)}>{opt}</button>
        {/each}
      </div>
    {:else if modal?.method === 'editor'}
      <textarea bind:this={modalFocusEl} bind:value={modalInput} rows={8} class="w-full bg-transparent border border-border focus:border-foreground/60 outline-none p-3 text-sm leading-relaxed resize-none rounded-lg transition-colors"></textarea>
      {:else if modal?.method === 'custom' && modal.interactive}
        <!-- Interactive custom component (ConversationViewer etc.) — scrollable text overlay -->
        <div class="relative flex-1 min-h-0" role="region" aria-label="Interactive component content">
          <pre class="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed bg-base-content/5 rounded p-3 mb-2 max-h-[50vh] overflow-y-auto select-text font-mono" bind:this={modalFocusEl}>
        {#each modal.lines ?? [] as line, i (i)}
{line}
{/each}
          </pre>
          <p class="text-[10px] text-muted-foreground/40 text-center py-1">
            ↑↓ scroll · Esc close
          </p>
        </div>
      {:else if modal?.method === 'custom'}
      {#if modal.parsed?.kind === 'container'}
        {#snippet renderParsed(comp: ParsedComponent)}
          {#if comp.kind === 'select'}
            <div class="space-y-1 max-h-60 overflow-y-auto">
              {#each comp.options as opt (opt.value)}
                <button class="w-full text-left px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors" onclick={() => modalSelectOption(opt.value)}>
                  {opt.label}
                  {#if opt.description}
                    <span class="text-xs text-muted-foreground/60 ml-2">{opt.description}</span>
                  {/if}
                </button>
              {/each}
            </div>
          {:else if comp.kind === 'input'}
            <p class="text-sm text-muted-foreground mb-2">{comp.label || 'Enter your response:'}</p>
            {#if comp.multiline}
              <textarea bind:this={modalFocusEl} bind:value={modalInput} placeholder={comp.placeholder ?? ''} rows={6} class="w-full bg-transparent border border-border focus:border-foreground/60 outline-none p-3 text-sm leading-relaxed resize-none rounded-lg transition-colors"></textarea>
            {:else}
              <input bind:this={modalFocusEl} type="text" bind:value={modalInput} placeholder={comp.placeholder ?? ''} class="w-full bg-transparent border-b border-border focus:border-foreground/60 outline-none py-2 text-sm placeholder-muted-foreground transition-colors" />
            {/if}
          {:else if comp.kind === 'text'}
            <pre class="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed bg-base-content/5 rounded p-3 mb-2 max-h-48 overflow-y-auto">{comp.content}</pre>
          {:else if comp.kind === 'button'}
            <button class="w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-accent hover:text-accent-foreground transition-colors border border-border {comp.variant === 'primary' ? 'bg-primary/10 text-primary' : ''}" onclick={() => modalSelectOption(comp.label)}>{comp.label}</button>
          {:else if comp.kind === 'checkbox'}
            <div class="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <span class="w-4 h-4 rounded border {comp.checked ? 'bg-primary/20 border-primary' : 'border-border'} flex items-center justify-center text-xs">
                {#if comp.checked}<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5 9-9"/></svg>{/if}
              </span>
              <span>{comp.label}</span>
            </div>
          {:else if comp.kind === 'container'}
            <div class="flex flex-col gap-1 {comp.direction === 'horizontal' ? 'flex-row gap-3' : ''}">
              {#each comp.children as child (child.kind + (JSON.stringify(child)))}
                {@render renderParsed(child)}
              {/each}
            </div>
          {/if}
        {/snippet}

        {@render renderParsed(modal.parsed)}
        <input bind:this={modalFocusEl} type="text" bind:value={modalInput} placeholder="Type your response…" class="w-full bg-transparent border-b border-border focus:border-foreground/60 outline-none py-2 text-sm placeholder-muted-foreground transition-colors" />
      {:else if modal.parsed?.kind === 'select'}
        <p class="text-sm text-muted-foreground mb-2">{modal.parsed.label || 'Select an option:'}</p>
        <div class="space-y-1 max-h-60 overflow-y-auto">
          {#each modal.parsed.options as opt (opt.value)}
            <button class="w-full text-left px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors" onclick={() => modalSelectOption(opt.value)}>
              {opt.label}
              {#if opt.description}
                <span class="text-xs text-muted-foreground/60 ml-2">{opt.description}</span>
              {/if}
            </button>
          {/each}
        </div>
      {:else if modal.parsed?.kind === 'input'}
        <p class="text-sm text-muted-foreground mb-2">{modal.parsed.label || 'Enter your response:'}</p>
        {#if modal.parsed.multiline}
          <textarea bind:this={modalFocusEl} bind:value={modalInput} placeholder={modal.parsed.placeholder ?? ''} rows={6} class="w-full bg-transparent border border-border focus:border-foreground/60 outline-none p-3 text-sm leading-relaxed resize-none rounded-lg transition-colors"></textarea>
        {:else}
          <input bind:this={modalFocusEl} type="text" bind:value={modalInput} placeholder={modal.parsed.placeholder ?? ''} class="w-full bg-transparent border-b border-border focus:border-foreground/60 outline-none py-2 text-sm placeholder-muted-foreground transition-colors" />
        {/if}
      {:else if modal.parsed?.kind === 'text'}
        <pre class="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed bg-base-content/5 rounded p-3 mb-2 max-h-48 overflow-y-auto">{modal.parsed.content}</pre>
        <input bind:this={modalFocusEl} type="text" bind:value={modalInput} placeholder="Type your response…" class="w-full bg-transparent border-b border-border focus:border-foreground/60 outline-none py-2 text-sm placeholder-muted-foreground transition-colors" />
      {:else}
        <p class="text-sm text-muted-foreground mb-2">Extension request:</p>
        <input bind:this={modalFocusEl} type="text" bind:value={modalInput} placeholder="Type your response…" class="w-full bg-transparent border-b border-border focus:border-foreground/60 outline-none py-2 text-sm placeholder-muted-foreground transition-colors" />
      {/if}
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={modalCancel}>cancel</Button>
      {#if modal?.method === 'confirm'}
        <Button size="sm" onclick={() => modalConfirm(true)}>confirm</Button>
      {:else if modal?.method === 'input' || modal?.method === 'editor'}
        <Button size="sm" onclick={modalSubmitValue}>submit</Button>
      {:else if modal?.method === 'custom' && modal.parsed?.kind !== 'select' && !modal.interactive}
        <Button size="sm" onclick={modalSubmitValue}>submit</Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- ── Fork session dialog ─────────────────────────────────────────────────────── -->
<Dialog.Root bind:open={showForkDialog}>
  <Dialog.Content class="font-mono">
    <Dialog.Header>
      <Dialog.Title>Fork session</Dialog.Title>
      <Dialog.Description>Choose a user message to branch from. A new session will be created up to that point.</Dialog.Description>
    </Dialog.Header>

    {#if forkLoading}
      <div class="flex items-center justify-center py-6 text-muted-foreground text-sm gap-2">
        <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        loading…
      </div>
    {:else if forkPoints.length === 0}
      <p class="text-sm text-muted-foreground py-4 text-center">No user messages found in this session.</p>
    {:else}
      <div class="space-y-1 max-h-64 overflow-y-auto">
        {#each forkPoints as fp (fp.entryId)}
          <button
            onclick={() => forkAt(fp.entryId)}
            class="w-full text-left px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors leading-snug truncate"
            title={fp.text}
          >{fp.text || '(empty)'}</button>
        {/each}
      </div>
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={() => { showForkDialog = false; }}>cancel</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

{#snippet renderNode(nodes: TreeNode[], depth: number)}
  {#each nodes as node (node.entryId)}
    <div class="flex items-start gap-2" style="padding-left: {depth * 1.25}rem;">
      {#if node.children.length > 0}
        <span class="text-base-content/30 shrink-0 mt-0.5 select-none">
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M9 5l7 7-7 7"/></svg>
        </span>
      {:else}
        <span class="w-3 shrink-0"></span>
      {/if}
      <div class="min-w-0 flex-1 py-1.5">
        <div class="flex items-baseline gap-2">
          {#if node.role === 'user'}
            <span class="text-xs font-semibold text-info/80">user</span>
          {:else if node.role === 'assistant'}
            <span class="text-xs font-semibold text-success/80">assistant</span>
          {:else if node.role === 'toolResult'}
            <span class="text-xs font-semibold text-warning/80">tool</span>
          {:else}
            <span class="text-xs font-semibold text-base-content/40">{node.type}</span>
          {/if}
          {#if node.text}
            <span class="text-xs text-base-content/60 truncate">{node.text}</span>
          {:else if node.label}
            <span class="text-xs text-base-content/40 italic truncate">[{node.label}]</span>
          {:else}
            <span class="text-xs text-base-content/30 italic">(empty)</span>
          {/if}
        </div>
      </div>
    </div>
    {#if node.children.length > 0}
      {@render renderNode(node.children, depth + 1)}
    {/if}
  {/each}
{/snippet}

<!-- ── Session tree modal ──────────────────────────────────────────────────── -->
<Dialog.Root bind:open={showTreeModal}>
  <Dialog.Content class="font-mono max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Session tree</Dialog.Title>
      <Dialog.Description>Hierarchical view of the session branch structure.</Dialog.Description>
    </Dialog.Header>

    {#if treeLoading}
      <div class="flex items-center justify-center py-6 text-muted-foreground text-sm gap-2">
        <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        loading…
      </div>
    {:else if treeData.length === 0}
      <p class="text-sm text-muted-foreground py-4 text-center">Session tree is empty.</p>
    {:else}
      <div class="max-h-96 overflow-y-auto py-2 space-y-0.5">
        {@render renderNode(treeData, 0)}
      </div>
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={() => { showTreeModal = false; }}>close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<FileViewerModal
  open={fileViewerOpen}
  path={fileViewerPath}
  line={fileViewerLine}
  content={fileViewerContent}
  loading={fileViewerLoading}
  error={fileViewerError}
  saving={fileSaving}
  onclose={() => { fileViewerOpen = false; }}
  onsave={handleFileSave}
  oninsert={() => {
    const ref = fileViewerPath.includes('/') ? fileViewerPath.split('/').pop() ?? fileViewerPath : fileViewerPath;
    input = input + `@${ref} `;
    fileViewerOpen = false;
    tick().then(() => { autoResizeTextarea(); inputEl?.focus(); });
  }}
/>

<style>
  .trace-step {
    --trace-icon-col: 1.25rem;
    --trace-label-col: 5.75rem;
    --trace-gap: 0.5rem;
  }

  .trace-row {
    display: grid;
    grid-template-columns: var(--trace-icon-col) var(--trace-label-col) minmax(0, 1fr) auto;
    column-gap: var(--trace-gap);
    align-items: center;
    min-height: 1.5rem;
    padding: 0.125rem 0;
    font-size: 0.75rem;
    line-height: 1.25rem;
    color: color-mix(in oklch, var(--color-base-content) 56%, transparent);
  }

  .trace-row-toggle {
    border-radius: 0.625rem;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .trace-row-toggle:hover {
    background: color-mix(in oklch, var(--color-base-content) 5%, transparent);
  }

  .trace-row-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    justify-self: center;
    width: 1rem;
    height: 1rem;
  }

  .trace-row-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    color: color-mix(in oklch, var(--color-base-content) 72%, transparent);
  }

  .trace-row-detail {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: color-mix(in oklch, var(--color-base-content) 52%, transparent);
  }

  .trace-row-meta {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.375rem;
    min-width: max-content;
    color: color-mix(in oklch, var(--color-base-content) 42%, transparent);
  }

  .trace-body,
  .trace-meta,
  .trace-output {
    margin-left: calc(var(--trace-icon-col) + var(--trace-gap));
  }

  .trace-output {
    padding-left: 0.75rem;
    border-left: 1px solid color-mix(in oklch, var(--color-base-content) 12%, transparent);
  }

  @media (max-width: 639px) {
    .trace-step {
      --trace-label-col: 4.5rem;
    }
  }

  /* ── Trace cluster two-level spacing ────────────────────────────────
   * Thinking and tool messages form a flat DOM sequence.  Adjacent
   * selectors create the grouped rhythm: tight inside a reasoning step,
   * wider between steps, and a large gap before the main answer body.
   *
   *  .asst-step  – assistant message (may contain thinking + body)
   *  .tool-step  – tool call
   *
   *  Relationship                         Gap
   *  ──────────────────────────────       ─────
   *  asst-step + tool-step                 6px  (thinking → its tool)
   *  tool-step + tool-step                 8px  (tool → next tool)
   *  tool-step + asst-step                16px  (new reasoning group)
   *  asst-step + asst-step                16px  (consecutive assistant)
   *  (inside asst-step: expanded thinking → body via mb-5 = 20px)
   *  (inside asst-step: collapsed thinking → body via 0 — toggle is unobtrusive)
   ─────────────────────────────────────────────────────────────────── */
  .tool-step {
    margin-bottom: 0.375rem; /* 6px — tight intra-cluster when followed by another tool */
  }
  .tool-step + .asst-step {
    margin-top: 0.625rem; /* 10px — medium gap to next reasoning group */
  }
  .asst-step + .tool-step {
    margin-top: 0;
  }
  .asst-step + .asst-step {
    margin-top: 1rem; /* 16px — between consecutive assistant messages */
  }
</style>
