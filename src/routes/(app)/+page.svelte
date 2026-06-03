<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';

  import type { ServerMessage, ClientMessage, ModelInfo, ProviderInfo, SessionSummary, SkillSummary, PromptSummary } from '$lib/ws/protocol';
  import { renderMarkdown, highlightCode } from '$lib/markdown';
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
    const desc = toolsList.find((t) => t.name.toLowerCase() === key)?.description;

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

  type MsgUsage = {
    input: number;
    output: number;
    totalTokens: number;
    cost: { total: number };
  };

  type UIMessage = {
    id: string;
    role: 'user' | 'assistant' | 'tool' | 'notice';
    content: string;
    /** Data-URL images attached to a user message */
    images?: string[];
    /** Brief label shown while streaming or collapsed (e.g. "$ git status") */
    toolInput?: string;
    /** Raw args object from tool_execution_start — used for unknown tool heuristics */
    toolArgs?: Record<string, unknown>;
    /** SDK toolCallId — used to match start/update/end events */
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    streaming: boolean;
    /** Whether the tool output block is expanded (collapsed by default) */
    expanded?: boolean;
    /** Unified diff string (edit tool only) — rendered with coloring when expanded */
    diff?: string;
    /** Number of output lines — shown in collapsed header */
    lineCount?: number;
    /** Token/cost usage attached when message_end fires */
    usage?: MsgUsage;
    /** Accumulated thinking text (assistant messages only) */
    thinking?: string;
    /** Whether the thinking block is expanded */
    thinkingExpanded?: boolean;
    /** Unix ms when message_start fired (live streaming only) */
    startMs?: number;
    /** Unix ms when message_end fired (live streaming only) */
    endMs?: number;
    /** Unix ms when first thinking_delta arrived (live streaming only) */
    thinkingStartMs?: number;
    /** Whether the per-message detail panel (tokens / cost / latency) is expanded */
    detailExpanded?: boolean;
    /** Category of inline system notice */
    noticeKind?: 'compaction' | 'retry';
  };

  // ── Extension UI modal state ─────────────────────────────────────────────────

  type ModalState =
    | { method: 'confirm'; id: string; title: string; message: string }
    | { method: 'input'; id: string; title: string; placeholder?: string }
    | { method: 'select'; id: string; title: string; options: string[] }
    | { method: 'editor'; id: string; title: string; prefill?: string };

  let modal = $state<ModalState | null>(null);
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

  function openFileViewer(path: string, line?: number) {
    fileViewerPath = path;
    fileViewerLine = line;
    fileViewerOpen = true;
    fileViewerContent = '';
    fileViewerError = null;
    fileViewerLoading = true;
    send({ type: 'read_file', path });
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
  let input = $state('');
  /** Images staged for the next prompt (base64 data + display src). */
  let attachedImages = $state<Array<{ data: string; mimeType: string; name: string; src: string }>>([]);
  let fileInputEl = $state<HTMLInputElement | undefined>(undefined);

  // ── Extension UI state ───────────────────────────────────────────────────────

  type Toast = { id: string; message: string; type: 'info' | 'warning' | 'error' };
  let toasts = $state<Toast[]>([]);
  /** Keyed status texts from extension setStatus() calls. */
  let extensionStatuses = $state<Record<string, string>>({});
  /** Keyed widget panels from extension setWidget() calls. */
  let extensionWidgets = $state<Record<string, string[]>>({});
  /** Custom working message from extension setWorkingMessage() calls. */
  let workingMessage = $state<string | undefined>(undefined);
  /** Whether the streaming working indicator is visible (setWorkingVisible). */
  let workingVisible = $state(true);
  /** Label shown for collapsed thinking blocks (setHiddenThinkingLabel). */
  let hiddenThinkingLabel = $state('thinking');
  /** Global tool output expansion state (setToolsExpanded). */
  let toolsExpandedGlobal = $state(false);
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
  const filteredSlashCommands = $derived.by<ComposerShortcut[]>(() => {
    if (!shortcutTrigger) return [];
    const q = shortcutQuery;
    const match = (value: string) => value.toLowerCase().includes(q);

    if (shortcutTrigger === '/') {
      const commands = SLASH_COMMANDS
        .filter((c) => !q || c.name.startsWith(q))
        .map((c) => ({ trigger: '/' as const, label: `/${c.name}`, description: c.description, insert: `/${c.name} ` }));
      const skills = resourcesSkills
        .filter((s) => !q || match(s.name) || match(s.description))
        .slice(0, 8)
        .map((s) => ({ trigger: '/' as const, label: `/skill:${s.name}`, description: s.description || `${s.scope} skill`, insert: `/skill:${s.name} `, muted: s.isBuiltin }));
      const prompts = resourcesPrompts
        .filter((p) => !q || match(p.name) || match(p.description))
        .slice(0, 8)
        .map((p) => ({ trigger: '/' as const, label: `/${p.name}`, description: p.description || p.argumentHint || `${p.scope} prompt`, insert: `/${p.name} `, muted: p.isBuiltin }));
      return [...commands, ...skills, ...prompts].slice(0, 14);
    }

    if (shortcutTrigger === '@') {
      const refs = [
        ...fileCompletions.map((path) => ({ label: `@${path}`, description: 'workspace file', insert: `@${path} ` })),
        ...(cwd ? [{ label: '@current', description: cwd, insert: `@${cwd} ` }] : []),
        ...projects.map((p) => ({ label: `@${p.basename}`, description: p.cwd, insert: `@${p.cwd} ` })),
        ...allSessions.slice(0, 24).map((s) => ({
          label: `@${s.name || s.firstMessage || '(empty)'}`,
          description: s.cwd,
          insert: `@${s.path} `,
        })),
      ];
      return refs
        .filter((r) => !q || match(r.label) || match(r.description))
        .slice(0, 12)
        .map((r) => ({ trigger: '@' as const, ...r }));
    }

    if (shortcutTrigger === '!') {
      return SHELL_SHORTCUTS
        .filter((s) => !q || match(s.label) || match(s.description) || match(s.insert))
        .map((s) => ({ trigger: '!' as const, ...s }));
    }

    return [
      ...SNIPPET_SHORTCUTS,
      ...resourcesPrompts.map((p) => ({ label: p.name, description: p.description || p.argumentHint || `${p.scope} prompt`, insert: `#${p.name} `, muted: p.isBuiltin })),
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
  /** Most recent input token count (from message_end) — used for context % */
  let lastInputTokens = $state(0);
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
  /** TTS: whether to auto-speak each assistant response. */
  let autoSpeak = $state(false);
  /** TTS: true while speechSynthesis is playing. */
  let isSpeaking = $state(false);
  /** TTS: ID of the message currently being spoken (null = none). */
  let speakingMsgId = $state<string | null>(null);
  /** TTS: true while waiting for an LLM-generated summary from the server. */
  let isSummarizing = $state(false);
  /** ID of the most-recent assistant message — used to target the summarising spinner. */
  const lastAsstId = $derived([...messages].reverse().find((m) => m.role === 'assistant')?.id ?? null);
  /** STT: true while SpeechRecognition is active. */
  let isRecording = $state(false);
  /** STT: active SpeechRecognition instance (not reactive — plain ref). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let speechRec: { stop(): void } | null = null;
  /** STT: true when the user manually stopped recording (so onend does NOT auto-submit). */
  let sttManualStop = false;
  /**
   * Conversation mode: when on, the mic auto-restarts after each TTS response so the
   * user can speak → send → listen → speak again without touching the UI.
   * Implies autoSpeak = true while active.
   */
  let conversationMode = $state(false);

  /** Browser TTS settings exposed in the settings modal. */
  let speechVoices = $state<SpeechSynthesisVoice[]>([]);
  let selectedVoiceURI = $state('');
  let speechRate = $state(1);
  let speechPitch = $state(1);

  // ── Panel state ──────────────────────────────────────────────────────────────

  let showRightPanel = $state(false);
  let rightPanelTab = $state<'models' | 'tools' | 'skills'>('models');
  let showSessionPanel = $state(false);

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
  /** Filter text for sessions list */
  let sessionFilter = $state('');
  /** Path of the session currently being renamed inline (null = none) */
  let renamingPath = $state<string | null>(null);
  /** Draft name for inline rename */
  let renameDraft = $state('');
  /** Error from rename/delete operations */
  let sessionError = $state<string | null>(null);
  /** Collapsed directory cwds in the session sidebar tree. */
  let collapsedDirs = $state<Set<string>>(new Set());
  /** Project groups whose full session list is visible. */
  let expandedSessionGroups = $state<Set<string>>(new Set());
  /** Session IDs that have unchecked/unseen results since last switch. */
  let uncheckedSessions = $state<Set<string>>(new Set());
  /** All sessions across all projects (from get_all_sessions). */
  let allSessions = $state<SessionSummary[]>([]);
  /** Whether the open-folder path input is visible in the sidebar footer. */
  let openFolderMode = $state(false);
  /** Text typed in the open-folder input. */
  let openFolderInput = $state('');
  /** Directory completions returned by the server for openFolderInput. */
  let dirCompletions = $state<string[]>([]);
  /** Workspace file completions shown for composer @ references. */
  let fileCompletions = $state<string[]>([]);
  let lastFileCompleteQuery = '';

  interface ProjectGroup { cwd: string; basename: string; sessions: SessionSummary[]; lastModified: number; }

  const SESSION_PREVIEW_LIMIT = 5;

  const SETTINGS_SECTIONS = [
    { id: 'session', label: 'Session', icon: '◐' },
    { id: 'voice', label: 'Voice', icon: '◌' },
    { id: 'shortcuts', label: 'Shortcuts', icon: '⌘' },
    { id: 'about', label: 'About', icon: 'π' },
  ] as const;

  const SHORTCUTS = [
    { keys: 'Ctrl / Cmd + /', action: 'Toggle sessions' },
    { keys: 'Ctrl / Cmd + K', action: 'Toggle model picker' },
    { keys: 'Escape', action: 'Close modal or panel' },
    { keys: 'Enter', action: 'Send from composer' },
    { keys: 'Shift + Enter', action: 'New line in composer' },
    { keys: '/', action: 'Open slash menu' },
    { keys: '@', action: 'Attach file context' },
  ];

  /** allSessions grouped by cwd, sorted by most-recently-modified first. */
  const projects = $derived.by<ProjectGroup[]>(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const s of allSessions) {
      const key = s.cwd ?? '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return [...map.entries()]
      .map(([c, ss]) => ({
        cwd: c,
        basename: c.split('/').filter(Boolean).pop() ?? c,
        sessions: ss,
        lastModified: Math.max(...ss.map((s) => s.modified)),
      }))
      .sort((a, b) => b.lastModified - a.lastModified);
  });

  /** Filtered project tree for the sidebar — inline hierarchy with collapsible dirs. */
  const filteredTree = $derived.by(() => {
    const q = sessionFilter.trim().toLowerCase();
    return projects
      .map((p) => ({
        cwd: p.cwd,
        basename: p.basename,
        lastModified: p.lastModified,
        streaming: isStreaming && p.cwd === cwd,
        sessions: p.sessions.filter(
          (s) =>
            !q ||
            (s.name ?? '').toLowerCase().includes(q) ||
            (s.firstMessage ?? '').toLowerCase().includes(q) ||
            p.basename.toLowerCase().includes(q)
        ),
      }))
      .filter((p) => !q || p.sessions.length > 0 || p.basename.toLowerCase().includes(q));
  });

  /** All tools reported by the server */
  let toolsList = $state<{ name: string; description: string; isBuiltin: boolean }[]>([]);
  /** Names of currently active/enabled tools */
  let activeToolNames = $state<string[]>([]);

  /** Whether the settings modal is open */
  let showSettingsPanel = $state(false);
  let settingsSection = $state<'session' | 'voice' | 'shortcuts' | 'about'>('session');
  /** Skills returned by the server */
  let resourcesSkills = $state<SkillSummary[]>([]);
  /** Prompt templates returned by the server */
  let resourcesPrompts = $state<PromptSummary[]>([]);
  /** True once resources_list has been received (distinguishes "loading" from "empty") */
  let resourcesLoaded = $state(false);
  /** Install skill form state */
  let skillInstallUrl = $state('');
  let skillInstallScope = $state<'project' | 'user'>('user');
  let skillInstalling = $state(false);
  let skillInstallFeedback = $state<{ success: boolean; message: string } | null>(null);

  /** Whether the footer session name is in inline-edit mode */
  let isEditingSessionName = $state(false);
  /** Draft value for inline session name edit */
  let sessionNameDraft = $state('');

  /** Which tab is active inside the model picker panel */
  let modelTab = $state<'models' | 'providers'>('models');
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
  /** Context window fill percentage (0 if unknown) */
  const contextPercent = $derived(
    model?.contextWindow && model.contextWindow > 0 && lastInputTokens > 0
      ? Math.round((lastInputTokens / model.contextWindow) * 100)
      : 0
  );
  /** Basename of cwd for compact display */
  const cwdBasename = $derived(cwd ? cwd.split('/').filter(Boolean).pop() ?? cwd : '');

  // ── Derived ──────────────────────────────────────────────────────────────────

  const modelsByProvider = $derived.by(() => {
    const map = new Map<string, ModelInfo[]>();
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
  let sendHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let sendHoldSubmitted = false;
  /** True when the scroll container is at (or near) the bottom */
  let isAtBottom = $state(true);
  /** The message id whose copy action is in the "copied" confirmation state */
  let copiedId = $state<string | null>(null);

  // ── Load sessions when panel opens ───────────────────────────────────────────

  $effect(() => {
    if (showSessionPanel) {
      send({ type: 'list_sessions' });
      send({ type: 'get_all_sessions' });
    }
  });

  // ── Request dir completions as user types open-folder path ───────────────────

  $effect(() => {
    if (openFolderMode && openFolderInput.trim()) {
      send({ type: 'dir_complete', prefix: openFolderInput });
    } else {
      dirCompletions = [];
    }
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

  // ── WebSocket ───────────────────────────────────────────────────────────────

  function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsState = 'connecting';

    ws.onopen = () => {
      wsState = 'open';
      isRestarting = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };

    ws.onmessage = ({ data }: MessageEvent<string>) => {
      try {
        handleServer(JSON.parse(data) as ServerMessage);
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = () => {
      wsState = 'closed';
      reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws?.close();
  }

  function send(msg: ClientMessage) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ── Server event handling ────────────────────────────────────────────────────

  function applySessionState(payload: {
    sessionId: string;
    isStreaming: boolean;
    thinkingLevel: string;
    model: ModelInfo | null;
    availableModels: ModelInfo[];
    messages: unknown[];
    cwd?: string;
    sessionName?: string;
  }) {
    sessionId = payload.sessionId;
    isStreaming = payload.isStreaming;
    thinkingLevel = payload.thinkingLevel;
    model = payload.model;
    availableModels = payload.availableModels ?? [];
    // Build a map of toolCallId → { name, input } from assistant content blocks
    // so replayed toolResult messages can show their input args.
    const toolInputMap = new Map<string, { name: string; input: Record<string, unknown> }>();
    for (const m of payload.messages ?? []) {
      const raw = m as Record<string, unknown>;
      if (raw.role === 'assistant' && Array.isArray(raw.content)) {
        for (const blk of raw.content as { type: string; id?: string; name?: string; input?: Record<string, unknown>; arguments?: Record<string, unknown> }[]) {
          // pi SDK uses type "toolCall" + "arguments"; Anthropic-style uses "tool_use" + "input"
          const isToolCall = (blk.type === 'toolCall' || blk.type === 'tool_use') && blk.id && blk.name;
          if (isToolCall) {
            toolInputMap.set(blk.id!, { name: blk.name!, input: blk.arguments ?? blk.input ?? {} });
          }
        }
      }
    }
    messages = (payload.messages ?? []).flatMap((m) => agentMsgToUI(m, toolInputMap)).filter(Boolean) as UIMessage[];
    if (payload.cwd) cwd = payload.cwd;
    sessionName = payload.sessionName;
    // Reset queue on session switch
    queuedSteering = [];
    queuedFollowUp = [];
    // Restore lastInputTokens from the most recent assistant message that has usage data,
    // so the ctx indicator re-appears immediately after a hard refresh / session switch.
    {
      const msgs = (payload.messages ?? []) as Record<string, unknown>[];
      let restored = 0;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const raw = msgs[i];
        const inp = (raw.usage as Record<string, unknown> | undefined)?.input;
        if (raw.role === 'assistant' && typeof inp === 'number' && inp > 0) {
          restored = inp;
          break;
        }
      }
      lastInputTokens = restored;
    }
    // Session-level settings (optional — present on connected/session_loaded)
    if ('isCompacting' in payload) isCompacting = Boolean((payload as Record<string, unknown>).isCompacting);
    if ('autoCompactionEnabled' in payload) autoCompactionEnabled = Boolean((payload as Record<string, unknown>).autoCompactionEnabled ?? true);
    if ('autoRetryEnabled' in payload) autoRetryEnabled = Boolean((payload as Record<string, unknown>).autoRetryEnabled ?? true);
  }

  function handleServer(msg: ServerMessage) {
    switch (msg.type) {
      case 'connected': {
        const c = msg as import('$lib/ws/protocol').ConnectedMessage;
        applySessionState({
          sessionId: c.sessionId,
          isStreaming: c.isStreaming,
          thinkingLevel: c.thinkingLevel,
          model: c.model,
          availableModels: c.availableModels,
          messages: c.messages,
          cwd: c.cwd,
          sessionName: c.sessionName,
        });
        if (c.piVersion) piVersion = c.piVersion;
        if (c.uiVersion) uiVersion = c.uiVersion;
        break;
      }

      case 'session_loaded': {
        const sl = msg as {
          type: string;
          sessionId: string;
          isStreaming: boolean;
          thinkingLevel: string;
          model: ModelInfo | null;
          availableModels: ModelInfo[];
          messages: unknown[];
          piVersion?: string;
          uiVersion?: string;
        };
        applySessionState(sl);
        if (sl.piVersion) piVersion = sl.piVersion;
        if (sl.uiVersion) uiVersion = sl.uiVersion;
        break;
      }

      case 'model_changed': {
        model = (msg as { type: string; model: ModelInfo | null }).model ?? null;
        break;
      }

      case 'thinking_level_changed': {
        thinkingLevel = (msg as { type: string; level: string }).level ?? thinkingLevel;
        break;
      }

      case 'sessions_list': {
        const listedSessions = ((msg as { type: string; sessions: SessionSummary[] }).sessions) ?? [];
        if (allSessions.length === 0) allSessions = listedSessions;
        sessionError = null;
        renamingPath = null;
        break;
      }

      case 'sessions_error': {
        sessionError = (msg as { type: string; message: string }).message ?? 'Unknown error';
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
        availableModels = (msg as { type: string; availableModels: ModelInfo[] }).availableModels ?? [];
        break;
      }

      case 'agent_start':
        isStreaming = true;
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
        sealStreaming();
        if (sessionId) {
          const next = new Set(uncheckedSessions);
          next.add(sessionId);
          uncheckedSessions = next;
        }
        // Auto-speak: request an LLM-generated summary from the server;
        // the tts_summary response handler will call speakText() with the result.
        // Skip if pi is about to retry (willRetry=true) — we'll speak the final response instead.
        if (autoSpeak && !willRetry) {
          const lastAsst = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
          if (lastAsst) {
            isSummarizing = true;
            send({ type: 'summarize_for_tts', content: lastAsst.content });
          } else if (conversationMode && wsState === 'open') {
            // No content to summarise (e.g. empty turn) — restart STT directly
            toggleSTT();
          }
        } else if (conversationMode && !willRetry && wsState === 'open') {
          // autoSpeak is off but conversation mode is on: restart STT directly after response
          toggleSTT();
        }
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
        const endMsg = msg.message as { role?: string; usage?: { input: number; output: number; totalTokens: number; cost: { total: number } } } | undefined;
        if (endMsg?.role === 'assistant' && endMsg.usage) {
          const a = lastStreaming('assistant');
          if (a) {
            a.usage = {
              input: endMsg.usage.input,
              output: endMsg.usage.output,
              totalTokens: endMsg.usage.totalTokens,
              cost: { total: endMsg.usage.cost?.total ?? 0 },
            };
            a.endMs = Date.now();
            a.streaming = false;
          }
          // Track latest input token count for context % display
          lastInputTokens = endMsg.usage.input;
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
            content?: { type: string; text?: string }[];
            details?: { diff?: string; patch?: string };
          } | undefined;
          if (result?.content) {
            t.content = extractTextContent(result.content);
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
        switch (method) {
          case 'confirm':
            modal = {
              method: 'confirm',
              id,
              title: (msg.title as string | undefined) ?? 'Confirm',
              message: (msg.message as string | undefined) ?? '',
            };
            modalInput = '';
            break;

          case 'input':
            modal = {
              method: 'input',
              id,
              title: (msg.title as string | undefined) ?? 'Input',
              placeholder: msg.placeholder as string | undefined,
            };
            modalInput = '';
            break;

          case 'select':
            modal = {
              method: 'select',
              id,
              title: (msg.title as string | undefined) ?? 'Select',
              options: (msg.options as string[] | undefined) ?? [],
            };
            modalInput = '';
            break;

          case 'editor':
            modal = {
              method: 'editor',
              id,
              title: (msg.title as string | undefined) ?? 'Editor',
              prefill: msg.prefill as string | undefined,
            };
            modalInput = (msg.prefill as string | undefined) ?? '';
            break;

          case 'notify':
            addToast(
              (msg.message as string | undefined) ?? '',
              (msg.notifyType as Toast['type'] | undefined) ?? 'info'
            );
            break;

          case 'setStatus': {
            const key = msg.statusKey as string | undefined;
            const text = msg.statusText as string | undefined;
            if (key) {
              if (text == null) {
                delete extensionStatuses[key];
              } else {
                extensionStatuses[key] = text;
              }
            }
            break;
          }

          case 'setWidget': {
            const key = msg.widgetKey as string | undefined;
            const lines = msg.widgetLines as string[] | undefined;
            if (key) {
              if (lines == null) {
                delete extensionWidgets[key];
              } else {
                extensionWidgets[key] = lines;
              }
            }
            break;
          }

          case 'setTitle':
            document.title = (msg.title as string | undefined) ?? 'pi';
            break;

          case 'set_editor_text':
            input = (msg.text as string | undefined) ?? '';
            tick().then(() => { autoResizeTextarea(); inputEl?.focus(); });
            break;

          case 'setWorkingMessage':
            workingMessage = (msg.message as string | undefined) ?? undefined;
            break;

          case 'setWorkingVisible':
            workingVisible = (msg.visible as boolean | undefined) ?? true;
            break;

          case 'setWorkingIndicator':
            // No-op: web UI uses CSS animations; frames/intervalMs are TUI-only.
            break;

          case 'setHiddenThinkingLabel':
            hiddenThinkingLabel = (msg.label as string | undefined) ?? 'thinking';
            break;

          case 'setToolsExpanded': {
            const exp = (msg.expanded as boolean | undefined) ?? false;
            toolsExpandedGlobal = exp;
            // Apply retroactively to all existing tool messages.
            for (const m of messages) {
              if (m.role === 'tool' && !m.streaming) m.expanded = exp;
            }
            break;
          }

          default:
            break;
        }
        break;
      }

      case 'queue_update': {
        queuedSteering = (msg.steering as string[] | undefined) ?? [];
        queuedFollowUp = (msg.followUp as string[] | undefined) ?? [];
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

      case 'all_sessions_list': {
        allSessions = ((msg as { type: string; sessions: SessionSummary[] }).sessions) ?? [];
        break;
      }

      case 'dir_completions': {
        dirCompletions = ((msg as { type: string; entries: string[] }).entries) ?? [];
        break;
      }

      case 'file_completions': {
        const fileMsg = msg as { type: string; query: string; entries: string[] };
        if (fileMsg.query === shortcutQuery) fileCompletions = fileMsg.entries ?? [];
        break;
      }

      case 'slash_result': {
        const result = msg as { type: 'slash_result'; command: string; message: string; level?: 'info' | 'warning' | 'error' };
        messages.push({
          id: uid(),
          role: 'notice',
          content: result.message,
          noticeKind: result.level === 'error' ? 'retry' : undefined,
          streaming: false,
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

      case 'server_restarting': {
        isRestarting = true;
        break;
      }

      case 'tts_summary': {
        isSummarizing = false;
        const summaryText = (msg as { type: 'tts_summary'; text: string }).text;
        const lastAsst = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
        if (summaryText) {
          // Speak the LLM-generated summary, attributed to the last assistant message
          speakText(summaryText, lastAsst?.id ?? null);
        } else if (lastAsst) {
          // Fallback: speak stripped raw content if summarisation failed/timed out
          speakText(stripMarkdown(lastAsst.content ?? ''), lastAsst.id);
        }
        break;
      }
    }

    scrollBottom();
  }

  // ── Modal actions ────────────────────────────────────────────────────────────

  function modalConfirm(confirmed: boolean) {
    if (!modal) return;
    send({ type: 'extension_ui_response', id: modal.id, confirmed });
    modal = null;
  }

  function modalSubmitValue() {
    if (!modal) return;
    send({ type: 'extension_ui_response', id: modal.id, value: modalInput });
    modal = null;
    modalInput = '';
  }

  function modalSelectOption(value: string) {
    if (!modal) return;
    send({ type: 'extension_ui_response', id: modal.id, value });
    modal = null;
  }

  function modalCancel() {
    if (!modal) return;
    send({ type: 'extension_ui_response', id: modal.id, cancelled: true });
    modal = null;
    modalInput = '';
  }

  function modalKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      modalCancel();
    }
    if (e.key === 'Enter' && !e.shiftKey && modal?.method !== 'editor') {
      e.preventDefault();
      if (modal?.method === 'confirm') modalConfirm(true);
      else if (modal?.method === 'input') modalSubmitValue();
    }
  }

  /** Handles Enter key inside the shadcn Dialog content (Escape is handled by onOpenChange). */
  function modalContentKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && modal?.method !== 'editor') {
      e.preventDefault();
      if (modal?.method === 'confirm') modalConfirm(true);
      else if (modal?.method === 'input') modalSubmitValue();
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

  function switchSession(path: string) {
    send({ type: 'switch_session', path });
    showSessionPanel = false;
    // Clear unchecked for the session we're switching to
    const s = allSessions.find((s) => s.path === path);
    if (s && uncheckedSessions.has(s.id)) {
      const next = new Set(uncheckedSessions);
      next.delete(s.id);
      uncheckedSessions = next;
    }
  }

  function newSession(targetCwd?: string) {
    send(targetCwd ? { type: 'new_session', targetCwd } : { type: 'new_session' });
    showSessionPanel = false;
    openFolderMode = false;
    openFolderInput = '';
    dirCompletions = [];
  }

  function startRename(s: SessionSummary) {
    renameDraft = s.name ?? '';
    renamingPath = s.path;
  }

  function commitRename() {
    if (!renamingPath) return;
    const name = renameDraft.trim();
    if (name) send({ type: 'rename_session', path: renamingPath, name });
    renamingPath = null;
    renameDraft = '';
  }

  function cancelRename() {
    renamingPath = null;
    renameDraft = '';
  }

  function deleteSession(path: string) {
    send({ type: 'delete_session', path });
  }

  function toggleDir(cwd: string) {
    const next = new Set(collapsedDirs);
    if (next.has(cwd)) next.delete(cwd);
    else next.add(cwd);
    collapsedDirs = next;
  }

  function toggleSessionGroup(cwd: string) {
    const next = new Set(expandedSessionGroups);
    if (next.has(cwd)) next.delete(cwd);
    else next.add(cwd);
    expandedSessionGroups = next;
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

  function visibleSessions(p: ProjectGroup): SessionSummary[] {
    return expandedSessionGroups.has(p.cwd) ? p.sessions : p.sessions.slice(0, SESSION_PREVIEW_LIMIT);
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

  function formatDate(ms: number): string {
    const diff = Date.now() - ms;
    const min = 60_000;
    const hour = 3_600_000;
    const day = 86_400_000;
    if (diff < 2 * min) return 'just now';
    if (diff < hour) return `${Math.floor(diff / min)}m ago`;
    if (diff < day) return `${Math.floor(diff / hour)}h ago`;
    if (diff < 2 * day) return 'yesterday';
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

  function refreshSpeechVoices() {
    if (!('speechSynthesis' in window)) return;
    speechVoices = window.speechSynthesis.getVoices();
    if (!selectedVoiceURI && speechVoices[0]) selectedVoiceURI = speechVoices[0].voiceURI;
  }

  function selectedVoice(): SpeechSynthesisVoice | undefined {
    return speechVoices.find((v) => v.voiceURI === selectedVoiceURI);
  }

  // ── Message helpers ──────────────────────────────────────────────────────────

  function uid() {
    return crypto.randomUUID();
  }

  function freshAssistant(): UIMessage {
    return { id: uid(), role: 'assistant', content: '', thinking: '', thinkingExpanded: false, streaming: true, startMs: Date.now() };
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

  function extractTextContent(blocks: { type: string; text?: string }[]): string {
    return blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }

  function formatToolInput(toolName: string, details?: Record<string, unknown>): string | undefined {
    if (!details) return undefined;
    const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
    const num = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined;

    if (toolName === 'bash' || toolName === 'execute_bash') {
      const cmd = str(details.command);
      if (cmd) return `$ ${cmd.split('\n')[0].trim()}`;
    }
    if (toolName === 'read' || toolName === 'read_file') {
      const p = str(details.path ?? details.file_path ?? details.file);
      if (!p) return undefined;
      const basename = p.split('/').pop() ?? p;
      const offset = num(details.offset);
      const limit = num(details.limit);
      if (offset !== undefined) {
        const end = limit !== undefined ? offset + limit - 1 : '';
        return `${basename}:${offset}${end ? `–${end}` : '+'}`;
      }
      return basename;
    }
    if (toolName === 'write' || toolName === 'write_file') {
      const p = str(details.path ?? details.file_path ?? details.file);
      return p ? p.split('/').pop() ?? p : undefined;
    }
    if (toolName === 'edit') {
      const p = str(details.path ?? details.file_path ?? details.file);
      const basename = p ? p.split('/').pop() ?? p : undefined;
      const edits = Array.isArray(details.edits) ? details.edits.length : undefined;
      if (basename && edits !== undefined && edits > 1) return `${basename} (${edits} edits)`;
      return basename;
    }
    if (toolName === 'grep') {
      const pattern = str(details.pattern);
      const path = str(details.path);
      const glob = str(details.glob);
      if (!pattern) return undefined;
      const loc = (path ?? glob ?? '').split('/').pop() ?? '';
      return loc ? `/${pattern}/ ${loc}` : `/${pattern}/`;
    }
    if (toolName === 'find') {
      const pattern = str(details.pattern);
      const path = str(details.path);
      if (!pattern) return undefined;
      const loc = (path ?? '').split('/').pop() ?? '';
      return loc ? `${pattern} ${loc}` : pattern;
    }
    if (toolName === 'ls') {
      return str(details.path) ?? '.';
    }
    // Generic fallback: first short string value
    for (const v of Object.values(details)) {
      if (typeof v === 'string' && v.length < 80) return v;
    }
    return undefined;
  }

  function findToolMessage(toolCallId: string): UIMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'tool' && messages[i].toolCallId === toolCallId) return messages[i];
    }
    return undefined;
  }

  function agentMsgToUI(m: unknown, toolInputMap?: Map<string, { name: string; input: Record<string, unknown> }>): UIMessage[] {
    const msg = m as Record<string, unknown>;
    if (!msg || typeof msg.role !== 'string') return [];

    switch (msg.role) {
      case 'user': {
        let text: string;
        let images: string[] | undefined;
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          const blocks = msg.content as { type: string; text?: string; data?: string; mimeType?: string }[];
          text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
          const imgBlocks = blocks.filter((b) => b.type === 'image' && b.data && b.mimeType);
          if (imgBlocks.length > 0) {
            images = imgBlocks.map((b) => `data:${b.mimeType};base64,${b.data}`);
          }
          if (!text && imgBlocks.length === 0) text = JSON.stringify(msg.content);
        } else {
          text = JSON.stringify(msg.content);
        }
        return [{ id: uid(), role: 'user', content: text, images, streaming: false }];
      }
      case 'assistant': {
        const blocks = (msg.content as { type: string; text?: string; thinking?: string }[]) ?? [];
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        const thinkingText = blocks
          .filter((b) => b.type === 'thinking')
          .map((b) => b.thinking ?? '')
          .join('');
        const rawUsage = msg.usage as { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } | undefined;
        const usage: MsgUsage | undefined = rawUsage?.totalTokens
          ? { input: rawUsage.input ?? 0, output: rawUsage.output ?? 0, totalTokens: rawUsage.totalTokens, cost: { total: rawUsage.cost?.total ?? 0 } }
          : undefined;
        return text || thinkingText ? [{ id: uid(), role: 'assistant', content: text, thinking: thinkingText || undefined, thinkingExpanded: false, streaming: false, usage }] : [];
      }
      case 'bashExecution': {
        const cmd = msg.command as string | undefined;
        const output = (msg.output as string | undefined) ?? '';
        return [
          {
            id: uid(),
            role: 'tool',
            toolName: 'bash',
            toolInput: cmd ? `$ ${cmd.split('\n')[0].trim()}` : undefined,
            toolArgs: cmd ? { command: cmd } : undefined,
            content: output,
            isError: typeof msg.exitCode === 'number' && (msg.exitCode as number) !== 0,
            streaming: false,
          },
        ];
      }
      case 'toolResult': {
        const toolCallId = msg.toolCallId as string | undefined;
        let toolInfo = toolCallId ? toolInputMap?.get(toolCallId) : undefined;
        if (!toolInfo && toolCallId && toolInputMap && toolInputMap.size > 0) {
          for (const [id, info] of toolInputMap) {
            if (id.endsWith(toolCallId) || toolCallId.endsWith(id)) {
              toolInfo = info;
              break;
            }
          }
        }
        const toolName = (msg.toolName as string | undefined) ?? toolInfo?.name ?? 'tool';
        const toolInput = toolInfo ? formatToolInput(toolName, toolInfo.input) : undefined;
        const blocks = (msg.content as { type: string; text?: string }[]) ?? [];
        return [
          {
            id: uid(),
            role: 'tool',
            toolName,
            toolCallId,
            toolInput,
            toolArgs: toolInfo?.input,
            content: extractTextContent(blocks),
            isError: (msg.isError as boolean | undefined) ?? false,
            streaming: false,
          },
        ];
      }
      default:
        return [];
    }
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
    const text = msg.content;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copiedId = msg.id;
      setTimeout(() => { copiedId = null; }, 2000);
    } catch {
      // clipboard not available (non-HTTPS or unsupported)
    }
  }

  async function copyToolOutput(msg: UIMessage) {
    const text = msg.content;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copiedId = msg.id;
      setTimeout(() => { copiedId = null; }, 2000);
    } catch {
      // clipboard not available
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

  /** Handle clicks on file-link buttons rendered by the markdown tokenizer. */
  function handleFileLink(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const btn = target.closest('.file-link-btn') as HTMLElement | null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const path = btn.dataset.filepath;
    const lineStr = btn.dataset.fileline;
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
      if (isEditingSessionName) return; // input handles its own Escape
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

    // Any printable character when no input is focused → focus textarea
    if (!inEditable() && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      inputEl?.focus();
    }
  }

  // ── User input ───────────────────────────────────────────────────────────────

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { resolve((reader.result as string).split(',')[1]); };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleFileInput(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const data = await fileToBase64(file);
      attachedImages.push({ data, mimeType: file.type, name: file.name, src: `data:${file.type};base64,${data}` });
    }
    (e.target as HTMLInputElement).value = '';
  }

  function removeAttachment(idx: number) {
    attachedImages.splice(idx, 1);
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

  // ── TTS / STT ────────────────────────────────────────────────────────────────

  /** Strip markdown so text sounds natural when spoken. */
  function stripMarkdown(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, '') // fenced code blocks → drop
      .replace(/`[^`\n]+`/g, '') // inline code → drop
      .replace(/\*\*([^*]+)\*\*/g, '$1') // bold → plain
      .replace(/\*([^*]+)\*/g, '$1') // italic → plain
      .replace(/#{1,6}\s+/g, '') // headings → plain
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → label only
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // images → drop
      .replace(/^\s*[-*+]\s+/gm, '') // list bullets → drop
      .replace(/^\s*\d+\.\s+/gm, '') // numbered list → drop
      .replace(/\n{2,}/g, '. ') // paragraph breaks → short pause
      .replace(/\n/g, ' ')
      .trim();
  }

  /** Speak arbitrary text via the browser SpeechSynthesis API, optionally tracking it to a message ID. */
  function speakText(text: string, msgId: string | null = null) {
    if (!('speechSynthesis' in window)) return;
    stopSpeaking();
    if (!text.trim()) return;
    const utt = new SpeechSynthesisUtterance(text);
    const voice = selectedVoice();
    if (voice) utt.voice = voice;
    utt.rate = speechRate;
    utt.pitch = speechPitch;
    speakingMsgId = msgId;
    isSpeaking = true;
    utt.onend = () => {
      isSpeaking = false;
      speakingMsgId = null;
      // Conversation mode: after TTS finishes, start listening for the next turn
      if (conversationMode && wsState === 'open' && !isRecording && !isStreaming) {
        toggleSTT();
      }
    };
    utt.onerror = () => { isSpeaking = false; speakingMsgId = null; };
    window.speechSynthesis.speak(utt);
  }

  function speakMsg(msg: UIMessage) {
    if (!('speechSynthesis' in window)) return;
    // Toggle off if already speaking this message
    if (speakingMsgId === msg.id) {
      stopSpeaking();
      return;
    }
    speakText(stripMarkdown(msg.content ?? ''), msg.id);
  }

  function stopSpeaking() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    isSpeaking = false;
    speakingMsgId = null;
  }

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
   * ON  → forces autoSpeak, starts STT immediately (if idle).
   * OFF → stops TTS + STT and clears the mode flag.
   */
  function toggleConversationMode() {
    if (conversationMode) {
      conversationMode = false;
      // Stop any in-flight TTS or STT when exiting
      sttManualStop = true;
      speechRec?.stop();
      stopSpeaking();
    } else {
      conversationMode = true;
      autoSpeak = true; // conversation mode requires auto-speak
      // Kick off the first listening turn if nothing is happening
      if (!isStreaming && !isSpeaking && !isRecording && wsState === 'open') {
        toggleSTT();
      }
    }
  }

  function canSubmitFollowUp() {
    return wsState === 'open' && !isStreaming && input.trim().length > 0 && attachedImages.length === 0;
  }

  function runSlashCommand(text: string): boolean {
    if (!text.startsWith('/')) return false;
    const [rawCommand, ...rest] = text.slice(1).split(/\s+/);
    const command = rawCommand.toLowerCase();
    const args = rest.join(' ').trim();

    switch (command) {
      case 'new':
        newSession(args || undefined);
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
      case 'login':
        openTab('models');
        modelTab = 'providers';
        return true;
      case 'session':
        send({ type: 'run_builtin', command, args });
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
      case 'logout':
      case 'clone':
      case 'export':
      case 'share':
      case 'changelog':
      case 'tree':
      case 'name':
        send({ type: 'run_builtin', command, args });
        return true;
      default:
        return false;
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

    if (!text && attachedImages.length === 0) return;

    if (attachedImages.length === 0 && !asFollowUp && runSlashCommand(text)) {
      input = '';
      resetTextareaHeight();
      return;
    }

    const imgs = attachedImages.length > 0
      ? attachedImages.map((img) => ({ data: img.data, mimeType: img.mimeType }))
      : undefined;

    messages.push({
      id: uid(),
      role: 'user',
      content: text,
      images: imgs ? attachedImages.map((img) => img.src) : undefined,
      streaming: false,
    });

    if (asFollowUp && attachedImages.length === 0) {
      send({ type: 'follow_up', message: text });
    } else {
      send({ type: 'prompt', message: text, ...(imgs ? { images: imgs } : {}) });
    }
    input = '';
    attachedImages = [];
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

  function restartServer() {
    if (!confirm('Restart the server? The page will reconnect automatically in a few seconds.')) return;
    send({ type: 'restart_server' });
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

  function startSessionNameEdit() {
    sessionNameDraft = sessionName ?? '';
    isEditingSessionName = true;
  }

  function commitSessionNameEdit() {
    isEditingSessionName = false;
    const name = sessionNameDraft.trim();
    if (name) send({ type: 'rename_current_session', name });
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
  });

  $effect(() => {
    if (!showSlashMenu) slashMenuIndex = -1;
  });

  onMount(() => {
    connect();
    inputEl?.focus();
    _mq = window.matchMedia('(max-width: 767px)');
    isMobile = _mq.matches;
    _mqHandler = (e: MediaQueryListEvent) => { isMobile = e.matches; };
    _mq.addEventListener('change', _mqHandler);
    // Restore persisted sidebar widths
    try {
      const sw = parseInt(localStorage.getItem('pifrontier:session-w') ?? '');
      if (!isNaN(sw)) sessionPanelWidth = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, sw));
      const rw = parseInt(localStorage.getItem('pifrontier:right-w') ?? '');
      if (!isNaN(rw)) rightPanelWidth = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, rw));
    } catch { /* localStorage unavailable */ }
    try {
      selectedVoiceURI = localStorage.getItem('pifrontier:voice-uri') ?? '';
      speechRate = Number(localStorage.getItem('pifrontier:speech-rate') ?? '1') || 1;
      speechPitch = Number(localStorage.getItem('pifrontier:speech-pitch') ?? '1') || 1;
    } catch { /* localStorage unavailable */ }
    refreshSpeechVoices();
    if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = refreshSpeechVoices;
  });

  onDestroy(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (sendHoldTimer) clearTimeout(sendHoldTimer);
    ws?.close();
    if (_mq && _mqHandler) _mq.removeEventListener('change', _mqHandler);
    if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = null;
  });
</script>

<svelte:head>
  <title>pi</title>
</svelte:head>

<svelte:window onkeydown={handleGlobalKeydown} />

<!--
  Root: flex-row — three columns:
    [session panel] [main content] [model picker panel]
  Sidebars are always in the DOM; their width transitions push/shrink the center.
-->
<Tooltip.Provider delayDuration={400}>
<div
  role="application"
  aria-label="pi chat"
  class="flex flex-row w-dvw h-dvh text-base-content font-mono text-base select-none overflow-hidden"
  ontouchstart={handleTouchStart}
  ontouchend={handleTouchEnd}
>

  <!-- ── LEFT SIDEBAR: Session panel ─────────────────────────────────────── -->

  <SidebarPanel
    title={projects.length ? `projects (${projects.length})` : 'projects'}
    open={showSessionPanel}
    {isMobile}
    width={sessionPanelWidth}
    side="left"
    resizing={sessionResizing}
    closeLabel="Close session panel"
    onClose={() => (showSessionPanel = false)}
    onResizeStart={startSessionResize}
    onResizeMove={onSessionResizeMove}
    onResizeStop={() => stopSessionResize()}
  >
    {#snippet header()}{/snippet}

      <!-- Filter input — capsule with search icon -->
      <div class="shrink-0 px-3 py-3">
        <div class="flex items-center gap-2 bg-base-content/[0.055] border border-base-content/[0.04] rounded-2xl px-3 py-2.5 shadow-inner shadow-black/5">
          <svg class="w-4 h-4 shrink-0 text-base-content/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input
            type="search"
            placeholder="search projects &amp; sessions…"
            bind:value={sessionFilter}
            class="flex-1 bg-transparent outline-none text-sm placeholder-base-content/30 text-base-content/80 min-w-0"
            aria-label="Filter projects and sessions"
            tabindex={showSessionPanel ? 0 : -1}
          />
        </div>
      </div>

      <!-- Error banner -->
      {#if sessionError}
        <div class="shrink-0 mx-3 mb-2 px-3 py-2.5 bg-error/10 border border-error/20 rounded-xl flex items-center justify-between gap-2">
          <span class="text-sm text-error break-words min-w-0">{sessionError}</span>
          <button
            onclick={() => (sessionError = null)}
            class="w-7 h-7 flex items-center justify-center text-error/50 hover:text-error/80 shrink-0 rounded-lg transition-colors"
            aria-label="Dismiss error"
          ><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      {/if}

      <!-- Scrollable content area — hierarchical tree with collapsible directories -->
      <ScrollArea class="flex-1 min-h-0">
      <div class="px-2.5 pb-2">
        {#if filteredTree.length === 0 && projects.length === 0}
          <div class="flex flex-col items-center justify-center gap-2 py-12 px-4 text-center">
            <svg class="w-8 h-8 text-base-content/15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
            <p class="text-sm text-base-content/35 font-medium">No projects yet</p>
            <p class="text-xs text-base-content/25">Open a folder below to start</p>
          </div>
        {:else if filteredTree.length === 0}
          <div class="flex flex-col items-center justify-center gap-1.5 py-10 px-4 text-center">
            <p class="text-sm text-base-content/35">No match</p>
            <p class="text-xs text-base-content/25">Try a different search term</p>
          </div>
        {:else}
          <div class="flex flex-col pt-1 gap-2">
            {#each filteredTree as p}
              {@const isDirActive = p.cwd === cwd}
              {@const dirCollapsed = collapsedDirs.has(p.cwd)}
              <!-- Directory header — collapsible + new-session action -->
              <div class="group/dir relative rounded-2xl transition-colors duration-150 hover:bg-base-content/[0.035]">
                <div class="flex items-center">
                  <button
                    onclick={() => toggleDir(p.cwd)}
                    class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 text-left transition-colors duration-150 rounded-2xl {isDirActive ? 'text-base-content font-semibold' : 'text-base-content/60 hover:text-base-content/85'}"
                    tabindex={showSessionPanel ? 0 : -1}
                    aria-expanded={!dirCollapsed}
                  >
                    <!-- Collapse/expand chevron -->
                    <svg class="w-3 h-3 shrink-0 text-base-content/40 transition-transform duration-150 {dirCollapsed ? '' : 'rotate-90'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                    <!-- Folder icon -->
                    <svg class="w-4 h-4 shrink-0 text-base-content/45" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                    <!-- Dir name -->
                    <span class="flex-1 truncate text-sm">{p.basename}</span>
                    <!-- Streaming indicator on dir -->
                    {#if p.streaming}
                      <span class="w-1.5 h-1.5 rounded-full bg-success shadow-[0_0_6px_1px_var(--color-success)/0.6] animate-pulse shrink-0" aria-label="Generating"></span>
                    {/if}
                    <!-- Session count -->
                    <span class="text-[11px] text-base-content/28 shrink-0 tabular-nums">{p.sessions.length}</span>
                  </button>
                  <!-- New session in this dir — visible on row hover -->
                  <button
                    onclick={() => { if (dirCollapsed) toggleDir(p.cwd); newSession(p.cwd); }}
                    class="w-7 h-7 mr-1.5 flex items-center justify-center text-base-content/30 hover:text-primary hover:bg-primary/10 rounded-xl transition-colors opacity-0 group-hover/dir:opacity-100 shrink-0"
                    title="New session in {p.basename}"
                    aria-label="New session in {p.basename}"
                    tabindex={showSessionPanel ? 0 : -1}
                  >
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                  </button>
                </div>
                <!-- Sessions nested under this directory -->
                {#if !dirCollapsed}
                  <div class="ml-3 pl-3 pt-1.5 pb-1.5 border-l border-base-content/8 space-y-1">
                    {#each visibleSessions(p) as s}
                      {@const isActive = sessionId === s.id}
                      {@const isRenaming = renamingPath === s.path}
                      {@const hasUnchecked = uncheckedSessions.has(s.id)}
                      <div class="group rounded-2xl transition-colors duration-150 hover:bg-base-content/[0.035]">
                        {#if isRenaming}
                          <div class="px-3 py-2 flex items-center gap-2">
                            <input
                              autofocus
                              type="text"
                              bind:value={renameDraft}
                              onkeydown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                                if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                              }}
                              class="flex-1 bg-transparent border-b border-base-content/30 focus:border-base-content/60 outline-none text-sm py-1 text-base-content/90 min-w-0 transition-colors"
                              placeholder="session name…"
                              aria-label="Session name"
                            />
                            <button onclick={commitRename} class="w-7 h-7 flex items-center justify-center text-primary/70 hover:text-primary hover:bg-primary/8 rounded-lg transition-colors" aria-label="Confirm rename"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></button>
                            <button onclick={cancelRename} class="w-7 h-7 flex items-center justify-center text-base-content/35 hover:text-base-content/70 hover:bg-base-content/8 rounded-lg transition-colors" aria-label="Cancel rename"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                          </div>
                        {:else}
                          <div class="flex items-stretch">
                            <button
                              onclick={() => switchSession(s.path)}
                              class="flex-1 text-left px-3 py-2 min-w-0"
                              aria-current={isActive ? 'true' : undefined}
                              tabindex={showSessionPanel ? 0 : -1}
                            >
                              <!-- Title row with indicators -->
                              <div class="flex items-center gap-2">
                                <!-- Status dot: streaming ⇢ animated pulse, unchecked ⇢ filled, else outline -->
                                {#if isStreaming && isActive}
                                  <span class="w-2 h-2 rounded-full bg-success shrink-0 animate-pulse shadow-[0_0_5px_1px_var(--color-success)/0.5]" aria-label="Streaming"></span>
                                {:else if hasUnchecked}
                                  <span class="w-2 h-2 rounded-full bg-primary shrink-0 shadow-[0_0_4px_1px_var(--color-primary)/0.3]" aria-label="Unchecked result"></span>
                                {:else}
                                  <span class="w-2 h-2 rounded-full bg-base-content/20 shrink-0"></span>
                                {/if}
                                <span class="text-sm truncate leading-snug {isActive ? 'text-base-content font-semibold tracking-[-0.01em]' : 'text-base-content/68'}">
                                  {s.name ? s.name : (s.firstMessage || '(empty)')}
                                </span>
                              </div>
                              {#if s.name && s.firstMessage}
                                <p class="text-xs text-base-content/35 mt-0.5 truncate pl-4">{s.firstMessage}</p>
                              {/if}
                               <p class="text-xs text-base-content/24 mt-0.5 pl-4 flex items-center gap-1.5">
                                 <span>{formatDate(s.modified)}</span>
                                 {#if s.messageCount > 0}
                                   <span class="text-base-content/18">·</span>
                                   <span>{s.messageCount} msg{s.messageCount === 1 ? '' : 's'}</span>
                                 {/if}
                               </p>
                            </button>
                            <!-- Actions — visible on row hover only -->
                            <div class="flex flex-col justify-center gap-0.5 pr-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onclick={() => startRename(s)} class="w-7 h-7 flex items-center justify-center text-base-content/40 hover:text-base-content/70 hover:bg-base-content/8 rounded-lg transition-colors" title="Rename" aria-label="Rename session" tabindex={showSessionPanel ? 0 : -1}><svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>
                              {#if isActive && messages.length > 0}
                                <button onclick={() => { showSessionPanel = false; openForkDialog(); }} disabled={isStreaming} class="w-7 h-7 flex items-center justify-center text-base-content/35 hover:text-primary hover:bg-primary/8 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed" title="Fork session" aria-label="Fork session" tabindex={showSessionPanel ? 0 : -1}><svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v4"/><path d="M18 3v4"/><path d="M6 7a6 6 0 0 0 6 6 6 6 0 0 0 6-6"/><path d="M12 13v8"/></svg></button>
                              {/if}
                              {#if !isActive}
                                <button onclick={() => deleteSession(s.path)} class="w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-error hover:bg-error/8 rounded-lg transition-colors" title="Delete" aria-label="Delete session" tabindex={showSessionPanel ? 0 : -1}><svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>
                              {/if}
                            </div>
                          </div>
                        {/if}
                      </div>
                    {/each}
                    {#if p.sessions.length > SESSION_PREVIEW_LIMIT}
                      {@const expanded = expandedSessionGroups.has(p.cwd)}
                      <button
                        onclick={() => toggleSessionGroup(p.cwd)}
                        class="w-full text-left pl-4 pr-3 py-1.5 text-xs text-base-content/32 hover:text-base-content/55 transition-colors"
                        tabindex={showSessionPanel ? 0 : -1}
                      >
                        {expanded ? 'Show fewer sessions' : `Show ${p.sessions.length - SESSION_PREVIEW_LIMIT} more sessions`}
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
      </ScrollArea>

      <!-- Footer -->
      <div class="shrink-0 p-3 pt-2 space-y-2 bg-gradient-to-t from-base-300/25 to-transparent">
        <!-- Open-folder toggle -->
        <button
          onclick={() => { openFolderMode = !openFolderMode; openFolderInput = ''; dirCompletions = []; }}
          class="w-full flex items-center justify-center gap-2 text-sm text-base-content/50 hover:text-base-content/80 transition-colors py-3 bg-base-content/[0.045] hover:bg-base-content/[0.075] border border-base-content/[0.035] rounded-2xl"
          tabindex={showSessionPanel ? 0 : -1}
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <span>{openFolderMode ? 'cancel' : 'open folder…'}</span>
        </button>
        {#if openFolderMode}
          <div class="bg-base-content/5 rounded-xl px-3 py-2.5">
            <!-- svelte-ignore a11y_autofocus -->
            <input
              autofocus
              type="text"
              bind:value={openFolderInput}
              placeholder="/path/to/project"
              class="w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/30"
              aria-label="Project path"
              tabindex={showSessionPanel ? 0 : -1}
              onkeydown={(e) => {
                if (e.key === 'Enter' && openFolderInput.trim()) {
                  e.preventDefault();
                  newSession(openFolderInput.trim());
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  openFolderMode = false;
                  openFolderInput = '';
                  dirCompletions = [];
                }
              }}
            />
            {#if dirCompletions.length > 0}
              <div class="mt-1.5 flex flex-col gap-0.5">
                {#each dirCompletions as entry}
                  <button
                    onclick={() => { openFolderInput = entry; dirCompletions = []; }}
                    class="text-left text-xs text-base-content/60 hover:text-base-content/90 py-1 px-1 rounded hover:bg-base-content/8 transition-colors truncate"
                    tabindex={showSessionPanel ? 0 : -1}
                  >{entry}</button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
  </SidebarPanel>

  <!-- ── MAIN COLUMN ──────────────────────────────────────────────────────── -->
  <div class="flex-1 flex flex-col min-w-0 bg-[color-mix(in_oklch,var(--color-base-200)_86%,black_8%)] relative">

    <!-- Top tab bar -->
    <header
      class="relative shrink-0 h-14 flex items-center gap-2 px-3 bg-[color-mix(in_oklch,var(--color-base-200)_86%,black_8%)] shadow-sm shadow-black/10"
      style="padding-top: env(safe-area-inset-top, 0px);"
    >
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
        class="absolute left-1/2 top-0 bottom-0 z-0 w-[min(52rem,calc(100vw-8.5rem))] -translate-x-1/2 min-w-0 flex flex-col items-center justify-center px-3 text-center rounded-t-none sm:rounded-t-xl border-x border-transparent hover:bg-base-content/[0.035] transition-colors"
        aria-label="Open model and provider panel"
        aria-expanded={showRightPanel && rightPanelTab === 'models'}
      >
        <span class="max-w-full text-sm sm:text-[15px] leading-tight text-base-content/82 truncate">
          {sessionName || cwdBasename || 'New chat'}
        </span>
        <span class="hidden sm:flex max-w-full items-center justify-center gap-1.5 text-[11px] leading-tight text-base-content/38 truncate">
          <span class="truncate">{model?.provider || 'no provider'}</span>
          {#if model?.name}<span class="text-base-content/20">›</span><span class="truncate">{model.name}</span>{/if}
          {#if thinkingLevel !== 'off'}<span class="text-success/65">{thinkingLevel}</span>{/if}
        </span>
      </button>

      <div class="relative z-10 flex items-center gap-1.5 shrink-0 ml-auto">
        {#if lastInputTokens > 0}
          <Tooltip.Root>
            <Tooltip.Trigger class="h-9 hidden md:flex items-center gap-2 rounded-xl px-3 bg-base-content/[0.055] border border-base-content/8 text-xs text-base-content/65 tabular-nums cursor-default">
              <span class="relative flex h-4 w-4 items-center justify-center">
                <span class="absolute inset-0 rounded-full border-2 border-success/35"></span>
                <span class="h-1.5 w-1.5 rounded-full bg-success/70"></span>
              </span>
              <span>{contextPercent > 0 ? `${contextPercent}%` : fmtTokens(lastInputTokens)}</span>
            </Tooltip.Trigger>
            <Tooltip.Content sideOffset={8} class="min-w-[170px]">
              <div class="flex flex-col gap-1 text-xs tabular-nums">
                <p>Used tokens: {lastInputTokens.toLocaleString()}</p>
                {#if model?.contextWindow}<p>Context limit: {model.contextWindow.toLocaleString()}</p>{/if}
                {#if sessionTokens > 0}<p>Output/session: {sessionTokens.toLocaleString()}</p>{/if}
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
        <div class="hidden md:flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-primary text-xs font-semibold border border-primary/20">π</div>
      </div>
    </header>

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
      {#if messages.length === 0 && wsState === 'open'}
        <div class="min-h-full flex flex-col items-center justify-center gap-3 select-none pointer-events-none">
          <span class="text-8xl font-light text-base-content/[0.08]">π</span>
          <p class="text-sm text-base-content/30">start a conversation</p>
        </div>
      {:else}
        <div class="w-full max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl mx-auto px-4 md:px-6 flex flex-col gap-1">
          {#each messages as msg (msg.id)}

            {#if msg.role === 'user'}
              {@const isExpanded = expandedUserMsgs[msg.id] ?? false}
              <div class="group sticky top-0 z-20 bg-base-100 relative pt-2 -mx-4 md:-mx-6">
                <div class="absolute bottom-0 left-0 right-0 h-5 bg-gradient-to-b from-base-100 to-transparent pointer-events-none"></div>
                <div class="flex justify-end px-4 md:px-6">
                <div class="max-w-[82%] space-y-0.5">
                  <div class="bg-base-content/[0.10] rounded-none sm:rounded-lg sm:rounded-br-sm px-3 py-2 space-y-1">
                    {#if msg.images?.length}
                      <div class="flex gap-2 flex-wrap -mx-1">
                        {#each msg.images as src}
                          <img {src} alt="attachment" class="max-h-48 max-w-full rounded-lg object-contain" />
                        {/each}
                      </div>
                    {/if}
                    {#if msg.content}
                      <p
                        class="whitespace-pre-wrap break-words leading-relaxed text-base-content/90 select-text {!isExpanded ? 'line-clamp-3' : ''}"
                        onclick={() => { expandedUserMsgs[msg.id] = !isExpanded; }}
                        role="button"
                        tabindex="0"
                        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expandedUserMsgs[msg.id] = !isExpanded; } }}
                      >{msg.content}</p>
                      <button
                        onclick={() => { expandedUserMsgs[msg.id] = !isExpanded; }}
                        class="text-[10px] text-base-content/30 hover:text-base-content/55 transition-colors select-none"
                      >{isExpanded ? 'show less' : 'show more'}</button>
                    {/if}
                  </div>
                  <div class="flex justify-end {isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity duration-150">
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
              <div class="group">

                <!-- THINKING TOGGLE (compact) -->
                {#if msg.streaming}
                  {#if msg.thinking && msg.thinking.length > 0}
                    <div class="flex items-center gap-1.5 text-[10px] text-base-content/25 py-0.5">
                      <Brain class="w-3 h-3 shrink-0" style="color:var(--color-secondary);animation:pulse 1.5s ease-in-out infinite" />
                      <span class="text-base-content/35">Thinking</span>
                      <span class="truncate">{msg.thinking.slice(0, 80)}{msg.thinking.length > 80 ? '…' : ''}</span>
                    </div>
                  {:else if !msg.content}
                    <div class="flex items-center gap-1.5 text-[10px] text-base-content/20 py-0.5">
                      <Loader class="w-3 h-3 animate-spin text-base-content/30" />
                      <span>thinking…</span>
                    </div>
                  {/if}
                {:else if msg.thinking}
                  <button
                    onclick={() => { msg.thinkingExpanded = !msg.thinkingExpanded; }}
                    class="flex items-center gap-1.5 text-[10px] text-base-content/25 hover:text-base-content/45 transition-colors py-0.5"
                    aria-expanded={msg.thinkingExpanded}
                  >
                    <Brain class="w-3 h-3 shrink-0" style="color:var(--color-secondary)" />
                    <span class="text-base-content/35">Thinking</span>
                    <span class="truncate">{msg.thinking.slice(0, 80)}{msg.thinking.length > 80 ? '…' : ''}</span>
                    {#if msg.endMs && msg.thinkingStartMs}
                      <span class="text-base-content/20 shrink-0">{fmtDuration(msg.endMs - msg.thinkingStartMs)}</span>
                    {/if}
                    <ChevronRight class="w-2.5 h-2.5 shrink-0 {msg.thinkingExpanded ? 'rotate-90' : ''} transition-transform" />
                  </button>
                {/if}

                <!-- EXPANDED THINKING BLOCK -->
                {#if msg.thinkingExpanded && msg.thinking}
                  <pre class="text-[11px] text-base-content/30 whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed bg-base-content/[0.03] rounded px-2 py-1.5 my-0.5 select-text ml-3 border-l-2 border-base-content/[0.08]">{msg.thinking}</pre>
                {/if}

                <!-- BODY -->
                <div class="leading-relaxed select-text">
                  {#if !msg.content && msg.streaming}
                    {#if workingVisible && !(msg.thinking && msg.thinking.length > 0)}
                      <span class="flex items-center gap-[3px] h-5" aria-label="Thinking">
                        <span class="typing-dot"></span>
                        <span class="typing-dot"></span>
                        <span class="typing-dot"></span>
                        {#if workingMessage}
                          <span class="ml-2 text-base-content/40 text-xs">{workingMessage}</span>
                        {/if}
                      </span>
                    {/if}
                  {:else}
                    <div class="prose text-base-content/90">{@html renderMarkdown(msg.content)}</div>
                    {#if msg.streaming}<span class="text-primary animate-pulse">▌</span>{/if}
                  {/if}
                </div>

                <!-- META + ACTIONS -->
                {#if msg.content && !msg.streaming}
                  <div class="flex items-center gap-2 text-[10px] text-base-content/20 py-0.5">
                    {#if msg.usage}
                      <span class="tabular-nums">{fmtTokens(msg.usage.totalTokens)}t</span>
                      {#if msg.usage.cost.total > 0}<span>· {fmtCost(msg.usage.cost.total)}</span>{/if}
                      {#if msg.startMs && msg.endMs}<span>· {fmtDuration(msg.endMs - msg.startMs)}</span>{/if}
                    {/if}
                    <span class="ml-auto flex items-center gap-0.5">
                      <button
                        onclick={() => copyMessage(msg)}
                        class="flex items-center justify-center w-5 h-5 text-base-content/25 hover:text-base-content/55 rounded transition-colors select-none"
                        aria-label="Copy message"
                      >{#if copiedId === msg.id}<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{:else}<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>{/if}</button>
                      {#if isSummarizing && msg.id === lastAsstId}
                        <span class="flex items-center justify-center w-5 h-5 text-primary/60" aria-label="Generating spoken summary…">
                          <svg class="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                        </span>
                      {:else}
                        <button
                          onclick={() => speakMsg(msg)}
                          class="flex items-center justify-center w-5 h-5 rounded transition-colors select-none {speakingMsgId === msg.id ? 'text-primary' : 'text-base-content/25 hover:text-base-content/55'}"
                          aria-label={speakingMsgId === msg.id ? 'Stop speaking' : 'Speak message'}
                        >{#if speakingMsgId === msg.id}<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>{:else}<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>{/if}</button>
                      {/if}
                    </span>
                  </div>
                {/if}
              </div>

            {:else if msg.role === 'tool'}
              {@const meta = getToolMeta(msg.toolName)}
              {@const detail = msg.toolInput ?? inferDetail(msg.toolName, msg.toolArgs)}
              <div class="group/tool flex flex-col mb-1">
                <button
                  onclick={() => { if (msg.content || msg.diff) msg.expanded = !msg.expanded; }}
                  class="flex items-center gap-2 px-2 py-1 text-xs font-mono rounded hover:bg-base-content/[0.04] transition-colors text-left w-full"
                  disabled={!msg.content && !msg.diff}
                >
                  <meta.icon class="w-3.5 h-3.5 shrink-0" style="color:{meta.color};{msg.streaming ? 'animation:pulse 1.5s ease-in-out infinite' : ''}" />
                  <span class="text-base-content/50 shrink-0">{meta.label}</span>
                  {#if detail}
                    <span class="text-base-content/30 truncate flex-1 min-w-0">{detail}</span>
                  {/if}
                  <span class="shrink-0 ml-auto flex items-center gap-1.5">
                    {#if msg.streaming}
                      <Loader class="w-3 h-3 text-base-content/30 animate-spin" />
                    {:else if msg.isError}
                      <CircleX class="w-3 h-3 text-destructive/70" />
                    {:else if msg.content || msg.diff}
                      {#if msg.lineCount !== undefined}
                        <span class="text-base-content/20 tabular-nums">{msg.lineCount}L</span>
                      {/if}
                      <ChevronRight class="w-3 h-3 text-base-content/20 transition-transform {msg.expanded ? 'rotate-90' : ''}" />
                    {:else}
                      <Check class="w-3 h-3 text-success/50" />
                    {/if}
                  </span>
                </button>
                {#if msg.expanded && !msg.streaming}
                  {#if msg.diff}
                    <div class="ml-4 mt-1">
                      <DiffViewer diff={msg.diff} />
                    </div>
                  {:else if msg.content}
                    {@const toolLang = getToolLang(msg.toolName, msg.toolInput)}
                    {#if toolLang}
                      <pre class="ml-4 pl-2 border-l border-base-content/[0.08] text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto leading-relaxed select-text py-1"><code class="hljs">{@html highlightCode(msg.content, toolLang)}</code></pre>
                    {:else}
                      <pre class="ml-4 pl-2 border-l border-base-content/[0.08] text-base-content/40 text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto leading-relaxed select-text py-1">{msg.content}</pre>
                    {/if}
                  {/if}
                {/if}
              </div>

            {:else if msg.role === 'notice'}
              <div class="flex items-center gap-2 text-[10px] text-base-content/20 select-none py-0.5">
                <span class="flex-1 h-px bg-base-content/[0.06]"></span>
                <span class="flex items-center gap-1 shrink-0">
                  {#if msg.streaming}
                    <svg class="w-2 h-2 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  {:else if msg.noticeKind === 'compaction'}
                    <span aria-hidden="true">✦</span>
                  {:else if msg.noticeKind === 'retry'}
                    <svg class="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                  {/if}
                  <span>{msg.content}</span>
                </span>
                <span class="flex-1 h-px bg-base-content/[0.06]"></span>
              </div>
            {/if}

          {/each}
        </div>
      {/if}
    </main>

    <!-- Scroll-to-bottom button — fades in when user scrolls up -->
    <div
      class="absolute right-4 z-10 pointer-events-none transition-all duration-200"
      style="bottom: calc(env(safe-area-inset-bottom, 0px) + 5.5rem);"
      class:opacity-0={isAtBottom}
      class:translate-y-2={isAtBottom}
    >
      <button
        onclick={scrollToBottom}
        class="pointer-events-auto w-9 h-9 rounded-full bg-base-200 border border-base-content/20 shadow-md flex items-center justify-center text-base-content/55 hover:text-base-content hover:bg-base-300 transition-colors"
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
          {#each queuedSteering as m}
            <span class="inline-flex items-center gap-1 text-xs text-base-content/40 bg-base-content/6 px-2 py-1 rounded-lg max-w-[16rem] truncate" title="Queued steer: {m}">
              <svg class="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              <span class="truncate">{m}</span>
            </span>
          {/each}
          {#each queuedFollowUp as m}
            <span class="inline-flex items-center gap-1 text-xs text-base-content/35 bg-base-content/5 px-2 py-1 rounded-lg max-w-[16rem] truncate" title="Queued follow-up: {m}">
              <svg class="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span class="truncate">{m}</span>
            </span>
          {/each}
        </div>
      {/if}

      <!-- Extension widget panels -->
      {#if Object.keys(extensionWidgets).length > 0}
        <div class="mb-2 flex flex-col gap-1">
          {#each Object.entries(extensionWidgets) as [_key, lines]}
            <div class="bg-base-content/5 rounded-xl px-3 py-2 text-xs text-base-content/45 font-mono whitespace-pre-wrap leading-relaxed">{lines.join('\n')}</div>
          {/each}
        </div>
      {/if}

      <!-- Slash command dropdown + input box wrapper -->
      <div class="relative">
        {#if showSlashMenu && filteredSlashCommands.length > 0}
          <div class="absolute bottom-full left-0 right-0 mb-1 z-10">
            <div class="bg-base-200 border border-base-content/10 rounded-xl overflow-hidden shadow-lg max-h-60 overflow-y-auto" role="listbox" aria-label="Composer shortcuts">
              {#each filteredSlashCommands as cmd, i}
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

      <div class="bg-base-100 border border-primary/25 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.3),0_0_0_1px_color-mix(in_oklch,var(--color-primary)_12%,transparent)] rounded-2xl px-3 py-2.5 flex flex-col gap-2.5">
        {#if attachedImages.length > 0}
          <div class="flex gap-2 flex-wrap pt-1">
            {#each attachedImages as img, i (img.src)}
              <div class="relative group/thumb">
                <img src={img.src} alt={img.name} class="h-16 w-16 object-cover rounded-lg bg-base-content/5" />
                <button
                  onclick={() => removeAttachment(i)}
                  class="absolute -top-1.5 -right-1.5 w-5 h-5 bg-base-content text-base-100 rounded-full flex items-center justify-center text-xs leading-none opacity-0 group-hover/thumb:opacity-100 transition-opacity"
                  aria-label="Remove {img.name}"
                >×</button>
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
          placeholder={wsState !== 'open' ? wsState + '…' : isStreaming ? 'Steer pi…' : 'Use @ / ! # for helpers'}
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
                <Tooltip.Content>Steer (Enter)</Tooltip.Content>
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
                    aria-label="Attach image"
                  ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>Attach image</Tooltip.Content>
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
              class="min-w-0 max-w-[12rem] md:max-w-[20rem] h-8 px-2.5 flex items-center gap-1.5 rounded-full text-sm font-semibold text-base-content/70 hover:text-base-content/90 hover:bg-base-content/7 transition-colors"
              aria-label="Select model"
              aria-expanded={showRightPanel && rightPanelTab === 'models'}
            >
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
                    disabled={(!input.trim() && attachedImages.length === 0) || wsState !== 'open'}
                    class="w-8 h-8 flex items-center justify-center rounded-full transition-colors shrink-0 {(input.trim() || attachedImages.length > 0) && wsState === 'open' ? 'text-primary hover:bg-primary/10' : 'text-base-content/25'} disabled:cursor-default"
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
        accept="image/*"
        multiple
        class="hidden"
        onchange={handleFileInput}
      />
      </div><!-- end .relative slash/input wrapper -->

      {#if Object.keys(extensionStatuses).length > 0 || lastInputTokens > 0 || sessionCostTotal > 0}
        <div class="hidden md:flex mt-1.5 px-1 items-center gap-2 text-xs select-none min-w-0">
          {#if Object.keys(extensionStatuses).length > 0}
            <span class="text-base-content/25 truncate min-w-0">
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
                    ? 'text-error/50'
                    : contextPercent >= 50
                      ? 'text-warning/50'
                      : 'text-base-content/20'
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
                    {lastInputTokens.toLocaleString()} / {(model?.contextWindow ?? 0).toLocaleString()} tokens
                  </p>
                  {#if sessionTokens > 0}
                    <p class="text-xs tabular-nums text-background/60">
                      session total: {sessionTokens.toLocaleString()}
                    </p>
                  {/if}
                </div>
              </Tooltip.Content>
            </Tooltip.Root>
          {:else if lastInputTokens > 0}
            <Tooltip.Root>
              <Tooltip.Trigger class="tabular-nums cursor-default text-base-content/20">
                {fmtTokens(lastInputTokens)} ctx
              </Tooltip.Trigger>
              <Tooltip.Content sideOffset={6} class="min-w-[140px]">
                <div class="flex flex-col gap-1.5">
                  <p class="text-xs tabular-nums">
                    {lastInputTokens.toLocaleString()} tokens
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
            <span class="text-base-content/20 tabular-nums">{fmtCost(sessionCostTotal)}</span>
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

    <div class="shrink-0 px-4 py-2 border-b border-base-content/8 flex items-center gap-2">
      <div class="flex items-center gap-1 flex-1">
        <button
          onclick={() => { rightPanelTab = 'models'; }}
          class="px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {rightPanelTab === 'models' ? 'text-base-content bg-base-content/10' : 'text-base-content/45 hover:text-base-content/70 hover:bg-base-content/8'}"
        >models</button>
        <button
          onclick={() => { rightPanelTab = 'tools'; }}
          class="px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {rightPanelTab === 'tools' ? 'text-base-content bg-base-content/10' : 'text-base-content/45 hover:text-base-content/70 hover:bg-base-content/8'}"
        >tools{#if toolsList.length} <span class="text-base-content/30 font-normal ml-0.5">{activeToolNames.length}/{toolsList.length}</span>{/if}</button>
        <button
          onclick={() => { rightPanelTab = 'skills'; }}
          class="px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {rightPanelTab === 'skills' ? 'text-base-content bg-base-content/10' : 'text-base-content/45 hover:text-base-content/70 hover:bg-base-content/8'}"
        >skills</button>
      </div>
      <button
        onclick={() => (showRightPanel = false)}
        class="w-8 h-8 flex items-center justify-center text-base-content/40 hover:text-base-content hover:bg-base-content/10 rounded-md transition-all duration-150 shrink-0"
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
              {#each ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as lvl}
                <button
                  onclick={() => pickThinkingLevel(lvl)}
                  class="px-2.5 py-1 text-xs font-medium rounded-md border transition-all duration-150 {thinkingLevel === lvl ? 'border-primary/60 text-primary bg-primary/10 shadow-[0_0_10px_-2px_var(--color-primary)/0.25]' : 'border-base-content/12 text-base-content/40 hover:border-base-content/30 hover:text-base-content/70 hover:bg-base-content/5'}"
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
                <p class="text-xs text-base-content/20">no models configured</p>
              </div>
            {:else if filteredModelsByProvider.length === 0}
              <div class="flex-1 flex items-center justify-center px-5 py-8">
                <p class="text-xs text-base-content/20">no match</p>
              </div>
            {:else}
              {#each filteredModelsByProvider as [provider, models]}
                <div>
                  <div class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6">
                    <span
                      style="background:{providerColor(provider)}"
                      class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0"
                      aria-hidden="true"
                    >{provider[0].toUpperCase()}</span>
                    <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold">{provider}</span>
                  </div>
                  {#each models as m}
                    {@const isActive = model?.id === m.id && model?.provider === m.provider}
                    <button
                      onclick={() => selectModel(m)}
                      class="w-full text-left px-5 py-2.5 text-sm transition-all duration-150 flex items-center gap-3 relative {isActive ? 'text-primary bg-primary/[0.06]' : 'text-base-content/70 hover:text-base-content hover:bg-base-content/[0.03]'}"
                      aria-pressed={isActive}
                      tabindex={showRightPanel ? 0 : -1}
                    >
                      {#if isActive}<span class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary shadow-[0_0_6px_1px_var(--color-primary)/0.4]"></span>{/if}
                      <span class="flex-1 truncate">{m.name}</span>
                      {#if m.reasoning}<span class="text-base-content/20 shrink-0 text-[10px]">✦</span>{/if}
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
                <p class="text-xs text-base-content/20">loading…</p>
              </div>
            {:else if filteredProviders.length === 0}
              <div class="flex-1 flex items-center justify-center px-5 py-8">
                <p class="text-xs text-base-content/20">no match</p>
              </div>
            {:else}
              {#each filteredProviders as p}
                {@const isCurrentProvider = model?.provider === p.id}
                {@const label = sourceLabel(p.source)}
                <div class="px-5 py-3 border-b border-base-content/6 transition-colors duration-150 {isCurrentProvider ? 'bg-primary/[0.04]' : 'hover:bg-base-content/[0.02]'}">
                  <div class="flex items-center gap-3 mb-2">
                    <span class="text-sm flex-1 truncate {p.configured ? 'text-base-content/85' : 'text-base-content/40'} {isCurrentProvider ? 'text-primary' : ''}">{p.name}</span>
                    {#if label}<span class="text-[10px] text-base-content/25 shrink-0 font-mono">{label}</span>{/if}
                    <span class="text-xs shrink-0 {p.configured ? 'text-primary/70' : 'text-base-content/15'}">{p.configured ? '●' : '○'}</span>
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
              {#each builtinTools as tool}
                {@const isActive = activeToolNames.includes(tool.name)}
                <button
                  onclick={() => toggleTool(tool.name)}
                  class="w-full text-left px-5 py-2.5 text-sm transition-all duration-150 flex items-center gap-3 relative {isActive ? 'hover:bg-base-content/5' : 'opacity-50 hover:opacity-75 hover:bg-base-content/3'}"
                  tabindex={showRightPanel ? 0 : -1}
                  aria-pressed={isActive}
                >
                  {#if isActive}<span class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary shadow-[0_0_6px_1px_var(--color-primary)/0.4]"></span>{/if}
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
              {#each customTools as tool}
                {@const isActive = activeToolNames.includes(tool.name)}
                <button
                  onclick={() => toggleTool(tool.name)}
                  class="w-full text-left px-5 py-2.5 text-sm transition-all duration-150 flex items-center gap-3 relative {isActive ? 'hover:bg-base-content/5' : 'opacity-50 hover:opacity-75 hover:bg-base-content/3'}"
                  tabindex={showRightPanel ? 0 : -1}
                  aria-pressed={isActive}
                >
                  {#if isActive}<span class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary shadow-[0_0_6px_1px_var(--color-primary)/0.4]"></span>{/if}
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
                  ><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>
                </div>
              {/snippet}

              {#if projectSkills.length > 0}
                <div class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6">
                  <span class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 bg-primary/70" aria-hidden="true">P</span>
                  <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold">project skills</span>
                </div>
                {#each projectSkills as skill}{@render skillItem(skill)}{/each}
              {/if}

              {#if userSkills.length > 0}
                <div class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6">
                  <span class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 bg-accent/70" aria-hidden="true">U</span>
                  <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold">user skills</span>
                </div>
                {#each userSkills as skill}{@render skillItem(skill)}{/each}
              {/if}

              {#if builtinSkills.length > 0}
                <div class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6">
                  <span class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 bg-base-content/30" aria-hidden="true">B</span>
                  <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold">built-in skills</span>
                </div>
                <div class="opacity-70">
                  {#each builtinSkills as skill}{@render skillItem(skill)}{/each}
                </div>
              {/if}
            {/if}

            {#if filteredSkills.prompts.length > 0}
              {@const projectPrompts = filteredSkills.prompts.filter((p) => p.scope === 'project')}
              {@const userPrompts = filteredSkills.prompts.filter((p) => p.scope === 'user')}
              {@const builtinPrompts = filteredSkills.prompts.filter((p) => p.isBuiltin)}

              {#if projectPrompts.length > 0}
                <div class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6">
                  <span class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 bg-primary/70" aria-hidden="true">P</span>
                  <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold">project prompts</span>
                </div>
                {#each projectPrompts as prompt}
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
                    ><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>
                  </div>
                {/each}
              {/if}

              {#if userPrompts.length > 0}
                <div class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6">
                  <span class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 bg-accent/70" aria-hidden="true">U</span>
                  <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold">user prompts</span>
                </div>
                {#each userPrompts as prompt}
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
                    ><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>
                  </div>
                {/each}
              {/if}

              {#if builtinPrompts.length > 0}
                <div class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6">
                  <span class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 bg-base-content/30" aria-hidden="true">B</span>
                  <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold">built-in prompts</span>
                </div>
                <div class="opacity-70">
                  {#each builtinPrompts as prompt}
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
                      ><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>
                    </div>
                  {/each}
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
            {#each SETTINGS_SECTIONS as section}
              <button
                onclick={() => (settingsSection = section.id)}
                class="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors {settingsSection === section.id ? 'bg-base-content/10 text-base-content' : 'text-base-content/62 hover:text-base-content/85 hover:bg-base-content/[0.055]'}"
              >
                <span class="w-5 text-center text-base-content/45">{section.icon}</span>
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
                {#each SETTINGS_SECTIONS as section}
                  <Select.Item value={section.id}>{section.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <div class="min-w-0 flex-1">
              <Dialog.Title class="text-base font-semibold text-base-content/82">
                {SETTINGS_SECTIONS.find((s) => s.id === settingsSection)?.label ?? 'Settings'}
              </Dialog.Title>
              <Dialog.Description class="text-xs text-base-content/38 mt-0.5">
                {#if settingsSection === 'session'}Defaults and behavior for session runs{:else if settingsSection === 'voice'}Speech synthesis and voice loop controls{:else if settingsSection === 'shortcuts'}Keyboard shortcuts available in the chat UI{:else}Runtime information and server controls{/if}
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
              {:else if settingsSection === 'voice'}
                <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
                  <div class="divide-y divide-base-content/8">
                    <div class="flex items-center gap-3 px-4 py-3">
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-base-content/75">Auto-speak responses</p>
                        <p class="text-xs text-base-content/35 mt-0.5">Speak assistant responses after each completed turn.</p>
                      </div>
                      <Switch checked={autoSpeak} onCheckedChange={(v) => { autoSpeak = v; if (!v) stopSpeaking(); }} disabled={wsState !== 'open'} aria-label="Toggle auto-speak" />
                    </div>
                    <div class="flex items-center gap-3 px-4 py-3">
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-base-content/75">Voice</p>
                        <p class="text-xs text-base-content/35 mt-0.5">Browser-provided speech synthesis voice.</p>
                      </div>
                      <Select.Root type="single" value={selectedVoiceURI} onValueChange={(v: string) => { selectedVoiceURI = v; try { localStorage.setItem('pifrontier:voice-uri', v); } catch { /* localStorage unavailable */ } }}>
                        <Select.Trigger size="sm" class="w-56 text-xs" disabled={speechVoices.length === 0}>{selectedVoice()?.name ?? 'Default voice'}</Select.Trigger>
                        <Select.Content>
                          {#each speechVoices as voice}
                            <Select.Item value={voice.voiceURI}>{voice.name} {voice.lang ? `(${voice.lang})` : ''}</Select.Item>
                          {/each}
                        </Select.Content>
                      </Select.Root>
                    </div>
                    <div class="px-4 py-3 space-y-3">
                      <div class="flex items-center gap-4">
                        <span class="w-20 text-sm text-base-content/65">Rate</span>
                        <input type="range" min="0.6" max="1.6" step="0.1" value={speechRate} oninput={(e) => { speechRate = Number(e.currentTarget.value); try { localStorage.setItem('pifrontier:speech-rate', String(speechRate)); } catch { /* localStorage unavailable */ } }} class="flex-1 accent-primary" />
                        <span class="w-10 text-right text-xs text-base-content/40 tabular-nums">{speechRate.toFixed(1)}</span>
                      </div>
                      <div class="flex items-center gap-4">
                        <span class="w-20 text-sm text-base-content/65">Pitch</span>
                        <input type="range" min="0.6" max="1.6" step="0.1" value={speechPitch} oninput={(e) => { speechPitch = Number(e.currentTarget.value); try { localStorage.setItem('pifrontier:speech-pitch', String(speechPitch)); } catch { /* localStorage unavailable */ } }} class="flex-1 accent-primary" />
                        <span class="w-10 text-right text-xs text-base-content/40 tabular-nums">{speechPitch.toFixed(1)}</span>
                      </div>
                    </div>
                  </div>
                </Card.Root>
              {:else if settingsSection === 'shortcuts'}
                <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
                  <div class="divide-y divide-base-content/8">
                    {#each SHORTCUTS as shortcut}
                      <div class="flex items-center gap-4 px-4 py-3">
                        <kbd class="min-w-32 rounded-lg border border-base-content/12 bg-base-content/[0.055] px-2 py-1 text-xs text-base-content/60 font-mono">{shortcut.keys}</kbd>
                        <span class="text-sm text-base-content/70">{shortcut.action}</span>
                      </div>
                    {/each}
                  </div>
                </Card.Root>
              {:else}
                <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
                  <div class="divide-y divide-base-content/8">
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
                        onclick={restartServer}
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


</div>
</Tooltip.Provider>

<!-- ── Restarting overlay ───────────────────────────────────────────────────── -->
{#if isRestarting}
  <div class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-base-100/90 backdrop-blur-sm gap-3">
    <p class="font-mono text-base-content/70 text-sm">restarting server…</p>
    <p class="font-mono text-base-content/35 text-xs">reconnecting automatically</p>
  </div>
{/if}

<!-- ── Toast notifications ─────────────────────────────────────────────────── -->
{#if toasts.length > 0}
  <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none" aria-live="polite">
    {#each toasts as toast (toast.id)}
      <div class="pointer-events-auto flex items-start gap-2 px-4 py-3 rounded-xl text-sm max-w-xs shadow-lg
        {toast.type === 'error' ? 'bg-error/90 text-error-content' : toast.type === 'warning' ? 'bg-warning/90 text-warning-content' : 'bg-base-content/90 text-base-100'}">
        <span class="flex-1 leading-relaxed">{toast.message}</span>
        <button onclick={() => dismissToast(toast.id)} class="shrink-0 opacity-50 hover:opacity-100 transition-opacity leading-none mt-0.5" aria-label="Dismiss">×</button>
      </div>
    {/each}
  </div>
{/if}

<!-- ── Extension UI modal ─────────────────────────────────────────────────────── -->
<Dialog.Root open={!!modal} onOpenChange={(v) => { if (!v && modal) modalCancel(); }}>
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
        {#each modal.options as opt}
          <button class="w-full text-left px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors" onclick={() => modalSelectOption(opt)}>{opt}</button>
        {/each}
      </div>
    {:else if modal?.method === 'editor'}
      <textarea bind:this={modalFocusEl} bind:value={modalInput} rows={8} class="w-full bg-transparent border border-border focus:border-foreground/60 outline-none p-3 text-sm leading-relaxed resize-none rounded-lg transition-colors"></textarea>
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={modalCancel}>cancel</Button>
      {#if modal?.method === 'confirm'}
        <Button size="sm" onclick={() => modalConfirm(true)}>confirm</Button>
      {:else if modal?.method === 'input' || modal?.method === 'editor'}
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
        {#each forkPoints as fp}
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

<FileViewerModal
  open={fileViewerOpen}
  path={fileViewerPath}
  line={fileViewerLine}
  content={fileViewerContent}
  loading={fileViewerLoading}
  error={fileViewerError}
  onclose={() => { fileViewerOpen = false; }}
  oninsert={() => {
    const ref = fileViewerPath.includes('/') ? fileViewerPath.split('/').pop() ?? fileViewerPath : fileViewerPath;
    input = input + `@${ref} `;
    fileViewerOpen = false;
    tick().then(() => { autoResizeTextarea(); inputEl?.focus(); });
  }}
/>
