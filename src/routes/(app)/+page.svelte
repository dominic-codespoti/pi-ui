<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';

  import type { ServerMessage, ClientMessage, ModelInfo, ProviderInfo, SessionSummary, SkillSummary, PromptSummary } from '$lib/ws/protocol';
  import { renderMarkdown, highlightCode } from '$lib/markdown';

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
      showModelPicker = false;
      showToolsPanel = false;
      showResourcesPanel = false;
    } else if (dx < 0 && touchStartX > window.innerWidth - 40) {
      // Swipe left from right edge → open model picker
      showModelPicker = true;
      showSessionPanel = false;
      showToolsPanel = false;
      showResourcesPanel = false;
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
  /** Whether the slash command menu is open. */
  let showSlashMenu = $state(false);
  /** Currently highlighted index in the slash command menu (-1 = none). */
  let slashMenuIndex = $state(-1);

  const filteredSlashCommands = $derived(
    input.startsWith('/') && !input.includes(' ')
      ? SLASH_COMMANDS.filter((c) => c.name.startsWith(input.slice(1).toLowerCase()))
      : []
  );
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

  // ── Panel state ──────────────────────────────────────────────────────────────

  let showModelPicker = $state(false);
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
  let sessions = $state<SessionSummary[]>([]);
  /** Filter text for sessions list */
  let sessionFilter = $state('');
  /** Path of the session currently being renamed inline (null = none) */
  let renamingPath = $state<string | null>(null);
  /** Draft name for inline rename */
  let renameDraft = $state('');
  /** Error from rename/delete operations */
  let sessionError = $state<string | null>(null);
  /** All sessions across all projects (from get_all_sessions). */
  let allSessions = $state<SessionSummary[]>([]);
  /** CWD of the project currently drilled into in the sidebar (null = project list view). */
  let selectedProject = $state<string | null>(null);
  /** Whether the open-folder path input is visible in the sidebar footer. */
  let openFolderMode = $state(false);
  /** Text typed in the open-folder input. */
  let openFolderInput = $state('');
  /** Directory completions returned by the server for openFolderInput. */
  let dirCompletions = $state<string[]>([]);

  const filteredSessions = $derived(
    sessionFilter.trim()
      ? sessions.filter(
          (s) =>
            (s.firstMessage ?? '').toLowerCase().includes(sessionFilter.toLowerCase()) ||
            (s.name ?? '').toLowerCase().includes(sessionFilter.toLowerCase())
        )
      : sessions
  );

  interface ProjectGroup { cwd: string; basename: string; sessions: SessionSummary[]; lastModified: number; }

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

  const filteredProjects = $derived(
    sessionFilter.trim()
      ? projects.filter((p) =>
          p.basename.toLowerCase().includes(sessionFilter.toLowerCase()) ||
          p.cwd.toLowerCase().includes(sessionFilter.toLowerCase())
        )
      : projects
  );

  const projectSessions = $derived(
    selectedProject != null ? allSessions.filter((s) => s.cwd === selectedProject) : []
  );

  const filteredProjectSessions = $derived(
    sessionFilter.trim()
      ? projectSessions.filter(
          (s) =>
            (s.firstMessage ?? '').toLowerCase().includes(sessionFilter.toLowerCase()) ||
            (s.name ?? '').toLowerCase().includes(sessionFilter.toLowerCase())
        )
      : projectSessions
  );

  /** Whether the tools panel is open */
  let showToolsPanel = $state(false);
  /** All tools reported by the server */
  let toolsList = $state<{ name: string; description: string; isBuiltin: boolean }[]>([]);
  /** Names of currently active/enabled tools */
  let activeToolNames = $state<string[]>([]);

  /** Whether the resources panel (skills + prompts) is open */
  let showResourcesPanel = $state(false);
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

  /** Whether the next non-streaming send is a follow_up or a fresh prompt */
  let inputMode = $state<'prompt' | 'follow_up'>('prompt');

  /** Which tab is active inside the model picker panel */
  let modelTab = $state<'models' | 'providers'>('models');
  let providers = $state<ProviderInfo[]>([]);
  /** Staged key text per provider id — cleared on successful save */
  let providerKeyInputs = $state<Record<string, string>>({});
  /** Filter text for the providers list */
  let providerFilter = $state('');
  /** Filter text for the models list */
  let modelFilter = $state('');
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

  // ── DOM refs ─────────────────────────────────────────────────────────────────

  let scrollEl = $state<HTMLElement | undefined>(undefined);
  let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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

  // ── Load providers when model picker opens ────────────────────────────────────

  $effect(() => {
    if (showModelPicker) {
      send({ type: 'get_providers' });
      modelFilter = '';
    }
  });

  // ── Load tools when tools panel opens ─────────────────────────────────────────

  $effect(() => {
    if (showToolsPanel) {
      send({ type: 'get_tools' });
    }
  });

  // ── Load resources when resources panel opens ─────────────────────────────────

  $effect(() => {
    if (showResourcesPanel) {
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
    // Build a map of toolCallId → { name, input } from assistant tool_use blocks
    // so replayed toolResult messages can show their input args.
    const toolInputMap = new Map<string, { name: string; input: Record<string, unknown> }>();
    for (const m of payload.messages ?? []) {
      const raw = m as Record<string, unknown>;
      if (raw.role === 'assistant' && Array.isArray(raw.content)) {
        for (const blk of raw.content as { type: string; id?: string; name?: string; input?: Record<string, unknown> }[]) {
          if (blk.type === 'tool_use' && blk.id && blk.name) {
            toolInputMap.set(blk.id, { name: blk.name, input: blk.input ?? {} });
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
    lastInputTokens = 0;
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
        };
        applySessionState(sl);
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
        sessions = ((msg as { type: string; sessions: SessionSummary[] }).sessions) ?? [];
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

      case 'agent_end':
        isStreaming = false;
        sealStreaming();
        break;

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

      case 'server_restarting': {
        isRestarting = true;
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

  // ── Model & session actions ──────────────────────────────────────────────────

  function selectModel(m: ModelInfo) {
    send({ type: 'set_model', provider: m.provider, modelId: m.id });
    showModelPicker = false;
  }

  function pickThinkingLevel(level: string) {
    thinkingLevel = level; // optimistic
    send({ type: 'set_thinking_level', level });
  }

  function switchSession(path: string) {
    send({ type: 'switch_session', path });
    showSessionPanel = false;
  }

  function newSession(targetCwd?: string) {
    send(targetCwd ? { type: 'new_session', targetCwd } : { type: 'new_session' });
    showSessionPanel = false;
    selectedProject = null;
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
    const day = 86_400_000;
    if (diff < day) return 'today';
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
      const p = str(details.path ?? details.file_path);
      if (!p) return undefined;
      const offset = num(details.offset);
      const limit = num(details.limit);
      if (offset !== undefined) {
        const end = limit !== undefined ? offset + limit - 1 : '';
        return `${p}:${offset}${end ? `–${end}` : '+'}`;
      }
      return p;
    }
    if (toolName === 'write' || toolName === 'write_file') {
      return str(details.path ?? details.file_path);
    }
    if (toolName === 'edit') {
      const p = str(details.path ?? details.file_path);
      const edits = Array.isArray(details.edits) ? details.edits.length : undefined;
      if (p && edits !== undefined && edits > 1) return `${p} (${edits} edits)`;
      return p;
    }
    if (toolName === 'grep') {
      const pattern = str(details.pattern);
      const path = str(details.path);
      const glob = str(details.glob);
      if (!pattern) return undefined;
      const loc = path ?? glob ?? '';
      return loc ? `/${pattern}/ in ${loc}` : `/${pattern}/`;
    }
    if (toolName === 'find') {
      const pattern = str(details.pattern);
      const path = str(details.path);
      if (!pattern) return undefined;
      return path ? `${pattern} in ${path}` : pattern;
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
            content: output,
            isError: typeof msg.exitCode === 'number' && (msg.exitCode as number) !== 0,
            streaming: false,
          },
        ];
      }
      case 'toolResult': {
        const toolCallId = msg.toolCallId as string | undefined;
        const toolInfo = toolCallId ? toolInputMap?.get(toolCallId) : undefined;
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
      if (showModelPicker) { e.preventDefault(); showModelPicker = false; return; }
      if (showToolsPanel) { e.preventDefault(); showToolsPanel = false; return; }
      if (showResourcesPanel) { e.preventDefault(); showResourcesPanel = false; return; }
      return;
    }

    // Ctrl+/ — toggle sessions panel
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      showSessionPanel = !showSessionPanel;
      if (showSessionPanel && showModelPicker) showModelPicker = false;
      return;
    }

    // Ctrl+K — toggle model picker
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      showModelPicker = !showModelPicker;
      if (showModelPicker) {
        showSessionPanel = false;
        showToolsPanel = false;
        showResourcesPanel = false;
      }
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

  function selectSlashCommand(name: string) {
    input = `/${name} `;
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

  function submitMessage() {
    if (wsState !== 'open') return;
    const text = input.trim();

    if (isStreaming) {
      if (!text) return;
      steerAgent();
      return;
    }

    if (!text && attachedImages.length === 0) return;

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

    if (inputMode === 'follow_up') {
      send({ type: 'follow_up', message: text });
    } else {
      send({ type: 'prompt', message: text, ...(imgs ? { images: imgs } : {}) });
    }
    input = '';
    attachedImages = [];
    resetTextareaHeight();
    scrollBottom();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (showSlashMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashMenuIndex = (slashMenuIndex + 1) % filteredSlashCommands.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashMenuIndex = (slashMenuIndex - 1 + filteredSlashCommands.length) % filteredSlashCommands.length;
        return;
      }
      if (e.key === 'Enter' && slashMenuIndex >= 0) {
        e.preventDefault();
        selectSlashCommand(filteredSlashCommands[slashMenuIndex].name);
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

  function toggleAutoCompaction() {
    autoCompactionEnabled = !autoCompactionEnabled; // optimistic
    send({ type: 'set_auto_compaction', enabled: autoCompactionEnabled });
  }

  function toggleAutoRetry() {
    autoRetryEnabled = !autoRetryEnabled; // optimistic
    send({ type: 'set_auto_retry', enabled: autoRetryEnabled });
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
    showSlashMenu = !isStreaming && input.startsWith('/') && !input.includes(' ') && filteredSlashCommands.length > 0;
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
  });

  onDestroy(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
    if (_mq && _mqHandler) _mq.removeEventListener('change', _mqHandler);
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
<div
  role="application"
  aria-label="pi chat"
  class="flex flex-row h-dvh text-base-content font-mono text-base select-none overflow-hidden"
  ontouchstart={handleTouchStart}
  ontouchend={handleTouchEnd}
>

  <!-- ── LEFT SIDEBAR: Session panel ─────────────────────────────────────── -->

  <!-- Mobile backdrop (tap to dismiss) -->
  {#if isMobile && showSessionPanel}
    <div
      class="fixed inset-0 z-30 bg-base-100/60 backdrop-blur-[2px]"
      onclick={() => (showSessionPanel = false)}
      aria-hidden="true"
      role="presentation"
    ></div>
  {/if}

  <div
    class={isMobile ? 'fixed inset-y-0 left-0 z-40 flex flex-col' : 'relative shrink-0 overflow-hidden'}
    style={isMobile
      ? `width: min(${sessionPanelWidth}px, 90vw); transform: translateX(${showSessionPanel ? '0' : '-100%'}); transition: transform 220ms cubic-bezier(0.33,1,0.68,1); padding-top: env(safe-area-inset-top, 0px);`
      : `width: ${showSessionPanel ? sessionPanelWidth + 'px' : '0'}; transition: ${sessionResizing ? 'none' : 'width 220ms cubic-bezier(0.33,1,0.68,1)'};`}
    aria-hidden={!showSessionPanel}
  >
    <!-- Fixed-width inner panel -->
    <div class="w-full h-full bg-base-200 border-r border-base-content/15 flex flex-col">

      <!-- Panel header -->
      <div class="shrink-0 px-4 py-3 border-b border-base-content/15 flex items-center justify-between bg-base-200">
        {#if selectedProject !== null}
          <div class="flex items-center gap-2 min-w-0">
            <button
              onclick={() => { selectedProject = null; sessionFilter = ''; }}
              class="w-8 h-8 flex items-center justify-center text-base-content/50 hover:text-base-content hover:bg-base-content/8 rounded-lg transition-colors shrink-0"
              aria-label="Back to projects"
              tabindex={showSessionPanel ? 0 : -1}
            ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>
            <span class="text-sm text-base-content/60 uppercase tracking-wider font-medium truncate">
              {selectedProject.split('/').filter(Boolean).pop() ?? selectedProject}
            </span>
          </div>
        {:else}
          <span class="text-sm text-base-content/60 uppercase tracking-wider font-medium">
            projects{projects.length ? ` (${projects.length})` : ''}
          </span>
        {/if}
        <button
          onclick={() => (showSessionPanel = false)}
          class="w-10 h-10 flex items-center justify-center text-base-content/55 hover:text-base-content hover:bg-base-content/8 rounded-lg transition-colors shrink-0"
          aria-label="Close session panel"
          tabindex={showSessionPanel ? 0 : -1}
        ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>

      <!-- Filter input — capsule with search icon -->
      <div class="shrink-0 px-3 py-3">
        <div class="flex items-center gap-2 bg-base-content/6 rounded-xl px-3 py-2.5">
          <svg class="w-4 h-4 shrink-0 text-base-content/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input
            type="search"
            placeholder={selectedProject !== null ? 'search sessions…' : 'search projects…'}
            bind:value={sessionFilter}
            class="flex-1 bg-transparent outline-none text-sm placeholder-base-content/30 text-base-content/80 min-w-0"
            aria-label={selectedProject !== null ? 'Filter sessions' : 'Filter projects'}
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

      <!-- Scrollable content area -->
      <div class="flex-1 overflow-y-auto px-2 pb-2">
        {#if selectedProject === null}
          <!-- ── PROJECT LIST ─────────────────────────────────────────────── -->
          {#if filteredProjects.length === 0 && projects.length === 0}
            <div class="flex flex-col items-center justify-center gap-2 py-12 px-4 text-center">
              <svg class="w-8 h-8 text-base-content/15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
              <p class="text-sm text-base-content/35 font-medium">No projects yet</p>
              <p class="text-xs text-base-content/25">Open a folder below to start</p>
            </div>
          {:else if filteredProjects.length === 0}
            <div class="flex flex-col items-center justify-center gap-1.5 py-10 px-4 text-center">
              <p class="text-sm text-base-content/35">No match</p>
              <p class="text-xs text-base-content/25">Try a different search term</p>
            </div>
          {:else}
            <div class="flex flex-col gap-0.5 pt-1">
              {#each filteredProjects as p}
                {@const isActive = p.cwd === cwd}
                <div class="group rounded-xl {isActive ? 'bg-primary/8 ring-1 ring-primary/15' : 'hover:bg-base-content/4'} transition-colors">
                  <button
                    onclick={() => { selectedProject = p.cwd; sessionFilter = ''; }}
                    class="w-full text-left px-3 py-2.5"
                    tabindex={showSessionPanel ? 0 : -1}
                  >
                    <p class="text-sm truncate leading-snug {isActive ? 'text-base-content font-medium' : 'text-base-content/70'}">
                      {p.basename}
                    </p>
                    <p class="text-xs text-base-content/30 mt-0.5 truncate">{p.cwd}</p>
                    <p class="text-xs text-base-content/25 mt-0.5">{p.sessions.length} session{p.sessions.length !== 1 ? 's' : ''} · {formatDate(p.lastModified)}</p>
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          <!-- Open-folder path expander -->
          {#if openFolderMode}
            <div class="mt-2 px-1">
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
            </div>
          {/if}

        {:else}
          <!-- ── PROJECT SESSIONS ─────────────────────────────────────────── -->
          {#if filteredProjectSessions.length === 0 && projectSessions.length === 0}
            <div class="flex flex-col items-center justify-center gap-2 py-12 px-4 text-center">
              <svg class="w-8 h-8 text-base-content/15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <p class="text-sm text-base-content/35 font-medium">No sessions here</p>
              <p class="text-xs text-base-content/25">Create one below</p>
            </div>
          {:else if filteredProjectSessions.length === 0}
            <div class="flex flex-col items-center justify-center gap-1.5 py-10 px-4 text-center">
              <p class="text-sm text-base-content/35">No match</p>
              <p class="text-xs text-base-content/25">Try a different search term</p>
            </div>
          {:else}
            <div class="flex flex-col gap-0.5 pt-1">
              {#each filteredProjectSessions as s}
                {@const isActive = sessionId === s.id}
                {@const isRenaming = renamingPath === s.path}
                <div class="group rounded-xl {isActive ? 'bg-primary/8 ring-1 ring-primary/15' : 'hover:bg-base-content/4'} transition-colors">
                  {#if isRenaming}
                    <!-- svelte-ignore a11y_autofocus -->
                    <div class="px-3 py-2.5 flex items-center gap-2">
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
                      <button onclick={commitRename} class="w-8 h-8 flex items-center justify-center text-primary/70 hover:text-primary hover:bg-primary/8 rounded-lg transition-colors" aria-label="Confirm rename"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></button>
                      <button onclick={cancelRename} class="w-8 h-8 flex items-center justify-center text-base-content/35 hover:text-base-content/70 hover:bg-base-content/8 rounded-lg transition-colors" aria-label="Cancel rename"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                    </div>
                  {:else}
                    <div class="flex items-stretch">
                      <button
                        onclick={() => switchSession(s.path)}
                        class="flex-1 text-left px-3 py-3 min-w-0"
                        aria-current={isActive ? 'true' : undefined}
                        tabindex={showSessionPanel ? 0 : -1}
                      >
                        <p class="text-sm truncate leading-snug {isActive ? 'text-base-content font-medium' : 'text-base-content/70'}">
                          {s.name ? s.name : (s.firstMessage || '(empty)')}
                        </p>
                        {#if s.name && s.firstMessage}
                          <p class="text-xs text-base-content/35 mt-0.5 truncate">{s.firstMessage}</p>
                        {/if}
                        <p class="text-xs text-base-content/30 mt-0.5">{formatDate(s.modified)}</p>
                      </button>
                      <!-- Actions — visible on row hover only -->
                      <div class="flex flex-col justify-center gap-0.5 pr-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onclick={() => startRename(s)} class="w-8 h-8 flex items-center justify-center text-base-content/40 hover:text-base-content/70 hover:bg-base-content/8 rounded-lg transition-colors" title="Rename" aria-label="Rename session" tabindex={showSessionPanel ? 0 : -1}><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>
                        {#if !isActive}
                          <button onclick={() => deleteSession(s.path)} class="w-8 h-8 flex items-center justify-center text-base-content/30 hover:text-error hover:bg-error/8 rounded-lg transition-colors" title="Delete" aria-label="Delete session" tabindex={showSessionPanel ? 0 : -1}><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>
                        {/if}
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>

      <!-- Footer -->
      <div class="shrink-0 p-3 pt-2">
        {#if selectedProject === null}
          <!-- Open-folder toggle -->
          <button
            onclick={() => { openFolderMode = !openFolderMode; openFolderInput = ''; dirCompletions = []; }}
            class="w-full flex items-center justify-center gap-2 text-sm text-base-content/50 hover:text-base-content/80 transition-colors py-3 bg-base-content/4 hover:bg-base-content/7 rounded-xl"
            tabindex={showSessionPanel ? 0 : -1}
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
            <span>{openFolderMode ? 'cancel' : 'open folder…'}</span>
          </button>
        {:else}
          <!-- New session in this project -->
          <button
            onclick={() => newSession(selectedProject ?? undefined)}
            class="w-full flex items-center justify-center gap-2 text-sm text-base-content/50 hover:text-base-content/80 transition-colors py-3 bg-base-content/4 hover:bg-base-content/7 rounded-xl"
            tabindex={showSessionPanel ? 0 : -1}
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            <span>new session</span>
          </button>
        {/if}
      </div>
    </div>
    <!-- Drag handle — right edge, desktop only -->
    {#if !isMobile}
      <div
        class="absolute top-0 right-0 bottom-0 w-1.5 z-10 cursor-col-resize hover:bg-primary/25 active:bg-primary/40 transition-colors"
        onpointerdown={startSessionResize}
        onpointermove={onSessionResizeMove}
        onpointerup={stopSessionResize}
        onpointercancel={stopSessionResize}
        aria-hidden="true"
      ></div>
    {/if}
  </div>

  <!-- ── MAIN COLUMN ──────────────────────────────────────────────────────── -->
  <div class="flex-1 flex flex-col min-w-0 bg-base-100 relative">

    <!-- Header -->
    <header
      class="shrink-0 flex items-center gap-3 px-3 border-b border-base-content/10 bg-base-200/40"
      style="padding-top: max(0.5rem, env(safe-area-inset-top, 0px)); padding-bottom: 0.5rem;"
    >

      <!-- Left: sessions toggle -->
      <div class="flex items-center shrink-0">
        <button
          onclick={() => { showSessionPanel = !showSessionPanel; showModelPicker = false; showToolsPanel = false; showResourcesPanel = false; }}
          class="flex items-center justify-center w-11 h-11 text-xl transition-colors rounded-lg {showSessionPanel ? 'text-primary bg-primary/10' : 'text-base-content/55 hover:text-base-content/80 hover:bg-base-content/5'}"
          title="Sessions"
          aria-label="Toggle session panel"
          aria-expanded={showSessionPanel}
        ><svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg></button>
      </div>

      <!-- Centre: model selector -->
      <div class="flex-1 flex justify-center min-w-0 px-2">
        <button
          onclick={() => { showModelPicker = !showModelPicker; showSessionPanel = false; showToolsPanel = false; showResourcesPanel = false; }}
          class="flex items-center gap-2 text-sm transition-colors truncate max-w-full group min-h-11 px-3 rounded-lg {showModelPicker ? 'text-primary bg-primary/10' : 'text-base-content/70 hover:text-base-content/95 hover:bg-base-content/5'}"
          title="Select model"
          aria-label="Select model"
          aria-expanded={showModelPicker}
        >
          {#if model}
            <span class="truncate">{model.name}</span>
            {#if model.reasoning && thinkingLevel !== 'off'}
              <span class="shrink-0 text-xs text-base-content/40 font-normal">[{thinkingLevel}]</span>
            {/if}
          {:else}
            <span class="text-base-content/40">no model</span>
          {/if}
          <span class="shrink-0 text-base-content/35 group-hover:text-base-content/55 transition-colors"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>
        </button>
      </div>

      <!-- Right: resources + tools + fork button -->
      <div class="flex items-center gap-3 shrink-0 pr-1">
        <button
          onclick={() => { showResourcesPanel = !showResourcesPanel; showModelPicker = false; showSessionPanel = false; showToolsPanel = false; }}
          class="flex items-center justify-center w-8 h-8 transition-colors rounded-lg {showResourcesPanel ? 'text-primary bg-primary/10' : 'text-base-content/35 hover:text-base-content/70 hover:bg-base-content/5'}"
          title="Skills &amp; Prompts"
          aria-label="Toggle resources panel"
          aria-expanded={showResourcesPanel}
        ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></button>
        <button
          onclick={() => { showToolsPanel = !showToolsPanel; showModelPicker = false; showSessionPanel = false; showResourcesPanel = false; }}
          class="flex items-center justify-center w-8 h-8 transition-colors rounded-lg {showToolsPanel ? 'text-primary bg-primary/10' : 'text-base-content/35 hover:text-base-content/70 hover:bg-base-content/5'}"
          title="Tools"
          aria-label="Toggle tools panel"
          aria-expanded={showToolsPanel}
        ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></button>
        <button
          onclick={openForkDialog}
          class="flex items-center justify-center w-8 h-8 text-base-content/35 hover:text-base-content/70 hover:bg-base-content/5 rounded-lg transition-colors"
          title="Fork session from a message"
          aria-label="Fork session"
          disabled={isStreaming}
        ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v4"/><path d="M18 3v4"/><path d="M6 7a6 6 0 0 0 6 6 6 6 0 0 0 6-6"/><path d="M12 13v8"/></svg></button>
      </div>
    </header>

    <!-- Message list -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <main
      bind:this={scrollEl}
      onscroll={handleScroll}
      onclick={handleCodeCopy}
      onkeydown={handleCodeCopy}
      role="region"
      aria-label="Conversation"
      class="flex-1 overflow-y-auto py-6"
      style="overflow-anchor: none; overscroll-behavior: contain;"
    >
      {#if messages.length === 0 && wsState === 'open'}
        <div class="min-h-full flex flex-col items-center justify-center gap-3 select-none pointer-events-none">
          <span class="text-8xl font-light text-base-content/[0.08]">π</span>
          <p class="text-sm text-base-content/30">start a conversation</p>
        </div>
      {:else}
        <div class="max-w-3xl mx-auto px-4 flex flex-col gap-4">
          {#each messages as msg (msg.id)}

            {#if msg.role === 'user'}
              <div class="flex justify-end group">
                <div class="max-w-[82%] space-y-1">
                  <div class="bg-base-content/[0.10] rounded-2xl rounded-br-sm px-4 py-3 space-y-2">
                    {#if msg.images?.length}
                      <div class="flex gap-2 flex-wrap -mx-1">
                        {#each msg.images as src}
                          <img {src} alt="attachment" class="max-h-48 max-w-full rounded-lg object-contain" />
                        {/each}
                      </div>
                    {/if}
                    {#if msg.content}
                      <p class="whitespace-pre-wrap break-words leading-relaxed text-base-content/90 select-text">{msg.content}</p>
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

            {:else if msg.role === 'assistant'}
              <div class="space-y-1 group">

                <!-- METADATA ROW -->
                <div class="flex items-center gap-2 text-xs text-base-content/35 select-none">
                  <span class="text-primary/60 font-medium uppercase tracking-wider" style="font-size:10px">pi</span>
                  {#if msg.streaming}
                    {#if msg.thinking && msg.thinking.length > 0}
                      <span class="text-base-content/25">· ~{fmtTokens(Math.round(msg.thinking.length / 4))}t thinking</span>
                    {:else if !msg.content}
                      <span class="text-base-content/20">· thinking…</span>
                    {/if}
                  {:else if msg.thinking}
                    <!-- Folded thought toggle — replaces the old box -->
                    <button
                      onclick={() => { msg.thinkingExpanded = !msg.thinkingExpanded; }}
                      class="text-base-content/30 hover:text-base-content/55 transition-colors"
                      aria-expanded={msg.thinkingExpanded}
                    >[thought{msg.endMs && msg.thinkingStartMs ? ` for ${fmtDuration(msg.endMs - msg.thinkingStartMs)}` : ''}]</button>
                  {/if}
                  {#if msg.usage && !msg.streaming}
                    <span class="ml-auto flex items-center gap-1.5 select-text">
                      <span>{fmtTokens(msg.usage.totalTokens)}t</span>
                      {#if msg.usage.cost.total > 0}<span>· {fmtCost(msg.usage.cost.total)}</span>{/if}
                      {#if msg.startMs && msg.endMs}<span>· {fmtDuration(msg.endMs - msg.startMs)}</span>{/if}
                      <button
                        onclick={() => { msg.detailExpanded = !msg.detailExpanded; }}
                        class="text-base-content/25 hover:text-base-content/50 transition-colors ml-0.5"
                        style="display:inline-flex;transition:transform 0.15s;{msg.detailExpanded ? 'transform:rotate(180deg)' : ''}"
                        aria-label="Toggle message detail"
                      ><svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
                    </span>
                  {/if}
                </div>

                <!-- DETAIL PANEL (per-message tokens / cost / latency) -->
                {#if msg.detailExpanded && msg.usage}
                  <div class="text-xs text-base-content/30 bg-base-content/[0.03] rounded-lg px-3 py-2 flex flex-wrap gap-x-4 gap-y-0.5 select-text">
                    <span>in {fmtTokens(msg.usage.input)}t</span>
                    <span>out {fmtTokens(msg.usage.output)}t</span>
                    <span>total {fmtTokens(msg.usage.totalTokens)}t</span>
                    {#if msg.usage.cost.total > 0}<span>{fmtCost(msg.usage.cost.total)}</span>{/if}
                    {#if msg.startMs && msg.endMs}<span>{fmtDuration(msg.endMs - msg.startMs)}</span>{/if}
                  </div>
                {/if}

                <!-- EXPANDED THINKING BLOCK -->
                {#if msg.thinkingExpanded && msg.thinking}
                  <pre class="text-xs text-base-content/35 whitespace-pre-wrap break-words max-h-72 overflow-y-auto leading-relaxed bg-base-content/[0.03] rounded-lg px-3 py-2 select-text">{msg.thinking}</pre>
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

                <!-- ACTIONS -->
                {#if msg.content && !msg.streaming}
                  <div class="flex justify-start {isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity duration-150">
                    <button
                      onclick={() => copyMessage(msg)}
                      class="flex items-center justify-center w-7 h-7 text-base-content/30 hover:text-base-content/60 rounded transition-colors select-none"
                      aria-label="Copy message"
                    >{#if copiedId === msg.id}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{:else}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>{/if}</button>
                  </div>
                {/if}
              </div>

            {:else if msg.role === 'tool'}
              <div class="bg-base-content/[0.04] rounded-xl overflow-hidden text-sm">
                <div class="flex items-center gap-2 px-3 py-2.5 bg-base-200/50">
                  <span class="text-base-content/45 font-medium shrink-0 text-xs">[{msg.toolName ?? 'tool'}]</span>
                  {#if msg.toolInput}
                    <span class="text-base-content/50 font-mono truncate flex-1 min-w-0 text-xs">{msg.toolInput}</span>
                  {/if}
                  <div class="flex items-center gap-2 shrink-0 ml-auto">
                    {#if msg.streaming}
                      <span class="text-base-content/35 animate-pulse text-xs">running…</span>
                    {:else if msg.isError}
                      <span class="text-error/70 text-xs">error</span>
                      {#if msg.content}
                        <button onclick={() => copyToolOutput(msg)} class="w-8 h-8 flex items-center justify-center text-base-content/30 hover:text-base-content/60 hover:bg-base-content/5 rounded transition-colors" aria-label="Copy tool output">{#if copiedId === msg.id}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{:else}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>{/if}</button>
                        <button onclick={() => { msg.expanded = !msg.expanded; }} class="w-8 h-8 flex items-center justify-center text-base-content/40 hover:text-base-content/70 hover:bg-base-content/5 rounded transition-colors" aria-label="{msg.expanded ? 'Collapse' : 'Expand'} tool output">{#if msg.expanded}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>{:else}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>{/if}</button>
                      {/if}
                    {:else if msg.content || msg.diff}
                      {#if msg.lineCount !== undefined && !msg.expanded}
                        <span class="text-base-content/25 text-xs">{msg.lineCount}L</span>
                      {/if}
                      {#if msg.content}
                        <button onclick={() => copyToolOutput(msg)} class="w-8 h-8 flex items-center justify-center text-base-content/30 hover:text-base-content/60 hover:bg-base-content/5 rounded transition-colors" aria-label="Copy tool output">{#if copiedId === msg.id}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{:else}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>{/if}</button>
                      {/if}
                      <button onclick={() => { msg.expanded = !msg.expanded; }} class="w-8 h-8 flex items-center justify-center text-base-content/40 hover:text-base-content/70 hover:bg-base-content/5 rounded transition-colors" aria-label="{msg.expanded ? 'Collapse' : 'Expand'} tool output">{#if msg.expanded}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>{:else}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>{/if}</button>
                    {:else}
                      <span class="text-base-content/30 text-xs">done</span>
                    {/if}
                  </div>
                </div>
                {#if msg.expanded || msg.streaming}
                  {#if msg.diff}
                    <!-- Diff view for edit tool -->
                    <div class="px-3 py-2.5 text-xs font-mono leading-relaxed border-t border-base-content/[0.08] bg-base-200/30 max-h-72 overflow-y-auto select-text">
                      {#each msg.diff.split('\n') as line}
                        {#if line.startsWith('+')}
                          <div class="text-success/70 whitespace-pre-wrap break-all">{line}</div>
                        {:else if line.startsWith('-')}
                          <div class="text-error/60 whitespace-pre-wrap break-all">{line}</div>
                        {:else if line.startsWith('@')}
                          <div class="text-base-content/30 whitespace-pre-wrap break-all">{line}</div>
                        {:else}
                          <div class="text-base-content/45 whitespace-pre-wrap break-all">{line}</div>
                        {/if}
                      {/each}
                    </div>
                  {:else if msg.content}
                    {@const toolLang = getToolLang(msg.toolName, msg.toolInput)}
                    {#if toolLang}
                      <pre class="px-3 py-2.5 text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto leading-relaxed border-t border-base-content/[0.08] bg-base-200/30 select-text"><code class="hljs">{@html highlightCode(msg.content, toolLang)}</code></pre>
                    {:else}
                      <pre class="px-3 py-2.5 text-base-content/45 text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto leading-relaxed border-t border-base-content/[0.08] bg-base-200/30 select-text">{msg.content}</pre>
                    {/if}
                  {/if}
                {/if}
              </div>

            {:else if msg.role === 'notice'}
              <div class="flex items-center gap-3 text-xs text-base-content/25 select-none my-1">
                <span class="flex-1 h-px bg-base-content/[0.08]"></span>
                <span class="flex items-center gap-1.5 shrink-0">
                  {#if msg.streaming}
                    <svg class="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  {:else if msg.noticeKind === 'compaction'}
                    <span aria-hidden="true">✦</span>
                  {:else if msg.noticeKind === 'retry'}
                    <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                  {/if}
                  <span>{msg.content}</span>
                </span>
                <span class="flex-1 h-px bg-base-content/[0.08]"></span>
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

    <!-- Status bar -->
    {#if cwd || contextPercent > 0 || sessionCostTotal > 0}
      <div class="shrink-0 px-4 py-1 flex items-center gap-3 text-xs text-base-content/30 border-t border-base-content/[0.06] bg-base-100 select-none overflow-hidden">
        {#if cwd}
          <span class="truncate min-w-0" title={cwd}>{cwdBasename}</span>
        {/if}
        {#if sessionName}
          {#if isEditingSessionName}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              autofocus
              type="text"
              bind:value={sessionNameDraft}
              onblur={commitSessionNameEdit}
              onkeydown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitSessionNameEdit(); }
                if (e.key === 'Escape') { e.preventDefault(); isEditingSessionName = false; }
              }}
              class="text-xs text-base-content/45 bg-transparent border-b border-base-content/20 focus:border-base-content/45 outline-none truncate min-w-0 max-w-[10rem] transition-colors"
              aria-label="Session name"
            />
          {:else}
            <button
              onclick={startSessionNameEdit}
              class="text-xs text-base-content/25 hover:text-base-content/50 truncate min-w-0 transition-colors text-left"
              title="Click to rename session"
              aria-label="Session name: {sessionName}. Click to rename."
            >{sessionName}</button>
          {/if}
        {/if}
        <span class="ml-auto flex items-center gap-3 shrink-0">
          {#if contextPercent > 0}
            <span title="context window usage">{contextPercent}%</span>
          {/if}
          {#if sessionCostTotal > 0}
            <span>{fmtCost(sessionCostTotal)}</span>
          {/if}
        </span>
      </div>
    {/if}

    <!-- Input bar — elevated surface to distinguish from chat -->
    <footer
      class="shrink-0 border-t border-base-content/15 bg-base-200/40 pt-3"
      style="padding-bottom: max(0.75rem, env(safe-area-inset-bottom, 0px));"
    >
      <div class="max-w-3xl mx-auto px-4">
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
            <div class="bg-base-200 border border-base-content/10 rounded-xl overflow-hidden shadow-lg max-h-52 overflow-y-auto" role="listbox" aria-label="Slash commands">
              {#each filteredSlashCommands as cmd, i}
                <button
                  onclick={() => selectSlashCommand(cmd.name)}
                  role="option"
                  aria-selected={slashMenuIndex === i}
                  class="w-full text-left px-3 py-2.5 transition-colors flex items-baseline gap-3 {slashMenuIndex === i ? 'bg-base-content/10' : 'hover:bg-base-content/8'}"
                >
                  <span class="text-sm font-mono text-primary shrink-0">/{cmd.name}</span>
                  <span class="text-xs text-base-content/40 truncate">{cmd.description}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

      <div class="bg-base-100 rounded-2xl px-3 py-2 flex flex-col gap-2">
        {#if !isStreaming && wsState === 'open'}
          <!-- Mode pill chips at the top of the input box -->
          <div class="flex items-center gap-1 -mb-0.5">
            <button onclick={() => (inputMode = 'prompt')} aria-pressed={inputMode === 'prompt'} class="text-xs px-2 py-0.5 rounded-full transition-colors {inputMode === 'prompt' ? 'bg-base-content/8 text-base-content/60' : 'text-base-content/25 hover:text-base-content/45'}">prompt</button>
            <button onclick={() => (inputMode = 'follow_up')} aria-pressed={inputMode === 'follow_up'} class="text-xs px-2 py-0.5 rounded-full transition-colors {inputMode === 'follow_up' ? 'bg-base-content/8 text-base-content/60' : 'text-base-content/25 hover:text-base-content/45'}">follow up</button>
          </div>
        {/if}
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
        <div class="flex gap-2 items-end">
        <textarea
          bind:this={inputEl}
          bind:value={input}
          onkeydown={handleKeydown}
          oninput={autoResizeTextarea}
          rows={1}
          placeholder={wsState !== 'open' ? wsState + '…' : isStreaming ? 'steer pi…' : 'message pi…'}
          aria-label="Message to pi"
          disabled={wsState !== 'open'}
          class="flex-1 bg-transparent resize-none outline-none placeholder-base-content/35 disabled:opacity-40 leading-relaxed max-h-48 overflow-y-auto transition-opacity text-base"
          style="field-sizing: content"
        ></textarea>

        {#if isStreaming}
          <div class="flex gap-1 items-center pb-0.5">
            {#if input.trim()}
              <button onclick={steerAgent} class="w-9 h-9 flex items-center justify-center text-warning/80 hover:text-warning hover:bg-warning/10 rounded-full transition-colors" title="Steer (Enter)" aria-label="Steer pi"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button>
            {/if}
            <button onclick={abortGeneration} class="w-9 h-9 flex items-center justify-center text-base-content/60 hover:text-base-content/90 hover:bg-base-content/8 rounded-full transition-colors" title="Abort" aria-label="Abort generation"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>
          </div>
        {:else}
          <div class="flex gap-1 items-center pb-0.5">
            <button
              onclick={() => fileInputEl?.click()}
              disabled={wsState !== 'open'}
              class="w-9 h-9 flex items-center justify-center text-base-content/35 hover:text-base-content/60 hover:bg-base-content/8 rounded-full transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default"
              title="Attach image"
              aria-label="Attach image"
            ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
            {#if isCompacting}
              <span class="w-9 h-9 flex items-center justify-center text-base-content/20 animate-pulse">
                <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              </span>
            {:else}
              <button
                onclick={compactSession}
                disabled={wsState !== 'open'}
                class="w-9 h-9 flex items-center justify-center text-base-content/30 hover:text-base-content/55 hover:bg-base-content/8 rounded-full transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default"
                title="Compact context"
                aria-label="Compact context"
              ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg></button>
            {/if}
            <button
              onclick={submitMessage}
              disabled={(!input.trim() && attachedImages.length === 0) || wsState !== 'open'}
              class="w-9 h-9 flex items-center justify-center rounded-full transition-colors shrink-0 {(input.trim() || attachedImages.length > 0) && wsState === 'open' ? 'bg-base-content text-base-100' : 'bg-base-content/12 text-base-content/30'} disabled:cursor-default"
              title="{inputMode === 'follow_up' ? 'Follow up' : 'Send'} (Enter)"
              aria-label="{inputMode === 'follow_up' ? 'Follow up' : 'Send'}"
            ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m0 0-7 7m7-7 7 7"/></svg></button>
          </div>
        {/if}
        </div>
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

      {#if Object.keys(extensionStatuses).length > 0}
        <div class="mt-1.5 px-1 text-xs text-base-content/25 truncate">
          {Object.values(extensionStatuses).filter(Boolean).join(' · ')}
        </div>
      {/if}
      </div>
    </footer>
  </div>

  <!-- ── RIGHT SIDEBAR: Tools panel ─────────────────────────────────────── -->

  <!-- Mobile backdrop (tap to dismiss) -->
  {#if isMobile && showToolsPanel}
    <div
      class="fixed inset-0 z-30 bg-base-100/60 backdrop-blur-[2px]"
      onclick={() => (showToolsPanel = false)}
      aria-hidden="true"
      role="presentation"
    ></div>
  {/if}

  <div
    class={isMobile ? 'fixed inset-y-0 right-0 z-40 flex flex-col' : 'relative shrink-0 overflow-hidden'}
    style={isMobile
      ? `width: min(${rightPanelWidth}px, 90vw); transform: translateX(${showToolsPanel ? '0' : '100%'}); transition: transform 220ms cubic-bezier(0.33,1,0.68,1); padding-top: env(safe-area-inset-top, 0px);`
      : `width: ${showToolsPanel ? rightPanelWidth + 'px' : '0'}; transition: ${rightResizing ? 'none' : 'width 220ms cubic-bezier(0.33,1,0.68,1)'};`}
    aria-hidden={!showToolsPanel}
  >
    <div class="w-full h-full bg-base-200 border-l border-base-content/15 flex flex-col">

      <!-- Panel header -->
      <div class="shrink-0 px-4 py-3 border-b border-base-content/15 flex items-center justify-between bg-base-200">
        <span class="text-sm text-base-content/60 uppercase tracking-wider font-medium">
          tools{toolsList.length ? ` (${activeToolNames.length}/${toolsList.length})` : ''}
        </span>
        <button
          onclick={() => (showToolsPanel = false)}
          class="w-10 h-10 flex items-center justify-center text-base-content/55 hover:text-base-content hover:bg-base-content/8 rounded-lg transition-colors"
          aria-label="Close tools panel"
          tabindex={showToolsPanel ? 0 : -1}
        ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>

      <!-- Tool list -->
      <div class="flex-1 overflow-y-auto">
        {#if toolsList.length === 0}
          <p class="text-sm text-base-content/45 px-4 py-5">loading…</p>
        {:else}
          {@const builtinTools = toolsList.filter((t) => t.isBuiltin)}
          {@const customTools = toolsList.filter((t) => !t.isBuiltin)}
          {#if builtinTools.length > 0}
            <p class="px-4 pt-4 pb-2 text-xs text-base-content/40 uppercase tracking-wider">built-in</p>
            {#each builtinTools as tool}
              {@const isActive = activeToolNames.includes(tool.name)}
              <button
                onclick={() => toggleTool(tool.name)}
                class="w-full text-left px-4 py-3 border-b border-base-content/8 flex items-start gap-3 transition-colors {isActive ? 'hover:bg-base-content/5' : 'opacity-50 hover:opacity-75 hover:bg-base-content/3'}"
                tabindex={showToolsPanel ? 0 : -1}
                aria-pressed={isActive}
              >
                <span class="mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors {isActive ? 'border-primary bg-primary' : 'border-base-content/30 bg-transparent'}">
                  {#if isActive}<svg class="w-2.5 h-2.5 text-primary-content" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{/if}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="text-sm font-mono text-base-content/80 block truncate">{tool.name}</span>
                  {#if tool.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{tool.description}</span>{/if}
                </span>
              </button>
            {/each}
          {/if}
          {#if customTools.length > 0}
            <p class="px-4 pt-4 pb-2 text-xs text-base-content/40 uppercase tracking-wider">custom</p>
            {#each customTools as tool}
              {@const isActive = activeToolNames.includes(tool.name)}
              <button
                onclick={() => toggleTool(tool.name)}
                class="w-full text-left px-4 py-3 border-b border-base-content/8 flex items-start gap-3 transition-colors {isActive ? 'hover:bg-base-content/5' : 'opacity-50 hover:opacity-75 hover:bg-base-content/3'}"
                tabindex={showToolsPanel ? 0 : -1}
                aria-pressed={isActive}
              >
                <span class="mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors {isActive ? 'border-primary bg-primary' : 'border-base-content/30 bg-transparent'}">
                  {#if isActive}<svg class="w-2.5 h-2.5 text-primary-content" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{/if}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="text-sm font-mono text-base-content/80 block truncate">{tool.name}</span>
                  {#if tool.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{tool.description}</span>{/if}
                </span>
              </button>
            {/each}
          {/if}
        {/if}
      </div>

      <!-- Footer actions -->
      <div class="shrink-0 border-t border-base-content/10 px-4 py-3 flex items-center justify-between">
        <button
          onclick={() => { activeToolNames = toolsList.map((t) => t.name); send({ type: 'set_active_tools', toolNames: activeToolNames }); }}
          class="text-xs text-base-content/35 hover:text-base-content/60 transition-colors py-1"
          tabindex={showToolsPanel ? 0 : -1}
        >enable all</button>
        <button
          onclick={() => { activeToolNames = []; send({ type: 'set_active_tools', toolNames: [] }); }}
          class="text-xs text-base-content/35 hover:text-base-content/60 transition-colors py-1"
          tabindex={showToolsPanel ? 0 : -1}
        >disable all</button>
      </div>

    </div>
    <!-- Drag handle — left edge, desktop only -->
    {#if !isMobile}
      <div
        class="absolute top-0 left-0 bottom-0 w-1.5 z-10 cursor-col-resize hover:bg-primary/25 active:bg-primary/40 transition-colors"
        onpointerdown={startRightResize}
        onpointermove={onRightResizeMove}
        onpointerup={stopRightResize}
        onpointercancel={stopRightResize}
        aria-hidden="true"
      ></div>
    {/if}
  </div>

  <!-- ── RIGHT SIDEBAR: Resources panel (skills + prompts) ──────────────── -->

  <!-- Mobile backdrop (tap to dismiss) -->
  {#if isMobile && showResourcesPanel}
    <div
      class="fixed inset-0 z-30 bg-base-100/60 backdrop-blur-[2px]"
      onclick={() => (showResourcesPanel = false)}
      aria-hidden="true"
      role="presentation"
    ></div>
  {/if}

  <div
    class={isMobile ? 'fixed inset-y-0 right-0 z-40 flex flex-col' : 'relative shrink-0 overflow-hidden'}
    style={isMobile
      ? `width: min(${rightPanelWidth}px, 90vw); transform: translateX(${showResourcesPanel ? '0' : '100%'}); transition: transform 220ms cubic-bezier(0.33,1,0.68,1); padding-top: env(safe-area-inset-top, 0px);`
      : `width: ${showResourcesPanel ? rightPanelWidth + 'px' : '0'}; transition: ${rightResizing ? 'none' : 'width 220ms cubic-bezier(0.33,1,0.68,1)'};`}
    aria-hidden={!showResourcesPanel}
  >
    <div class="w-full h-full bg-base-200 border-l border-base-content/15 flex flex-col">

      <!-- Panel header -->
      <div class="shrink-0 px-4 py-3 border-b border-base-content/15 flex items-center justify-between bg-base-200">
        <span class="text-sm text-base-content/60 uppercase tracking-wider font-medium">skills &amp; prompts</span>
        <button
          onclick={() => (showResourcesPanel = false)}
          class="w-10 h-10 flex items-center justify-center text-base-content/55 hover:text-base-content hover:bg-base-content/8 rounded-lg transition-colors"
          aria-label="Close resources panel"
          tabindex={showResourcesPanel ? 0 : -1}
        ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>

      <!-- Resource list -->
      <div class="flex-1 overflow-y-auto">
        {#if !resourcesLoaded}
          <p class="text-sm text-base-content/45 px-4 py-5">loading…</p>
        {:else if resourcesSkills.length === 0 && resourcesPrompts.length === 0}
          <p class="text-sm text-base-content/45 px-4 py-5">No skills or prompts found.</p>
        {:else}
          <!-- Skills section -->
          {#if resourcesSkills.length > 0}
            {@const projectSkills = resourcesSkills.filter((s) => s.scope === 'project')}
            {@const userSkills = resourcesSkills.filter((s) => s.scope === 'user')}
            <!-- "built-in" group: package-origin skills that have neither project nor user scope -->
            {@const builtinSkills = resourcesSkills.filter((s) => s.isBuiltin && s.scope !== 'project' && s.scope !== 'user')}

            {#snippet skillItem(skill: SkillSummary)}
              <div class="px-4 py-3 border-b border-base-content/8 flex items-start gap-3">
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5 mb-0.5 flex-wrap">
                    <span class="text-sm font-mono text-base-content/80 truncate">{skill.name}</span>
                    {#if skill.isBuiltin}<span class="shrink-0 px-1.5 py-0.5 rounded text-base-content/30 bg-base-content/6" style="font-size:9px">pkg</span>{/if}
                  </span>
                  {#if skill.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{skill.description}</span>{/if}
                </span>
                <button
                  onclick={() => { input = `/skill:${skill.name} `; showResourcesPanel = false; tick().then(() => inputEl?.focus()); }}
                  class="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-primary hover:bg-primary/10 rounded transition-colors"
                  title="Use skill"
                  tabindex={showResourcesPanel ? 0 : -1}
                ><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>
              </div>
            {/snippet}

            {#if projectSkills.length > 0}
              <p class="px-4 pt-4 pb-2 text-xs text-base-content/40 uppercase tracking-wider">project skills</p>
              {#each projectSkills as skill}{@render skillItem(skill)}{/each}
            {/if}

            {#if userSkills.length > 0}
              <p class="px-4 pt-4 pb-2 text-xs text-base-content/40 uppercase tracking-wider">user skills</p>
              {#each userSkills as skill}{@render skillItem(skill)}{/each}
            {/if}

            {#if builtinSkills.length > 0}
              <p class="px-4 pt-4 pb-2 text-xs text-base-content/40 uppercase tracking-wider">built-in skills</p>
              <div class="opacity-70">
                {#each builtinSkills as skill}{@render skillItem(skill)}{/each}
              </div>
            {/if}
          {/if}

          <!-- Prompts section -->
          {#if resourcesPrompts.length > 0}
            {@const projectPrompts = resourcesPrompts.filter((p) => p.scope === 'project')}
            {@const userPrompts = resourcesPrompts.filter((p) => p.scope === 'user')}
            {@const builtinPrompts = resourcesPrompts.filter((p) => p.isBuiltin)}

            {#if projectPrompts.length > 0}
              <p class="px-4 pt-4 pb-2 text-xs text-base-content/40 uppercase tracking-wider">project prompts</p>
              {#each projectPrompts as prompt}
                <div class="px-4 py-3 border-b border-base-content/8 flex items-start gap-3">
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-2 mb-0.5">
                      <span class="text-sm font-mono text-base-content/80 truncate">{prompt.name}</span>
                      {#if prompt.argumentHint}<span class="shrink-0 text-xs text-base-content/35 font-mono">{prompt.argumentHint}</span>{/if}
                    </span>
                    {#if prompt.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{prompt.description}</span>{/if}
                  </span>
                  <button
                    onclick={() => { input = `/${prompt.name} `; showResourcesPanel = false; tick().then(() => inputEl?.focus()); }}
                    class="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-primary hover:bg-primary/10 rounded transition-colors"
                    title="Use prompt"
                    tabindex={showResourcesPanel ? 0 : -1}
                  ><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>
                </div>
              {/each}
            {/if}

            {#if userPrompts.length > 0}
              <p class="px-4 pt-4 pb-2 text-xs text-base-content/40 uppercase tracking-wider">user prompts</p>
              {#each userPrompts as prompt}
                <div class="px-4 py-3 border-b border-base-content/8 flex items-start gap-3">
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-2 mb-0.5">
                      <span class="text-sm font-mono text-base-content/80 truncate">{prompt.name}</span>
                      {#if prompt.argumentHint}<span class="shrink-0 text-xs text-base-content/35 font-mono">{prompt.argumentHint}</span>{/if}
                    </span>
                    {#if prompt.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{prompt.description}</span>{/if}
                  </span>
                  <button
                    onclick={() => { input = `/${prompt.name} `; showResourcesPanel = false; tick().then(() => inputEl?.focus()); }}
                    class="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-primary hover:bg-primary/10 rounded transition-colors"
                    title="Use prompt"
                    tabindex={showResourcesPanel ? 0 : -1}
                  ><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>
                </div>
              {/each}
            {/if}

            {#if builtinPrompts.length > 0}
              <p class="px-4 pt-4 pb-2 text-xs text-base-content/40 uppercase tracking-wider">built-in prompts</p>
              {#each builtinPrompts as prompt}
                <div class="px-4 py-3 border-b border-base-content/8 flex items-start gap-3 opacity-70">
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-2 mb-0.5">
                      <span class="text-sm font-mono text-base-content/80 truncate">{prompt.name}</span>
                      {#if prompt.argumentHint}<span class="shrink-0 text-xs text-base-content/35 font-mono">{prompt.argumentHint}</span>{/if}
                    </span>
                    {#if prompt.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{prompt.description}</span>{/if}
                  </span>
                  <button
                    onclick={() => { input = `/${prompt.name} `; showResourcesPanel = false; tick().then(() => inputEl?.focus()); }}
                    class="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-primary hover:bg-primary/10 rounded transition-colors"
                    title="Use prompt"
                    tabindex={showResourcesPanel ? 0 : -1}
                  ><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>
                </div>
              {/each}
            {/if}
          {/if}
        {/if}
      </div>

      <!-- Install skill footer -->
      <div class="shrink-0 border-t border-base-content/10 px-4 py-3 space-y-2">
        <p class="text-xs text-base-content/40 uppercase tracking-wider mb-1">install skill</p>
        <input
          bind:value={skillInstallUrl}
          type="url"
          placeholder="GitHub URL or raw .md URL"
          class="w-full text-xs bg-base-content/5 border border-base-content/10 rounded-lg px-3 py-2 text-base-content/80 placeholder-base-content/30 focus:outline-none focus:border-primary/50"
          tabindex={showResourcesPanel ? 0 : -1}
          onkeydown={(e) => { if (e.key === 'Enter' && skillInstallUrl.trim() && !skillInstalling) { skillInstalling = true; skillInstallFeedback = null; send({ type: 'install_skill', url: skillInstallUrl.trim(), scope: skillInstallScope }); } }}
        />
        <div class="flex items-center gap-2">
          <select
            bind:value={skillInstallScope}
            class="text-xs bg-base-content/5 border border-base-content/10 rounded-lg px-2 py-1.5 text-base-content/70 focus:outline-none focus:border-primary/50"
            tabindex={showResourcesPanel ? 0 : -1}
          >
            <option value="user">user (~/.pi)</option>
            <option value="project">project (.pi)</option>
          </select>
          <button
            onclick={() => { if (!skillInstallUrl.trim() || skillInstalling) return; skillInstalling = true; skillInstallFeedback = null; send({ type: 'install_skill', url: skillInstallUrl.trim(), scope: skillInstallScope }); }}
            disabled={!skillInstallUrl.trim() || skillInstalling}
            class="flex-1 text-xs py-1.5 px-3 rounded-lg transition-colors {skillInstalling ? 'bg-base-content/10 text-base-content/30' : 'bg-primary/15 text-primary hover:bg-primary/25'}"
            tabindex={showResourcesPanel ? 0 : -1}
          >{skillInstalling ? 'installing…' : 'install'}</button>
        </div>
        {#if skillInstallFeedback}
          <p class="text-xs {skillInstallFeedback.success ? 'text-success' : 'text-error'} leading-snug">{skillInstallFeedback.message}</p>
        {/if}
      </div>

    </div>
    <!-- Drag handle — left edge, desktop only -->
    {#if !isMobile}
      <div
        class="absolute top-0 left-0 bottom-0 w-1.5 z-10 cursor-col-resize hover:bg-primary/25 active:bg-primary/40 transition-colors"
        onpointerdown={startRightResize}
        onpointermove={onRightResizeMove}
        onpointerup={stopRightResize}
        onpointercancel={stopRightResize}
        aria-hidden="true"
      ></div>
    {/if}
  </div>

  <!-- ── RIGHT SIDEBAR: Model picker panel ───────────────────────────────── -->

  <!-- Mobile backdrop (tap to dismiss) -->
  {#if isMobile && showModelPicker}
    <div
      class="fixed inset-0 z-30 bg-base-100/60 backdrop-blur-[2px]"
      onclick={() => (showModelPicker = false)}
      aria-hidden="true"
      role="presentation"
    ></div>
  {/if}

  <div
    class={isMobile ? 'fixed inset-y-0 right-0 z-40 flex flex-col' : 'relative shrink-0 overflow-hidden'}
    style={isMobile
      ? `width: min(${rightPanelWidth}px, 90vw); transform: translateX(${showModelPicker ? '0' : '100%'}); transition: transform 220ms cubic-bezier(0.33,1,0.68,1); padding-top: env(safe-area-inset-top, 0px);`
      : `width: ${showModelPicker ? rightPanelWidth + 'px' : '0'}; transition: ${rightResizing ? 'none' : 'width 220ms cubic-bezier(0.33,1,0.68,1)'};`}
    aria-hidden={!showModelPicker}
  >
    <!-- Fixed-width inner panel -->
    <div class="w-full h-full bg-base-200 border-l border-base-content/15 flex flex-col">

      <!-- Panel header with tabs -->
      <div class="shrink-0 px-4 py-3 border-b border-base-content/15 flex items-center gap-3 bg-base-200">
        <div class="flex gap-1 flex-1">
          <button
            onclick={() => (modelTab = 'models')}
            class="px-3 py-2 text-sm rounded-lg transition-colors {modelTab === 'models' ? 'text-base-content bg-base-content/8' : 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/5'}"
            tabindex={showModelPicker ? 0 : -1}
          >models</button>
          <button
            onclick={() => (modelTab = 'providers')}
            class="px-3 py-2 text-sm rounded-lg transition-colors {modelTab === 'providers' ? 'text-base-content bg-base-content/8' : 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/5'}"
            tabindex={showModelPicker ? 0 : -1}
          >providers{providers.length ? ` (${configuredProviderCount}/${providers.length})` : ''}</button>
        </div>
        <button
          onclick={() => (showModelPicker = false)}
          class="w-10 h-10 flex items-center justify-center text-base-content/55 hover:text-base-content hover:bg-base-content/8 rounded-lg transition-colors text-xl shrink-0"
          aria-label="Close model picker"
          tabindex={showModelPicker ? 0 : -1}
        ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>

      {#if modelTab === 'models'}
        {#if model?.reasoning}          <div class="shrink-0 px-4 py-3 border-b border-base-content/15">
            <p class="text-xs text-base-content/50 uppercase tracking-wider mb-3">thinking</p>
            <div class="flex flex-wrap gap-2">
              {#each ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as lvl}
                <button
                  onclick={() => pickThinkingLevel(lvl)}
                  class="px-3 py-1.5 text-sm rounded-lg border transition-colors {thinkingLevel === lvl ? 'border-primary text-primary bg-primary/8' : 'border-base-content/20 text-base-content/55 hover:border-base-content/40 hover:text-base-content/80 hover:bg-base-content/5'}"
                  tabindex={showModelPicker ? 0 : -1}
                >{lvl}</button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="flex-1 overflow-y-auto flex flex-col">
          <div class="shrink-0 px-4 py-3 border-b border-base-content/10">
            <input
              type="search"
              placeholder="filter models…"
              bind:value={modelFilter}
              class="w-full bg-transparent outline-none text-sm placeholder-base-content/30 text-base-content/80"
              aria-label="Filter models"
              tabindex={showModelPicker ? 0 : -1}
            />
          </div>
          <div class="flex-1 overflow-y-auto">
            {#if availableModels.length === 0}
              <p class="text-sm text-base-content/45 px-4 py-5">no models configured</p>
            {:else if filteredModelsByProvider.length === 0}
              <p class="text-sm text-base-content/45 px-4 py-5">no match</p>
            {:else}
              {#each filteredModelsByProvider as [provider, models]}
                <div class="py-1">
                  <p class="px-4 py-2 text-xs text-base-content/40 uppercase tracking-wider flex items-center gap-2">
                    <span
                      style="background:{providerColor(provider)};font-size:9px"
                      class="inline-flex items-center justify-center w-4 h-4 rounded text-white font-bold leading-none select-none shrink-0"
                      aria-hidden="true"
                    >{provider[0].toUpperCase()}</span>
                    {provider}
                  </p>
                  {#each models as m}
                    {@const isActive = model?.id === m.id && model?.provider === m.provider}
                    <button
                      onclick={() => selectModel(m)}
                      class="w-full text-left px-4 py-3 text-sm transition-colors flex items-center gap-2 {isActive ? 'bg-primary/10 text-primary' : 'text-base-content/80 hover:bg-base-content/5 hover:text-base-content'}"
                      aria-pressed={isActive}
                      tabindex={showModelPicker ? 0 : -1}
                    >
                      <span class="flex-1 truncate">{m.name}</span>
                      {#if m.reasoning}<span class="text-base-content/30 shrink-0 text-xs">✦</span>{/if}
                      {#if isActive}<span class="text-primary shrink-0"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></span>{/if}
                    </button>
                  {/each}
                </div>
              {/each}
            {/if}
          </div>
        </div>

      {:else}
        <div class="flex-1 overflow-y-auto flex flex-col">
          <div class="shrink-0 px-4 py-3 border-b border-base-content/10">
            <input
              type="search"
              placeholder="filter providers…"
              bind:value={providerFilter}
              class="w-full bg-transparent outline-none text-sm placeholder-base-content/30 text-base-content/80"
              aria-label="Filter providers"
              tabindex={showModelPicker ? 0 : -1}
            />
          </div>

          {#if providerError}
            <div class="shrink-0 px-4 py-3 bg-error/15 border-b border-error/30 flex items-center justify-between gap-2">
              <span class="text-sm text-error break-words min-w-0">{providerError}</span>
              <button onclick={() => (providerError = null)} class="w-8 h-8 flex items-center justify-center text-error/60 hover:text-error/80 shrink-0 rounded" aria-label="Dismiss error"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            </div>
          {/if}

          <div class="flex-1 overflow-y-auto">
            {#if providers.length === 0}
              <p class="text-sm text-base-content/45 px-4 py-5">loading…</p>
            {:else if filteredProviders.length === 0}
              <p class="text-sm text-base-content/45 px-4 py-5">no match</p>
            {:else}
              {#each filteredProviders as p}
                {@const isCurrentProvider = model?.provider === p.id}
                {@const label = sourceLabel(p.source)}
                <div class="px-4 py-3 border-b border-base-content/8 {isCurrentProvider ? 'bg-base-content/4' : ''}">
                  <div class="flex items-center gap-2 mb-2">
                    <span class="text-sm flex-1 truncate {p.configured ? 'text-base-content/90' : 'text-base-content/45'} {isCurrentProvider ? 'text-primary' : ''}">{p.name}</span>
                    {#if label}<span class="text-xs text-base-content/30 shrink-0 font-mono">({label})</span>{/if}
                    <span class="text-sm shrink-0 {p.configured ? 'text-primary' : 'text-base-content/20'}">{p.configured ? '●' : '○'}</span>
                    <span class="text-xs text-base-content/35 shrink-0">{p.modelCount}m</span>
                  </div>
                  {#if p.configured}
                    {#if canRemove(p.source)}
                      <button onclick={() => removeProviderKey(p.id)} class="text-sm text-base-content/30 hover:text-error transition-colors py-1" tabindex={showModelPicker ? 0 : -1}>remove key</button>
                    {:else}
                      <span class="text-sm text-base-content/20">set externally</span>
                    {/if}
                  {:else}
                    <div class="flex gap-2 items-center mt-1">
                      <input
                        type="password"
                        placeholder="API key…"
                        bind:value={providerKeyInputs[p.id]}
                        onkeydown={(e) => { if (e.key === 'Enter') setProviderKey(p.id); }}
                        class="flex-1 bg-transparent border-b border-base-content/15 focus:border-base-content/45 outline-none text-sm py-1.5 placeholder-base-content/20 transition-colors min-w-0"
                        aria-label="API key for {p.name}"
                        tabindex={showModelPicker ? 0 : -1}
                      />
                      <button
                        onclick={() => setProviderKey(p.id)}
                        disabled={!(providerKeyInputs[p.id] ?? '').trim()}
                        class="text-sm text-base-content/40 hover:text-base-content disabled:opacity-25 transition-colors shrink-0 px-2 py-1.5"
                        tabindex={showModelPicker ? 0 : -1}
                      >save</button>
                    </div>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        </div>
      {/if}

      <!-- Settings section — always visible at bottom of model picker -->
      <div class="shrink-0 border-t border-base-content/10 px-4 py-3 space-y-3">
        <p class="text-xs text-base-content/40 uppercase tracking-wider">session</p>
        <div class="flex items-center gap-3">
          <span class="flex-1 text-sm text-base-content/55">auto-compact</span>
          <button
            onclick={toggleAutoCompaction}
            class="relative w-9 h-5 rounded-full transition-colors shrink-0 {autoCompactionEnabled ? 'bg-primary' : 'bg-base-content/20'}"
            role="switch"
            aria-checked={autoCompactionEnabled}
            aria-label="Toggle auto-compaction"
            tabindex={showModelPicker ? 0 : -1}
          >
            <span class="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-all {autoCompactionEnabled ? 'left-[1.125rem]' : 'left-0.5'}"></span>
          </button>
        </div>
        <div class="flex items-center gap-3">
          <span class="flex-1 text-sm text-base-content/55">auto-retry</span>
          <button
            onclick={toggleAutoRetry}
            class="relative w-9 h-5 rounded-full transition-colors shrink-0 {autoRetryEnabled ? 'bg-primary' : 'bg-base-content/20'}"
            role="switch"
            aria-checked={autoRetryEnabled}
            aria-label="Toggle auto-retry"
            tabindex={showModelPicker ? 0 : -1}
          >
            <span class="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-all {autoRetryEnabled ? 'left-[1.125rem]' : 'left-0.5'}"></span>
          </button>
        </div>
        <p class="text-xs text-base-content/40 uppercase tracking-wider pt-1">server</p>
        <div class="flex items-center gap-3">
          <span class="flex-1 text-sm text-base-content/55">restart server</span>
          <button
            onclick={restartServer}
            class="px-3 py-1 text-xs rounded-lg transition-colors {wsState === 'open' ? 'text-error/70 hover:text-error hover:bg-error/10' : 'text-base-content/25 cursor-default'}"
            tabindex={showModelPicker ? 0 : -1}
            disabled={wsState !== 'open'}
            aria-label="Restart server"
          >restart</button>
        </div>
      </div>

    </div>
    <!-- Drag handle — left edge, desktop only -->
    {#if !isMobile}
      <div
        class="absolute top-0 left-0 bottom-0 w-1.5 z-10 cursor-col-resize hover:bg-primary/25 active:bg-primary/40 transition-colors"
        onpointerdown={startRightResize}
        onpointermove={onRightResizeMove}
        onpointerup={stopRightResize}
        onpointercancel={stopRightResize}
        aria-hidden="true"
      ></div>
    {/if}
  </div>

</div>

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
{#if modal}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    class="fixed inset-0 z-50 flex items-center justify-center bg-base-100/80 backdrop-blur-sm p-4"
    onkeydown={modalKeydown}
  >
    <div class="w-full max-w-sm bg-base-200 border border-base-content/15 rounded-2xl p-5 space-y-4 font-mono text-base text-base-content">
      <p class="font-semibold tracking-tight">{modal.title}</p>

      {#if modal.method === 'confirm'}
        {#if modal.message}
          <p class="text-base-content/70 text-sm leading-relaxed whitespace-pre-wrap">{modal.message}</p>
        {/if}
        <div class="flex gap-3 justify-end">
          <button class="px-4 py-2 text-sm text-base-content/55 hover:text-base-content hover:bg-base-content/8 rounded-lg transition-colors" onclick={modalCancel}>cancel</button>
          <button class="px-4 py-2 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors" onclick={() => modalConfirm(true)}>confirm</button>
        </div>

      {:else if modal.method === 'input'}
        <input bind:this={modalFocusEl} type="text" bind:value={modalInput} placeholder={modal.placeholder ?? ''} class="w-full bg-transparent border-b border-base-content/25 focus:border-base-content/60 outline-none py-2 text-base placeholder-base-content/35 transition-colors" />
        <div class="flex gap-3 justify-end">
          <button class="px-4 py-2 text-sm text-base-content/55 hover:text-base-content hover:bg-base-content/8 rounded-lg transition-colors" onclick={modalCancel}>cancel</button>
          <button class="px-4 py-2 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors" onclick={modalSubmitValue}>submit</button>
        </div>

      {:else if modal.method === 'select'}
        <div class="space-y-1 max-h-64 overflow-y-auto">
          {#each modal.options as opt}
            <button class="w-full text-left px-3 py-3 rounded-lg text-sm text-base-content/80 hover:bg-base-content/10 hover:text-base-content transition-colors" onclick={() => modalSelectOption(opt)}>{opt}</button>
          {/each}
        </div>
        <div class="flex justify-end">
          <button class="px-4 py-2 text-sm text-base-content/55 hover:text-base-content hover:bg-base-content/8 rounded-lg transition-colors" onclick={modalCancel}>cancel</button>
        </div>

      {:else if modal.method === 'editor'}
        <textarea bind:this={modalFocusEl} bind:value={modalInput} rows={8} class="w-full bg-transparent border border-base-content/25 focus:border-base-content/60 outline-none p-3 text-sm leading-relaxed resize-none rounded-lg transition-colors"></textarea>
        <div class="flex gap-3 justify-end">
          <button class="px-4 py-2 text-sm text-base-content/55 hover:text-base-content hover:bg-base-content/8 rounded-lg transition-colors" onclick={modalCancel}>cancel</button>
          <button class="px-4 py-2 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors" onclick={modalSubmitValue}>submit</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- ── Fork session dialog ─────────────────────────────────────────────────────── -->
{#if showForkDialog}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Fork session"
    tabindex="-1"
    class="fixed inset-0 z-50 flex items-center justify-center bg-base-100/80 backdrop-blur-sm p-4"
    onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); showForkDialog = false; } }}
  >
    <div class="w-full max-w-sm bg-base-200 border border-base-content/15 rounded-2xl p-5 space-y-4 font-mono text-base text-base-content">
      <p class="font-semibold tracking-tight">Fork session</p>
      <p class="text-xs text-base-content/45 leading-relaxed">Choose a user message to branch from. A new session will be created up to that point.</p>

      {#if forkLoading}
        <div class="flex items-center justify-center py-6 text-base-content/35 text-sm gap-2">
          <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          loading…
        </div>
      {:else if forkPoints.length === 0}
        <p class="text-sm text-base-content/40 py-4 text-center">No user messages found in this session.</p>
      {:else}
        <div class="space-y-1 max-h-72 overflow-y-auto">
          {#each forkPoints as fp}
            <button
              onclick={() => forkAt(fp.entryId)}
              class="w-full text-left px-3 py-3 rounded-lg text-sm text-base-content/75 hover:bg-base-content/10 hover:text-base-content transition-colors leading-snug truncate"
              title={fp.text}
            >{fp.text || '(empty)'}</button>
          {/each}
        </div>
      {/if}

      <div class="flex justify-end">
        <button
          onclick={() => { showForkDialog = false; }}
          class="px-4 py-2 text-sm text-base-content/55 hover:text-base-content hover:bg-base-content/8 rounded-lg transition-colors"
        >cancel</button>
      </div>
    </div>
  </div>
{/if}
