<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { dev } from '$app/env';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';

  import type {
    ServerMessage,
    ClientMessage,
    ModelInfo,
    ProviderInfo,
    SkillSummary,
    PromptSummary,
    ExtensionSummary,
    WidgetContent,
    WidgetPayload,
    ExtensionUiStatePayload,
    TreeNode,
    UpdateStatus,
    UpdateTarget,
    ConnectedMessage,
    ProjectTrustInfo,
    RuntimeDiagnostic,
    ConfiguredPackageInfo,
    PackageUpdateInfo,
    PackageProgress,
    SessionStats,
    ContextUsage,
  } from '#lib/ws/protocol.js';
  import type { PiEvent } from '#lib/ws/protocol.js';
  import { parseServerMessage } from '#lib/ws/server-message-schema.js';
  import { renderMarkdown, renderStreamingPreview, onLangRegistered } from '#lib/markdown.js';
  import { providerColor, versionText, fmtTokens, fmtCost, fmtDuration } from '#lib/utils.js';
  import type { ParsedComponent } from '#lib/tui-stubs.js';
  import { projectsState } from '#lib/state/projects-state.svelte.js';
  import { extensionUiState } from '#lib/state/extension-ui-state.svelte.js';
  import {
    rawMessagesToUI,
    uid,
    formatToolInput,
    extractTextContent,
    reconnectDelay,
    type UIMessage,
    type CompactionNoticeDetails,
  } from '#lib/client-messages.js';
  import { extensionOptionParts } from '#lib/extension-modals.js';
  import { saveSnapshot, loadSnapshot } from '#lib/session-snapshot.js';
  import { SessionViewCache, type SessionView } from '#lib/session-view-cache.js';
  import { saveIdentity, loadIdentity, clearIdentity } from '#lib/session-identity.js';
  import {
    TEXT_FILE_EXTENSIONS,
    fileToText,
    prepareImage,
    MAX_IMAGE_PAYLOAD,
  } from '#lib/attachments.js';
  import {
    type NotificationPrefs,
    NOTIF_NUDGE_SEEN_KEY,
    loadNotificationPrefs,
    saveNotificationPrefs,
    urlBase64ToUint8Array,
  } from '#lib/notification-prefs.js';
  import { clampThinkingLevelForModel, getSupportedThinkingLevels } from '#lib/thinking-levels.js';
  import { encodeTerminalKey, wrapBracketedPaste } from '#lib/terminal-key-encoder.js';
  import * as Tooltip from '#lib/components/ui/tooltip/index.js';
  import { Switch } from '#lib/components/ui/switch/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Select from '#lib/components/ui/select/index.js';
  import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
  import * as Card from '#lib/components/ui/card/index.js';
  import SidebarPanel from '#lib/components/sidebar-panel.svelte';
  import ProjectsSidebar from '#lib/components/projects/lazy-projects-sidebar.svelte';
  import LiveElapsed from '#lib/components/chat/live-elapsed.svelte';
  import MessageList from '#lib/components/chat/message-list.svelte';
  import RightPanel from '#lib/components/panels/lazy-right-panel.svelte';
  import ExtensionComponent from '#lib/components/ui/extension-component.svelte';
  import ConfirmDialog from '#lib/components/dialogs/confirm-dialog.svelte';

  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import X from '@lucide/svelte/icons/x';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import Blocks from '@lucide/svelte/icons/blocks';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import PiIcon from '@lucide/svelte/icons/pi';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import PackageOpen from '@lucide/svelte/icons/package-open';
  import Bell from '@lucide/svelte/icons/bell';
  import Wrench from '@lucide/svelte/icons/wrench';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import ShieldQuestion from '@lucide/svelte/icons/shield-question';

  // ── Builtin slash commands ───────────────────────────────────────────────────

  const SLASH_COMMANDS = [
    { name: 'reload', description: 'Reload extensions, skills, prompts, and themes' },
    { name: 'compact', description: 'Manually compact the session context' },
    { name: 'name', description: 'Set session display name' },
    { name: 'new', description: 'Start a new session' },
    { name: 'fork', description: 'Create a new fork from a previous user message' },
    { name: 'clone', description: 'Duplicate the current session at the current position' },
    { name: 'resume', description: 'Resume a different session' },
    { name: 'export', description: 'Export session (.html/.jsonl)' },
    { name: 'share', description: 'Share session as a secret GitHub gist' },
    { name: 'session', description: 'Show session info and stats' },
    { name: 'login', description: 'Configure provider authentication' },
    { name: 'logout', description: 'Remove provider authentication' },
    { name: 'tree', description: 'Navigate session tree (switch branches)' },
    { name: 'model', description: 'Select model' },
    { name: 'copy', description: 'Copy last agent message to clipboard' },
    { name: 'changelog', description: 'Show changelog entries' },
    { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  ] as const;

  type ShortcutTrigger = '/' | '@' | '!' | '#';
  type ComposerShortcut = {
    trigger: ShortcutTrigger;
    label: string;
    description: string;
    insert: string;
    muted?: boolean;
    disabled?: boolean;
    /** Optional section header for grouping commands. */
    section?: string;
  };

  const SHELL_SHORTCUTS = [
    {
      label: 'shell command',
      description: '⚠ Run a shell command directly (bypasses pi)',
      insert: '! ',
    },
    { label: 'git status', description: 'Check the working tree', insert: '! git status' },
    { label: 'list files', description: 'Inspect the current directory', insert: '! ls' },
  ] as const;

  const SNIPPET_SHORTCUTS = [
    {
      label: 'review',
      description: 'Ask for a concise code review',
      insert: '#review ',
    },

    {
      label: 'fix',
      description: 'Ask pi to diagnose and fix an issue',
      insert: '#fix ',
    },

    {
      label: 'explain',
      description: 'Ask pi to explain selected code or output',
      insert: '#explain ',
    },
  ] as const;

  // ── UI message model ────────────────────────────────────────────────────────
  // (MsgUsage and UIMessage types imported from #lib/client-messages)

  // ── Extension UI modal state ─────────────────────────────────────────────────

  function parsedComponentHasAction(comp: ParsedComponent | undefined): boolean {
    if (!comp) return false;
    if (comp.kind === 'select' || comp.kind === 'button' || comp.kind === 'checkbox') return true;
    if (comp.kind === 'settings') return comp.items.some((it) => !!it.values?.length);
    if (comp.kind === 'container') return comp.children.some(parsedComponentHasAction);
    return false;
  }

  function parsedComponentHasInput(comp: ParsedComponent | undefined): boolean {
    if (!comp) return false;
    if (comp.kind === 'input') return true;
    if (comp.kind === 'container') return comp.children.some(parsedComponentHasInput);
    return false;
  }
  function parsedComponentHasCheckbox(comp: ParsedComponent | undefined): boolean {
    if (!comp) return false;
    if (comp.kind === 'checkbox') return true;
    if (comp.kind === 'container') return comp.children.some(parsedComponentHasCheckbox);
    return false;
  }

  function parsedComponentIsDisplayOnly(comp: ParsedComponent | undefined): boolean {
    if (!comp) return false;
    if (comp.kind === 'container') return comp.children.every(parsedComponentIsDisplayOnly);

    return (
      comp.kind === 'text' ||
      comp.kind === 'markdown' ||
      comp.kind === 'progress' ||
      comp.kind === 'loader' ||
      comp.kind === 'image' ||
      (comp.kind === 'settings' && !comp.items.some((it) => !!it.values?.length))
    );
  }

  function customModalNeedsTextInput(comp: ParsedComponent | undefined): boolean {
    if (!comp) return true;
    if (
      parsedComponentHasInput(comp) ||
      parsedComponentHasAction(comp) ||
      parsedComponentIsDisplayOnly(comp)
    )
      return false;
    return true;
  }

  let modal = $derived(extensionUiState.modalQueue[0] ?? null);
  let modalInput = $state('');
  let selectFilter = $state('');
  let selectOptionIndex = $state(0);
  const selectOptions = $derived.by(() => {
    if (!modal || modal.method !== 'select') return [];
    return modal.options.map((value, index) => ({
      value,
      index,
      option: extensionOptionParts(value, index),
    }));
  });
  const filteredSelectOptions = $derived.by(() => {
    const query = selectFilter.trim().toLowerCase();
    if (!query) return selectOptions;
    return selectOptions.filter((item) =>
      `${item.value} ${item.option.label} ${item.option.description ?? ''}`
        .toLowerCase()
        .includes(query)
    );
  });
  let modalFocusEl = $state<HTMLElement | undefined>(undefined);
  let overlayPreEl = $state<HTMLElement | undefined>(undefined);
  let overlayViewportEl = $state<HTMLElement | undefined>(undefined);
  let overlayResizeConnection = $state(0);
  let lastOverlayResize:
    { id: string; connection: number; columns: number; rows: number } | undefined;
  let preparedModalId = $state<string | null>(null);
  let focusedModalId = $state<string | null>(null);
  // Sync modalInput when the active modal changes — avoids overwriting input
  // for queued modals that are not yet active.
  $effect(() => {
    const m = modal;
    if (!m) {
      preparedModalId = null;
      return;
    }
    if (preparedModalId === m.id) return;
    preparedModalId = m.id;
    if (m.method === 'select') {
      selectFilter = '';
      selectOptionIndex = 0;
    }
    if (m.method === 'custom' && m.interactive) {
      modalInput = '';
    } else if (m.method === 'editor') {
      modalInput = m.prefill ?? '';
    } else if (m.method !== 'confirm') {
      modalInput = '';
    }
  });

  $effect(() => {
    const m = modal;
    if (!m) {
      focusedModalId = null;
      return;
    }
    if (focusedModalId === m.id || !modalFocusEl) return;
    // A custom overlay replaces the prior modal input. Focus after that DOM
    // update, otherwise a stale, hidden input can receive focus instead.
    void tick().then(() => {
      if (modal?.id !== m.id || focusedModalId === m.id || !modalFocusEl) return;
      modalFocusEl.focus({ preventScroll: true });
      focusedModalId = m.id;
    });
  });
  $effect(() => {
    const m = modal;
    const pre = overlayPreEl;
    const viewport = overlayViewportEl;
    const connection = overlayResizeConnection;
    if (!m) {
      lastOverlayResize = undefined;
      return;
    }
    if (m.method !== 'custom' || !m.interactive || !pre || !viewport) return;

    const probe = document.createElement('span');
    probe.textContent = 'M';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.font = 'inherit';
    pre.appendChild(probe);

    let charAdvance = probe.getBoundingClientRect().width;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    const measureAndSend = () => {
      if (modal?.id !== m.id) return;
      if (!(charAdvance > 0)) {
        charAdvance = probe.getBoundingClientRect().width;
      }
      const style = getComputedStyle(pre);
      const lineHeight = Number.parseFloat(style.lineHeight);
      if (!(charAdvance > 0) || !(lineHeight > 0)) return;

      const paddingX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const contentWidth = viewport.clientWidth - paddingX;
      const contentHeight = viewport.clientHeight - paddingY;
      const columns = Math.min(200, Math.max(20, Math.floor(contentWidth / charAdvance)));
      const rows = Math.min(80, Math.max(5, Math.floor(contentHeight / lineHeight)));
      if (
        lastOverlayResize?.id === m.id &&
        lastOverlayResize.connection === connection &&
        columns === lastOverlayResize.columns &&
        rows === lastOverlayResize.rows
      )
        return;

      if (send({ type: 'extension_custom_resize', id: m.id, columns, rows })) {
        lastOverlayResize = { id: m.id, connection, columns, rows };
      }
    };

    const scheduleMeasure = () => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        measureAndSend();
      }, 150);
    };

    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(viewport);
    const frame = requestAnimationFrame(measureAndSend);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      probe.remove();
    };
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

  /** autocorrect is a real attribute but missing from Svelte's HTML typings. */
  function autoCorrectOff(node: HTMLElement) {
    node.setAttribute('autocorrect', 'off');
  }
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
    if (dy > 40) return;
    const absDx = Math.abs(dx);
    if (absDx < 50) return;

    // Drag-to-close: a horizontal drag on an open drawer toward its closed
    // edge closes it (left drawer slides out left, right drawer slides out
    // right). Only counts when the gesture starts on the drawer surface.
    const drawerW = Math.min(
      showSessionPanel ? sessionPanelWidth : showRightPanel ? rightPanelWidth : 0,
      window.innerWidth - 16
    );
    if (showSessionPanel && dx < -70 && touchStartX < drawerW) {
      showSessionPanel = false;
      return;
    }
    if (showRightPanel && dx > 70 && touchStartX > window.innerWidth - drawerW) {
      showRightPanel = false;
      return;
    }

    if (dx > 0 && touchStartX < 40) {
      // Swipe right from left edge → open session panel
      showSessionPanel = true;
      showRightPanel = false;
    } else if (dx < 0 && touchStartX > window.innerWidth - 40) {
      // Swipe left from right edge → open model picker
      openTab('models');
    }
  }

  /** Micro-haptic feedback — Android touch devices only (iOS Safari has no vibrate). */
  function haptic(pattern: number | number[] = 8) {
    try {
      if (window.matchMedia('(pointer: coarse)').matches && navigator.vibrate) {
        navigator.vibrate(pattern);
      }
    } catch {
      /* vibrate unsupported */
    }
  }

  // ── iOS keyboard inset ────────────────────────────────────────────────────
  // iOS Safari never resizes the layout viewport for the software keyboard
  // (WebKit bug 259770): the keyboard overlays the page. The visualViewport
  // delta (layout − visual height) is the portable keyboard signal:
  //   · iOS:     innerHeight stays, visual shrinks   → delta > 0 → pad layout
  //   · Chromium: resizes-content meta shrinks both  → delta ≈ 0 → no-op
  // The padding is applied to the main column so the composer stays pinned
  // above the keyboard instead of Safari's crude auto-pan.
  let keyboardInset = $state(0);

  $effect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const delta = window.innerHeight - vv.height;
      keyboardInset = delta > 0 ? Math.round(delta) : 0;
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  });

  // ── Android back: close open drawers before leaving ──────────────────────
  // A same-URL history marker is pushed while a drawer is open; the system
  // back gesture pops it, we swallow the pop and close the drawer. SvelteKit's
  // router ignores same-URL pops, so no navigation happens.
  $effect(() => {
    // popstate.state describes the entry becoming active, not the one being
    // popped — so the marker can't be inspected here. The sync effect below
    // keeps the marker on top whenever a drawer is open, making ANY pop with a
    // drawer open a back gesture on it: swallow by closing the drawer.
    const onPop = () => {
      if (showSessionPanel || showRightPanel) {
        showSessionPanel = false;
        showRightPanel = false;
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });

  $effect(() => {
    if (!isMobile) return;
    const anyOpen = showSessionPanel || showRightPanel;
    const marked = page.state.piUiDrawer === true;
    if (anyOpen && !marked) {
      // Shallow navigation pushes a same-URL history entry carrying the
      // marker; Android back pops it and the listener above swallows the
      // pop by closing the drawer. SvelteKit reapplies page.state on the
      // pop, which clears the marker.
      goto(window.location.href, {
        shallow: true,
        state: { ...page.state, piUiDrawer: true },
      }).catch(() => {
        /* marker is best-effort — the drawer still opens without it */
      });
    } else if (!anyOpen && marked) {
      history.back();
    }
  });

  // ── Service-worker messages (notification clicks) ─────────────────────────
  $effect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onSwMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; sessionPath?: string } | undefined;
      if (!d?.type) return;
      if (d.type === 'pi_focus_session' && typeof d.sessionPath === 'string') {
        const target = projectsState.allSessions.find((s) => s.path === d.sessionPath);
        // Notification deep links can name a session that is not in the
        // sidebar's cached list yet (or that has disappeared from it). The
        // server remains the authority on whether the path can be opened.
        if (!target || target.id !== projectsState.activeSessionId) {
          if (ws?.readyState === WebSocket.OPEN && _wsHandshakeComplete) {
            projectsState.switchSession(d.sessionPath);
          } else {
            // Keep the latest click until the next application-level handshake.
            pendingNotificationSessionPath = d.sessionPath;
          }
        }
      } else if (d.type === 'pi_steer') {
        haptic();
        tick().then(() => inputEl?.focus());
      }
    };
    navigator.serviceWorker.addEventListener('message', onSwMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onSwMessage);
  });

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
    try {
      localStorage.setItem('pifrontier:session-w', String(sessionPanelWidth));
    } catch {
      /* quota */
    }
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
    try {
      localStorage.setItem('pifrontier:right-w', String(rightPanelWidth));
    } catch {
      /* quota */
    }
  }

  // ── Core state ───────────────────────────────────────────────────────────────

  let messages = $state<UIMessage[]>([]);
  let expandedUserMsgs = $state<Record<string, boolean>>({});
  let truncatedUserMsgs = $state<Record<string, boolean>>({});
  /** Long runtime diagnostics (e.g. absolute-path dumps) collapse to a
   * preview by default in the settings panel — keyed by message text. */
  let expandedDiagnostics = $state<Record<string, boolean>>({});
  /** Direct pointer to the currently-streaming assistant message — avoids O(n) lastStreaming() scans. */
  let activeStreamMsg = $state<UIMessage | null>(null);
  // Non-reactive index for high-frequency tool updates. Rebuilt when history
  // is replaced and updated incrementally for live tool events.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive lookup index
  const toolMessagesById = new Map<string, UIMessage>();
  /** Inactive session transcripts and UI-only state, bounded by the cache's LRU cap. */
  const sessionViewCache = new SessionViewCache();

  let input = $state('');
  /** Images staged for the next prompt (base64 data + display src). */
  let attachedImages = $state<Array<{ data: string; mimeType: string; name: string; src: string }>>(
    []
  );
  /** Text files staged for the next prompt (content read as text). */
  let attachedFiles = $state<Array<{ name: string; content: string; size: number }>>([]);
  let fileInputEl = $state<HTMLInputElement | undefined>(undefined);

  // ── Extension UI state ───────────────────────────────────────────────────────

  const AGENT_SUMMARY_WIDGET_KEYS = new Set(['agents', 'subagents']);

  const FLEET_WIDGET_KEY = 'fleet';
  let visibleExtensionStatuses = $derived(
    Object.entries(extensionUiState.statuses).filter(([, value]) => Boolean(value))
  );
  let visibleExtensionFooter = $derived(extensionUiState.footer || undefined);
  let hasFleetWidget = $derived(
    Object.entries(extensionUiState.widgets).some(
      ([key]) =>
        key === FLEET_WIDGET_KEY &&
        (extensionUiState.widgetPlacement[key] ?? 'aboveEditor') === 'belowEditor'
    )
  );
  let aboveEditorWidgets = $derived(
    Object.entries(extensionUiState.widgets).filter(
      ([key]) =>
        (extensionUiState.widgetPlacement[key] ?? 'aboveEditor') === 'aboveEditor' &&
        !(AGENT_SUMMARY_WIDGET_KEYS.has(key) && hasFleetWidget)
    )
  );
  let belowEditorWidgets = $derived(
    Object.entries(extensionUiState.widgets).filter(
      ([key]) => (extensionUiState.widgetPlacement[key] ?? 'aboveEditor') === 'belowEditor'
    )
  );
  /** Current frame index for the working indicator animation. */
  let workingFrameIndex = $state(0);
  /** Global tool output expansion state (setToolsExpanded). */
  let toolsExpandedGlobal = $state(false);
  /** Argument completions for the current extension command (subcommands). */
  let commandArgCompletions = $state<{ value: string; label: string; description?: string }[]>([]);
  let commandArgCommand = $state('');
  let commandArgPrefix = $state('');
  let commandCompletionsPending = $state(false);
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
    const commandEnd = trimmed.search(/\s/);
    if (commandEnd < 0) return null;
    const cmdName = trimmed.slice(0, commandEnd).toLowerCase();
    const extCmd = extensionCommands.find((c) => c.name.toLowerCase() === cmdName);
    if (!extCmd) return null;
    return { command: cmdName, prefix: trimmed.slice(commandEnd).trim() };
  });
  const filteredSlashCommands = $derived.by<ComposerShortcut[]>(() => {
    if (!shortcutTrigger) return [];
    const q = shortcutQuery;
    const match = (value: string) => value.toLowerCase().includes(q);

    if (shortcutTrigger === '/') {
      // Show subcommand completions when typing past an extension command, e.g. "/ag ".
      if (commandArgMode) {
        const cmdName = commandArgMode.command;
        const prefix = commandArgMode.prefix.toLowerCase();
        const filtered = commandArgCompletions
          .filter((c) => !prefix || c.value.toLowerCase().startsWith(prefix))
          .map((c) => ({
            trigger: '/' as const,
            label: c.label || c.value,
            description: c.description ?? `/${cmdName} subcommand`,
            insert: `/${cmdName} ${c.value} `,
          }))
          .slice(0, 14);
        if (filtered.length > 0) return filtered;
        return [
          {
            trigger: '/' as const,
            label: commandCompletionsPending ? 'Loading subcommands…' : 'No subcommands found',
            description: `/${cmdName}${commandArgMode.prefix ? ` ${commandArgMode.prefix}` : ''}`,
            insert: input,
            muted: true,
            disabled: true,
          },
        ];
      }
      const commands = SLASH_COMMANDS.filter((c) => !q || c.name.startsWith(q)).map((c) => ({
        trigger: '/' as const,
        label: `/${c.name}`,
        description: c.description,
        insert: `/${c.name} `,
      }));
      // Group extension commands by source (file/package name)
      const extBySource = Object.groupBy(
        extensionCommands.filter((c) => typeof c.name === 'string' && (!q || c.name.startsWith(q))),
        (c) => c.source
      );
      const extCmds: ComposerShortcut[] = [];
      for (const [source, cmds] of Object.entries(extBySource).filter(
        (e): e is [string, typeof extensionCommands] => !!e[1]
      )) {
        for (const c of cmds.slice(0, 6)) {
          extCmds.push({
            trigger: '/' as const,
            label: `/${c.name}`,
            description: c.description || `${source} command`,
            insert: `/${c.name} `,
            section: source,
          });
        }
      }
      const skills = resourcesSkills
        .filter((s) => !q || match(s.name) || match(s.description))
        .slice(0, 8)
        .map((s) => ({
          trigger: '/' as const,
          label: `/skill:${s.name}`,
          description: s.description || `${s.scope} skill`,
          insert: `/skill:${s.name} `,
          muted: s.isBuiltin,
        }));
      const prompts = resourcesPrompts
        .filter((p) => !q || match(p.name) || match(p.description))
        .slice(0, 8)
        .map((p) => ({
          trigger: '/' as const,
          label: `/${p.name}`,
          description: p.description || p.argumentHint || `${p.scope} prompt`,
          insert: `/${p.name} `,
          muted: p.isBuiltin,
        }));
      const extAuto = extensionCompletions
        .filter((c) => !q || match(c.label) || match(c.description ?? ''))
        .slice(0, 8)
        .map((c) => ({
          trigger: '/' as const,
          label: `/${c.label}`,
          description: c.description ?? 'extension',
          insert: `/${c.value} `,
        }));
      return [...commands, ...extCmds, ...skills, ...prompts, ...extAuto].slice(0, 14);
    }

    if (shortcutTrigger === '@') {
      const refs = [
        ...fileCompletions.map((path) => ({
          label: `@${path}`,
          description: 'workspace file',
          insert: `@${path} `,
        })),

        ...(cwd ? [{ label: '@current', description: cwd, insert: `@${cwd} ` }] : []),

        ...projectsState.groups.map((p) => ({
          label: `@${p.name}`,
          description: p.cwd,
          insert: `@${p.cwd} `,
        })),
        ...projectsState.allSessions.slice(0, 24).map((s) => ({
          label: `@${s.name || s.firstMessage || '(empty)'}`,
          description: s.cwd,
          insert: `@${s.path} `,
        })),
        ...extensionCompletions
          .filter((c) => !q || match(c.label) || match(c.description ?? ''))
          .map((c) => ({
            label: `@${c.label}`,
            description: c.description ?? 'extension',
            insert: `@${c.value} `,
          })),
      ];
      return refs
        .filter((r) => !q || match(r.label) || match(r.description))
        .slice(0, 12)
        .map((r) => ({ trigger: '@' as const, ...r }));
    }

    if (shortcutTrigger === '!') {
      const extAuto = extensionCompletions
        .filter((c) => !q || match(c.label) || match(c.description ?? ''))
        .map((c) => ({
          label: c.label,
          description: c.description ?? 'extension',
          insert: `!${c.value} `,
        }));
      return [
        ...SHELL_SHORTCUTS.filter(
          (s) => !q || match(s.label) || match(s.description) || match(s.insert)
        ).map((s) => ({ trigger: '!' as const, ...s })),
        ...extAuto.map((c) => ({ trigger: '!' as const, ...c })),
      ];
    }

    const extAuto = extensionCompletions
      .filter((c) => !q || match(c.label) || match(c.description ?? ''))
      .map((c) => ({
        label: c.label,
        description: c.description ?? 'extension',
        insert: `#${c.value} `,
        muted: false,
      }));
    return [
      ...SNIPPET_SHORTCUTS,
      ...resourcesPrompts.map((p) => ({
        label: p.name,
        description: p.description || p.argumentHint || `${p.scope} prompt`,
        insert: `#${p.name} `,
        muted: p.isBuiltin,
      })),
      ...extAuto,
    ]
      .filter((s) => !q || match(s.label) || match(s.description))
      .slice(0, 12)
      .map((s) => ({ trigger: '#' as const, ...s }));
  });
  let isStreaming = $state(false);
  let activeToolName = $state<string | undefined>(undefined);
  let wsState = $state<'connecting' | 'open' | 'closed'>('connecting');
  /** True from server_restarting until the WS successfully reconnects. */
  let isRestarting = $state(false);
  let sessionId = $state<string | null>(null);
  let thinkingLevel = $state('off');
  let model = $state<ModelInfo | null>(null);
  /** Thinking levels available for the current model — derived from model.thinkingLevelMap. */
  let availableThinkingLevels = $derived(getSupportedThinkingLevels(model));
  $effect(() => {
    const clamped = clampThinkingLevelForModel(model, thinkingLevel);
    if (clamped !== thinkingLevel) thinkingLevel = clamped;
  });
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
  /** Session file path on disk — used to persist the active session across page reloads. */
  let sessionPath = $state<string | undefined>(undefined);
  /** Real-time context usage from the pi SDK (via getContextUsage()). */
  let contextUsageTokens = $state<number | null>(null);
  let contextUsageWindow = $state(0);
  /** Whether the server truncated older messages from the initial payload. */
  let messagesTruncated = $state(false);
  /** Total session message count (may exceed visible messages.length). */
  let totalMessageCount = $state(0);
  /** How many raw SDK messages we've loaded so far (used for correct history pagination). */
  let totalRawMessagesLoaded = $state(0);
  /** Prevent duplicate older-history requests from appending the same page twice. */
  let olderMessagesLoading = $state(false);
  /** True while a session switch is in flight — shows skeleton instead of stale chat. */
  /* eslint-disable-next-line svelte/prefer-writable-derived */
  let sessionLoading = $state(false);
  $effect(() => {
    sessionLoading = projectsState.sessionLoading;
  });
  // Optimistic new-chat: clear messages instantly when new_session is
  // dispatched — waiting for the server's session_loaded (which can take
  // seconds with 34 tools/extensions) makes "new chat" feel hung.
  let _optimisticPrevMessages: typeof messages | null = null;
  /** Draft captured before an optimistic new-session reset; restored on failure. */
  let _optimisticPrevInput: string | null = null;
  /** Draft typed while an existing session is still opening. */
  let sessionSwitchDraft: string | null = null;
  /** Draft supplied by the Web Share Target; it outranks cached session drafts once. */
  let shareTargetDraft: string | null = null;
  let bootResumePath: string | null = null;
  /** Connected snapshot held back while the remembered boot session loads. */
  let _bootServerSnapshot: ConnectedMessage | null = null;
  /** Request token for the remembered-session boot switch. */
  let _bootResumeRequestId: string | null = null;
  /** Boot identity restore must not wait for the general 20 s op watchdog. */
  const BOOT_RESUME_TIMEOUT_MS = 4_000;
  let _bootResumeTimer: ReturnType<typeof setTimeout> | null = null;
  function clearBootResumeTimer(): void {
    if (_bootResumeTimer !== null) {
      clearTimeout(_bootResumeTimer);
      _bootResumeTimer = null;
    }
  }
  function releaseBootResumeFallback(): void {
    if (bootResumePath === null || _bootResumeRequestId === null) return;
    // The timer handles a still-pending request; the effect below handles the
    // store's normal timeout verdict. Ignore an already-settled operation.
    if (!projectsState.sessionLoading && projectsState.error !== 'Session switch timed out') return;

    const fallback = _bootServerSnapshot;
    clearBootResumeTimer();
    projectsState.cancelPendingOps();
    projectsState.error = null;
    bootResumePath = null;
    _bootResumeRequestId = null;
    _bootServerSnapshot = null;
    clearIdentity();
    if (fallback) {
      applySessionState(fallback as unknown as Record<string, unknown>);
      _lastVisibleSessionPath =
        typeof fallback.sessionPath === 'string' ? fallback.sessionPath : undefined;
      _lastVisibleSessionId =
        typeof fallback.sessionId === 'string' ? fallback.sessionId : undefined;
      resetSessionPanelState();
      projectTrust = fallback.projectTrust ?? null;
      runtimeDiagnostics = fallback.diagnostics ?? [];
      resyncEditorMirror();
      sessionStartTime = Date.now();
      if (fallback.piVersion) piVersion = fallback.piVersion;
      if (fallback.uiVersion) uiVersion = fallback.uiVersion;
      if (fallback.sessionMode) sessionMode = fallback.sessionMode;
      loadWebhookUrlFromServer(fallback.webhookUrl);
      sessionLoading = false;
      if (sessionPath) {
        setSessionParam(sessionPath);
        saveIdentity(sessionPath, sessionId ?? undefined, sessionName);
        saveSnapshot(sessionPath, sessionName, messages);
      } else {
        clearIdentity();
      }
    } else {
      sessionLoading = false;
    }
    showChatNotice('Session switch timed out', 'warning');
  }
  /** Last path rendered from an authoritative full snapshot. */
  let _lastVisibleSessionPath: string | undefined;
  /** Last session id rendered from an authoritative full snapshot. */
  let _lastVisibleSessionId: string | undefined;
  /** The optimistic new-chat reset already saved this outgoing view. */
  let _optimisticViewSavedSessionId: string | null = null;
  let _pendingEdit: { messages: UIMessage[]; input: string } | null = null;
  $effect(() => {
    if (projectsState.pendingNewSession && !_optimisticPrevMessages) {
      if (sessionId) {
        saveVisibleSessionView(sessionId);
        _optimisticViewSavedSessionId = sessionId;
      }
      sessionSwitchDraft = null;
      discardPendingTerminalInputs();
      _optimisticPrevMessages = messages.slice();
      _optimisticPrevInput = input;
      messages = [];
      toolMessagesById.clear();
      input = '';
      totalRawMessagesLoaded = 0;
      totalMessageCount = 0;
      messagesTruncated = false;
      olderMessagesLoading = false;
      activeStreamMsg = null;
      isStreaming = false;
      activeToolName = undefined;
      projectsState.isStreaming = false;
      compactionStartedAt = null;
      sessionName = undefined;
      // Keep cwd until server confirms targetCwd; don't wipe model etc.
    }
  });
  // Explicit session errors restore the optimistic new-chat state locally.
  // A watchdog timeout is different: the server may have created the new
  // session successfully, so wait for resync_session's authoritative snapshot.
  $effect(() => {
    if (
      !projectsState.pendingNewSession &&
      _optimisticPrevMessages &&
      projectsState.error &&
      projectsState.error !== 'New chat timed out — server did not respond in time'
    ) {
      messages = _optimisticPrevMessages;
      rebuildToolMessageIndex();
      if (_optimisticPrevInput !== null) input = _optimisticPrevInput;
      _optimisticPrevMessages = null;
      _optimisticPrevInput = null;
      _optimisticViewSavedSessionId = null;
    }
  });
  $effect(() => {
    if (
      bootResumePath === null ||
      _bootResumeRequestId === null ||
      projectsState.sessionLoading ||
      projectsState.error !== 'Session switch timed out'
    )
      return;
    releaseBootResumeFallback();
  });
  let sessionStartTime = $state(0);
  /** Pending steered messages (queue_update) */
  let queuedSteering = $state<string[]>([]);
  /** Pending follow-up messages (queue_update) */
  let queuedFollowUp = $state<string[]>([]);
  /** Whether context compaction is currently running */
  let isCompacting = $state(false);
  /** Unix ms when the current compaction began, for live elapsed display. */
  let compactionStartedAt = $state<number | null>(null);
  /** Whether auto-compaction is enabled — persisted in localStorage */
  let autoCompactionEnabled = $state(true);
  /** Whether auto-retry on transient errors is enabled — persisted in localStorage */
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

  // ── Panel state ──────────────────────────────────────────────────────────────

  let showRightPanel = $state(urlParam('rp', '') === '1');

  let rightPanelTab = $state<'models' | 'tools' | 'skills'>(
    (['models', 'tools', 'skills'] as const).includes(
      urlParam('rpt', '') as 'models' | 'tools' | 'skills'
    )
      ? (urlParam('rpt', '') as 'models' | 'tools' | 'skills')
      : 'models'
  );

  function setTheme(t: string) {
    selectedTheme = t;
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem('pifrontier:theme', t);
    } catch {
      /* noop */
    }
    // Sync PWA theme-color meta to the daisyUI base-100 background
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue('--color-base-100')
        .trim();
      if (bg) {
        // daisyUI stores oklch() in the CSS var; use it directly
        meta.setAttribute('content', `oklch(${bg})`);
      }
    }
    // Persist theme choice to server for cross-device sync
    send({ type: 'set_settings', settings: { theme: t } });
  }
  let showSessionPanel = $state(urlParam('sp', '') === '1');

  // ── Sidebar resize ────────────────────────────────────────────────────────────

  const PANEL_MIN_W = 180;
  const PANEL_MAX_W = 560;
  /** Left sidebar (session panel) pixel width. */
  let sessionPanelWidth = $state(320);
  /** Right sidebars (model picker / tools / resources) pixel width — shared. */
  let rightPanelWidth = $state(320);
  /** True while the user is dragging the right panel resize handle. */
  let rightResizing = $state(false);
  /** True while the user is dragging the session panel resize handle. */
  let sessionResizing = $state(false);
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
  let lastExtensionQuery = $state('');
  let lastFileCompleteQuery = '';
  let _fileCompleteTimer: ReturnType<typeof setTimeout> | null = null;
  const SETTINGS_SECTIONS = [
    { id: 'session', label: 'Session', icon: SlidersHorizontal },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
    { id: 'extensions', label: 'Extensions', icon: Blocks },
    { id: 'packages', label: 'Packages', icon: PackageOpen },
    { id: 'updates', label: 'Updates', icon: RefreshCw },
    { id: 'about', label: 'About', icon: PiIcon },
  ] as const;

  const THEMES: { id: string; name: string }[] = [
    { id: 'pi', name: 'Pi' },
    { id: 'night', name: 'Night' },
    { id: 'dark', name: 'Dark' },
    { id: 'dracula', name: 'Dracula' },
    { id: 'synthwave', name: 'Synthwave' },
    { id: 'forest', name: 'Forest' },
    { id: 'luxury', name: 'Luxury' },
    { id: 'coffee', name: 'Coffee' },
    { id: 'sunset', name: 'Sunset' },
    { id: 'dim', name: 'Dim' },
    { id: 'black', name: 'Black' },
    { id: 'nord', name: 'Nord' },
    { id: 'abyss', name: 'Abyss' },
    { id: 'winter', name: 'Winter' },
    { id: 'emerald', name: 'Emerald' },
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

  /** Touch gestures — see handleTouchStart/handleTouchEnd. Shown alongside
   * SHORTCUTS in the settings panel so they're discoverable without a
   * keyboard to hunt for a keybind list in the first place. */
  const GESTURES = [
    { gesture: 'Swipe right from left edge', action: 'Open sessions panel' },
    { gesture: 'Swipe left from right edge', action: 'Open model & tools panel' },
    { gesture: 'Swipe an open panel toward its edge', action: 'Close it' },
  ];

  /** All tools reported by the server */
  let toolsList = $state<
    { name: string; description: string; isBuiltin: boolean; origin?: string }[]
  >([]);
  /** Names of currently active/enabled tools */
  let activeToolNames = $state<string[]>([]);
  /** Registered slash commands from extensions */
  let extensionCommands = $state<{ name: string; description?: string; source: string }[]>([]);

  /** PWA install prompt (beforeinstallprompt event). Non-reactive — event fires once. */
  let deferredInstallPrompt: Event | null = null;
  let installReady = $state(false);

  async function handleInstallClick() {
    if (!deferredInstallPrompt) return;
    const e = deferredInstallPrompt as Event & {
      prompt(): Promise<void>;
      userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
    };
    e.preventDefault();
    await e.prompt();
    const result = await e.userChoice;
    if (result.outcome === 'accepted') installReady = false;
    deferredInstallPrompt = null;
  }

  /** Whether the settings modal is open */
  let showSettingsPanel = $state(false);
  /** Native confirmation dialog state — replaces window.confirm for delete/update/restart. */
  let pendingConfirm = $state<{
    title: string;
    message: string;
    confirmLabel: string;
    variant: 'error' | 'warning' | 'info';
    onConfirm: () => void;
  } | null>(null);
  function requestConfirm(
    message: string,
    onConfirm: () => void,
    opts?: { title?: string; confirmLabel?: string; variant?: 'error' | 'warning' | 'info' }
  ) {
    pendingConfirm = {
      title: opts?.title ?? 'Confirm',
      message,
      confirmLabel: opts?.confirmLabel ?? 'Confirm',
      variant: opts?.variant ?? 'error',
      onConfirm,
    };
  }
  let notificationPrefs = $state<NotificationPrefs>(loadNotificationPrefs());
  $effect(() => {
    saveNotificationPrefs(notificationPrefs);
  });

  // ── Post-run permission nudge ─────────────────────────────────────────────
  // Asking right after a completed turn (when the value is obvious) converts
  // far better than the Settings toggle. Shown once; permission requests MUST
  // come from a user gesture, so the banner's Enable button does the asking.
  let showNotifNudge = $state(false);
  let notifNudgeSeen = $state(false);
  try {
    notifNudgeSeen = localStorage.getItem(NOTIF_NUDGE_SEEN_KEY) === '1';
  } catch {
    /* ignore */
  }
  function enableNotifications() {
    showNotifNudge = false;
    notifNudgeSeen = true;
    try {
      localStorage.setItem(NOTIF_NUDGE_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission()
        .then((p) => {
          if (p === 'granted' && connectedPushVapidKey && wsState === 'open') {
            void syncPushSubscription();
          }
        })
        .catch(() => {});
    }
  }
  function dismissNotifNudge() {
    showNotifNudge = false;
    notifNudgeSeen = true;
    try {
      localStorage.setItem(NOTIF_NUDGE_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  // ── Web Push subscription sync ────────────────────────────────────────────
  // One subscription per browser, mirroring it to the server so closed-app
  // notifications (agent_end pushes) can reach this device. Subscribe when
  // notifications are enabled + permission granted; unsubscribe otherwise.
  let connectedPushVapidKey = $state<string | null>(null);
  let _pushSyncInFlight = false;

  async function syncPushSubscription() {
    if (_pushSyncInFlight) return;
    _pushSyncInFlight = true;
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        const json = existing.toJSON();
        if (json.keys?.p256dh && json.keys.auth) {
          send({
            type: 'push_subscribe',
            endpoint: existing.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
            expirationTime: existing.expirationTime ?? null,
          });
        }
        return;
      }
      if (!connectedPushVapidKey) return;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(connectedPushVapidKey),
      });
      const json = sub.toJSON();
      send({
        type: 'push_subscribe',
        endpoint: sub.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
        expirationTime: sub.expirationTime ?? null,
      });
    } catch (err) {
      // Permission revoked, push unavailable, or a malformed VAPID key —
      // notifications just stay page-only. Log for diagnosability.
      console.warn('[pi-ui] push subscribe failed:', err);
    } finally {
      _pushSyncInFlight = false;
    }
  }

  async function unsubscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        send({ type: 'push_unsubscribe', endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
    } catch {
      /* ignore */
    }
  }

  $effect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!connectedPushVapidKey || wsState !== 'open') return;
    if (notificationPrefs.enabled && Notification.permission === 'granted') {
      void syncPushSubscription();
    } else {
      void unsubscribePush();
    }
  });

  /** Webhook notification URL (ntfy.sh/Pushover/Gotify) — persisted server-side. */
  let notificationWebhookUrl = $state('');
  function loadWebhookUrlFromServer(url?: string) {
    notificationWebhookUrl = url ?? '';
  }

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

  function initSettingsSection():
    'session' | 'notifications' | 'shortcuts' | 'extensions' | 'packages' | 'updates' | 'about' {
    const v = urlParam('ss', 'session');
    const valid = [
      'session',
      'notifications',
      'shortcuts',
      'extensions',
      'packages',
      'updates',
      'about',
    ] as const;
    return (valid as readonly string[]).includes(v) ? (v as (typeof valid)[number]) : 'session';
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
  let projectTrust = $state<ProjectTrustInfo | null>(null);
  /** True while the active project's trust is undecided — shows the trust strip. */
  const trustPromptVisible = $derived(
    wsState === 'open' && projectTrust?.requiresDecision === true && projectTrust.decision === 'ask'
  );
  let runtimeDiagnostics = $state<RuntimeDiagnostic[]>([]);
  let packagesList = $state<ConfiguredPackageInfo[]>([]);
  let packageUpdates = $state<PackageUpdateInfo[]>([]);
  let packagesLoaded = $state(false);
  let packageSource = $state('');
  let packageScope = $state<'user' | 'project'>('user');
  let packageBusy = $state(false);
  let packageProgress = $state<PackageProgress | null>(null);
  let extensionsLoaded = $state(false);
  let sessionStats = $state<SessionStats | null>(null);
  let exportFeedback = $state<string | null>(null);

  /** Update tab state */
  let updateStatus = $state<UpdateStatus | null>(null);
  let updateLoading = $state(false);
  let updateRunning = $state(false);
  let updateTarget = $state<UpdateTarget | null>(null);
  let updateLog = $state('');
  let updateFeedback = $state<{
    success: boolean;
    message: string;
    restartRequired?: boolean;
    reloadRequired?: boolean;
  } | null>(null);
  let reloadAfterRestart = false;

  /** Install skill form state */
  let skillInstallUrl = $state('');
  let skillInstallScope = $state<'project' | 'user'>('user');
  let skillInstalling = $state(false);
  let skillInstallFeedback = $state<{ success: boolean; message: string } | null>(null);

  /** Which tab is active inside the model picker panel */
  let modelTab = $state<'models' | 'providers'>(
    urlParam('mt', 'models') === 'providers' ? 'providers' : 'models'
  );
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
  let modelRefreshLoading = $state(false);
  let modelRefreshFeedback = $state<{ success: boolean; message: string } | null>(null);
  let modelRefreshFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

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
      ? providers.filter(
          (p) =>
            p.name.toLowerCase().includes(providerFilter.toLowerCase()) ||
            p.id.toLowerCase().includes(providerFilter.toLowerCase())
        )
      : providers
  );

  const configuredProviderCount = $derived(providers.filter((p) => p.configured).length);

  const sessionTokens = $derived(messages.reduce((s, m) => s + (m.usage?.totalTokens ?? 0), 0));
  const sessionCostTotal = $derived(messages.reduce((s, m) => s + (m.usage?.cost?.total ?? 0), 0));
  const sessionDuration = $derived(
    sessionStartTime > 0 ? fmtDuration(Date.now() - sessionStartTime) : ''
  );
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

  /** Most recent completed compaction, surfaced in the context tooltip. */
  const latestCompaction = $derived.by(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.noticeKind === 'compaction' && message.compaction?.status === 'completed') {
        return message.compaction;
      }
    }
    return undefined;
  });
  const lastCompactionSavings = $derived.by(() => {
    const before = latestCompaction?.tokensBefore;
    const after = latestCompaction?.tokensAfter;
    if (before === undefined || after === undefined || before <= 0 || after > before)
      return undefined;
    return Math.round(((before - after) / before) * 100);
  });

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
      .map(
        ([provider, models]) =>
          [
            provider,
            models.filter(
              (m) => m.name.toLowerCase().includes(q) || provider.toLowerCase().includes(q)
            ),
          ] as [string, ModelInfo[]]
      )
      .filter(([, models]) => models.length > 0);
  });

  const filteredTools = $derived.by(() => {
    const q = toolFilter.trim().toLowerCase();
    if (!q) return toolsList;
    return toolsList.filter(
      (t) => t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q)
    );
  });

  const filteredSkills = $derived.by(() => {
    const q = skillFilter.trim().toLowerCase();
    if (!q) return { skills: resourcesSkills, prompts: resourcesPrompts };
    return {
      skills: resourcesSkills.filter(
        (s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)
      ),
      prompts: resourcesPrompts.filter(
        (p) => p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q)
      ),
    };
  });

  // ── DOM refs ─────────────────────────────────────────────────────────────────

  let scrollEl = $state<HTMLElement | undefined>(undefined);
  let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);
  let ws: WebSocket | null = null;
  /** True after this socket receives its application-level `connected` message. */
  let _wsHandshakeComplete = false;
  /** Latest notification deep-link waiting for a live, handshaken socket. */
  let pendingNotificationSessionPath: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectCountdown = $state(0);
  let reconnectInterval: ReturnType<typeof setInterval> | null = null;
  /** Throttle recovery UI for malformed frames so repeated bad payloads do not flood the chat. */
  let _invalidFrameNoticeAt = 0;
  /** Resync requests are limited to one in flight and one attempt per five seconds. */
  let _resyncRequestedAt = 0;
  let _resyncInFlight = false;
  let sendHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let sendHoldSubmitted = false;
  /** True while the send button is being held down toward the follow-up threshold — drives the progress ring. */
  let sendHolding = $state(false);
  /** True when the scroll container is at (or near) the bottom */
  let isAtBottom = $state(true);
  /** The message id whose copy action is in the "copied" confirmation state */
  let copiedId = $state<string | null>(null);
  /** The message id whose "copy turn" action is in the "copied" confirmation state */
  let copiedTurnId = $state<string | null>(null);

  // ── Refresh project/session lists when the sidebar opens ────────────────────

  $effect(() => {
    if (showSessionPanel) projectsState.refresh();
  });

  // ── Right-panel data fetches ────────────────────────────────────────────────
  function resetSessionPanelState() {
    providers = [];
    providerError = null;
    providerKeyInputs = {};
    resourcesSkills = [];
    resourcesPrompts = [];
    resourcesLoaded = false;
    extensionsList = [];
    extensionErrors = [];
    extensionsLoaded = false;
    packagesList = [];
    packageUpdates = [];
    packagesLoaded = false;
    packageBusy = false;
    packageProgress = null;
  }

  // ── Load providers when models tab is active ──────────────────────────────────

  $effect(() => {
    if (showRightPanel && rightPanelTab === 'models' && wsState === 'open' && sessionId) {
      send({ type: 'get_providers' });
      modelFilter = '';
    }
  });
  function showModelRefreshFeedback(feedback: { success: boolean; message: string }) {
    if (modelRefreshFeedbackTimer) clearTimeout(modelRefreshFeedbackTimer);
    modelRefreshFeedback = feedback;
    modelRefreshFeedbackTimer = setTimeout(() => {
      modelRefreshFeedback = null;
      modelRefreshFeedbackTimer = null;
    }, 5_000);
  }

  function requestModelRefresh() {
    if (modelRefreshLoading || wsState !== 'open') return;
    modelRefreshLoading = true;
    modelRefreshFeedback = null;
    if (!send({ type: 'refresh_models' })) {
      modelRefreshLoading = false;
      showModelRefreshFeedback({ success: false, message: 'Not connected.' });
    }
  }

  // ── Load tools when tools tab is active ─────────────────────────────────────
  // Tools are seeded from connected/session_loaded plus the async bindRpcHost
  // push. The tab fetches only when the list is empty while the panel is open
  // on a live session.
  $effect(() => {
    if (
      showRightPanel &&
      rightPanelTab === 'tools' &&
      wsState === 'open' &&
      toolsList.length === 0
    ) {
      send({ type: 'get_tools' });
    }
  });

  // ── Load resources when skills tab is active ─────────────────────────────────

  $effect(() => {
    if (showRightPanel && rightPanelTab === 'skills' && wsState === 'open' && sessionId) {
      resourcesLoaded = false;
      send({ type: 'get_resources' });
    }
  });

  // ── Working indicator frame animation ──────────────────────────────────────

  $effect(() => {
    const frames = extensionUiState.workingIndicatorFrames;
    const ms = extensionUiState.workingIndicatorMs;
    if (frames.length === 0 || !extensionUiState.workingVisible) return;
    workingFrameIndex = 0;
    const id = setInterval(() => {
      workingFrameIndex = (workingFrameIndex + 1) % frames.length;
    }, ms);
    return () => clearInterval(id);
  });

  // ── Load extensions when settings extensions tab is active ──────────────────

  $effect(() => {
    if (showSettingsPanel && settingsSection === 'extensions' && wsState === 'open' && sessionId) {
      extensionsLoaded = false;
      send({ type: 'get_extensions' });
    }
  });
  $effect(() => {
    if (showSettingsPanel && settingsSection === 'packages' && wsState === 'open' && sessionId) {
      packagesLoaded = false;
      send({ type: 'get_packages' });
    }
  });
  $effect(() => {
    if (showSettingsPanel && settingsSection === 'about' && wsState === 'open') {
      send({ type: 'get_session_stats' });
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
  // ── Heartbeat — detects zombie sockets (dead-but-open, e.g. wifi drop or
  // network switch while the page is visible) that never fire onclose, and
  // keeps idle connections alive under the server's 120s idleTimeout.
  let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Timestamp of the last message received from the server (any type counts as liveness). */
  let _lastMsgAt = 0;
  /** Timestamp of the last ping we sent; 0 when no ping is outstanding. */
  let _pingSentAt = 0;
  const HEARTBEAT_INTERVAL_MS = 25_000;
  const PONG_TIMEOUT_MS = 10_000;

  function startHeartbeat() {
    stopHeartbeat();
    _lastMsgAt = Date.now();
    _pingSentAt = 0;
    _heartbeatTimer = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      // A ping is outstanding, its timeout passed, and nothing arrived since —
      // the socket is dead. Force-close so onclose fires and reconnection runs.
      if (_pingSentAt && _lastMsgAt < _pingSentAt && now - _pingSentAt > PONG_TIMEOUT_MS) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      if (now - _lastMsgAt >= HEARTBEAT_INTERVAL_MS) {
        _pingSentAt = now;
        send({ type: 'ping' });
      }
    }, HEARTBEAT_INTERVAL_MS / 2);
  }

  function stopHeartbeat() {
    if (_heartbeatTimer) {
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
    }
  }

  function getReconnectDelay(): number {
    return reconnectDelay(_reconnectAttempt);
  }

  function cancelReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }
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
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
      }
      connect();
    }, delay);
  }

  /** Navigate to /login, preserving the current URL so login can return here. */
  function redirectToLogin() {
    _intentionalClose = true;
    cancelReconnect();
    stopHeartbeat();
    wsState = 'closed';
    const current = location.pathname + location.search;
    location.assign(`/login?redirect=${encodeURIComponent(current)}`);
  }

  let _authProbeInFlight = false;

  /**
   * Detect an expired/revoked session after a socket failure. A rejected WS
   * upgrade (401) surfaces to the client as a generic abnormal close, so the
   * only way to tell "server down" from "session expired" is an HTTP probe:
   * hooks.server redirects every path but /login with a 302 when the JWT is
   * missing or invalid. Network failures mean the server is unreachable and
   * the normal reconnect loop applies.
   */
  async function probeSessionExpired(): Promise<void> {
    if (_authProbeInFlight || document.hidden || !navigator.onLine) return;
    _authProbeInFlight = true;
    try {
      const res = await fetch('/', { method: 'HEAD', redirect: 'manual', cache: 'no-store' });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        redirectToLogin();
      }
    } catch {
      // Server unreachable — keep the reconnect loop.
    } finally {
      _authProbeInFlight = false;
    }
  }

  function recoverFromInvalidFrame() {
    const now = Date.now();
    if (now - _invalidFrameNoticeAt >= 3_000) {
      _invalidFrameNoticeAt = now;
      showChatNotice('Received an invalid server update; refreshing the session.', 'warning');
    }
    if (_resyncInFlight || now - _resyncRequestedAt < 5_000) return;
    _resyncRequestedAt = now;
    if (send({ type: 'resync_session' })) _resyncInFlight = true;
  }

  function connect() {
    if (document.hidden) return;
    // Belt-and-braces: connect() nulls the old socket's onclose before
    // closing it, so its close event may never reach flushPendingTerminalInputs.
    flushPendingTerminalInputs();
    if (ws) {
      try {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    cancelReconnect();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // In dev mode the Bun WS server runs on a separate port (5174);
    // in production everything is served from a single port.
    const wsPort = dev ? '5174' : location.port;
    const socket = new WebSocket(`${proto}//${location.hostname}${wsPort ? ':' + wsPort : ''}/ws`);
    ws = socket;
    _wsHandshakeComplete = false;

    socket.onopen = () => {
      if (ws !== socket) return;
      wsState = 'open';
      cancelReconnect();
      startHeartbeat();
    };

    socket.onmessage = ({ data }: MessageEvent<string>) => {
      if (ws !== socket) return;
      _lastMsgAt = Date.now();
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch (e) {
        console.warn('[pi-ui] Failed to parse WS message:', e);
        return;
      }
      const parsedResult = parseServerMessage(raw);
      if (!parsedResult.ok) {
        console.warn('[pi-ui] invalid WS payload', parsedResult.issues);
        recoverFromInvalidFrame();
        return;
      }
      const parsed = parsedResult.value as ServerMessage & Record<string, unknown>;
      if (parsedResult.kind === 'connected' || parsed.type === 'connected') {
        _wsHandshakeComplete = true;
        overlayResizeConnection++;
        _reconnectAttempt = 0;
        if (reloadAfterRestart) {
          reloadAfterRestart = false;
          if (_reloadPending) {
            _reloadPending = false;
            location.reload();
          }
        }
      }
      handleServer(parsed);
    };

    socket.onclose = (event) => {
      // Stale-guard: a close event from a superseded socket (e.g. one torn
      // down by the resume force-close) must not clobber the current
      // connection's state or schedule spurious reconnects.
      if (ws !== socket) return;
      olderMessagesLoading = false;
      modelRefreshLoading = false;
      flushPendingTerminalInputs();
      stopHeartbeat();
      if (_intentionalClose) return;
      // 4001 = the server closed the socket because the session token expired
      // (or was revoked). Reconnecting can never succeed — go to /login.
      if (event.code === 4001) {
        redirectToLogin();
        return;
      }
      if (!_wsHandshakeComplete && event.code === 1011) {
        showChatNotice(`Server initialization failed: ${event.reason || 'unknown error'}`, 'error');
      }
      wsState = 'connecting';
      // Seal any streaming notices (compaction, retry) that would otherwise
      // stay stuck with streaming=true indefinitely after a disconnect
      for (const m of messages) {
        if (m.streaming) m.streaming = false;
      }
      activeStreamMsg = null;
      scheduleReconnect();
      // A rejected upgrade (expired cookie) looks like a dead server to the
      // WS API — probe HTTP to distinguish the two.
      probeSessionExpired();
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };
  }

  /** Read the persisted session path from URL params (?session=). */
  function getSessionParam(): string | null {
    try {
      return new URLSearchParams(window.location.search).get('session');
    } catch {
      return null;
    }
  }

  /** Persist the active session path to URL params without navigation. */
  function setSessionParam(path: string): void {
    const url = new URL(window.location.href);
    url.searchParams.set('session', path);
    // Confirmed URL writes clear the optimistic marker used to distinguish a
    // stale app-written query from a genuine deep link on the next boot.
    goto(url, {
      shallow: true,
      replace: true,
      state: { ...untrack(() => page.state), piUiOptimisticSession: null },
    }).catch(() => {
      /* best-effort URL sync — never fail the WS flow */
    });
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
    // See setSessionParam() for the goto rationale. `untrack` is required:
    // this runs from a layout-sync $effect, and reading `page.state` there
    // would subscribe the effect to it — goto's state write then re-triggers
    // the effect, looping forever.
    goto(url, { shallow: true, replace: true, state: untrack(() => page.state) }).catch(() => {
      /* best-effort URL sync */
    });
  }

  /** Gracefully close the WS without reconnecting. */
  function disconnect() {
    _intentionalClose = true;
    wsState = 'closed';
    stopHeartbeat();
    cancelReconnect();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  function send(msg: ClientMessage): boolean {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }
  /** Tell the server which session this socket currently has in view. */
  function sendSessionFocus(focusedSessionId: string | null): void {
    send({ type: 'session_focus', sessionId: focusedSessionId });
  }
  /** Apply the latest queued notification deep link after a live handshake. */
  function flushPendingNotificationSession() {
    const path = pendingNotificationSessionPath;
    if (!path || ws?.readyState !== WebSocket.OPEN || !_wsHandshakeComplete) return;
    pendingNotificationSessionPath = null;
    const target = projectsState.allSessions.find((s) => s.path === path);
    if (target && target.id === projectsState.activeSessionId) return;
    if (projectsState.switchSession(path) !== 'ok') {
      // Keep the intent if another session operation is still settling.
      pendingNotificationSessionPath = path;
    }
  }

  function notifyPiEvent(title: string, body: string, tag: string, data?: Record<string, unknown>) {
    if (!notificationPrefs.enabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const msg = { type: 'show_notification' as const, title, body, tag, data };
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage(msg);
    } else {
      try {
        new Notification(title, { body, tag, icon: '/pwa-192x192.png' });
      } catch {
        /* fail silently */
      }
    }
  }

  /** Keep the PWA badge equal to the number of unread resident sessions. */
  function updateAppBadge() {
    if (!('setAppBadge' in navigator)) return;
    const badge = navigator as Navigator & {
      setAppBadge(count?: number): Promise<void>;
      clearAppBadge(): Promise<void>;
    };
    if (projectsState.unreadCount > 0) {
      badge.setAppBadge(projectsState.unreadCount).catch(() => {});
    } else {
      badge.clearAppBadge().catch(() => {});
    }
  }

  $effect(() => {
    // Read the count so the effect re-runs when it changes; updateAppBadge
    // reads it again to decide between setAppBadge and clearAppBadge.
    void projectsState.unreadCount;
    updateAppBadge();
  });

  /** Deduplicate one completion alert per resident run (lastActivity is its run token). */
  const _notifiedBackgroundCompletions = new SvelteSet<string>();
  function notifyBackgroundCompletion(sessionRuntime: {
    sessionId: string;
    lastActivity: number;
  }): void {
    const key = `${sessionRuntime.sessionId}:${sessionRuntime.lastActivity}`;
    if (_notifiedBackgroundCompletions.has(key)) return;
    _notifiedBackgroundCompletions.add(key);
    if (_notifiedBackgroundCompletions.size > 64) {
      const oldest = _notifiedBackgroundCompletions.values().next().value;
      if (typeof oldest === 'string') _notifiedBackgroundCompletions.delete(oldest);
    }

    const summary = projectsState.allSessions.find((item) => item.id === sessionRuntime.sessionId);
    const name =
      summary?.name?.trim() ||
      summary?.firstMessage?.trim() ||
      summary?.path.split('/').filter(Boolean).pop() ||
      sessionRuntime.sessionId;
    if (document.hidden) {
      if (notificationPrefs.onComplete) {
        notifyPiEvent(
          'Response Complete',
          `${name} finished responding.`,
          `pi-agent-end-${sessionRuntime.sessionId}-${sessionRuntime.lastActivity}`,
          { kind: 'response_complete', sessionId: sessionRuntime.sessionId }
        );
      }
    } else {
      showChatNotice(`${name} finished responding.`, 'info');
    }
  }

  /** Screen Wake Lock — keeps the display on during agent responses. */
  let wakeLock: WakeLockSentinel | null = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      }
    } catch {
      /* wake lock unavailable */
    }
  }
  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // Give the shared projects store access to the live socket.
  projectsState.send = send;
  // Same for the extension UI store (modal answers need to send responses).
  projectsState.onBeforeSwitch = () => {
    // Stop any awaited key verdicts before the active session identity can
    // change. The store flips sessionLoading synchronously, but the local
    // mirror is an effect and can lag one turn behind a click.
    discardPendingTerminalInputs();
    sessionSwitchDraft = null;
  };
  extensionUiState.send = send;

  // ── Editor mirror (extension getEditorText) ──────────────────────────────
  // Every keystroke sends the full composer value — debounce it so fast typing
  // doesn't flood the WS. Extensions read the mirror on demand (dialogs,
  // widgets, terminal input), so every extension interaction flushes first.
  let _editorMirrorTimer: ReturnType<typeof setTimeout> | null = null;
  function flushEditorMirror() {
    if (!_editorMirrorTimer) return;
    clearTimeout(_editorMirrorTimer);
    _editorMirrorTimer = null;
    if (
      wsState === 'open' &&
      _wsHandshakeComplete &&
      sessionId &&
      !sessionLoading &&
      !projectsState.pendingNewSession
    ) {
      send({ type: 'extension_editor_text_change', text: input, sessionId });
    }
  }

  $effect(() => {
    const text = input;
    const sid = sessionId;
    // Same handshake gate as the bridge: before `connected` the stale
    // sessionId would write the previous session's editor mirror.
    if (_editorMirrorTimer) {
      clearTimeout(_editorMirrorTimer);
      _editorMirrorTimer = null;
    }
    if (
      wsState === 'open' &&
      _wsHandshakeComplete &&
      sid &&
      !sessionLoading &&
      !projectsState.pendingNewSession
    ) {
      _editorMirrorTimer = setTimeout(() => {
        _editorMirrorTimer = null;
        send({ type: 'extension_editor_text_change', text, sessionId: sid });
      }, 150);
    }
  });

  /**
   * Explicit resync — the mirror $effect above only refires when `input` or
   * `sessionId` change as SVELTE STATE. A same-session reconnect changes
   * neither (sessionId is reassigned to the identical value, a no-op for
   * $state equality), so the effect would never resend and the server's
   * synchronous getEditorText() mirror could stay stale/empty after the
   * server recreates the session's UI bucket. Call after every
   * connected/session_loaded once sessionId is current.
   */
  function resyncEditorMirror() {
    if (sessionId) send({ type: 'extension_editor_text_change', text: input, sessionId });
  }

  function currentContextUsage(): ContextUsage | null {
    if (contextUsageTokens === null && contextUsageWindow <= 0) return null;
    return {
      tokens: contextUsageTokens,
      contextWindow: contextUsageWindow,
      percent:
        contextUsageTokens !== null && contextUsageWindow > 0
          ? (contextUsageTokens / contextUsageWindow) * 100
          : null,
    };
  }

  /** Save the visible session before its state is replaced by another snapshot. */
  function saveVisibleSessionView(sid: string): void {
    const expanded = new Set(
      Object.entries(expandedUserMsgs)
        .filter(([, value]) => value)
        .map(([id]) => id)
    );
    const truncated = new Set(
      Object.entries(truncatedUserMsgs)
        .filter(([, value]) => value)
        .map(([id]) => id)
    );
    sessionViewCache.save(sid, {
      messages,
      activeStreamMsg,
      toolsById: new Map(toolMessagesById),
      expandedUserMsgs: expanded,
      truncatedUserMsgs: truncated,
      draft: input,
      contextUsage: currentContextUsage(),
      queuedSteering,
      queuedFollowUp,
      scrollAtBottom: isAtBottom,
    });
  }

  /** Bind a retained inactive view to the page's visible-session state. */
  function restoreSessionView(view: SessionView): void {
    const activeId = view.activeStreamMsg?.id;
    messages = view.messages;
    rebuildToolMessageIndex();
    activeStreamMsg = activeId
      ? (messages.find((message) => message.id === activeId) ?? null)
      : null;
    expandedUserMsgs = Object.fromEntries([...view.expandedUserMsgs].map((id) => [id, true]));
    truncatedUserMsgs = Object.fromEntries([...view.truncatedUserMsgs].map((id) => [id, true]));
    input = view.draft;
    queuedSteering = view.queuedSteering.slice();
    queuedFollowUp = view.queuedFollowUp.slice();
    contextUsageTokens = view.contextUsage?.tokens ?? null;
    contextUsageWindow = view.contextUsage?.contextWindow ?? 0;
    isAtBottom = view.scrollAtBottom;

    const streamingTool = messages.find((message) => message.role === 'tool' && message.streaming);
    isStreaming = Boolean(activeStreamMsg?.streaming || streamingTool);
    activeToolName = streamingTool?.toolName;
    const compaction = [...messages]
      .reverse()
      .find((message) => message.noticeKind === 'compaction' && message.streaming);
    isCompacting = Boolean(compaction);
    compactionStartedAt = compaction?.compaction?.startedAt ?? null;
    for (const message of messages) {
      if (
        (message.content && !message.renderedContent) ||
        (message.thinking && !message.renderedThinking)
      ) {
        scheduleContentRender(message);
      }
    }
  }

  // ── Server event handling ────────────────────────────────────────────────────
  function applySessionState(payload: Record<string, unknown>) {
    const prevSessionId = sessionId;
    if (typeof payload.sessionId === 'string') {
      const nextSessionId = payload.sessionId;
      if (nextSessionId !== prevSessionId) {
        // A connected/session_loaded snapshot can race a draft typed while
        // the socket is still completing its handshake. Preserve that draft
        // when no explicit switch is in flight; otherwise a late snapshot
        // replaces it with an empty composer and leaves Send disabled.
        const draftWhileSwitching = !projectsState.pendingNewSession
          ? (sessionSwitchDraft ?? (!projectsState.sessionLoading ? input : null))
          : null;
        const sharedDraft = shareTargetDraft;
        if (
          prevSessionId &&
          _optimisticViewSavedSessionId !== prevSessionId &&
          !projectsState.pendingNewSession
        ) {
          saveVisibleSessionView(prevSessionId);
        }
        const restored = !projectsState.pendingNewSession
          ? sessionViewCache.restore(nextSessionId)
          : null;
        sessionId = nextSessionId;
        attachedImages = [];
        attachedFiles = [];
        if (projectsState.pendingNewSession) {
          // The composer stays live while the server creates the session.
          // Keep that new draft instead of replacing it with another session's draft.
          expandedUserMsgs = {};
          truncatedUserMsgs = {};
        } else if (restored) {
          restoreSessionView(restored);
          // A draft typed while the switch was in flight belongs to the new
          // visible session and takes precedence over its cached draft.
          if (sharedDraft !== null) input = sharedDraft;
          else if (draftWhileSwitching !== null) input = draftWhileSwitching;
        } else {
          input = sharedDraft ?? draftWhileSwitching ?? '';
          expandedUserMsgs = {};
          truncatedUserMsgs = {};
        }
        shareTargetDraft = null;
        _optimisticViewSavedSessionId = null;
        // A key round-trip for the previous session must never be applied to
        // or routed toward the new one (its late verdict would insert text or
        // even submit into the wrong composer).
        discardPendingTerminalInputs();
        sessionSwitchDraft = null;
      }
    }
    const isFullSessionPayload = payload.type === 'connected' || payload.type === 'session_loaded';
    if ('isStreaming' in payload) isStreaming = payload.isStreaming as boolean;
    if ('activeToolName' in payload) {
      const incomingTool = payload.activeToolName;
      activeToolName =
        typeof incomingTool === 'string' && incomingTool.length > 0 ? incomingTool : undefined;
    } else if (
      isFullSessionPayload ||
      ('sessionId' in payload && payload.sessionId !== prevSessionId)
    ) {
      activeToolName = undefined;
    }
    const newModel = payload.model as ModelInfo | null | undefined;
    if (newModel !== undefined) model = newModel;
    if (typeof payload.thinkingLevel === 'string') {
      thinkingLevel = clampThinkingLevelForModel(model, payload.thinkingLevel);
    }
    if (payload.availableModels !== undefined) {
      availableModels = (payload.availableModels as ModelInfo[]) ?? [];
    }
    if (payload.tools !== undefined) {
      toolsList =
        (payload.tools as
          | { name: string; description: string; isBuiltin: boolean; origin?: string }[]
          | undefined) ?? [];
    }
    if (payload.activeToolNames !== undefined) {
      activeToolNames = (payload.activeToolNames as string[] | undefined) ?? [];
    }
    if (payload.cwd) cwd = payload.cwd as string;
    if ('sessionPath' in payload) {
      sessionPath = typeof payload.sessionPath === 'string' ? payload.sessionPath : undefined;
    } else if (payload.sessionMode === 'in-memory') {
      sessionPath = undefined;
    }
    if ('sessionName' in payload) {
      sessionName = typeof payload.sessionName === 'string' ? payload.sessionName : undefined;
    } else if (isFullSessionPayload) {
      // Full snapshots are authoritative: an unnamed session serializes with
      // the key dropped (JSON omits undefined), so absence must clear the
      // previous session's name instead of leaving it stale in the header.
      sessionName = undefined;
    }
    if ('messages' in payload) {
      const raw = (payload.messages as unknown[]) ?? [];
      const streamingMessage = payload.streamingMessage;
      messages = rawMessagesToUI(streamingMessage === undefined ? raw : [...raw, streamingMessage]);
      olderMessagesLoading = false;
      rebuildToolMessageIndex();
      pruneUnresolvedLangs();
      activeStreamMsg = null;
      if (streamingMessage !== undefined && isStreaming) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            messages[i].streaming = true;
            activeStreamMsg = messages[i];
            break;
          }
        }
      }
      totalRawMessagesLoaded = raw.length;
      if ('totalMessageCount' in payload) totalMessageCount = payload.totalMessageCount as number;
      if ('messagesTruncated' in payload) messagesTruncated = Boolean(payload.messagesTruncated);
    }
    if (payload.extensionUiState && typeof payload.extensionUiState === 'object') {
      extensionUiState.applySnapshot(payload.extensionUiState as ExtensionUiStatePayload);
    } else if ('widgets' in payload) {
      // Legacy snapshots carry widgets as a top-level array. Treat the
      // snapshot as a full session-scoped replacement, including title and
      // other extension channels, before replaying the widgets.
      extensionUiState.reset();
      for (const w of (payload.widgets as WidgetPayload[]) ?? []) {
        extensionUiState.applyWidget(w as unknown as Record<string, unknown>);
      }
    } else if ('sessionId' in payload && (payload.sessionId as string) !== prevSessionId) {
      // Defensive: a session change without a snapshot must never keep the
      // previous session's extension UI behind (legacy/partial payloads).
      extensionUiState.reset();
    }
    // Legacy full snapshots do not carry the newer extensionUiState title.
    // Once the session changes, fall back to its name rather than retaining
    // the previous session's extension-injected document title.
    if (isFullSessionPayload && payload.extensionUiState === undefined) {
      extensionUiState.setTitle(sessionName);
    }
    // Sync the shared projects store with the active session.
    projectsState.cwd = cwd;
    if ('sessionId' in payload && typeof payload.sessionId === 'string') {
      projectsState.reconcileActiveRuntime(payload.sessionId, isStreaming, activeToolName);
    } else {
      projectsState.isStreaming = isStreaming;
      projectsState.activeToolName = activeToolName;
    }
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
      const cu = payload.contextUsage as
        { tokens?: number | null; contextWindow?: number } | undefined;
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
    if ('isCompacting' in payload) {
      const compacting = Boolean(payload.isCompacting);
      isCompacting = compacting;
      if (compacting) {
        if (compactionStartedAt === null) compactionStartedAt = Date.now();
      } else {
        compactionStartedAt = null;
      }
    }
    if ('autoCompactionEnabled' in payload) {
      autoCompactionEnabled = Boolean(payload.autoCompactionEnabled ?? true);
      try {
        localStorage.setItem(
          'pifrontier:autoCompactionEnabled',
          JSON.stringify(autoCompactionEnabled)
        );
      } catch {
        /* noop */
      }
    }
    if ('autoRetryEnabled' in payload) {
      autoRetryEnabled = Boolean(payload.autoRetryEnabled ?? true);
      try {
        localStorage.setItem('pifrontier:autoRetryEnabled', JSON.stringify(autoRetryEnabled));
      } catch {
        /* noop */
      }
    }
  }

  function backgroundLastStreaming(
    view: SessionView,
    role: UIMessage['role']
  ): UIMessage | undefined {
    for (let i = view.messages.length - 1; i >= 0; i--) {
      const message = view.messages[i];
      if (message.role === role && message.streaming) return message;
    }
    return undefined;
  }

  function backgroundFindTool(view: SessionView, toolCallId: string): UIMessage | undefined {
    const indexed = view.toolsById.get(toolCallId);
    if (indexed) return indexed;
    for (let i = view.messages.length - 1; i >= 0; i--) {
      const message = view.messages[i];
      if (message.role === 'tool' && message.toolCallId === toolCallId) {
        view.toolsById.set(toolCallId, message);
        return message;
      }
    }
    return undefined;
  }

  function backgroundEnsureTool(
    view: SessionView,
    toolCallId: string | undefined,
    toolName: string,
    details?: Record<string, unknown>,
    renderedCallHtml?: string[]
  ): UIMessage | undefined {
    if (!toolCallId) return undefined;
    const existing = backgroundFindTool(view, toolCallId);
    if (existing) return existing;
    const created: UIMessage = {
      id: uid(),
      role: 'tool',
      content: '',
      toolName,
      toolCallId,
      toolInput: formatToolInput(toolName, details),
      renderedCallHtml,
      streaming: true,
      expanded: toolsExpandedGlobal,
      startMs: Date.now(),
      createdAt: Date.now(),
    };
    view.messages.push(created);
    view.toolsById.set(toolCallId, created);
    return created;
  }

  function backgroundSeal(view: SessionView): void {
    for (let i = view.messages.length - 1; i >= 0; i--) {
      const message = view.messages[i];
      if (
        message.streaming &&
        message.role === 'assistant' &&
        !message.content &&
        !message.thinking
      ) {
        view.messages.splice(i, 1);
      } else if (message.streaming) {
        message.streaming = false;
        delete message.renderedContent;
        delete message.renderedThinking;
      }
    }
    view.activeStreamMsg = null;
  }

  /**
   * Apply a session-scoped live event to an inactive resident view. This path
   * intentionally never invokes markdown rendering, scroll handling, or any
   * page-level reactive state; the view is rendered only after it is selected.
   */
  function applyBackgroundFrame(msg: ServerMessage, sid: string): boolean {
    const view = sessionViewCache.restore(sid);
    if (!view) return false;
    const frame = msg as unknown as Record<string, unknown>;
    switch (frame.type) {
      case 'agent_start':
        return true;
      case 'agent_error':
        backgroundSeal(view);
        return true;
      case 'agent_end':
        backgroundSeal(view);
        return true;
      case 'message_start': {
        const message = frame.message as { role?: string } | undefined;
        if (message?.role === 'assistant') {
          const assistant = freshAssistant();
          view.messages.push(assistant);
          view.activeStreamMsg = assistant;
        }
        return true;
      }
      case 'message_update': {
        const event = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        const active = view.activeStreamMsg;
        if (!active || typeof event?.delta !== 'string') return true;
        if (event.type === 'text_delta') {
          active.content += event.delta;
          delete active.renderedContent;
        } else if (event.type === 'thinking_delta') {
          active.thinking = (active.thinking ?? '') + event.delta;
          delete active.renderedThinking;
        }
        return true;
      }
      case 'message_end': {
        const endMessage = frame.message as
          | {
              role?: string;
              content?: { type: string; text?: string; thinking?: string }[];
              usage?: {
                input: number;
                output: number;
                totalTokens: number;
                cost?: { total?: number };
              };
              stopReason?: string;
            }
          | undefined;
        if (endMessage?.role === 'custom') {
          const [custom] = rawMessagesToUI([endMessage]);
          if (custom) {
            custom.images = undefined;
            view.messages.push(custom);
          }
        }
        if (endMessage?.role === 'assistant') {
          const active = view.activeStreamMsg;
          if (active) {
            active.endMs = Date.now();
            active.streaming = false;
            delete active.renderedContent;
            delete active.renderedThinking;
            if (endMessage.stopReason === 'aborted') {
              active.aborted = true;
              active.content = 'Operation aborted';
            } else {
              const content = endMessage.content ?? [];
              const text = extractTextContent(content);
              const thinking = content
                .filter((block) => block.type === 'thinking')
                .map((block) => block.thinking ?? block.text ?? '')
                .join('');
              if (text) active.content = text;
              if (thinking) active.thinking = thinking;
              if (endMessage.usage) {
                active.usage = {
                  input: endMessage.usage.input,
                  output: endMessage.usage.output,
                  totalTokens: endMessage.usage.totalTokens,
                  cost: { total: endMessage.usage.cost?.total ?? 0 },
                };
              }
            }
          }
        }
        view.activeStreamMsg = null;
        const context = frame.contextUsage as ContextUsage | undefined;
        if (context) view.contextUsage = { ...context };
        return true;
      }
      case 'tool_execution_start': {
        const toolName = (frame.toolName as string | undefined) ?? 'tool';
        const toolCallId = frame.toolCallId as string | undefined;
        const details = (frame.args ?? frame.input ?? frame.details) as
          Record<string, unknown> | undefined;
        const tool = backgroundEnsureTool(
          view,
          toolCallId,
          toolName,
          details,
          frame.renderedCallHtml as string[] | undefined
        );
        if (tool) {
          tool.toolName = toolName;
          tool.toolInput = formatToolInput(toolName, details);
          tool.renderedCallHtml = frame.renderedCallHtml as string[] | undefined;
          tool.streaming = true;
          tool.isError = false;
          tool.outputLoading = false;
          tool.outputElided = false;
          tool.endMs = undefined;
        }
        return true;
      }
      case 'tool_execution_update': {
        const toolCallId = frame.toolCallId as string | undefined;
        const details = (frame.args ?? frame.input ?? frame.details) as
          Record<string, unknown> | undefined;
        const tool = toolCallId
          ? backgroundEnsureTool(
              view,
              toolCallId,
              (frame.toolName as string | undefined) ?? 'tool',
              details,
              frame.renderedCallHtml as string[] | undefined
            )
          : backgroundLastStreaming(view, 'tool');
        if (tool) {
          const partial = frame.partialResult as
            { content?: { type: string; text?: string }[] } | undefined;
          if (partial?.content) {
            tool.content = extractTextContent(partial.content);
            delete tool.renderedResultHtml;
          }
          if (frame.renderedResultHtml)
            tool.renderedResultHtml = frame.renderedResultHtml as string[];
        }
        return true;
      }
      case 'tool_execution_end': {
        const toolCallId = frame.toolCallId as string | undefined;
        const details = (frame.args ?? frame.input ?? frame.details) as
          Record<string, unknown> | undefined;
        const tool = toolCallId
          ? backgroundEnsureTool(
              view,
              toolCallId,
              (frame.toolName as string | undefined) ?? 'tool',
              details,
              frame.renderedCallHtml as string[] | undefined
            )
          : backgroundLastStreaming(view, 'tool');
        if (tool) {
          if (frame.renderedResultHtml)
            tool.renderedResultHtml = frame.renderedResultHtml as string[];
          tool.streaming = false;
          tool.isError = (frame.isError as boolean | undefined) ?? false;
          const result = frame.result as
            | { content?: { type: string; text?: string }[]; details?: { diff?: string } }
            | undefined;
          if (result?.content) tool.content = extractTextContent(result.content);
          const diff = result?.details?.diff;
          if (diff) {
            tool.diff = diff;
            tool.lineCount = diff.split('\\n').length;
            tool.expanded = true;
          } else if (tool.content) {
            tool.lineCount = tool.content.split('\\n').length;
            if (tool.isError || (tool.lineCount <= 8 && tool.content.length <= 400)) {
              tool.expanded = true;
            }
          }
        }
        return true;
      }
      case 'bash_execution_update': {
        const bashId = frame.id as string | undefined;
        const bash = bashId ? backgroundEnsureTool(view, bashId, 'bash') : undefined;
        const delta = frame.delta as string | undefined;
        if (bash && delta) {
          bash.content += delta;
          bash.streaming = true;
          bash.lineCount = bash.content.split('\\n').length;
          delete bash.renderedResultHtml;
        }
        return true;
      }
      case 'tool_output': {
        const toolCallId = frame.toolCallId as string | undefined;
        if (!toolCallId) return true;
        const tool = backgroundFindTool(view, toolCallId);
        if (!tool) return true;
        if (frame.content !== undefined) tool.content = frame.content as string;
        if (frame.details !== undefined) tool.details = frame.details as string;
        if (frame.diff !== undefined) {
          tool.diff = frame.diff as string;
          tool.lineCount = tool.diff.split('\\n').length;
        }
        if (frame.renderedResultHtml !== undefined)
          tool.renderedResultHtml = frame.renderedResultHtml as string[];
        tool.outputElided = false;
        return true;
      }
      case 'queue_update':
        view.queuedSteering = (frame.steering as string[] | undefined) ?? [];
        view.queuedFollowUp = (frame.followUp as string[] | undefined) ?? [];
        return true;
      case 'compaction_start': {
        const startedAt = Date.now();
        const reason = (frame.reason as string | undefined) ?? '';
        const beforeTokens = view.contextUsage?.tokens ?? undefined;
        view.messages.push({
          id: uid(),
          role: 'notice',
          content:
            reason === 'manual'
              ? 'compacting context…'
              : `auto-compacting context (${reason || 'automatic'})…`,
          noticeKind: 'compaction',
          compaction: {
            reason: reason || 'automatic',
            status: 'running',
            startedAt,
            ...(beforeTokens !== undefined ? { tokensBefore: beforeTokens } : {}),
          },
          streaming: true,
          createdAt: startedAt,
        });
        return true;
      }
      case 'compaction_end': {
        const notice = [...view.messages]
          .reverse()
          .find(
            (message) =>
              message.role === 'notice' && message.noticeKind === 'compaction' && message.streaming
          );
        if (notice) {
          notice.streaming = false;
          const previous = notice.compaction;
          const aborted = (frame.aborted as boolean | undefined) ?? false;
          const willRetry = (frame.willRetry as boolean | undefined) ?? false;
          const errorMessage = frame.errorMessage as string | undefined;
          const result = frame.result as
            { estimatedTokensAfter?: number; tokensBefore?: number } | undefined;
          const startedAt = previous?.startedAt ?? notice.createdAt;
          const endedAt = Date.now();
          const status: CompactionNoticeDetails['status'] = willRetry
            ? 'retrying'
            : errorMessage
              ? 'failed'
              : aborted
                ? 'aborted'
                : 'completed';
          notice.compaction = {
            ...(previous ?? { status: 'running', startedAt }),
            status,
            startedAt,
            endedAt,
            durationMs: Math.max(0, endedAt - startedAt),
            ...(result?.tokensBefore !== undefined ? { tokensBefore: result.tokensBefore } : {}),
            ...(result?.estimatedTokensAfter !== undefined
              ? { tokensAfter: result.estimatedTokensAfter }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
            willRetry,
          };
          notice.content = errorMessage
            ? `compaction failed: ${errorMessage}`
            : aborted
              ? 'compaction aborted'
              : willRetry
                ? 'compaction failed · retrying…'
                : 'context compacted';
        }
        const context = frame.contextUsage as ContextUsage | undefined;
        if (context) view.contextUsage = { ...context };
        return true;
      }
      case 'auto_retry_start': {
        const attempt = (frame.attempt as number | undefined) ?? 1;
        const max = (frame.maxAttempts as number | undefined) ?? 1;
        const delayS = Math.round(((frame.delayMs as number | undefined) ?? 0) / 1000);
        const errorMessage = (frame.errorMessage as string | undefined) ?? '';
        view.messages.push({
          id: uid(),
          role: 'notice',
          content: `retrying (${attempt}/${max}${delayS > 0 ? `, ${delayS}s` : ''})${errorMessage ? ` — ${errorMessage}` : ''}`,
          noticeKind: 'retry',
          streaming: true,
          createdAt: Date.now(),
        });
        return true;
      }
      case 'auto_retry_end': {
        const notice = [...view.messages]
          .reverse()
          .find(
            (message) =>
              message.role === 'notice' && message.noticeKind === 'retry' && message.streaming
          );
        if (notice) {
          notice.streaming = false;
          const success = (frame.success as boolean | undefined) ?? false;
          const finalError = frame.finalError as string | undefined;
          notice.content = success
            ? 'retry succeeded'
            : `retry failed${finalError ? `: ${finalError}` : ''}`;
        }
        return true;
      }
      default:
        return true;
    }
  }

  function handleServer(msg: ServerMessage) {
    // Snapshots establish active-session identity, session_runtime and
    // session_updated are global inventory/status frames. Other stamped
    // events belong to the visible session or to an inactive cached view.
    if (msg && typeof msg === 'object' && 'sessionId' in msg) {
      const msgType = (msg as Record<string, unknown>).type;
      if (
        msgType !== 'session_updated' &&
        msgType !== 'session_runtime' &&
        msgType !== 'connected' &&
        msgType !== 'session_loaded'
      ) {
        const sid = (msg as Record<string, unknown>).sessionId;
        if (typeof sid === 'string' && sid !== sessionId) {
          // If this resident session has no retained view, the authoritative
          // snapshot on a future switch will rebuild it from disk.
          applyBackgroundFrame(msg, sid);
          return;
        }
      }
    }
    switch (msg.type) {
      case 'connected': {
        _resyncInFlight = false;
        const c = msg as ConnectedMessage;
        const targetPath = bootResumePath;
        const serverPath = typeof c.sessionPath === 'string' ? c.sessionPath : undefined;
        const serverSessionId = typeof c.sessionId === 'string' ? c.sessionId : undefined;
        const shouldResumeTarget = !!targetPath && targetPath !== serverPath;
        const hadOrphanedSessionState =
          projectsState.pendingNewSession ||
          projectsState.sessionLoading ||
          _optimisticPrevMessages !== null;

        if (shouldResumeTarget) {
          // Keep the hydrated boot target visible until its switch response
          // arrives; the server's current session is only a fallback.
          _bootServerSnapshot = c;
        } else {
          applySessionState(c as unknown as Record<string, unknown>);
          _lastVisibleSessionPath = serverPath;
          _lastVisibleSessionId = serverSessionId;
          resetSessionPanelState();
          projectTrust = c.projectTrust ?? null;
          runtimeDiagnostics = c.diagnostics ?? [];
          resyncEditorMirror();
          sessionStartTime = Date.now();
        }
        if (sessionId ?? serverSessionId) sendSessionFocus(sessionId ?? serverSessionId ?? null);
        connectedPushVapidKey = c.pushVapidKey ?? null;
        if (c.piVersion) piVersion = c.piVersion;
        if (c.uiVersion) uiVersion = c.uiVersion;
        if (c.sessionMode && !shouldResumeTarget) sessionMode = c.sessionMode;
        loadWebhookUrlFromServer(c.webhookUrl);
        // A reconnect orphans any in-flight new_session/switch_session: its
        // reply would land on the dead socket, and this connected payload is
        // authoritative for the live server state.
        projectsState.cancelPendingOps();
        if (!shouldResumeTarget) {
          sessionLoading = false;
          // applySessionState() has replaced optimistic state with the server
          // snapshot. Never retain the old stash for a later operation.
          if (hadOrphanedSessionState || _optimisticPrevMessages !== null) {
            _optimisticPrevMessages = null;
            _optimisticPrevInput = null;
          }
          sessionSwitchDraft = null;
        } else {
          sessionLoading = true;
        }
        send({ type: 'get_project_trust' });
        // Warm the project/session lists so pickers have data immediately.
        projectsState.refresh({ force: true });
        updateAppBadge();
        send({ type: 'get_settings' });

        if (targetPath && shouldResumeTarget) {
          // switchSession arms the op watchdog and syncs the URL — same
          // semantics as the manual action it replaces.
          const result = projectsState.switchSession(targetPath);
          if (result === 'ok') {
            _bootResumeRequestId = projectsState.pendingRequestId;
            clearBootResumeTimer();
            _bootResumeTimer = setTimeout(() => {
              _bootResumeTimer = null;
              releaseBootResumeFallback();
            }, BOOT_RESUME_TIMEOUT_MS);
          } else {
            // The socket was open for connected, so this is only a defensive
            // fallback for a race with another local operation.
            _bootResumeRequestId = null;
            bootResumePath = null;
            _bootServerSnapshot = null;
            applySessionState(c as unknown as Record<string, unknown>);
            resetSessionPanelState();
            projectTrust = c.projectTrust ?? null;
            runtimeDiagnostics = c.diagnostics ?? [];
            resyncEditorMirror();
            sessionStartTime = Date.now();
            if (sessionId) sendSessionFocus(sessionId);
            sessionLoading = false;
            if (sessionPath) {
              setSessionParam(sessionPath);
              saveIdentity(sessionPath, sessionId ?? undefined, sessionName);
              saveSnapshot(sessionPath, sessionName, messages);
            } else {
              clearIdentity();
            }
          }
        } else if (!shouldResumeTarget) {
          bootResumePath = null;
          _bootResumeRequestId = null;
          _bootServerSnapshot = null;
          if (sessionPath) {
            setSessionParam(sessionPath);
            saveIdentity(sessionPath, sessionId ?? undefined, sessionName);
            saveSnapshot(sessionPath, sessionName, messages);
          } else {
            // In-memory sessions are intentionally not durable identities.
            clearIdentity();
          }
        }
        flushPendingNotificationSession();
        break;
      }

      case 'session_loaded': {
        const sl = msg as Record<string, unknown>;
        const requestId = typeof sl.requestId === 'string' ? sl.requestId : undefined;
        // A response whose operation has already settled (or timed out) is
        // stale and must not clobber the newer visible session.
        if (requestId && projectsState.isRetiredRequest(requestId)) break;
        const pendingRequestId = projectsState.pendingRequestId;
        const pendingSwitchPath = projectsState.pendingSwitchPath;
        const previousPath = _lastVisibleSessionPath;
        const previousSessionId = _lastVisibleSessionId;
        const loadedPath = typeof sl.sessionPath === 'string' ? sl.sessionPath : undefined;
        const loadedSessionId = typeof sl.sessionId === 'string' ? sl.sessionId : undefined;
        const ownResponse =
          pendingRequestId !== null
            ? requestId !== undefined
              ? requestId === pendingRequestId
              : pendingSwitchPath === null || pendingSwitchPath === loadedPath
            : false;
        // A requestId is authoritative when present. A stamped snapshot for
        // another operation belongs to another tab (or an abandoned request),
        // never this tab, even when its session path differs.
        if (requestId !== undefined && !ownResponse) break;
        const resyncResponse = projectsState.pendingResync;
        const foreignPathChange =
          !ownResponse &&
          !resyncResponse &&
          (loadedPath !== previousPath || loadedSessionId !== previousSessionId);
        const foreignResponse = !ownResponse && pendingRequestId !== null;
        const foreignSnapshot = foreignResponse || foreignPathChange;
        if (foreignPathChange && bootResumePath !== null) {
          // Keep the latest server truth available if the remembered target
          // subsequently fails while another client changes the live session.
          _bootServerSnapshot = sl as unknown as ConnectedMessage;
        }
        _resyncInFlight = false;
        applySessionState(sl);
        if (sessionId ?? loadedSessionId) sendSessionFocus(sessionId ?? loadedSessionId ?? null);
        _lastVisibleSessionPath =
          loadedPath ?? (ownResponse ? pendingSwitchPath : sessionPath) ?? undefined;
        _lastVisibleSessionId = sessionId ?? loadedSessionId;
        resetSessionPanelState();
        projectTrust = (sl.projectTrust as ProjectTrustInfo | undefined) ?? null;
        runtimeDiagnostics = (sl.diagnostics as RuntimeDiagnostic[] | undefined) ?? [];
        resyncEditorMirror();
        sessionStartTime = Date.now();
        if (sl.piVersion) piVersion = sl.piVersion as string;
        if (sl.uiVersion) uiVersion = sl.uiVersion as string;
        if (sl.sessionMode) sessionMode = sl.sessionMode as string;
        const authoritativePath =
          loadedPath ?? (ownResponse ? pendingSwitchPath : sessionPath) ?? undefined;
        const settled = projectsState.onSessionLoaded(
          ownResponse ? requestId : undefined,
          loadedPath
        );
        sessionLoading = projectsState.sessionLoading;
        if (settled) showSessionPanel = false;
        projectPickerOpen = false;

        if (ownResponse) {
          if (_bootResumeRequestId !== null) {
            clearBootResumeTimer();
            bootResumePath = null;
            _bootResumeRequestId = null;
            _bootServerSnapshot = null;
          } else {
            bootResumePath = null;
          }
          if (authoritativePath) {
            setSessionParam(authoritativePath);
            saveIdentity(authoritativePath, sessionId ?? undefined, sessionName);
          } else {
            clearIdentity();
          }
          projectsState.pendingSwitchPath = null;
        } else if (!foreignSnapshot) {
          // A same-session resync is still authoritative for this device.
          if (authoritativePath) {
            setSessionParam(authoritativePath);
            saveIdentity(authoritativePath, sessionId ?? undefined, sessionName);
          } else {
            clearIdentity();
          }
        } else if (foreignPathChange) {
          showChatNotice('Another client switched the active session.', 'info');
        }
        saveSnapshot(authoritativePath, sessionName, messages);
        _pendingEdit = null;
        // Any accepted authoritative snapshot supersedes the optimistic
        // empty-chat view, including a resync after a lost watchdog reply.
        _optimisticPrevMessages = null;
        _optimisticPrevInput = null;
        break;
      }

      case 'tool_output': {
        const toolFrame = msg as {
          type: 'tool_output';
          toolCallId: string;
          content?: string;
          details?: string;
          diff?: string;
          renderedResultHtml?: string[];
          error?: string;
        };
        const tool = findToolMessage(toolFrame.toolCallId);
        if (!tool) {
          if (toolFrame.error) {
            showChatNotice(`Failed to load tool output: ${toolFrame.error}`, 'error');
          }
          break;
        }
        tool.outputLoading = false;
        if (toolFrame.error) {
          showChatNotice(`Failed to load tool output: ${toolFrame.error}`, 'error');
          break;
        }
        if (toolFrame.content !== undefined) tool.content = toolFrame.content;
        if (toolFrame.details !== undefined) tool.details = toolFrame.details;
        if (toolFrame.diff !== undefined) {
          tool.diff = toolFrame.diff;
          tool.lineCount = toolFrame.diff.split('\n').length;
        }
        if (toolFrame.renderedResultHtml !== undefined) {
          tool.renderedResultHtml = toolFrame.renderedResultHtml;
        }
        tool.outputElided = false;
        if (tool.content && tool.lineCount === undefined) {
          tool.lineCount = tool.content.split('\n').length;
        }
        break;
      }

      case 'model_changed': {
        applySessionState({
          model: (msg as { type: string; model: ModelInfo | null }).model ?? null,
        });
        break;
      }

      case 'thinking_level_changed': {
        const incoming = (msg as { type: string; level: string }).level ?? 'off';
        applySessionState({
          thinkingLevel: clampThinkingLevelForModel(model, incoming),
        });
        break;
      }

      case 'sessions_list':
      case 'projects_list': {
        projectsState.handleMessage(msg as PiEvent);
        break;
      }

      case 'sessions_error': {
        const errMsg = (msg as Record<string, unknown>).message ?? 'Unknown session error';
        const wasIdentityRestore = bootResumePath !== null && _bootResumeRequestId !== null;
        const fallback = wasIdentityRestore ? _bootServerSnapshot : null;
        // Let the shared state validate correlation before changing any local
        // UI. Retired/foreign errors must not clear a newer operation or
        // surface a notice; a matching request settles the operation and
        // reverts its optimistic URL in the store.
        if (!projectsState.handleMessage(msg as PiEvent)) break;
        olderMessagesLoading = false;
        // Render the operation error in the chat transcript only. Leaving the
        // shared error field set also creates a hidden copy in the off-canvas
        // projects panel, which can mask the visible notice for consumers.
        projectsState.error = null;
        if (sessionSwitchDraft !== null) {
          input = sessionSwitchDraft;
          sessionSwitchDraft = null;
        }
        if (wasIdentityRestore) {
          clearBootResumeTimer();
          // The remembered path is unavailable. Drop that dead pointer, then
          // reveal the connected session that was held back during boot.
          clearIdentity();
          bootResumePath = null;
          _bootResumeRequestId = null;
          _bootServerSnapshot = null;
          if (fallback) {
            applySessionState(fallback as unknown as Record<string, unknown>);
            _lastVisibleSessionPath =
              typeof fallback.sessionPath === 'string' ? fallback.sessionPath : undefined;
            resetSessionPanelState();
            projectTrust = fallback.projectTrust ?? null;
            runtimeDiagnostics = fallback.diagnostics ?? [];
            resyncEditorMirror();
            sessionStartTime = Date.now();
            if (fallback.piVersion) piVersion = fallback.piVersion;
            if (fallback.uiVersion) uiVersion = fallback.uiVersion;
            if (fallback.sessionMode) sessionMode = fallback.sessionMode;
            loadWebhookUrlFromServer(fallback.webhookUrl);
          }
        } else {
          bootResumePath = null;
        }
        showChatNotice(errMsg as string, 'warning');

        // Restore optimistic new-chat if it failed — don't leave empty chat or draft.
        if (_optimisticPrevMessages) {
          messages = _optimisticPrevMessages;
          _optimisticPrevMessages = null;
        }
        if (_optimisticPrevInput !== null) {
          input = _optimisticPrevInput;
          _optimisticPrevInput = null;
        }
        rebuildToolMessageIndex();
        sessionLoading = false;
        projectsState.sessionLoading = false;
        if (wasIdentityRestore && fallback) {
          if (sessionPath) {
            setSessionParam(sessionPath);
            saveIdentity(sessionPath, sessionId ?? undefined, sessionName);
            saveSnapshot(sessionPath, sessionName, messages);
          } else {
            clearIdentity();
          }
        }
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
        applySessionState({
          availableModels:
            (msg as { type: string; availableModels: ModelInfo[] }).availableModels ?? [],
        });
        break;
      }
      case 'models_refresh_result': {
        modelRefreshLoading = false;
        const success = Boolean(msg.success);
        showModelRefreshFeedback({
          success,
          message:
            (msg as { type: string; success?: boolean; message?: string }).message ??
            (success ? 'Models refreshed.' : 'Model refresh failed.'),
        });
        break;
      }

      case 'agent_start':
        // The first agent_start proves the server accepted the edit rewind;
        // keep the optimistic history and stop retaining its rollback copy.
        _pendingEdit = null;
        isStreaming = true;
        projectsState.isStreaming = true;
        requestWakeLock();
        break;

      case 'message_start':
        // Fires for user, assistant, AND toolResult messages — only create a
        // bubble for the assistant turn.
        if ((msg.message as { role?: string } | undefined)?.role === 'assistant') {
          messages.push(freshAssistant());
          activeStreamMsg = messages[messages.length - 1];
        }
        break;

      case 'agent_end': {
        const { willRetry } = msg as { type: 'agent_end'; willRetry?: boolean };
        isStreaming = false;
        projectsState.isStreaming = false;
        sealStreaming();
        activeStreamMsg = null;
        // agent_end for the active session — results just appeared on screen,
        // no "unseen" dot needed.
        if (conversationMode && !willRetry && wsState === 'open') {
          toggleSTT();
        }
        releaseWakeLock();
        updateAppBadge();
        if (notificationPrefs.onComplete && document.hidden && !willRetry) {
          notifyPiEvent('Response Complete', 'pi finished responding.', 'pi-agent-end', {
            kind: 'response_complete',
          });
        }
        // Contextual permission nudge — once, after the first completed turn.
        if (
          !willRetry &&
          !showNotifNudge &&
          !notifNudgeSeen &&
          notificationPrefs.enabled &&
          'Notification' in window &&
          Notification.permission === 'default'
        ) {
          showNotifNudge = true;
        }
        saveSnapshot(sessionPath, sessionName, messages);
        break;
      }

      case 'agent_error': {
        // Server-side error during prompt/steer/followUp — unfreeze the UI.
        isStreaming = false;
        projectsState.isStreaming = false;
        sealStreaming();
        activeStreamMsg = null;
        releaseWakeLock();
        const errMsg = (msg as { error?: string }).error ?? 'Unknown error';
        if (_optimisticPrevMessages || projectsState.pendingNewSession) {
          if (_optimisticPrevMessages) {
            messages = _optimisticPrevMessages;
            _optimisticPrevMessages = null;
          }
          if (_optimisticPrevInput !== null) input = _optimisticPrevInput;
          _optimisticPrevInput = null;
          rebuildToolMessageIndex();
          projectsState.cancelPendingOps();
          sessionLoading = false;
        }
        if (restorePendingEdit()) {
          // The error may be unrelated to the edit because edit_message has
          // no request token. Resync so the authoritative server history wins.
          send({ type: 'resync_session' });
        }
        showChatNotice(`Agent error: ${errMsg}`, 'error');
        break;
      }

      case 'message_update': {
        const event = msg.assistantMessageEvent as { type: string; delta?: string } | undefined;
        if (event?.type === 'text_delta' && typeof event.delta === 'string') {
          const a = activeStreamMsg;
          if (a) {
            a.content += event.delta;
            scheduleContentRender(a);
            scrollBottom();
          }
        } else if (event?.type === 'thinking_delta' && typeof event.delta === 'string') {
          const a = activeStreamMsg;
          if (a) {
            if (!a.thinkingStartMs) a.thinkingStartMs = Date.now();
            a.thinking = (a.thinking ?? '') + event.delta;
            scheduleContentRender(a);
          }
        }
        break;
      }

      case 'message_end': {
        const endMsg = msg.message as
          | {
              role?: string;
              usage?: {
                input: number;
                output: number;
                totalTokens: number;
                cost: { total: number };
              };
              content?: {
                type: string;
                text?: string;
                thinking?: string;
                data?: string;
                mimeType?: string;
              }[];
              stopReason?: string;
              errorMessage?: string;
            }
          | undefined;
        if (endMsg?.role === 'custom') {
          // Custom extension entries arrive as ordinary message_start/end
          // pairs. They are not assistant bubbles, but still belong in the
          // conversation and use the same conversion as loaded history.
          const [custom] = rawMessagesToUI([endMsg]);
          if (custom) messages.push(custom);
        }
        if (endMsg?.role === 'assistant') {
          const a = activeStreamMsg;
          if (a) {
            a.endMs = Date.now();
            a.streaming = false;
            if (endMsg.stopReason === 'aborted') {
              a.aborted = true;
              a.content = 'Operation aborted';
            } else {
              // Replace streamed buffers with the sealed message only when
              // the final payload actually contains those block types. A
              // tool-only or wire-truncated final message must not erase text
              // that arrived through deltas.
              const finalText = extractTextContent(endMsg.content ?? []);
              const finalThinking = (endMsg.content ?? [])
                .filter((b) => b.type === 'thinking')
                .map((b) => b.thinking ?? '')
                .join('');
              if (finalText) a.content = finalText;
              if (finalThinking) a.thinking = finalThinking;
              if (endMsg.usage) {
                a.usage = {
                  input: endMsg.usage.input,
                  output: endMsg.usage.output,
                  totalTokens: endMsg.usage.totalTokens,
                  cost: { total: endMsg.usage.cost?.total ?? 0 },
                };
              }
              // Extract any image blocks from the final message content
              if (endMsg.content) {
                const imgBlocks = endMsg.content.filter(
                  (b) => b.type === 'image' && b.data && b.mimeType
                );
                if (imgBlocks.length > 0) {
                  a.images = imgBlocks.map((b) => `data:${b.mimeType};base64,${b.data}`);
                }
              }
            }
            // Final markdown render — full parse with hljs now that streaming is done
            if (a.content)
              a.renderedContent = renderMarkdown(a.content, {
                onUnresolvedLang: (lang) => recordUnresolvedLang(a, lang),
              });
            if (a.thinking)
              a.renderedThinking = renderMarkdown(a.thinking, {
                onUnresolvedLang: (lang) => recordUnresolvedLang(a, lang),
              });
          }
        }
        if (endMsg?.role === 'assistant' && endMsg.stopReason === 'error' && endMsg.errorMessage) {
          showChatNotice(`Agent error: ${endMsg.errorMessage}`, 'error');
        }
        activeStreamMsg = null;
        // Use real context usage from the SDK (server enriches message_end with this)
        const cu = (msg as Record<string, unknown>).contextUsage as
          { tokens?: number | null; contextWindow?: number } | undefined;
        if (cu) {
          applySessionState({ contextUsage: cu });
        }
        break;
      }

      case 'tool_execution_start': {
        const toolName = (msg.toolName as string | undefined) ?? 'tool';
        const toolCallId = msg.toolCallId as string | undefined;
        const details = (msg.args ?? msg.input ?? msg.details) as
          Record<string, unknown> | undefined;
        const renderedCallHtml = msg.renderedCallHtml as string[] | undefined;
        let toolMessage = ensureToolMessage(toolCallId, toolName, details, renderedCallHtml);
        if (!toolMessage) {
          toolMessage = createToolMessage(toolName, toolCallId, details, renderedCallHtml);
          messages.push(toolMessage);
          indexToolMessage(toolMessage);
        }
        toolMessage.toolName = toolName;
        toolMessage.toolInput = formatToolInput(toolName, details);
        toolMessage.renderedCallHtml = renderedCallHtml;
        toolMessage.streaming = true;
        toolMessage.isError = false;
        toolMessage.outputLoading = false;
        toolMessage.outputElided = false;
        toolMessage.endMs = undefined;
        break;
      }

      case 'tool_execution_update': {
        const updateId = msg.toolCallId as string | undefined;
        const details = (msg.args ?? msg.input ?? msg.details) as
          Record<string, unknown> | undefined;
        const t = updateId
          ? ensureToolMessage(
              updateId,
              (msg.toolName as string | undefined) ?? activeToolName ?? 'tool',
              details,
              msg.renderedCallHtml as string[] | undefined
            )
          : lastStreaming('tool');
        if (t) {
          const partial = msg.partialResult as
            { content?: { type: string; text?: string }[] } | undefined;
          if (partial?.content) {
            t.content = extractTextContent(partial.content);
          }
          if (msg.renderedResultHtml) t.renderedResultHtml = msg.renderedResultHtml as string[];
        }
        break;
      }

      case 'tool_execution_end': {
        const endId = msg.toolCallId as string | undefined;
        const details = (msg.args ?? msg.input ?? msg.details) as
          Record<string, unknown> | undefined;
        const t = endId
          ? ensureToolMessage(
              endId,
              (msg.toolName as string | undefined) ?? activeToolName ?? 'tool',
              details,
              msg.renderedCallHtml as string[] | undefined
            )
          : lastStreaming('tool');
        if (t) {
          if (msg.renderedResultHtml) t.renderedResultHtml = msg.renderedResultHtml as string[];
          t.streaming = false;
          t.isError = (msg.isError as boolean | undefined) ?? false;
          const result = msg.result as
            | {
                content?: {
                  type: string;
                  text?: string;
                  data?: string;
                  mimeType?: string;
                }[];
                details?: { diff?: string; patch?: string };
              }
            | undefined;

          if (result?.content) {
            t.content = extractTextContent(result.content);
            const imgBlocks = result.content.filter(
              (b) => b.type === 'image' && b.data && b.mimeType
            );
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
            // Auto-expand errors (the user needs to see what failed) and
            // short outputs (≤ 8 lines and ≤ 400 chars).
            if (t.isError || (lines <= 8 && t.content.length <= 400)) {
              t.expanded = true;
            }
          }
        }
        break;
      }

      case 'bash_execution_update': {
        const bashId = msg.id as string | undefined;
        const delta = msg.delta as string | undefined;
        const bash = bashId ? ensureToolMessage(bashId, 'bash') : undefined;
        if (bash && delta) {
          bash.content += delta;
          bash.streaming = true;
          bash.lineCount = bash.content.split('\n').length;
        }
        break;
      }

      case 'extension_flag_result': {
        const name = (msg.name as string | undefined) ?? 'unknown';
        const success = Boolean(msg.success);
        showChatNotice(
          success
            ? `Extension flag "${name}" updated.`
            : `Failed to update extension flag "${name}".`,
          success ? 'info' : 'error'
        );
        break;
      }

      case 'shutdown_requested': {
        showChatNotice('Server is shutting down; reconnecting automatically.', 'warning');
        break;
      }

      case 'extension_ui_request': {
        const method = msg.method as string;
        extensionUiState.queueModalFromRequest(msg);

        // Non-blocking extension methods (fire-and-forget, no modal response needed):
        if (method === 'notify') {
          showChatNotice(
            (msg.message as string | undefined) ?? '',
            (msg.notifyType as 'info' | 'warning' | 'error' | undefined) ?? 'info'
          );
        } else if (method === 'setStatus') {
          extensionUiState.setStatus(
            msg.statusKey as string | undefined,
            msg.statusText as string | undefined
          );
        } else if (method === 'setWidget') {
          extensionUiState.applyWidget(msg);
        } else if (method === 'setTitle') {
          extensionUiState.setTitle(msg.title as string | undefined);
        } else if (method === 'set_editor_text') {
          if (!projectsState.pendingNewSession) {
            input = (msg.text as string | undefined) ?? '';
            tick().then(() => {
              autoResizeTextarea();
              inputEl?.focus();
            });
          }
        } else if (method === 'paste_to_editor') {
          if (!projectsState.pendingNewSession) {
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
          }
        } else if (method === 'setWorkingMessage') {
          extensionUiState.setWorkingMessage(msg.message as string | undefined);
        } else if (method === 'setWorkingVisible') {
          extensionUiState.setWorkingVisible((msg.visible as boolean | undefined) ?? true);
        } else if (method === 'setWorkingIndicator') {
          const frames = (msg.frames as string[] | undefined) ?? [];
          extensionUiState.setWorkingIndicator(frames, msg.intervalMs as number | undefined);
          workingFrameIndex = 0;
        } else if (method === 'setHiddenThinkingLabel') {
          extensionUiState.setHiddenThinkingLabel(msg.label as string | undefined);
        } else if (method === 'setToolsExpanded') {
          const exp = (msg.expanded as boolean | undefined) ?? false;
          toolsExpandedGlobal = exp;
          for (const m of messages) {
            if (m.role === 'tool' && !m.streaming) m.expanded = exp;
          }
        } else if (method === 'set_header') {
          extensionUiState.setHeader(msg.content as string | undefined);
        } else if (method === 'set_footer') {
          extensionUiState.setFooter(msg.content as string | undefined);
        } else if (method === 'set_editor_component') {
          extensionUiState.setEditorComponent((msg.parsed as ParsedComponent | null) ?? null);
        } else if (method === 'diagnostic') {
          messages.push({
            id: uid(),
            role: 'diagnostic',
            content: (msg.message as string) ?? '',
            level: (msg.level as 'info' | 'warning' | 'error' | 'success' | undefined) ?? 'info',
            details: msg.details as string | undefined,
            source: msg.source as string | undefined,
            streaming: false,
            createdAt: (msg.timestamp as number | undefined) ?? Date.now(),
          });
        }

        // Blocking request — pi is waiting on the user. Ping when the tab is
        // hidden so the blocking question isn't discovered on return.
        if (
          document.hidden &&
          ['confirm', 'input', 'select', 'editor', 'custom'].includes(method)
        ) {
          notifyPiEvent(
            'pi needs your input',
            (msg.title as string | undefined) || 'An extension is asking for a response.',
            `pi-ui-request-${String(msg.id ?? '')}`,
            { kind: 'ui_request' }
          );
        }

        break;
      }

      case 'extension_ui_request_replay': {
        extensionUiState.replayModalFromRequest(msg);
        break;
      }
      case 'extension_ui_state': {
        const uiMsg = msg as {
          type: 'extension_ui_state';
          sessionId: string;
          ui: ExtensionUiStatePayload;
        };
        if (uiMsg.sessionId === sessionId) extensionUiState.applySnapshot(uiMsg.ui);
        break;
      }

      case 'extension_terminal_input_active': {
        const act = msg as { type: string; active: boolean; sessionId?: string };
        if (act.sessionId === undefined || act.sessionId === sessionId) {
          extensionUiState.setTerminalInputActive(Boolean(act.active));
        }
        break;
      }

      case 'extension_terminal_input_result': {
        const res = msg as {
          type: string;
          id: string;
          consumed: boolean;
          data?: string;
          sessionId?: string;
        };
        if (res.sessionId !== undefined && res.sessionId !== sessionId) break;
        const settle = pendingTerminalInputs.get(res.id);
        if (settle)
          settle({
            consumed: Boolean(res.consumed),
            ...(res.data !== undefined ? { data: res.data } : {}),
          });
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
          tick().then(() => {
            autoResizeTextarea();
            inputEl?.focus();
          });
        }
        break;
      }

      case 'compaction_start': {
        const startedAt = Date.now();
        const reason = (msg.reason as string | undefined) ?? '';
        const beforeTokens = effectiveContextTokens > 0 ? effectiveContextTokens : undefined;
        isCompacting = true;
        compactionStartedAt = startedAt;
        messages.push({
          id: uid(),
          role: 'notice',
          content:
            reason === 'manual'
              ? 'compacting context…'
              : `auto-compacting context (${reason || 'automatic'})…`,
          noticeKind: 'compaction',
          compaction: {
            reason: reason || 'automatic',
            status: 'running',
            startedAt,
            ...(beforeTokens !== undefined ? { tokensBefore: beforeTokens } : {}),
          },
          streaming: true,
          createdAt: startedAt,
        });
        break;
      }

      case 'compaction_end': {
        const endedAt = Date.now();
        const aborted = (msg.aborted as boolean | undefined) ?? false;
        const willRetry = (msg.willRetry as boolean | undefined) ?? false;
        const errMsg = msg.errorMessage as string | undefined;
        const compResult = (msg as Record<string, unknown>).result as
          { estimatedTokensAfter?: number; tokensBefore?: number } | undefined;
        const cu = (msg as Record<string, unknown>).contextUsage as
          { tokens?: number | null; contextWindow?: number } | undefined;
        // Seal the in-progress compaction notice with its measured outcome.
        const notice = [...messages]
          .reverse()
          .find((m) => m.role === 'notice' && m.noticeKind === 'compaction' && m.streaming);
        const previous = notice?.compaction;
        const startedAt =
          compactionStartedAt ?? previous?.startedAt ?? notice?.createdAt ?? endedAt;
        const durationMs = Math.max(0, endedAt - startedAt);
        const tokensBefore = compResult?.tokensBefore ?? previous?.tokensBefore;
        const tokensAfter = compResult?.estimatedTokensAfter ?? cu?.tokens ?? previous?.tokensAfter;
        const status: CompactionNoticeDetails['status'] = willRetry
          ? 'retrying'
          : errMsg
            ? 'failed'
            : aborted
              ? 'aborted'
              : 'completed';
        const reason =
          ((msg.reason as string | undefined) ?? previous?.reason ?? 'automatic').trim() ||
          'automatic';
        isCompacting = false;
        compactionStartedAt = null;
        if (notice) {
          notice.streaming = false;
          notice.compaction = {
            ...(previous ?? { status: 'running', startedAt }),
            reason,
            status,
            startedAt,
            endedAt,
            durationMs,
            ...(tokensBefore !== undefined ? { tokensBefore } : {}),
            ...(tokensAfter !== undefined ? { tokensAfter } : {}),
            ...(errMsg ? { errorMessage: errMsg } : {}),
            willRetry,
          };
          notice.content = willRetry
            ? `compaction failed${errMsg ? `: ${errMsg}` : ''} · retrying…`
            : errMsg
              ? `compaction failed: ${errMsg}`
              : aborted
                ? 'compaction aborted'
                : compResult?.tokensBefore != null && compResult.estimatedTokensAfter != null
                  ? `context compacted · ${compResult.tokensBefore.toLocaleString()} → ${compResult.estimatedTokensAfter.toLocaleString()} tokens`
                  : 'context compacted';
        }
        if (cu?.tokens != null) {
          applySessionState({ contextUsage: cu });
        } else if (compResult?.estimatedTokensAfter != null) {
          applySessionState({
            contextUsage: {
              tokens: compResult.estimatedTokensAfter,
              contextWindow: contextUsageWindow || model?.contextWindow,
            },
          });
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
        const notice = [...messages]
          .reverse()
          .find((m) => m.role === 'notice' && m.noticeKind === 'retry' && m.streaming);
        if (notice) {
          notice.streaming = false;
          const success = (msg.success as boolean | undefined) ?? false;
          const finalErr = msg.finalError as string | undefined;
          notice.content = success
            ? 'retry succeeded'
            : `retry failed${finalErr ? `: ${finalErr}` : ''}`;
        }
        break;
      }

      case 'session_info_changed': {
        sessionName = msg.name as string | undefined;
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
        toolsList =
          (msg.tools as
            | {
                name: string;
                description: string;
                isBuiltin: boolean;
                origin?: string;
              }[]
            | undefined) ?? [];

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
      case 'project_trust':
        projectTrust = msg.trust as ProjectTrustInfo;
        break;

      case 'runtime_diagnostics':
        runtimeDiagnostics = (msg.diagnostics as RuntimeDiagnostic[] | undefined) ?? [];
        break;

      case 'packages_list':
        packagesList = (msg.packages as ConfiguredPackageInfo[] | undefined) ?? [];
        packageUpdates = (msg.updates as PackageUpdateInfo[] | undefined) ?? [];
        packagesLoaded = true;
        break;

      case 'package_progress':
        packageProgress = msg.progress as PackageProgress;
        packageBusy = packageProgress.phase !== 'complete' && packageProgress.phase !== 'error';
        break;

      case 'package_result':
        packageBusy = false;
        packageProgress = null;
        if (msg.success) send({ type: 'get_packages' });
        break;
      case 'session_stats': {
        const stats = msg.stats as SessionStats | undefined;
        if (!stats || stats.sessionId !== sessionId) break;
        sessionStats = stats;
        break;
      }

      case 'export_result':
        exportFeedback = msg.error
          ? `Export failed: ${msg.error as string}`
          : `Exported to ${msg.path as string}`;
        break;

      case 'commands_list': {
        extensionCommands =
          (msg.commands as { name: string; description?: string; source: string }[] | undefined) ??
          [];

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
          skillInstallFeedback = {
            success: false,
            message: (msg.error as string) ?? 'Installation failed.',
          };
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
        const progress = msg as {
          type: 'update_progress';
          target: UpdateTarget;
          command?: string;
          message: string;
        };
        updateRunning = true;
        updateTarget = progress.target;
        updateFeedback = null;
        updateLog = updateLog ? `${updateLog}\n\n${progress.message}` : progress.message;
        break;
      }

      case 'update_result': {
        const result = msg as {
          type: 'update_result';
          target: UpdateTarget;
          success: boolean;
          message: string;
          output?: string;
          restartRequired?: boolean;
          reloadRequired?: boolean;
        };
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
      case 'session_updated':
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
        const extMsg = msg as unknown as {
          trigger: string;
          query: string;
          items: { value: string; label: string; description?: string }[];
        };
        if (extMsg.trigger === shortcutTrigger && extMsg.query === shortcutQuery) {
          extensionCompletions = extMsg.items ?? [];
        }
        break;
      }

      case 'command_completions': {
        const cc = msg as unknown as {
          command: string;
          prefix: string;
          items: { value: string; label: string; description?: string }[];
        };
        if (cc.command === commandArgCommand && cc.prefix === commandArgPrefix) {
          commandArgCompletions = cc.items ?? [];
          commandCompletionsPending = false;
        }
        break;
      }

      case 'custom_render': {
        const renderId = msg.id as string | undefined;
        const renderLines = msg.lines as string[] | undefined;
        const renderHtmlLines = msg.htmlLines as string[] | undefined;
        extensionUiState.updateCustomRender(renderId, renderLines, renderHtmlLines);
        break;
      }

      case 'extension_ui_update': {
        const updateId = msg.id as string | undefined;
        const updatedParsed = msg.parsed as ParsedComponent | undefined;
        extensionUiState.updateCustomParsed(updateId, updatedParsed);
        break;
      }

      case 'extension_ui_dismiss': {
        const dismissId = msg.id as string | undefined;
        const wasActive = extensionUiState.dismissModal(dismissId);
        if (wasActive) modalInput = '';
        break;
      }

      case 'slash_result': {
        const result = msg as {
          type: 'slash_result';
          command: string;
          message: string;
          level?: 'info' | 'warning' | 'error';
        };
        if (result.command === 'shell' && sessionId) {
          const shell = findToolMessage(`shell-${sessionId}`);
          if (shell) {
            shell.streaming = false;
            shell.endMs = Date.now();
            shell.isError = result.level === 'error';
            if (!shell.content && result.message) shell.content = result.message;
          }
        }
        messages.push({
          id: uid(),
          role: 'notice',
          content: result.message,
          noticeKind: result.level === 'error' ? 'retry' : undefined,
          customType: 'slash_result',
          streaming: false,
          createdAt: Date.now(),
        });
        break;
      }

      case 'extension_event': {
        const ev = msg as {
          type: 'extension_event';
          source: string;
          event: string;
          level?: 'info' | 'warning' | 'error';
          message?: string;
        };
        if (ev.level === 'error' || ev.level === 'warning') {
          const body = ev.message ? `: ${ev.message}` : '';
          showChatNotice(`[ext] ${ev.source}: ${ev.event}${body}`, ev.level);
        }
        break;
      }

      case 'older_messages': {
        const older = msg as {
          type: string;
          messages: unknown[];
          totalMessageCount: number;
          messagesTruncated: boolean;
          sessionId?: string;
        };
        if (older.sessionId && older.sessionId !== sessionId) break;
        olderMessagesLoading = false;
        const olderUi = rawMessagesToUI(older.messages);
        messages.unshift(...olderUi);
        for (let i = 0; i < olderUi.length; i++) indexToolMessage(messages[i]);
        totalRawMessagesLoaded += older.messages.length;
        totalMessageCount = older.totalMessageCount;
        messagesTruncated = older.messagesTruncated;
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
          showChatNotice(`Failed to save ${fs.path}: ${fs.error}`, 'error');
        } else {
          showChatNotice(`Saved ${fs.path}`, 'info');
          // Re-read only if the saved file is still the one being viewed.
          if (fs.path === fileViewerPath) {
            fileViewerLoading = true;
            send({ type: 'read_file', path: fs.path });
          }
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
        const rt = msg as unknown as {
          type: 'session_runtime';
          sessionId: string;
          phase: 'idle' | 'running' | 'awaiting-input' | 'error';
          isRunning: boolean;
          activeToolName?: string;
          lastActivity: number;
          unread: boolean;
          needsAttention: boolean;
          resident: boolean;
        };
        const previousRuntime = projectsState.runtime.get(rt.sessionId);
        projectsState.applyRuntime({
          sessionId: rt.sessionId,
          phase: rt.phase,
          isRunning: Boolean(rt.isRunning),
          ...(typeof rt.activeToolName === 'string' && rt.activeToolName.length > 0
            ? { activeToolName: rt.activeToolName }
            : {}),
          lastActivity: rt.lastActivity,
          unread: rt.unread,
          needsAttention: rt.needsAttention,
          resident: rt.resident,
        });
        if (rt.sessionId === sessionId) {
          const isRunning = Boolean(rt.isRunning);
          const toolName =
            typeof rt.activeToolName === 'string' && rt.activeToolName.length > 0
              ? rt.activeToolName
              : undefined;
          isStreaming = isRunning;
          activeToolName = toolName;
          if (isRunning || toolName) requestWakeLock();
          else releaseWakeLock();
        } else if (previousRuntime?.phase === 'running' && rt.phase !== 'running' && rt.unread) {
          notifyBackgroundCompletion(rt);
        }
        break;
      }

      case 'notification_webhook_url': {
        const nw = msg as { type: 'notification_webhook_url'; url: string | null };
        loadWebhookUrlFromServer(nw.url ?? undefined);
        break;
      }

      case 'settings': {
        const s = msg as { type: 'settings'; settings: Record<string, unknown> };
        if (s.settings) {
          // Merge server-persisted settings into localStorage
          for (const [key, value] of Object.entries(s.settings)) {
            try {
              localStorage.setItem(`pifrontier:${key}`, JSON.stringify(value));
            } catch {
              /* noop */
            }
          }
          // Apply theme if present and different from current
          const themeVal = s.settings['theme'];
          if (typeof themeVal === 'string' && themeVal !== selectedTheme) {
            setTheme(themeVal);
          }
        }
        break;
      }
    }

    scrollBottom();
  }

  function loadOlderMessages() {
    if (olderMessagesLoading || !messagesTruncated || totalRawMessagesLoaded >= totalMessageCount)
      return;
    if (
      send({
        type: 'load_messages',
        count: 50,
        alreadyHasCount: totalRawMessagesLoaded,
      })
    ) {
      olderMessagesLoading = true;
    }
  }

  // ── Modal actions ────────────────────────────────────────────────────────────

  /**
   * Interaction with a live parsed component inside a `custom` dialog — the
   * server invokes the extension's REAL callback and either broadcasts an
   * updated tree (extension_ui_update) or dismisses the dialog
   * (extension_ui_dismiss); this never closes the modal locally.
   */
  function modalComponentAction(
    path: number[],
    event: 'select' | 'click' | 'toggle' | 'submit' | 'setting',
    value?: string
  ) {
    if (!modal || modal.method !== 'custom') return;
    flushEditorMirror();
    send({ type: 'extension_component_event', id: modal.id, path, event, value });
  }

  function modalSubmitValue() {
    flushEditorMirror();
    if (extensionUiState.answerSubmitValue(modalInput)) {
      modalInput = '';
    }
  }

  function modalCancel() {
    flushEditorMirror();
    if (extensionUiState.answerCancel()) {
      modalInput = '';
    }
  }

  /** Handles keydown inside the modal (Enter submits, Esc cancels). The
   *  interactive custom overlay is a separate DOM tree (see `overlayKeydown`) —
   *  this dialog is never open at the same time as that overlay. */
  function focusSelectOption(direction: 1 | -1) {
    const options = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-extension-option="true"]')
    );
    if (options.length === 0) return;

    const current = options.findIndex((option) => option === document.activeElement);
    const next =
      current < 0
        ? direction > 0
          ? 0
          : options.length - 1
        : (current + direction + options.length) % options.length;
    selectOptionIndex = next;
    options[next]?.focus();
  }

  function modalContentKeydown(e: KeyboardEvent) {
    if (modal?.method === 'select') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focusSelectOption(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const target = e.target;
        if (target instanceof HTMLButtonElement && target.dataset.extensionOption === 'true') {
          const index = Number(target.dataset.extensionOptionIndex);
          const selected = filteredSelectOptions[index];
          if (selected) {
            e.preventDefault();
            extensionUiState.answerSelect(selected.value);
          }
        }
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && modal?.method !== 'editor') {
      e.preventDefault();
      if (modal?.method === 'confirm') extensionUiState.answerConfirm(true);
      else if (modal?.method === 'input' || modal?.method === 'custom') modalSubmitValue();
    }
  }
  /** Handles keydown on the hidden input in the interactive custom overlay.
   *  Encodes it as a real terminal byte sequence and forwards it to the
   *  extension's pi-tui component — see `#lib/terminal-key-encoder.js`. */
  function overlayKeydown(e: KeyboardEvent) {
    if (modal?.method !== 'custom' || !modal.interactive) return;
    // Let the IME finish composing; `overlayCompositionEnd` forwards the
    // finalized text once composition ends.
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      modalCancel();
      return;
    }
    const data = encodeTerminalKey(e);
    if (data === null) return; // unsupported key — leave default browser behavior alone
    e.preventDefault();
    e.stopPropagation();
    flushEditorMirror();
    send({ type: 'extension_custom_input', id: modal.id, data });
    // The hidden input is uncontrolled; clear anything it may have picked up.
    if (modalFocusEl instanceof HTMLInputElement) modalFocusEl.value = '';
  }

  /** Handles paste in the hidden input — forwards the clipboard text as a
   *  single bracketed paste so multi-line content (and embedded newlines)
   *  is inserted literally instead of being parsed as separate keystrokes. */
  function overlayPaste(e: ClipboardEvent) {
    if (modal?.method !== 'custom' || !modal.interactive) return;
    e.preventDefault();
    const text = e.clipboardData?.getData('text') ?? '';
    if (!text) return;
    send({ type: 'extension_custom_input', id: modal.id, data: wrapBracketedPaste(text) });
  }

  /** Handles IME composition end (CJK, emoji picker, etc.) in the hidden
   *  input — forwards the finalized text as a single bracketed paste. */
  function overlayCompositionEnd(e: CompositionEvent) {
    if (modal?.method !== 'custom' || !modal.interactive) return;
    if (modalFocusEl instanceof HTMLInputElement) modalFocusEl.value = '';
    const text = e.data;
    if (!text) return;
    send({ type: 'extension_custom_input', id: modal.id, data: wrapBracketedPaste(text) });
  }

  // ── Model & session actions ──────────────────────────────────────────────────

  function pickThinkingLevel(level: string) {
    const clamped = clampThinkingLevelForModel(model, level);
    thinkingLevel = clamped; // optimistic
    send({ type: 'set_thinking_level', level: clamped });
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
  function cloneMessagesForEdit(source: UIMessage[]): UIMessage[] {
    return source.map((message) => ({
      ...message,
      images: message.images?.slice(),
      toolArgs: message.toolArgs ? { ...message.toolArgs } : undefined,
      usage: message.usage ? { ...message.usage, cost: { ...message.usage.cost } } : undefined,
      compaction: message.compaction ? { ...message.compaction } : undefined,
      renderedCallHtml: message.renderedCallHtml?.slice(),
      renderedResultHtml: message.renderedResultHtml?.slice(),
      renderedNoticeHtml: message.renderedNoticeHtml?.slice(),
    }));
  }
  function restorePendingEdit(): boolean {
    if (!_pendingEdit) return false;
    messages = _pendingEdit.messages;
    input = _pendingEdit.input;
    _pendingEdit = null;
    rebuildToolMessageIndex();
    return true;
  }
  function editMessage(originalText: string, newText: string) {
    if (wsState !== 'open' || isStreaming || _pendingEdit) return;
    // Find the message in local state (last matching user message)
    const idx = messages.findLastIndex((m) => m.role === 'user' && m.content === originalText);
    if (idx === -1) return;
    _pendingEdit = { messages: cloneMessagesForEdit(messages), input };
    // Update content first, then truncate after this message without mutating
    // the objects retained by the rollback snapshot.
    messages = messages
      .slice(0, idx + 1)
      .map((message, messageIndex) =>
        messageIndex === idx ? { ...message, content: newText } : message
      );
    rebuildToolMessageIndex();
    // Send to server — server rewinds session and resends
    if (!send({ type: 'edit_message', originalMessage: originalText, newMessage: newText })) {
      restorePendingEdit();
      showChatNotice('Unable to edit message while disconnected.', 'warning');
      return;
    }
    scrollBottom();
  }

  // ── Message helpers ──────────────────────────────────────────────────────────

  function freshAssistant(): UIMessage {
    return {
      id: uid(),
      role: 'assistant',
      content: '',
      thinking: '',
      thinkingExpanded: false,
      streaming: true,
      startMs: Date.now(),
      createdAt: Date.now(),
    };
  }

  function lastStreaming(role: UIMessage['role']): UIMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === role && messages[i].streaming) return messages[i];
    }
  }

  // ── Throttled markdown rendering during streaming ─────────────────────────
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal throttle buffer, never read reactively
  let _pendingRenderSet = new Set<UIMessage>();
  let _renderScheduled = false;

  /**
   * Fence languages still loading when a message was last rendered, keyed by
   * message id. Lets the lazy-grammar-ready handler re-render ONLY the
   * messages that actually need the new language (re-rendering every loaded
   * message per registration is O(history × grammars)).
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive tracking map, never rendered
  const _unresolvedLangs = new Map<string, Set<string>>();

  function recordUnresolvedLang(m: UIMessage, lang: string) {
    let set = _unresolvedLangs.get(m.id);
    if (!set) {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain set inside a non-reactive map
      set = new Set();
      _unresolvedLangs.set(m.id, set);
    }
    set.add(lang);
  }

  /** Prune tracking for messages that no longer exist (wholesale replacements). */
  function pruneUnresolvedLangs() {
    const live = new Set(messages.map((m) => m.id));
    for (const id of _unresolvedLangs.keys()) {
      if (!live.has(id)) _unresolvedLangs.delete(id);
    }
  }

  function scheduleContentRender(msg: UIMessage) {
    _pendingRenderSet.add(msg);
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
      for (const m of _pendingRenderSet) {
        if (!messages.includes(m)) continue; // stale — evicted or replaced
        if (m.streaming) {
          // Escaped plain-text preview — full markdown parse per delta is the
          // streaming hot spot (100k chars ≈ 24 ms parse, 60×/s); the
          // message_end / sealStreaming finalize paths render real markdown.
          if (m.content) m.renderedContent = renderStreamingPreview(m.content);
          if (m.thinking) m.renderedThinking = renderStreamingPreview(m.thinking);
        } else {
          if (m.content)
            m.renderedContent = renderMarkdown(m.content, {
              onUnresolvedLang: (lang) => recordUnresolvedLang(m, lang),
            });
          if (m.thinking)
            m.renderedThinking = renderMarkdown(m.thinking, {
              onUnresolvedLang: (lang) => recordUnresolvedLang(m, lang),
            });
        }
      }
      _pendingRenderSet.clear();
      _renderScheduled = false;
    });
  }

  function sealStreaming() {
    // Drop empty streaming assistant bubbles (LLM turns that produced only tool calls, no text/thinking).
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.streaming && m.role === 'assistant' && !m.content && !m.thinking) {
        messages.splice(i, 1);
      } else if (m.streaming) {
        m.streaming = false;
        // Finalize path for turns that ended without message_end (agent_error,
        // abort): the streaming preview must be replaced with real markdown.
        if (m.content)
          m.renderedContent = renderMarkdown(m.content, {
            onUnresolvedLang: (lang) => recordUnresolvedLang(m, lang),
          });
        if (m.thinking)
          m.renderedThinking = renderMarkdown(m.thinking, {
            onUnresolvedLang: (lang) => recordUnresolvedLang(m, lang),
          });
      }
    }
  }

  function indexToolMessage(message: UIMessage): void {
    if (message.role === 'tool' && message.toolCallId) {
      toolMessagesById.set(message.toolCallId, message);
    }
  }

  function rebuildToolMessageIndex(): void {
    toolMessagesById.clear();
    for (const message of messages) indexToolMessage(message);
  }

  function findToolMessage(toolCallId: string): UIMessage | undefined {
    const indexed = toolMessagesById.get(toolCallId);
    if (indexed) return indexed;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === 'tool' && message.toolCallId === toolCallId) {
        toolMessagesById.set(toolCallId, message);
        return message;
      }
    }
    return undefined;
  }

  function createToolMessage(
    toolName: string,
    toolCallId: string | undefined,
    details?: Record<string, unknown>,
    renderedCallHtml?: string[]
  ): UIMessage {
    return {
      id: uid(),
      role: 'tool',
      content: '',
      toolName,
      toolCallId,
      toolInput: formatToolInput(toolName, details),
      renderedCallHtml,
      streaming: true,
      expanded: toolsExpandedGlobal,
      startMs: Date.now(),
      createdAt: Date.now(),
    };
  }

  function ensureToolMessage(
    toolCallId: string | undefined,
    toolName: string,
    details?: Record<string, unknown>,
    renderedCallHtml?: string[]
  ): UIMessage | undefined {
    if (!toolCallId) return undefined;
    const existing = findToolMessage(toolCallId);
    if (existing) return existing;
    const created = createToolMessage(toolName, toolCallId, details, renderedCallHtml);
    messages.push(created);
    // `$state` deep-wraps objects when they enter the messages array. Index
    // that wrapped value so later event mutations invalidate the rendered row;
    // indexing the pre-push object bypasses Svelte's proxy.
    const reactive = messages[messages.length - 1];
    indexToolMessage(reactive);
    return reactive;
  }

  /** One pending scroll per frame — token deltas and WS frames call this often. */
  let _scrollRaf: number | null = null;
  /** Lazy-cached media query — allocating a MediaQueryList per call is wasteful. */
  let _reducedMotion: MediaQueryList | null = null;

  async function scrollBottom() {
    if (_scrollRaf !== null || !isAtBottom || !scrollEl) return;
    _scrollRaf = requestAnimationFrame(async () => {
      _scrollRaf = null;
      await tick();
      if (!isAtBottom || !scrollEl) return;
      // Instant (not smooth) — a smooth animation restarts every frame while
      // streaming and never settles; the bottom button stays smooth below.
      scrollEl.scrollTop = scrollEl.scrollHeight;
    });
  }

  function handleScroll() {
    if (!scrollEl) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollEl;
    isAtBottom = scrollHeight - scrollTop - clientHeight < 80;
  }

  function scrollToBottom() {
    isAtBottom = true;
    if (!_reducedMotion) _reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (_reducedMotion.matches) {
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    } else {
      scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
    }
  }

  function downloadText(text: string, name: string) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  async function copyMessage(msg: UIMessage) {
    const text = msg.content || msg.thinking;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copiedId = msg.id;
      setTimeout(() => {
        copiedId = null;
      }, 2000);
    } catch {
      // clipboard failed — for large content offer download instead
      if (text.length > 50000) downloadText(text, `message-${msg.id}.txt`);
    }
    // Fallback: even on success, very large copies may be truncated — offer download
    if (text.length > 50000) {
      // No auto-download; user can use the download button, but ensure clipboard attempt was made
    }
  }
  async function copyTurnMessages(msg: UIMessage) {
    const msgIdx = messages.indexOf(msg);
    if (msgIdx === -1) return;
    // Walk backward to find the last user message before this one
    let turnStart = 0;
    for (let i = msgIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        turnStart = i + 1;
        break;
      }
    }
    // Collect all assistant messages in the turn up to and including this one
    const parts: string[] = [];
    for (let i = turnStart; i <= msgIdx; i++) {
      const m = messages[i];
      if (m.role === 'assistant' && (m.content || m.thinking)) {
        parts.push(m.content || (m.thinking ?? ''));
      }
    }
    if (!parts.length) return;
    try {
      await navigator.clipboard.writeText(parts.join('\n\n'));
      copiedTurnId = msg.id;
      setTimeout(() => {
        copiedTurnId = null;
      }, 2000);
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
    setTimeout(() => {
      btn.textContent = prev;
    }, 2000);
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
    // Native chat behavior: tapping the conversation dismisses the keyboard.
    if (inputEl && document.activeElement === inputEl) {
      const target = e.target as HTMLElement | null;
      if (target && !target.closest('button, a, input, textarea, select, [role="button"], label')) {
        inputEl.blur();
      }
    }
  }

  /** Global keyboard shortcut handler — runs on every keydown in the document. */
  function handleGlobalKeydown(e: KeyboardEvent) {
    const inEditable = () => {
      const el = document.activeElement as HTMLElement | null;
      return el?.tagName === 'TEXTAREA' || el?.tagName === 'INPUT' || el?.isContentEditable;
    };
    // Preserve custom terminal input even if focus briefly falls through to
    // the composer while the overlay is mounting.
    if (modal?.method === 'custom' && modal.interactive) {
      overlayKeydown(e);
      return;
    }

    // Escape — dismiss modal or close open panels
    if (e.key === 'Escape') {
      if (modal) return; // modal's own onkeydown handles this
      if (showSessionPanel) {
        e.preventDefault();
        showSessionPanel = false;
        return;
      }
      if (showRightPanel) {
        e.preventDefault();
        showRightPanel = false;
        return;
      }
      if (showSettingsPanel) {
        e.preventDefault();
        showSettingsPanel = false;
        return;
      }
      return;
    }

    // Ctrl+/ — toggle sessions panel
    if (!inEditable() && (e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      showSessionPanel = !showSessionPanel;
      if (showSessionPanel && showRightPanel) showRightPanel = false;
      if (showSessionPanel && showSettingsPanel) showSettingsPanel = false;
      return;
    }

    // Ctrl+K — toggle model picker
    if (!inEditable() && (e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      openTab('models');
      return;
    }

    // Ctrl+T — open thinking level selector
    if (!inEditable() && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 't') {
      e.preventDefault();
      openTab('models');
      return;
    }

    // Ctrl+Shift+T — cycle thinking level
    if (
      !inEditable() &&
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      (e.key === 't' || e.key === 'T')
    ) {
      e.preventDefault();
      const current = thinkingLevel;
      const idx = (availableThinkingLevels as readonly string[]).indexOf(current);
      const next = availableThinkingLevels[(idx + 1) % availableThinkingLevels.length];
      pickThinkingLevel(next);
      showChatNotice(`Thinking level: ${next}`, 'info');
      return;
    }

    // Any printable character when no input is focused → focus textarea
    if (!inEditable() && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      inputEl?.focus();
    }
  }

  // ── User input ───────────────────────────────────────────────────────────────

  async function processAttachmentFiles(files: File[]) {
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const prepared = await prepareImage(file);
        if (!prepared) continue;
        if (prepared.data.length > MAX_IMAGE_PAYLOAD) {
          showChatNotice(
            `Image too large: ${file.name || 'clipboard image'} (max 3MB encoded)`,
            'warning'
          );
          continue;
        }
        attachedImages.push({
          data: prepared.data,
          mimeType: prepared.mimeType,
          name: file.name || 'clipboard image',
          src: `data:${prepared.mimeType};base64,${prepared.data}`,
        });
      } else {
        const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
        if (!TEXT_FILE_EXTENSIONS.has(ext)) {
          showChatNotice(
            `Unsupported file type: ${file.name} (only text files and images are supported)`,
            'warning'
          );
          continue;
        }
        if (file.size > 1024 * 1024) {
          showChatNotice(`File too large: ${file.name} (max 1MB)`, 'warning');
          continue;
        }
        const content = await fileToText(file);
        attachedFiles.push({ name: file.name, content, size: file.size });
      }
    }
  }

  async function handleFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) await processAttachmentFiles(Array.from(input.files));
    input.value = '';
  }

  /** Stages image files from the clipboard while leaving ordinary text paste
   *  to the textarea's native editing behavior. */
  async function handleComposerPaste(e: ClipboardEvent) {
    const data = e.clipboardData;
    if (!data) return;

    const imageFiles = Array.from(data.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (imageFiles.length === 0) {
      imageFiles.push(...Array.from(data.files).filter((file) => file.type.startsWith('image/')));
    }
    if (imageFiles.length === 0) return;

    e.preventDefault();
    await processAttachmentFiles(imageFiles);
  }

  function removeAttachment(idx: number) {
    attachedImages.splice(idx, 1);
  }

  function removeFileAttachment(idx: number) {
    attachedFiles.splice(idx, 1);
  }

  /** Shows a transient status/error message inline in the chat transcript
   *  instead of a corner toast. Client-only — never sent to the session, so
   *  it does not persist past a reload. */
  function showChatNotice(message: string, level: 'info' | 'warning' | 'error' = 'info') {
    messages.push({
      id: uid(),
      role: 'notice',
      content: message,
      noticeKind: 'toast',
      level,
      streaming: false,
      createdAt: Date.now(),
    });
  }

  function dismissChatNotice(id: string) {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx >= 0) messages.splice(idx, 1);
  }

  function selectSlashCommand(shortcut: ComposerShortcut) {
    if (shortcut.disabled) return;
    input = shortcut.insert;
    showSlashMenu = false;
    tick().then(() => {
      autoResizeTextarea();
      inputEl?.focus();
    });
  }

  function steerAgent() {
    const text = input.trim();
    if (!text || wsState !== 'open') return;
    // Commands entered while the agent is running must retain command
    // semantics; only ordinary text belongs in the steering queue.
    if (runSlashCommand(text, true)) {
      input = '';
      resetTextareaHeight();
      return;
    }
    // Keep the draft when the socket closes between the guard and send().
    if (!send({ type: 'steer', message: text })) return;
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
    rec.continuous = false; // browser ends recognition after a silence gap automatically
    rec.interimResults = true; // show live transcript while speaking

    sttManualStop = false; // reset for this session
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

    rec.onerror = () => {
      isRecording = false;
      speechRec = null;
    };
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
    return (
      wsState === 'open' &&
      !sessionLoading &&
      !isStreaming &&
      input.trim().length > 0 &&
      attachedImages.length === 0 &&
      attachedFiles.length === 0
    );
  }

  function runSlashCommand(text: string, isStreamingNow = false): boolean {
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

    // These mutate live session/agent state (context, tools/prompts, model
    // auth, branch files) in ways that can race an in-flight turn — block
    // them while the agent is streaming rather than dispatching them (or,
    // absent this check, letting submitMessage() steer the literal command
    // text into the conversation as a user message). Mirrors the server-side
    // guard in the `run_builtin`/`compact` handlers.
    if (isStreamingNow && ['compact', 'reload', 'login', 'logout', 'clone'].includes(command)) {
      showChatNotice('Wait for the agent to finish before running this command.', 'warning');
      return true;
    }

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
        else showChatNotice('No assistant message to copy yet.', 'warning');
        return true;
      }
      case 'hotkeys':
        showChatNotice(
          'Shortcuts: Enter sends, Shift+Enter newline, Cmd/Ctrl+B opens sessions, Cmd/Ctrl+K opens model picker.',
          'info'
        );
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
    if (wsState !== 'open' || sessionLoading) return;
    flushEditorMirror();
    const text = input.trim();

    // Slash/bang commands are commands, not conversation text — dispatch
    // them before the streaming check so they run instead of being steered
    // into the agent's turn as literal text. runSlashCommand() itself blocks
    // the handful of commands unsafe to run mid-turn.
    if (
      attachedImages.length === 0 &&
      attachedFiles.length === 0 &&
      !asFollowUp &&
      runSlashCommand(text, isStreaming)
    ) {
      input = '';
      resetTextareaHeight();
      return;
    }

    if (isStreaming) {
      if (!text) return;
      haptic();
      steerAgent();
      return;
    }

    if (!text && attachedImages.length === 0 && attachedFiles.length === 0) return;
    haptic();

    const imgs =
      attachedImages.length > 0
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
      send({
        type: 'prompt',
        message: fullText,
        ...(imgs ? { images: imgs } : {}),
      });
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
    sendHolding = true;
    sendHoldTimer = setTimeout(() => {
      sendHoldSubmitted = true;
      sendHolding = false;
      submitMessage(true);
      sendHoldTimer = null;
    }, 550);
  }

  function cancelSendHold() {
    sendHolding = false;
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

  function handleComposerKey(e: KeyboardEvent): boolean {
    if (showSlashMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filteredSlashCommands.length === 0) return true;
        slashMenuIndex = (slashMenuIndex + 1) % filteredSlashCommands.length;
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filteredSlashCommands.length === 0) return true;
        slashMenuIndex =
          (slashMenuIndex - 1 + filteredSlashCommands.length) % filteredSlashCommands.length;
        return true;
      }
      if (e.key === 'Enter' && slashMenuIndex >= 0) {
        e.preventDefault();
        const selected = filteredSlashCommands[slashMenuIndex];
        if (!selected?.disabled) selectSlashCommand(selected);
        return true;
      }
    }
    // Keep Enter available as a newline while the session is opening. The
    // eventual session_loaded path enables submission without losing the draft.
    if ((sessionLoading || projectsState.pendingNewSession) && e.key === 'Enter') return false;
    if (e.key === 'Enter' && (isMobile ? e.shiftKey : !e.shiftKey)) {
      e.preventDefault();
      submitMessage();
      return true;
    }
    return false;
  }

  type ComposerSnapshot = {
    value: string;
    start: number;
    end: number;
    seq: number;
    /** composerForeignEditSeq at snapshot time — any bump before the verdict
     *  arrives means something OTHER than this key's own expected native
     *  action changed the text (paste, IME, programmatic, another verdict). */
    foreignSeq: number;
    menuOpen: boolean;
    /** Native delete was prevented (keys were pending) — replayed at verdict time. */
    deferredDelete?: 'backward' | 'forward';
  };

  let terminalInputChain: Promise<void> = Promise.resolve();
  /** Bumped when pending inputs are flushed/discarded — stale queued executors
   *  and late verdicts check it before sending/applying anything. */
  let terminalInputGeneration = 0;
  /** Bumped ONLY by a session-switch discard (never by a flush). A queued
   *  entry captured before a discard epoch bump must always be dropped even
   *  if a LATER, unrelated flush also invalidates its generation — otherwise
   *  a stale entry from session A could resurrect and apply after session
   *  B's socket closes. Comparing epochs (not a single mutable "discarding"
   *  flag) makes each entry's own capture point authoritative. */
  let terminalInputDiscardEpoch = 0;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive dispatch table, never rendered
  const pendingTerminalInputs = new Map<
    string,
    (verdict: { consumed: boolean; data?: string }, discard?: boolean) => void
  >();
  let composerEditSeq = 0;
  /** Bumped by any composer input event NOT attributable to the immediately
   *  preceding optimistic keydown's own native action (see expectingNativeEdit
   *  below) — paste, IME commit, programmatic replace, or a verdict's own
   *  insert/delete/restore. Lets a pending verdict tell "my key's expected
   *  native change" apart from "something else changed the text". */
  let composerForeignEditSeq = 0;
  /** True for the one input event expected to follow an optimistic keydown's
   *  own native default action (if it produces one at all — arrows/Home/End
   *  don't). Consumed by that event without bumping composerForeignEditSeq;
   *  cleared on a microtask so a key with NO native input event (e.g. a bare
   *  arrow) never misattributes a LATER, unrelated edit to itself. */
  let expectingNativeEdit = false;

  function handleComposerInput() {
    if (expectingNativeEdit) {
      expectingNativeEdit = false;
    } else {
      composerForeignEditSeq++;
    }
    if ((sessionLoading || projectsState.sessionLoading) && !projectsState.pendingNewSession) {
      sessionSwitchDraft = input;
    }
    autoResizeTextarea();
  }

  function handleComposerKeydown(e: KeyboardEvent) {
    // During session creation or the reconnect handshake, sessionId and
    // terminalInputActive still describe the previous session. Keep typing
    // local and never route keys to that session's extension handlers.
    if (
      sessionLoading ||
      projectsState.sessionLoading ||
      projectsState.pendingNewSession ||
      !_wsHandshakeComplete ||
      !extensionUiState.terminalInputActive ||
      e.isComposing
    ) {
      handleComposerKey(e);
      return;
    }
    const data = encodeTerminalKey(e);
    if (!data) {
      handleComposerKey(e);
      return;
    }
    const optimistic = isOptimisticTerminalKey(e);
    const snapshot: ComposerSnapshot = {
      value: inputEl?.value ?? input,
      start: inputEl?.selectionStart ?? input.length,
      end: inputEl?.selectionEnd ?? input.length,
      seq: ++composerEditSeq,
      foreignSeq: composerForeignEditSeq,
      menuOpen: showSlashMenu,
    };
    if (optimistic) {
      // Native default action applies the key; app-level handling runs now.
      // Backspace/Delete with earlier keys still in flight would delete
      // against pre-verdict text (terminal order breaks: "a" then ⌫ must
      // delete the "a"). Defer those until the pending verdicts land.
      if ((e.key === 'Backspace' || e.key === 'Delete') && pendingTerminalInputs.size > 0) {
        e.preventDefault();
        e.stopPropagation();
        snapshot.deferredDelete = e.key === 'Backspace' ? 'backward' : 'forward';
      } else {
        expectingNativeEdit = true;
        handleComposerKey(e);
        queueMicrotask(() => {
          expectingNativeEdit = false;
        });
      }
    } else {
      e.preventDefault();
      e.stopPropagation();
    }
    enqueueTerminalInput(e, data, optimistic, snapshot);
  }

  /**
   * Keys whose native textarea behavior is complex (caret/selection/line
   * movement, clipboard, focus) are applied natively and the verdict arrives
   * in the background; consumed keys are reverted best-effort. All other keys
   * (printable chars, Enter, Escape) await the verdict before applying.
   */
  function isOptimisticTerminalKey(e: KeyboardEvent): boolean {
    // Ctrl/Alt-modified keys are optimistic EXCEPT Enter — a consumed
    // Ctrl+Enter/Alt+Enter verdict must be able to veto the submit.
    if (e.ctrlKey || e.altKey) return e.key !== 'Enter';
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
      case 'PageUp':
      case 'PageDown':
      case 'Backspace':
      case 'Delete':
      case 'Tab':
      case 'Insert':
        return true;
      default:
        return false;
    }
  }

  function enqueueTerminalInput(
    e: KeyboardEvent,
    data: string,
    optimistic: boolean,
    snapshot: ComposerSnapshot
  ) {
    const id = crypto.randomUUID();
    const gen = terminalInputGeneration;
    const discardEpoch = terminalInputDiscardEpoch;
    terminalInputChain = terminalInputChain
      .then(
        () =>
          new Promise<void>((resolve) => {
            // Flushed/discarded (socket close, session switch) while queued —
            // this key must neither be sent nor applied.
            if (gen !== terminalInputGeneration) {
              if (discardEpoch === terminalInputDiscardEpoch) {
                // Only flush(es) — never a discard — happened since capture,
                // so this key still belongs to the current session and must
                // not vanish.
                applyTerminalInputResult(e, { consumed: false }, snapshot, optimistic);
              }
              resolve();
              return;
            }
            const entry = {
              applied: false,
              timeout: setTimeout(() => settle({ consumed: false }), 2000),
            };
            function settle(verdict: { consumed: boolean; data?: string }, discard = false) {
              if (entry.applied) return;
              entry.applied = true;
              clearTimeout(entry.timeout);
              pendingTerminalInputs.delete(id);
              resolve();
              if (!discard) applyTerminalInputResult(e, verdict, snapshot, optimistic);
            }
            pendingTerminalInputs.set(id, settle);
            send({ type: 'extension_terminal_input', id, data, sessionId: sessionId ?? '' });
          })
      )
      .catch(() => {
        pendingTerminalInputs.delete(id);
        if (gen === terminalInputGeneration || discardEpoch === terminalInputDiscardEpoch) {
          applyTerminalInputResult(e, { consumed: false }, snapshot, optimistic);
        }
      });
  }

  function applyTerminalInputResult(
    e: KeyboardEvent,
    verdict: { consumed: boolean; data?: string },
    snapshot: ComposerSnapshot,
    optimistic: boolean
  ) {
    if (verdict.consumed) {
      // Best-effort revert: only when no later keydown intervened AND the
      // text wasn't changed by a non-keydown edit (paste/IME/programmatic)
      // while the verdict was in flight.
      if (snapshot.seq === composerEditSeq && snapshot.foreignSeq === composerForeignEditSeq) {
        restoreComposer(snapshot);
      }
      return;
    }
    if (verdict.data !== undefined) {
      // pi-tui replaces the key with the rewritten data. For optimistic keys
      // the native default action already ran, so undo it first (guarded).
      if (
        optimistic &&
        snapshot.seq === composerEditSeq &&
        snapshot.foreignSeq === composerForeignEditSeq
      )
        restoreComposer(snapshot);
      applyRewrittenData(verdict.data, e);
      return;
    }
    if (optimistic) {
      if (snapshot.deferredDelete) {
        // Earlier verdicts have landed by now (chain order) — delete against
        // the live text so terminal order is preserved.
        deleteComposerText(snapshot.deferredDelete === 'backward');
      } else if (!snapshot.menuOpen && showSlashMenu) {
        // The key's app-level handling may have run before an earlier awaited
        // key's verdict opened the slash menu (fast typing: "/" then ArrowDown).
        // Replay the menu interaction now that the menu exists.
        handleComposerKey(e);
      }
      return;
    }
    if (handleComposerKey(e)) return;

    if (e.key === 'Enter') insertComposerText('\n');
    else // Shift+Enter newline
    if (e.key.length === 1) insertComposerText(e.key);
    else if (e.key === 'Escape') {
      // The awaited tier preventDefault+stopPropagation'd this key, so the
      // window handler (close panels, dismiss modal) never saw it — replay it.
      handleGlobalKeydown(e);
    }
    // Other unmapped keys: nothing to apply.
  }

  /**
   * Applies handler-rewritten data. In pi-tui the rewritten bytes are
   * processed as a key, not inserted literally — map the single-byte
   * sequences with real composer actions; anything else is inserted as text
   * (the only current consumer never rewrites).
   */
  function applyRewrittenData(data: string, sourceEvent: KeyboardEvent) {
    if (data === '\r') {
      // Rewritten to Enter — replay the composer's Enter handling with the
      // original event's modifiers (shift state decides submit vs newline).
      // A real KeyboardEvent is required: handleComposerKey calls
      // preventDefault(), which throws Illegal invocation on event fakes.
      handleComposerKey(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          shiftKey: sourceEvent.shiftKey,
        })
      );
      return;
    }
    if (data === '\x1b') {
      // Rewritten to Escape — replay global Escape handling (close panels)
      // with the key transformed, since handleGlobalKeydown reads e.key.
      handleGlobalKeydown(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
          ctrlKey: sourceEvent.ctrlKey,
          metaKey: sourceEvent.metaKey,
          shiftKey: sourceEvent.shiftKey,
          altKey: sourceEvent.altKey,
        })
      );
      return;
    }
    insertComposerText(data);
  }

  function insertComposerText(text: string) {
    if (!inputEl) {
      input += text;
      return;
    }
    const start = inputEl.selectionStart ?? input.length;
    const end = inputEl.selectionEnd ?? input.length;
    inputEl.setRangeText(text, start, end, 'end');
    inputEl.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
    );
    autoResizeTextarea();
  }

  /** Native-equivalent Backspace/Delete against the live composer text. */
  function deleteComposerText(backward: boolean) {
    if (!inputEl) {
      input = backward ? input.slice(0, Math.max(0, input.length - 1)) : input.slice(1);
      return;
    }
    const start = inputEl.selectionStart ?? input.length;
    const end = inputEl.selectionEnd ?? input.length;
    const delStart = backward ? Math.max(0, start - (start === end ? 1 : 0)) : start;
    const delEnd = backward ? end : Math.min(inputEl.value.length, end + (start === end ? 1 : 0));
    inputEl.setRangeText('', delStart, delEnd, 'end');
    inputEl.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: backward ? 'deleteContentBackward' : 'deleteContentForward',
      })
    );
    autoResizeTextarea();
  }

  function restoreComposer(s: ComposerSnapshot) {
    if (!inputEl) {
      input = s.value;
      return;
    }
    inputEl.value = s.value;
    inputEl.setSelectionRange(s.start, s.end);
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop' }));
    autoResizeTextarea();
  }

  function flushPendingTerminalInputs() {
    // No discardEpoch bump — queued entries invalidated by this flush alone
    // still apply as unconsumed (see enqueueTerminalInput).
    terminalInputGeneration++;
    for (const settle of [...pendingTerminalInputs.values()]) settle({ consumed: false });
    pendingTerminalInputs.clear();
    terminalInputChain = Promise.resolve();
  }

  /** Session switch — keys sent for the previous session must neither be
   *  applied to the new session's composer nor routed to it. */
  function discardPendingTerminalInputs() {
    terminalInputDiscardEpoch++;
    terminalInputGeneration++;
    for (const settle of [...pendingTerminalInputs.values()]) settle({ consumed: false }, true);
    pendingTerminalInputs.clear();
    terminalInputChain = Promise.resolve();
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
    haptic();
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
    const suffix =
      target === 'ui' ? ' The server will restart and the page will reload when it finishes.' : '';
    requestConfirm(
      `Update ${label}? This will run package commands on the server.${suffix}`,
      () => {
        updateRunning = true;
        updateTarget = target;
        updateLog = '';
        updateFeedback = null;
        send({ type: 'run_update', target });
      },
      { title: `Update ${label}`, confirmLabel: 'Update', variant: 'warning' }
    );
  }

  function requestServerRestart(reloadPage = false) {
    if (reloadPage) _reloadPending = true;
    reloadAfterRestart = reloadPage;
    send({ type: 'request_restart' });
  }

  function restartServer(reloadPage = false) {
    requestConfirm(
      'Restart the server? The page will reconnect automatically in a few seconds.',
      () => {
        requestServerRestart(reloadPage);
      },
      { title: 'Restart server', confirmLabel: 'Restart', variant: 'warning' }
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  $effect(() => {
    const commandLike = !!shortcutTrigger && !input.slice(1).includes('\n');
    showSlashMenu =
      !isStreaming && commandLike && (filteredSlashCommands.length > 0 || !!commandArgMode);
    if (
      (shortcutTrigger === '/' || shortcutTrigger === '#') &&
      !resourcesLoaded &&
      wsState === 'open'
    ) {
      resourcesLoaded = true;
      send({ type: 'get_resources' });
    }
    if (shortcutTrigger === '@' && wsState === 'open' && shortcutQuery !== lastFileCompleteQuery) {
      lastFileCompleteQuery = shortcutQuery;
      if (_fileCompleteTimer) {
        clearTimeout(_fileCompleteTimer);
        _fileCompleteTimer = null;
      }
      _fileCompleteTimer = setTimeout(() => {
        _fileCompleteTimer = null;
        send({ type: 'file_complete', query: shortcutQuery });
      }, 200);
    } else if (shortcutTrigger !== '@') {
      lastFileCompleteQuery = '';
      fileCompletions = [];
    }
    // Request extension autocomplete items when trigger or query changes.
    if (
      shortcutTrigger &&
      wsState === 'open' &&
      (shortcutTrigger !== lastExtensionTrigger || shortcutQuery !== lastExtensionQuery)
    ) {
      lastExtensionTrigger = shortcutTrigger;
      lastExtensionQuery = shortcutQuery;
      extensionCompletions = [];
      send({ type: 'get_extension_autocomplete', trigger: shortcutTrigger, query: shortcutQuery });
    } else if (!shortcutTrigger) {
      lastExtensionTrigger = '';
      lastExtensionQuery = '';
      extensionCompletions = [];
    }
    // Request command argument completions when user continues past a command name
    if (commandArgMode) {
      const needsFetch =
        commandArgMode.command !== commandArgCommand || commandArgMode.prefix !== commandArgPrefix;
      if (needsFetch) {
        commandArgCommand = commandArgMode.command;
        commandArgPrefix = commandArgMode.prefix;
        commandCompletionsPending = true;
        commandArgCompletions = [];
        send({
          type: 'get_command_completions',
          command: commandArgMode.command,
          prefix: commandArgMode.prefix,
        });
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
  let _unsubLangReady: (() => void) | null = null;

  onMount(() => {
    // Paint the last conversation immediately on cold start (mobile OSes
    // discard backgrounded PWAs; without this the user stares at a splash
    // until the WS delivers `connected`). A URL written by this app while a
    // switch was still pending may be stale after a reload, so the durable
    // device identity outranks that one URL only. Genuine deep links keep
    // their normal precedence.
    const urlSessionPath = getSessionParam();
    const storedIdentityPath = loadIdentity()?.path ?? null;
    let appOwnedOptimisticUrl = false;
    try {
      const marker = (history.state as Record<string, unknown> | null)?.piUiOptimisticSession;
      appOwnedOptimisticUrl = marker === urlSessionPath && typeof marker === 'string';
    } catch {
      /* history unavailable */
    }
    bootResumePath =
      appOwnedOptimisticUrl && storedIdentityPath
        ? storedIdentityPath
        : (urlSessionPath ?? storedIdentityPath);
    const snap = loadSnapshot(bootResumePath);
    if (snap) _lastVisibleSessionPath = bootResumePath ?? undefined;
    if (snap) {
      messages = snap.messages;
      rebuildToolMessageIndex();
      if (snap.sessionName) sessionName = snap.sessionName;
    }
    // Web Share Target (static/manifest.webmanifest → share_target, method GET,
    // action "/") lands here as ?share_title=&share_text=&share_url= — fold
    // whatever's present into the composer, then scrub the params so a
    // refresh doesn't re-populate it. Set this before connecting so the
    // initial connected snapshot cannot replace the shared draft with a
    // cached/empty draft.
    try {
      const shareParams = new URLSearchParams(window.location.search);
      const sharedTitle = shareParams.get('share_title');
      const sharedText = shareParams.get('share_text');
      const sharedUrl = shareParams.get('share_url');
      if (sharedTitle || sharedText || sharedUrl) {
        shareTargetDraft = [sharedTitle, sharedText, sharedUrl].filter(Boolean).join('\n');
        input = shareTargetDraft;
        setUrlParams({ share_title: null, share_text: null, share_url: null });
        tick().then(autoResizeTextarea);
      }
    } catch {
      /* URL unavailable */
    }
    connect();
    inputEl?.focus();
    // Prefetch the lazily-loaded sidebar modules once the main thread is
    // idle — first open is then instant while first paint stays untouched.
    const idlePrefetch = (fn: () => void) => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(fn, { timeout: 2000 });
      } else {
        setTimeout(fn, 1000);
      }
    };
    idlePrefetch(() => {
      import('#lib/components/panels/right-panel.svelte').catch(() => {});
      import('#lib/components/projects/projects-sidebar.svelte').catch(() => {});
    });
    _mq = window.matchMedia('(max-width: 767px)');
    isMobile = _mq.matches;
    _mqHandler = (e: MediaQueryListEvent) => {
      isMobile = e.matches;
    };
    _mq.addEventListener('change', _mqHandler);
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
    // Some Android WebViews/OEM browsers resume without a visibilitychange
    // event — focus is a reliable secondary resume signal.
    window.addEventListener('focus', _onFocusResume);
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
    } catch {
      /* localStorage unavailable */
    }
    try {
      const savedTheme = localStorage.getItem('pifrontier:theme');
      if (savedTheme) setTheme(savedTheme);
    } catch {
      /* localStorage unavailable */
    }
    // Load persisted auto-compact/auto-retry settings
    try {
      const ac = localStorage.getItem('pifrontier:autoCompactionEnabled');
      if (ac !== null) autoCompactionEnabled = JSON.parse(ac);
      const ar = localStorage.getItem('pifrontier:autoRetryEnabled');
      if (ar !== null) autoRetryEnabled = JSON.parse(ar);
    } catch {
      /* localStorage unavailable */
    }
    // Re-render ONLY messages that could use the newly loaded grammar —
    // fence-bearing messages tracked during their last render, plus expanded
    // tool outputs (their highlightCode calls aren't tracked per-message).
    // The old code re-rendered every loaded message per registration.
    _unsubLangReady = onLangRegistered((lang) => {
      for (const m of messages) {
        const needsLang = _unresolvedLangs.get(m.id)?.has(lang);
        const needsToolRehighlight = m.role === 'tool' && m.expanded && m.content;
        if (needsLang || needsToolRehighlight) scheduleContentRender(m);
      }
      pruneUnresolvedLangs();
    });
  });

  onDestroy(() => {
    releaseWakeLock();
    if (sendHoldTimer) clearTimeout(sendHoldTimer);
    clearBootResumeTimer();
    if (_fileCompleteTimer) clearTimeout(_fileCompleteTimer);
    if (_editorMirrorTimer) {
      clearTimeout(_editorMirrorTimer);
      _editorMirrorTimer = null;
    }
    if (modelRefreshFeedbackTimer) {
      clearTimeout(modelRefreshFeedbackTimer);
      modelRefreshFeedbackTimer = null;
    }
    disconnect();
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    window.removeEventListener('focus', _onFocusResume);
    if (_installPromptHandler)
      window.removeEventListener('beforeinstallprompt', _installPromptHandler);
    if (_appInstalledHandler) window.removeEventListener('appinstalled', _appInstalledHandler);
    if (_onlineHandler) window.removeEventListener('online', _onlineHandler);
    if (_offlineHandler) window.removeEventListener('offline', _offlineHandler);
    if (_mq && _mqHandler) _mq.removeEventListener('change', _mqHandler);
    if (_unsubLangReady) _unsubLangReady();
  });

  /**
   * Secondary resume signal: some Android WebViews/OEM browsers return from
   * background without a visibilitychange event. Focus carries the same
   * "user came back" meaning, so re-run the visibility resume path.
   */
  function _onFocusResume() {
    if (document.hidden || _pageHiddenAt <= 0) return;
    _onVisibilityChange();
  }

  /** Single visibility-change handler: pause reconnection + manage wake lock. */
  function _onVisibilityChange() {
    if (document.hidden) {
      _pageHiddenAt = Date.now();
      // Last reliable moment to persist before a possible OS freeze/discard
      saveSnapshot(sessionPath, sessionName, messages);
      releaseWakeLock();
      sendSessionFocus(null);
    } else {
      // Wake lock: re-acquire if still streaming
      if (sessionId) sendSessionFocus(sessionId);
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
        } else if (wsState === 'open' && wasHidden > 120_000) {
          // Server idle timeout (120s) likely closed the socket — force reconnect
          _intentionalClose = false;
          const old = ws;
          if (old) {
            // Detach first: the close event fires asynchronously and must not
            // reach the onclose of a socket we're about to supersede.
            old.onclose = null;
            old.onerror = null;
            try {
              old.close();
            } catch {
              /* ignore */
            }
          }
          ws = null;
          wsState = 'connecting';
          connect();
        }
      }
    }
  }
</script>

<svelte:head><title>pi UI</title></svelte:head>
<svelte:window onkeydown={handleGlobalKeydown} />
<!--
  Root: flex-row — three columns:
    [session panel] [main content] [model picker panel]
  Sidebars are always in the DOM; their width transitions push/shrink the center.
-->
<Tooltip.Provider delayDuration={400} disabled={isMobile}>
  <div
    role="presentation"
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
      {#snippet header()}
        {#if isMobile}
          <div
            class="shrink-0 px-4 py-3 border-b border-base-content/10 flex items-center justify-between bg-base-content/[0.025]"
          >
            <span
              class="text-sm text-base-content/60 uppercase tracking-[0.16em] font-medium truncate"
            >
              {projectsState.groups.length
                ? `projects (${projectsState.groups.length})`
                : 'projects'}
            </span>

            <button
              onclick={() => (showSessionPanel = false)}
              class="w-9 h-9 flex items-center justify-center text-base-content/45 hover:text-base-content/80 hover:bg-base-content/8 rounded-xl transition-colors shrink-0"
              aria-label="Close projects panel"
              ><svg
                class="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg
              >
            </button>
          </div>
        {/if}
      {/snippet}

      <ProjectsSidebar
        open={showSessionPanel}
        canFork={messages.length > 0 && !isStreaming}
        onFork={() => {
          showSessionPanel = false;
          openForkDialog();
        }}
        onRequestConfirm={requestConfirm}
      />
    </SidebarPanel>

    <!-- ── MAIN COLUMN ──────────────────────────────────────────────────────── -->
    <div
      class="flex-1 flex flex-col min-w-0 bg-[color-mix(in_oklch,var(--color-base-200)_86%,black_8%)] relative"
      style="padding-bottom: {keyboardInset}px;"
    >
      <!-- Top tab bar -->
      <header
        class="relative shrink-0 min-h-14 flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 bg-[radial-gradient(ellipse_70%_100%_at_50%_0%,color-mix(in_oklch,var(--color-primary)_6%,transparent),transparent_75%),color-mix(in_oklch,var(--color-base-200)_86%,black_8%)] shadow-sm shadow-black/10"
        style="padding-top: env(safe-area-inset-top, 0px);"
      >
        <div class="absolute inset-x-0 bottom-0 hairline-x pointer-events-none"></div>
        <div class="relative z-10 flex items-center gap-1.5 shrink-0">
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  onclick={() => {
                    showSessionPanel = !showSessionPanel;
                    showRightPanel = false;
                    showSettingsPanel = false;
                  }}
                  class="{isMobile
                    ? 'h-10 w-10'
                    : 'h-9 w-9'} relative flex items-center justify-center rounded-lg transition-colors {showSessionPanel
                    ? 'text-primary bg-primary/12'
                    : 'text-base-content/60 hover:text-base-content/90 hover:bg-base-content/8'}"
                  aria-label="Toggle session panel"
                  aria-expanded={showSessionPanel}
                >
                  <svg
                    class="w-[18px] h-[18px]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect x="3" y="4" width="18" height="16" rx="2"></rect>
                    <path d="M9 4v16"></path>
                  </svg>
                </button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content side="bottom">Sessions</Tooltip.Content>
          </Tooltip.Root>
        </div>

        <button
          onclick={() => openTab('models')}
          class="absolute left-1/2 top-0 bottom-0 z-0 w-[min(52rem,calc(100vw-12.5rem))] sm:w-[min(52rem,calc(100vw-8.5rem))] -translate-x-1/2 min-w-0 flex flex-col items-center justify-center px-2 sm:px-3 text-center rounded-t-none sm:rounded-t-xl border-x border-transparent hover:bg-base-content/[0.035] transition-colors"
          aria-label="Open model and provider panel"
          aria-expanded={showRightPanel && rightPanelTab === 'models'}
        >
          <span
            class="max-w-full text-sm sm:text-[15px] leading-tight text-base-content/82 truncate"
          >
            {sessionName || activeProjectName || 'New chat'}
          </span>
          <span
            class="hidden sm:flex max-w-full items-center justify-center gap-1.5 text-[11px] leading-tight text-base-content/38 truncate"
          >
            <span class="truncate">{model?.provider || 'no provider'}</span>
            {#if model?.name}<span class="text-base-content/40">›</span><span class="truncate"
                >{model.name}</span
              >{/if}
            {#if thinkingLevel !== 'off'}<span class="text-success/65">{thinkingLevel}</span>{/if}
          </span>
        </button>

        <div class="relative z-10 flex items-center gap-1.5 shrink-0 ml-auto">
          {#if activeToolName}
            <div
              class="h-9 flex items-center gap-1.5 rounded-xl px-2.5 sm:px-3 bg-primary/10 border border-primary/25 text-primary text-xs font-medium shrink-0 animate-pulse"
              role="status"
              aria-label={`Running tool ${activeToolName}`}
            >
              <Wrench class="w-3.5 h-3.5 shrink-0" />
              <span class="hidden sm:inline max-w-40 truncate">Running {activeToolName}…</span>
              <span class="sm:hidden">Running…</span>
            </div>
          {/if}
          {#if effectiveContextTokens > 0}
            <Tooltip.Root>
              <Tooltip.Trigger
                class={[
                  'h-9 hidden md:flex items-center gap-2 rounded-xl px-3 border text-xs tabular-nums cursor-default transition-colors',
                  contextPercent >= 75
                    ? 'bg-error/8 border-error/18 text-error/70'
                    : contextPercent >= 50
                      ? 'bg-warning/8 border-warning/18 text-warning/70'
                      : 'bg-base-content/[0.055] border-base-content/8 text-base-content/65',
                ].join(' ')}
              >
                <span class="relative flex h-4 w-4 items-center justify-center">
                  <span
                    class={[
                      'absolute inset-0 rounded-full border-2 transition-colors',
                      contextPercent >= 75
                        ? 'border-error/40'
                        : contextPercent >= 50
                          ? 'border-warning/40'
                          : 'border-success/35',
                    ].join(' ')}
                  ></span>
                  <span
                    class={[
                      'h-1.5 w-1.5 rounded-full transition-colors',
                      contextPercent >= 75
                        ? 'bg-error/70'
                        : contextPercent >= 50
                          ? 'bg-warning/70'
                          : 'bg-success/70',
                    ].join(' ')}
                  ></span>
                </span>
                <span
                  >{contextPercent > 0
                    ? `${contextPercent}%`
                    : fmtTokens(effectiveContextTokens)}</span
                >
              </Tooltip.Trigger>
              <Tooltip.Content sideOffset={8} class="min-w-[180px]">
                <div class="flex flex-col gap-2 py-0.5">
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-background/60">Context</span>
                    <span class="font-medium"
                      >{contextPercent > 0
                        ? `${contextPercent}%`
                        : fmtTokens(effectiveContextTokens)}</span
                    >
                  </div>
                  <div class="w-full h-1.5 rounded-full bg-background/15 overflow-hidden">
                    <div
                      class={[
                        'h-full rounded-full transition-all',
                        contextPercent >= 75
                          ? 'bg-error/70'
                          : contextPercent >= 50
                            ? 'bg-warning/70'
                            : 'bg-background/70',
                      ].join(' ')}
                      style="width: {Math.min(contextPercent, 100)}%"
                    ></div>
                  </div>
                  <div class="flex items-center justify-between text-background/60">
                    <span>{effectiveContextTokens.toLocaleString()}</span>
                    {#if contextUsageWindow > 0 || model?.contextWindow}
                      <span
                        >/ {(
                          (contextUsageWindow > 0 ? contextUsageWindow : null) ??
                          model?.contextWindow ??
                          0
                        ).toLocaleString()} tokens</span
                      >
                    {/if}
                  </div>
                  {#if latestCompaction?.tokensBefore !== undefined && latestCompaction.tokensAfter !== undefined}
                    <div
                      class="flex items-center justify-between gap-3 border-t border-background/10 pt-1.5 mt-0.5"
                    >
                      <span class="text-background/45">Last compaction</span>
                      <span class="text-success/75">
                        {latestCompaction.tokensBefore.toLocaleString()} →
                        {latestCompaction.tokensAfter.toLocaleString()}
                        {#if lastCompactionSavings !== undefined}
                          <span class="ml-1">({lastCompactionSavings}% freed)</span>
                        {/if}
                      </span>
                    </div>
                  {/if}
                  {#if sessionTokens > 0}
                    <div
                      class="flex items-center justify-between border-t border-background/10 pt-1.5 mt-0.5"
                    >
                      <span class="text-background/45">Session</span>
                      <span class="text-background/70">{sessionTokens.toLocaleString()} tokens</span
                      >
                    </div>
                  {/if}
                  {#if sessionCostTotal > 0}
                    <div class="flex items-center justify-between">
                      <span class="text-background/45">Cost</span>
                      <span class="text-background/70">{fmtCost(sessionCostTotal)}</span>
                    </div>
                  {/if}
                  {#if sessionDuration}
                    <div
                      class="flex items-center justify-between border-t border-background/10 pt-1.5 mt-0.5"
                    >
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
                  class="h-9 w-9 hidden sm:flex items-center justify-center rounded-lg transition-colors {showRightPanel &&
                  rightPanelTab === 'skills'
                    ? 'text-primary bg-primary/12'
                    : 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8'}"
                  aria-label="Toggle resources panel"
                  aria-expanded={showRightPanel && rightPanelTab === 'skills'}
                  ><BookOpen class="w-4 h-4" /></button
                >
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content side="bottom">Skills & Prompts</Tooltip.Content>
          </Tooltip.Root>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  onclick={() => openTab('tools')}
                  class="{isMobile
                    ? 'h-10 w-10'
                    : 'h-9 w-9'} flex items-center justify-center rounded-lg transition-colors {showRightPanel &&
                  rightPanelTab === 'tools'
                    ? 'text-primary bg-primary/12'
                    : 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8'}"
                  aria-label="Toggle tools panel"
                  aria-expanded={showRightPanel && rightPanelTab === 'tools'}
                  ><Wrench class="w-4 h-4" /></button
                >
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
                    ><svg
                      class="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M12 3v13"></path>
                      <path d="m5 13 7 7 7-7"></path>
                      <path d="M5 21h14"></path>
                    </svg>
                  </button>
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
                  onclick={() => {
                    showSettingsPanel = !showSettingsPanel;
                    showRightPanel = false;
                    showSessionPanel = false;
                  }}
                  class="{isMobile
                    ? 'h-10 w-10'
                    : 'h-9 w-9'} flex items-center justify-center rounded-lg transition-colors {showSettingsPanel
                    ? 'text-primary bg-primary/12'
                    : 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8'}"
                  aria-label="Open settings"
                  aria-expanded={showSettingsPanel}
                  ><svg
                    class="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"></path>

                    <path
                      d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.4.2.7.5.9.9.2.3.4.7.4 1.1V11a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"
                    ></path>
                  </svg>
                </button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content side="bottom">Settings</Tooltip.Content>
          </Tooltip.Root>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  class="h-9 w-9 hidden sm:flex items-center justify-center rounded-lg transition-colors relative {wsState ===
                  'open'
                    ? 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8'
                    : wsState === 'connecting'
                      ? 'text-warning/50 hover:text-warning/70 hover:bg-warning/8'
                      : 'text-error/50 hover:text-error/70 hover:bg-error/8'}"
                  aria-label="Connection info"
                  ><svg
                    class="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M4 5h16"></path>
                    <path d="M7 5v11a2 2 0 0 0 2 2h2"></path>
                    <path d="M13 5v11a2 2 0 0 0 2 2h2"></path>
                  </svg>

                  <span
                    class="absolute top-0.5 right-0.5 w-2 h-2 rounded-full border border-base-100 {wsState ===
                    'open'
                      ? 'bg-success glow-success'
                      : wsState === 'connecting'
                        ? 'bg-warning animate-pulse'
                        : 'bg-error'}"
                  ></span>
                </button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content sideOffset={8} class="min-w-[180px]">
              <div class="flex flex-col gap-2 py-0.5">
                <div class="flex items-center justify-between gap-3">
                  <span class="text-background/60">Connection</span>
                  <span class="flex items-center gap-1.5 font-medium">
                    <span
                      class="w-1.5 h-1.5 rounded-full {wsState === 'open'
                        ? 'bg-success'
                        : wsState === 'connecting'
                          ? 'bg-warning animate-pulse'
                          : 'bg-error'}"
                    ></span>
                    {wsState === 'open'
                      ? 'Connected'
                      : wsState === 'connecting'
                        ? 'Connecting'
                        : 'Disconnected'}
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
        <div
          class="shrink-0 flex items-center justify-center gap-3 px-3 py-2 text-xs bg-error/10 text-error/80 border-b border-error/15"
          role="status"
          aria-live="polite"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-error animate-pulse"></span>

          <span
            >disconnected{reconnectCountdown > 0
              ? ` — reconnecting in ${reconnectCountdown}s`
              : ''}</span
          >

          <button
            onclick={connect}
            class="ml-auto shrink-0 px-2 py-0.5 rounded-md font-semibold text-error/90 hover:text-error hover:bg-error/15 transition-colors"
            >Reconnect now</button
          >
        </div>
      {:else if wsState === 'connecting'}
        <div
          class="shrink-0 flex items-center justify-center gap-2 px-3 py-2 text-xs bg-warning/10 text-warning/80 border-b border-warning/15"
          role="status"
          aria-live="polite"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
          <span class="flex items-center gap-1">
            reconnecting
            {#if reconnectCountdown > 0}
              <span class="tabular-nums ml-0.5">({reconnectCountdown}s)</span>
            {/if}
          </span>
        </div>
      {/if}

      {#if trustPromptVisible && projectTrust}
        <div
          class="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs bg-warning/10 text-warning/85 border-b border-warning/15"
          role="status"
          aria-live="polite"
        >
          <ShieldQuestion class="w-3.5 h-3.5 shrink-0" />
          <span class="flex-1 min-w-0 truncate">
            Project resources in
            <span class="font-mono text-warning/70">{projectTrust?.cwd}</span>
            aren't trusted
          </span>
          <button
            class="shrink-0 px-2 py-0.5 rounded-md font-semibold text-warning/90 hover:text-warning hover:bg-warning/15 transition-colors"
            onclick={() =>
              send({
                type: 'set_project_trust',
                cwd: projectTrust?.cwd ?? '',
                decision: 'trusted',
              })}>Trust project</button
          >
          <button
            class="shrink-0 px-2 py-0.5 rounded-md font-semibold text-warning/90 hover:text-warning hover:bg-warning/15 transition-colors"
            onclick={() =>
              send({
                type: 'set_project_trust',
                cwd: projectTrust?.cwd ?? '',
                decision: 'session',
              })}>Trust this session</button
          >
        </div>
      {/if}

      {#if showNotifNudge}
        <div
          class="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs bg-primary/[0.08] text-base-content/80 border-b border-primary/15"
          role="status"
        >
          <Bell class="w-3.5 h-3.5 shrink-0 text-primary/80" />
          <span class="flex-1 min-w-0 truncate"
            >Get a notification when pi finishes — even with the app closed.</span
          >
          <button
            class="shrink-0 px-2 py-0.5 rounded-md font-semibold text-primary hover:text-primary/90 hover:bg-primary/12 transition-colors"
            onclick={enableNotifications}>Enable</button
          >
          <button
            class="shrink-0 px-2 py-0.5 rounded-md text-base-content/50 hover:text-base-content/80 hover:bg-base-content/8 transition-colors"
            onclick={dismissNotifNudge}
            aria-label="Dismiss notification prompt"><X class="w-3 h-3" /></button
          >
        </div>
      {/if}
      <!-- Extension header -->
      {#if extensionUiState.header}
        <div
          class="shrink-0 min-w-0 px-3 py-1.5 text-xs text-base-content/60 bg-base-200/50 border-b border-base-content/10 font-mono whitespace-pre-wrap flex items-start gap-2"
        >
          <span class="min-w-0 flex-1 break-words">{extensionUiState.header}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            onclick={() => {
              extensionUiState.setHeader(undefined);
            }}
            aria-label="Dismiss header"><X class="w-3 h-3" /></Button
          >
        </div>
      {/if}

      <!-- Message list -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <main
        id="main-content"
        bind:this={scrollEl}
        onscroll={handleScroll}
        onclick={handleMessageAreaClick}
        onkeydown={handleCodeCopy}
        role="region"
        aria-label="Conversation"
        aria-busy={sessionLoading}
        class="flex-1 overflow-y-auto overflow-x-hidden scroll-container-mobile pb-3 sm:pb-4 bg-base-100 rounded-none sm:rounded-xl"
        style="overflow-anchor: none; overscroll-behavior: contain;"
      >
        <MessageList
          {messages}
          {sessionLoading}
          {wsState}
          {sessionId}
          {isMobile}
          {copiedId}
          {copiedTurnId}
          {isStreaming}
          {expandedUserMsgs}
          bind:truncatedUserMsgs
          workingVisible={extensionUiState.workingVisible}
          hiddenThinkingLabel={extensionUiState.hiddenThinkingLabel}
          workingIndicatorFrames={extensionUiState.workingIndicatorFrames}
          {workingFrameIndex}
          workingMessage={extensionUiState.workingMessage}
          {messagesTruncated}
          {totalRawMessagesLoaded}
          {totalMessageCount}
          {projectPickerOpen}
          {activeProjectName}
          onLoadOlder={loadOlderMessages}
          onCopyMessage={copyMessage}
          onCopyTurn={copyTurnMessages}
          onExpandUserMsg={(msgId, val) => {
            expandedUserMsgs[msgId] = val;
          }}
          onToggleThinking={(msg) => {
            msg.thinkingExpanded = !msg.thinkingExpanded;
          }}
          onToggleTool={(msg) => {
            const expanding = !msg.expanded;
            msg.expanded = expanding;
            if (
              expanding &&
              msg.outputElided &&
              !msg.content &&
              !msg.outputLoading &&
              msg.toolCallId
            ) {
              msg.outputLoading = true;
              if (!send({ type: 'get_tool_output', toolCallId: msg.toolCallId })) {
                msg.outputLoading = false;
                showChatNotice('Unable to load tool output while disconnected.', 'warning');
              }
            }
          }}
          onProjectPickerToggle={(e) => {
            e.stopPropagation();
            projectPickerOpen = !projectPickerOpen;
          }}
          onProjectPickerClose={() => (projectPickerOpen = false)}
          onInsertShortcut={(text) => {
            input = text;
            tick().then(() => inputEl?.focus());
          }}
          onEditMessage={editMessage}
          onDismissNotice={dismissChatNotice}
          onHaptic={haptic}
        />
      </main>

      <!-- Extension footer -->
      {#if visibleExtensionFooter}
        <div
          class="shrink-0 min-w-0 px-3 py-1.5 text-xs text-base-content/60 bg-base-200/50 border-t border-base-content/10 font-mono whitespace-pre-wrap flex items-start gap-2"
        >
          <span class="min-w-0 flex-1 break-words">{visibleExtensionFooter}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            onclick={() => {
              extensionUiState.setFooter(undefined);
            }}
            aria-label="Dismiss footer"><X class="w-3 h-3" /></Button
          >
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
          ><svg
            class="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M12 5v14m0 0-7-7m7 7 7-7"></path></svg
          >
        </button>
      </div>

      <!-- Input bar — elevated surface to distinguish from chat -->
      <footer
        class="shrink-0 bg-transparent pt-1.5 md:pt-3"
        style="padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0px));"
      >
        <div
          class="w-full max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl mx-auto px-2.5 sm:px-3 md:px-6"
        >
          {#if queuedSteering.length > 0 || queuedFollowUp.length > 0}
            <div class="flex flex-wrap gap-1.5 mb-2 px-1">
              {#each queuedSteering as m (m)}
                <span
                  class="inline-flex items-center gap-1 text-xs text-base-content/40 bg-base-content/6 px-2 py-1 rounded-lg max-w-[16rem] truncate"
                  title="Queued steer: {m}"
                >
                  <svg
                    class="w-2.5 h-2.5 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"></path></svg
                  >
                  <span class="truncate">{m}</span>
                </span>
              {/each}
              {#each queuedFollowUp as m (m)}
                <span
                  class="inline-flex items-center gap-1 text-xs text-base-content/35 bg-base-content/5 px-2 py-1 rounded-lg max-w-[16rem] truncate"
                  title="Queued follow-up: {m}"
                >
                  <svg
                    class="w-2.5 h-2.5 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                  </svg>

                  <span class="truncate">{m}</span>
                </span>
              {/each}
            </div>
          {/if}

          <!-- Extension editor component panel -->
          {#if extensionUiState.editorComponentPanel}
            <div
              class="mb-2 bg-base-content/5 rounded-xl px-3 py-2 text-xs text-base-content/60 flex items-start gap-2"
            >
              <span class="flex-1">
                <ExtensionComponent component={extensionUiState.editorComponentPanel} />
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onclick={() => {
                  extensionUiState.setEditorComponent(null);
                }}
                aria-label="Dismiss editor panel"><X class="w-3 h-3" /></Button
              >
            </div>
          {/if}

          <!-- Extension widget panels -->
          {#snippet extensionWidgetPanel(key: string, widget: WidgetContent)}
            <div class="group relative">
              <button
                onclick={() => extensionUiState.dismissWidget(key)}
                class="touch-reveal absolute -top-1 -right-1 w-4 h-4 bg-base-content/20 hover:bg-base-content/40 rounded-full flex items-center justify-center text-[9px] leading-none transition-opacity z-10 {isMobile
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100'}"
                aria-label="Dismiss widget"><X class="w-2.5 h-2.5" /></button
              >
              {#if widget.type === 'text'}
                <div
                  class="bg-base-content/5 rounded-xl px-3 py-2 text-xs text-base-content/70 font-mono whitespace-pre overflow-x-auto leading-relaxed"
                >
                  {#if widget.htmlLines}{#each widget.htmlLines as line, i (i)}<div>
                        {@html line || '&nbsp;'}
                      </div>{/each}{:else}{widget.lines.join('\n')}{/if}
                </div>
              {:else if widget.type === 'table'}
                <div
                  class="bg-base-content/5 rounded-xl px-3 py-2 text-xs text-base-content/70 font-mono overflow-x-auto"
                >
                  <table class="w-full border-collapse">
                    {#if widget.headers.length > 0}
                      <thead>
                        <tr class="border-b border-base-content/10">
                          {#each widget.headers as header (header)}
                            <th class="text-left px-2 py-1 text-base-content/60 font-semibold"
                              >{header}</th
                            >
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
                  <span
                    class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium
                {widget.variant === 'success'
                      ? 'bg-success/15 text-success'
                      : widget.variant === 'error'
                        ? 'bg-error/15 text-error'
                        : widget.variant === 'warning'
                          ? 'bg-warning/15 text-warning'
                          : 'bg-info/15 text-info'}">{widget.text}</span
                  >
                </div>
              {:else if widget.type === 'component'}
                <div class="bg-base-content/5 rounded-xl px-3 py-2">
                  <ExtensionComponent component={widget.component} />
                </div>
              {/if}
            </div>
          {/snippet}

          {#if aboveEditorWidgets.length > 0}
            <div class="mb-2 flex flex-col gap-1">
              {#each aboveEditorWidgets as [key, widget] (key)}
                {@render extensionWidgetPanel(key, widget)}
              {/each}
            </div>
          {/if}

          <!-- Slash command dropdown + input box wrapper -->
          <div class="relative">
            {#if showSlashMenu && filteredSlashCommands.length > 0}
              <div class="absolute bottom-full left-0 right-0 mb-2 z-10">
                <div
                  class="overflow-hidden rounded-[1.35rem] border border-base-content/10 bg-base-200/96 shadow-2xl shadow-black/35 backdrop-blur-xl"
                  role="listbox"
                  aria-label="Composer shortcuts"
                >
                  <div
                    class="flex items-center justify-between gap-3 border-b border-base-content/8 px-3 py-2"
                  >
                    <span class="text-[10px] uppercase tracking-[0.18em] text-base-content/35">
                      {commandArgMode
                        ? `/${commandArgMode.command} subcommands`
                        : shortcutTrigger === '/'
                          ? 'slash commands'
                          : shortcutTrigger === '@'
                            ? 'references'
                            : shortcutTrigger === '!'
                              ? 'shell shortcuts'
                              : 'prompt shortcuts'}
                    </span>
                    <span class="hidden sm:inline text-[10px] text-base-content/25"
                      >↑↓ select · Enter insert</span
                    >
                  </div>
                  <div class="max-h-[min(18rem,45dvh)] overflow-y-auto p-1.5">
                    {#each filteredSlashCommands as cmd, i (cmd.label ?? i)}
                      {#if cmd.section && (i === 0 || cmd.section !== filteredSlashCommands[i - 1]?.section)}
                        <div class="px-3 pt-2 pb-1">
                          <span
                            class="text-[10px] font-semibold text-base-content/35 uppercase tracking-wider"
                          >
                            {cmd.section}
                          </span>
                        </div>
                      {/if}
                      <button
                        onclick={() => selectSlashCommand(cmd)}
                        role="option"
                        aria-selected={slashMenuIndex === i}
                        disabled={cmd.disabled}
                        class="w-full rounded-xl px-3 py-2.5 text-left transition-colors flex items-start gap-3 disabled:cursor-default {slashMenuIndex ===
                          i && !cmd.disabled
                          ? 'bg-primary/10 text-base-content'
                          : cmd.disabled
                            ? 'text-base-content/35'
                            : 'hover:bg-base-content/8 text-base-content/72 hover:text-base-content'}"
                      >
                        <span
                          class="mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-lg bg-base-content/7 px-1.5 text-xs font-mono {cmd.trigger ===
                          '!'
                            ? 'text-warning/75'
                            : cmd.trigger === '@'
                              ? 'text-info/75'
                              : 'text-primary/75'}">{cmd.trigger}</span
                        >
                        <span class="min-w-0 flex-1">
                          <span
                            class="block whitespace-normal break-words [overflow-wrap:anywhere] text-sm font-mono {cmd.muted
                              ? 'text-base-content/55'
                              : ''}">{cmd.label}</span
                          >
                          {#if cmd.description}
                            <span
                              class="block whitespace-normal break-words [overflow-wrap:anywhere] text-xs text-base-content/38"
                              >{cmd.description}</span
                            >
                          {/if}
                        </span>
                      </button>
                    {/each}
                  </div>
                </div>
              </div>
            {/if}

            <div
              class="composer rounded-[1.25rem] sm:rounded-2xl px-2.5 sm:px-3 py-2 sm:py-2.5 flex flex-col gap-2 sm:gap-2.5"
            >
              {#if attachedImages.length > 0 || attachedFiles.length > 0}
                <div class="flex gap-2 flex-wrap pt-1">
                  {#each attachedImages as img, i (img.src)}
                    <div class="relative group/thumb">
                      <img
                        src={img.src}
                        alt={img.name}
                        class="h-16 w-16 object-cover rounded-lg bg-base-content/5"
                      />
                      <button
                        onclick={() => removeAttachment(i)}
                        class="touch-reveal absolute -top-1.5 -right-1.5 w-5 h-5 bg-base-content text-base-100 rounded-full flex items-center justify-center text-xs leading-none transition-opacity {isMobile
                          ? 'opacity-100'
                          : 'opacity-0 group-hover/thumb:opacity-100'}"
                        aria-label="Remove {img.name}"><X class="w-3 h-3" /></button
                      >
                    </div>
                  {/each}
                  {#each attachedFiles as f, i (f.name)}
                    <div class="relative group/thumb">
                      <div
                        class="h-16 w-16 flex flex-col items-center justify-center rounded-lg bg-base-content/10 text-center p-1"
                      >
                        <svg
                          class="w-5 h-5 text-base-content/40 mb-0.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path
                            d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"
                          ></path>
                          <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                        <span
                          class="text-[10px] text-base-content/40 leading-tight truncate max-w-full"
                          >{f.name}</span
                        >
                      </div>
                      <button
                        onclick={() => removeFileAttachment(i)}
                        class="touch-reveal absolute -top-1.5 -right-1.5 w-5 h-5 bg-base-content text-base-100 rounded-full flex items-center justify-center text-xs leading-none transition-opacity {isMobile
                          ? 'opacity-100'
                          : 'opacity-0 group-hover/thumb:opacity-100'}"
                        aria-label="Remove {f.name}"><X class="w-3 h-3" /></button
                      >
                    </div>
                  {/each}
                </div>
              {/if}
              <textarea
                bind:this={inputEl}
                bind:value={input}
                onkeydown={handleComposerKeydown}
                oninput={handleComposerInput}
                onpaste={handleComposerPaste}
                rows={1}
                placeholder={sessionLoading
                  ? 'Opening session…'
                  : wsState === 'closed'
                    ? 'Disconnected'
                    : wsState === 'connecting'
                      ? 'Reconnecting…'
                      : isStreaming
                        ? 'Steer pi…'
                        : isMobile
                          ? 'Message pi…'
                          : 'Message pi — @ files · / commands · ! shell'}
                aria-label="Message to pi"
                disabled={wsState !== 'open'}
                class="w-full min-h-10 sm:min-h-12 mt-0 sm:mt-1 bg-transparent resize-none outline-none placeholder-base-content/45 disabled:opacity-40 leading-relaxed max-h-40 sm:max-h-48 overflow-y-auto transition-opacity text-base"
                autocapitalize="off"
                spellcheck={false}
                use:autoCorrectOff
                style="field-sizing: content"></textarea>

              {#if isStreaming}
                <div class="flex items-center justify-end gap-1">
                  {#if input.trim()}
                    <Tooltip.Root>
                      <Tooltip.Trigger>
                        {#snippet child({ props })}
                          <button
                            {...props}
                            onclick={() => submitMessage()}
                            class="w-9 h-9 flex items-center justify-center text-warning/80 hover:text-warning hover:bg-warning/10 rounded-full transition-colors"
                            aria-label="Steer pi"
                            ><svg
                              class="w-4 h-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"></path></svg
                            >
                          </button>
                        {/snippet}
                      </Tooltip.Trigger>
                      <Tooltip.Content>Steer after the current turn (Enter)</Tooltip.Content>
                    </Tooltip.Root>
                  {/if}
                  <Tooltip.Root>
                    <Tooltip.Trigger>
                      {#snippet child({ props })}
                        <button
                          {...props}
                          onclick={abortGeneration}
                          class="w-9 h-9 flex items-center justify-center text-base-content/60 hover:text-base-content/90 hover:bg-base-content/8 rounded-full transition-colors"
                          aria-label="Abort generation"
                        >
                          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"
                            ><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg
                          >
                        </button>
                      {/snippet}
                    </Tooltip.Trigger>
                    <Tooltip.Content>Abort</Tooltip.Content>
                  </Tooltip.Root>
                </div>
              {:else}
                <div class="flex items-center gap-1 min-w-0">
                  <Tooltip.Root>
                    <Tooltip.Trigger>
                      {#snippet child({ props })}
                        <button
                          {...props}
                          onclick={() => fileInputEl?.click()}
                          disabled={wsState !== 'open' || sessionLoading}
                          class="w-10 h-10 sm:w-8 sm:h-8 flex items-center justify-center text-base-content/45 hover:text-base-content/70 hover:bg-base-content/8 rounded-full transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default"
                          aria-label="Attach file"
                          ><svg
                            class="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            ><path
                              d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
                            ></path>
                          </svg>
                        </button>
                      {/snippet}
                    </Tooltip.Trigger>
                    <Tooltip.Content>Attach file</Tooltip.Content>
                  </Tooltip.Root>
                  {#if isCompacting}
                    <span
                      class="hidden md:flex items-center gap-1.5 min-w-0 max-w-40 text-warning/70"
                      role="status"
                      aria-live="polite"
                      aria-label="Compaction in progress"
                    >
                      <svg
                        class="w-3.5 h-3.5 shrink-0 animate-spin"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.5"
                        stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg
                      >
                      <span class="truncate text-[10px]">compacting ·</span>
                      <LiveElapsed
                        startMs={compactionStartedAt ?? undefined}
                        active={isCompacting}
                        format="duration"
                        className="shrink-0 text-[10px] tabular-nums"
                      />
                    </span>
                  {:else}
                    <Tooltip.Root>
                      <Tooltip.Trigger>
                        {#snippet child({ props })}
                          <button
                            {...props}
                            onclick={compactSession}
                            disabled={wsState !== 'open' || sessionLoading}
                            class="hidden md:flex w-8 h-8 items-center justify-center text-base-content/35 hover:text-base-content/60 hover:bg-base-content/8 rounded-full transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default"
                            aria-label="Compact context"
                            ><svg
                              class="w-4 h-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <polyline points="21 8 21 21 3 21 3 8"></polyline>
                              <rect x="1" y="3" width="22" height="5"></rect>
                              <line x1="10" y1="12" x2="14" y2="12"></line>
                            </svg>
                          </button>
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
                          disabled={wsState !== 'open' || sessionLoading}
                          class="{conversationMode
                            ? 'flex'
                            : 'hidden md:flex'} w-10 h-10 sm:w-8 sm:h-8 items-center justify-center rounded-full transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default {conversationMode
                            ? 'text-primary bg-primary/12'
                            : 'text-base-content/35 hover:text-base-content/60 hover:bg-base-content/8'}"
                          aria-label={conversationMode
                            ? 'Exit conversation mode'
                            : 'Enter conversation mode'}
                          role="switch"
                          aria-checked={conversationMode}
                          ><svg
                            class="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>

                            <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"
                            ></path>

                            <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"
                            ></path>
                          </svg>
                        </button>
                      {/snippet}
                    </Tooltip.Trigger>
                    <Tooltip.Content
                      >{conversationMode
                        ? 'Exit conversation mode'
                        : 'Enter conversation mode (voice loop)'}</Tooltip.Content
                    >
                  </Tooltip.Root>
                  <Tooltip.Root>
                    <Tooltip.Trigger>
                      {#snippet child({ props })}
                        <button
                          {...props}
                          onclick={toggleSTT}
                          disabled={wsState !== 'open' || sessionLoading}
                          class="w-10 h-10 sm:w-8 sm:h-8 flex items-center justify-center rounded-full transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default {isRecording
                            ? 'text-error bg-error/10 animate-pulse'
                            : 'text-base-content/35 hover:text-base-content/60 hover:bg-base-content/8'}"
                          aria-label={isRecording ? 'Stop recording' : 'Record voice input'}
                          ><svg
                            class="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path>

                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                            <line x1="12" y1="19" x2="12" y2="22"></line>
                          </svg>
                        </button>
                      {/snippet}
                    </Tooltip.Trigger>
                    <Tooltip.Content
                      >{isRecording ? 'Stop recording' : 'Record voice input'}</Tooltip.Content
                    >
                  </Tooltip.Root>
                  <span class="flex-1"></span>
                  <button
                    onclick={() => openTab('models')}
                    class="flex min-w-0 max-w-[12rem] md:max-w-[20rem] h-8 px-3 items-center gap-2 rounded-full text-xs font-medium bg-base-content/[0.045] border border-base-content/[0.07] text-base-content/65 hover:text-base-content/90 hover:border-base-content/15 hover:bg-base-content/[0.07] transition-colors"
                    aria-label="Select model"
                    aria-expanded={showRightPanel && rightPanelTab === 'models'}
                  >
                    {#if model?.provider}
                      <span
                        class="w-1.5 h-1.5 rounded-full shrink-0"
                        style="background:{providerColor(model.provider)}"
                      ></span>
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
                          disabled={(!input.trim() &&
                            attachedImages.length === 0 &&
                            attachedFiles.length === 0) ||
                            wsState !== 'open' ||
                            sessionLoading}
                          class="relative w-10 h-10 sm:w-8 sm:h-8 flex items-center justify-center rounded-full transition-all duration-200 shrink-0 {(input.trim() ||
                            attachedImages.length > 0 ||
                            attachedFiles.length > 0) &&
                          wsState === 'open' &&
                          !sessionLoading
                            ? 'bg-primary text-primary-content hover:brightness-110 shadow-[0_0_16px_-4px_color-mix(in_oklch,var(--color-primary)_60%,transparent)]'
                            : 'text-base-content/25'} disabled:cursor-default"
                          aria-label="Send message"
                        >
                          {#if canSubmitFollowUp()}
                            <svg
                              class="absolute inset-0 w-full h-full -rotate-90 pointer-events-none"
                              viewBox="0 0 36 36"
                              aria-hidden="true"
                            >
                              <circle
                                cx="18"
                                cy="18"
                                r="16"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2.5"
                                class="text-primary-content/70"
                                pathLength="100"
                                style="stroke-dasharray:100; stroke-dashoffset:{sendHolding
                                  ? 0
                                  : 100}; transition: stroke-dashoffset {sendHolding
                                  ? '550ms linear'
                                  : '150ms ease-out'};"
                              ></circle>
                            </svg>
                          {/if}
                          <svg
                            class="w-4 h-4 relative"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"><path d="M12 19V5m0 0-7 7m7-7 7 7"></path></svg
                          >
                        </button>
                      {/snippet}
                    </Tooltip.Trigger>
                    <Tooltip.Content
                      >{canSubmitFollowUp()
                        ? 'Send (Enter). Hold for follow-up.'
                        : 'Send (Enter)'}</Tooltip.Content
                    >
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
          </div>
          <!-- end .relative slash/input wrapper -->

          {#if belowEditorWidgets.length > 0}
            <div class="mt-2 flex flex-col gap-1">
              {#each belowEditorWidgets as [key, widget] (key)}
                {@render extensionWidgetPanel(key, widget)}
              {/each}
            </div>
          {/if}

          {#if visibleExtensionStatuses.length > 0 || effectiveContextTokens > 0 || sessionCostTotal > 0}
            <div class="flex mt-1.5 px-1 items-center gap-2 text-xs select-none min-w-0">
              {#if visibleExtensionStatuses.length > 0}
                <Tooltip.Root>
                  <Tooltip.Trigger
                    class="min-w-0 truncate cursor-help text-left text-base-content/50 transition-colors hover:text-base-content/75"
                    aria-label="Extension statuses"
                    >{visibleExtensionStatuses
                      .map((entry) => entry[1])
                      .join(' · ')}</Tooltip.Trigger
                  >

                  <Tooltip.Content sideOffset={6} class="max-w-[min(22rem,calc(100vw-2rem))]">
                    <div class="flex min-w-[12rem] flex-col gap-1.5">
                      <p class="text-[10px] uppercase tracking-[0.16em] text-background/50">
                        Extension status
                      </p>
                      {#each visibleExtensionStatuses as [key, value] (key)}
                        <div class="flex items-start justify-between gap-4 text-xs">
                          <span class="shrink-0 text-background/55">{key}</span>
                          <span class="min-w-0 text-right font-mono text-background/90"
                            >{value}</span
                          >
                        </div>
                      {/each}
                    </div>
                  </Tooltip.Content>
                </Tooltip.Root>
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
                          : 'text-base-content/40',
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
                        {effectiveContextTokens.toLocaleString()} / {(
                          (contextUsageWindow > 0 ? contextUsageWindow : null) ??
                          model?.contextWindow ??
                          0
                        ).toLocaleString()} tokens
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
          {#if contextPercent > 0}
            <div class="h-0.5 mx-1 mt-1 rounded-full bg-base-content/8 overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500 ease-out {contextPercent >=
                75
                  ? 'bg-error/60'
                  : contextPercent >= 50
                    ? 'bg-warning/60'
                    : 'bg-primary/50'}"
                style="width: {Math.min(contextPercent, 100)}%"
              ></div>
            </div>
          {/if}
        </div>
      </footer>
    </div>

    <!-- ── RIGHT SIDEBAR: Unified panel (models / tools / skills) ─────────── -->

    <RightPanel
      open={showRightPanel}
      {isMobile}
      width={rightPanelWidth}
      resizing={rightResizing}
      tab={rightPanelTab}
      {modelTab}
      {model}
      {availableModels}
      {modelRefreshLoading}
      {modelRefreshFeedback}
      {toolsList}
      {activeToolNames}
      {resourcesLoaded}
      {thinkingLevel}
      {availableThinkingLevels}
      {providers}
      bind:providerError
      bind:providerKeyInputs
      bind:providerFilter
      bind:modelFilter
      bind:toolFilter
      bind:skillFilter
      {filteredProviders}
      {configuredProviderCount}
      {filteredModelsByProvider}
      {filteredTools}
      {filteredSkills}
      bind:skillInstallUrl
      bind:skillInstallScope
      {skillInstalling}
      bind:skillInstallFeedback
      onClose={() => (showRightPanel = false)}
      onResizeStart={startRightResize}
      onResizeMove={onRightResizeMove}
      onResizeStop={() => stopRightResize()}
      onTabChange={(t) => {
        rightPanelTab = t;
      }}
      onSelectModel={(m) => {
        send({ type: 'set_model', provider: m.provider, modelId: m.id });
        showRightPanel = false;
      }}
      onPickThinkingLevel={(lvl) => {
        thinkingLevel = lvl;
        send({ type: 'set_thinking_level', level: lvl });
      }}
      onToggleTool={(name) => {
        const next = activeToolNames.includes(name)
          ? activeToolNames.filter((n) => n !== name)
          : [...activeToolNames, name];
        activeToolNames = next;
        send({ type: 'set_active_tools', toolNames: next });
      }}
      onSetProviderKey={(id) => {
        const key = (providerKeyInputs[id] ?? '').trim();
        if (!key) return;
        if (send({ type: 'set_provider_key', provider: id, key })) {
          providerKeyInputs[id] = '';
        }
      }}
      onRemoveProviderKey={(id) =>
        requestConfirm(
          `Remove API key for ${id}?`,
          () => send({ type: 'remove_provider_key', provider: id }),
          { title: 'Remove API key', confirmLabel: 'Remove', variant: 'error' }
        )}
      onSetActiveTools={(names) => {
        activeToolNames = names;
        send({ type: 'set_active_tools', toolNames: names });
      }}
      onInstallSkill={(url, scope) => {
        skillInstalling = true;
        skillInstallFeedback = null;
        send({ type: 'install_skill', url, scope });
      }}
      onUseSkill={(name) => {
        input = `/skill:${name} `;
        showRightPanel = false;
        tick().then(() => inputEl?.focus());
      }}
      onDismissProviderError={() => (providerError = null)}
      onRefreshModels={requestModelRefresh}
    />

    <!-- ── MODAL: Settings ───────────────────────────────────────────────────── -->

    <Dialog.Root bind:open={showSettingsPanel}>
      <Dialog.Content
        class="p-0 overflow-hidden max-w-[calc(100vw-1rem)] sm:max-w-[min(68rem,calc(100vw-2rem))] h-[fit-content(calc(100dvh-2rem))] sm:h-[min(44rem,calc(100dvh-2rem))] bg-base-200 text-base-content border border-base-content/10 shadow-2xl shadow-black/40"
        showCloseButton={false}
      >
        <div class="flex h-full min-h-0">
          <aside
            class="hidden sm:flex w-60 shrink-0 flex-col border-r border-base-content/10 bg-base-300/70"
          >
            <div class="px-5 py-4 border-b border-base-content/8">
              <p class="text-sm font-semibold text-base-content/80">Settings</p>
              <p class="text-xs text-base-content/35 mt-0.5">pi-ui preferences</p>
            </div>
            <nav class="flex-1 p-2 space-y-1">
              {#each SETTINGS_SECTIONS as section (section.id)}
                <button
                  onclick={() => (settingsSection = section.id)}
                  class="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors {settingsSection ===
                  section.id
                    ? 'bg-base-content/10 text-base-content'
                    : 'text-base-content/62 hover:text-base-content/85 hover:bg-base-content/[0.055]'}"
                >
                  <span class="w-5 flex items-center justify-center text-base-content/45"
                    ><section.icon class="w-4 h-4" /></span
                  >
                  <span>{section.label}</span>
                </button>
              {/each}
            </nav>
            <div class="px-5 py-3 border-t border-base-content/8 space-y-1.5">
              <a
                href={resolve('logout')}
                class="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-base-content/45 hover:text-base-content/85 hover:bg-base-content/[0.055] transition-colors"
              >
                Sign out
              </a>
              <div class="text-[10px] text-base-content/32 font-mono">
                {uiVersion ? `pi-ui v${uiVersion}` : 'pi-ui'}
              </div>
            </div>
          </aside>

          <div
            class="flex-1 min-w-0 min-h-0 flex flex-col bg-[radial-gradient(circle_at_30%_25%,color-mix(in_oklch,var(--color-primary)_8%,transparent),transparent_35%),var(--color-base-200)]"
          >
            <header
              class="shrink-0 flex flex-col gap-1.5 px-4 sm:px-6 py-3 sm:py-4 border-b border-base-content/10"
            >
              <div class="flex items-center gap-3">
                <Select.Root
                  type="single"
                  value={settingsSection}
                  onValueChange={(v: string) => {
                    if (v) settingsSection = v as typeof settingsSection;
                  }}
                >
                  <Select.Trigger size="sm" class="sm:hidden w-40 text-xs">
                    {SETTINGS_SECTIONS.find((s) => s.id === settingsSection)?.label ?? 'Settings'}
                  </Select.Trigger>
                  <Select.Content>
                    {#each SETTINGS_SECTIONS as section (section.id)}
                      <Select.Item value={section.id}>{section.label}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
                <Dialog.Title
                  class="sr-only sm:not-sr-only sm:min-w-0 sm:flex-1 sm:truncate text-base font-semibold text-base-content/82"
                >
                  {SETTINGS_SECTIONS.find((s) => s.id === settingsSection)?.label ?? 'Settings'}
                </Dialog.Title>
                <span class="flex-1 sm:hidden"></span>
                <Button
                  variant="ghost"
                  size="icon"
                  class="shrink-0"
                  onclick={() => (showSettingsPanel = false)}
                  aria-label="Close settings"
                >
                  <svg
                    class="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg
                  >
                </Button>
              </div>
              <Dialog.Description class="text-xs text-base-content/45 sm:text-base-content/38">
                {#if settingsSection === 'session'}Defaults and behavior for session runs{:else if settingsSection === 'notifications'}Configure
                  PWA push and page notifications{:else if settingsSection === 'shortcuts'}Keyboard
                  shortcuts and touch gestures available in the chat UI{:else if settingsSection === 'extensions'}Loaded
                  extensions and their tools/commands{:else if settingsSection === 'packages'}Manage
                  SDK extension packages{:else if settingsSection === 'updates'}Check and apply
                  pi-ui or SDK updates{:else}Runtime information and server controls{/if}
              </Dialog.Description>
            </header>

            <ScrollArea class="flex-1 min-h-0">
              <div class="max-w-3xl px-4 sm:px-8 py-6 space-y-6">
                {#if settingsSection === 'session'}
                  <Card.Root
                    size="sm"
                    class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                  >
                    <div class="divide-y divide-base-content/8">
                      <div class="flex items-center gap-3 px-4 py-3">
                        <div class="flex-1 min-w-0">
                          <p class="text-sm text-base-content/75">Auto-compact</p>
                          <p class="text-xs text-base-content/35 mt-0.5">
                            Let pi compress context before it gets too large.
                          </p>
                        </div>
                        <Switch
                          checked={autoCompactionEnabled}
                          onCheckedChange={(v) => {
                            autoCompactionEnabled = v;
                            try {
                              localStorage.setItem(
                                'pifrontier:autoCompactionEnabled',
                                JSON.stringify(v)
                              );
                            } catch {
                              /* noop */
                            }
                            send({ type: 'set_auto_compaction', enabled: v });
                          }}
                          disabled={wsState !== 'open'}
                          aria-label="Toggle auto-compaction"
                        />
                      </div>
                      <div class="flex items-center gap-3 px-4 py-3">
                        <div class="flex-1 min-w-0">
                          <p class="text-sm text-base-content/75">Auto-retry</p>
                          <p class="text-xs text-base-content/35 mt-0.5">
                            Retry transient model errors automatically.
                          </p>
                        </div>
                        <Switch
                          checked={autoRetryEnabled}
                          onCheckedChange={(v) => {
                            autoRetryEnabled = v;
                            try {
                              localStorage.setItem(
                                'pifrontier:autoRetryEnabled',
                                JSON.stringify(v)
                              );
                            } catch {
                              /* noop */
                            }
                            send({ type: 'set_auto_retry', enabled: v });
                          }}
                          disabled={wsState !== 'open'}
                          aria-label="Toggle auto-retry"
                        />
                      </div>
                    </div>
                  </Card.Root>
                  <Card.Root
                    size="sm"
                    class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                  >
                    <div class="px-4 py-3 space-y-3">
                      <div>
                        <p class="text-sm text-base-content/75">Project trust</p>
                        <p class="text-xs text-base-content/35 mt-0.5">
                          Project extensions, skills, prompts, and packages load only when trusted.
                        </p>
                      </div>
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-xs font-mono text-base-content/55"
                          >{projectTrust?.decision ?? 'ask'}</span
                        >
                        {#each [['trusted', 'Trust project'], ['denied', 'Block project'], ['ask', 'Ask next time']] as [decision, label] (decision)}
                          <Button
                            size="sm"
                            variant={projectTrust?.decision === decision ? 'default' : 'outline'}
                            disabled={wsState !== 'open'}
                            onclick={() =>
                              send({
                                type: 'set_project_trust',
                                cwd: projectTrust?.cwd ?? cwd,
                                decision: decision as 'trusted' | 'denied' | 'ask',
                              })}>{label}</Button
                          >
                        {/each}
                      </div>
                    </div>
                  </Card.Root>
                  {#if runtimeDiagnostics.length > 0}
                    <Card.Root
                      size="sm"
                      class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                    >
                      <div class="px-4 py-3">
                        <p class="text-sm text-base-content/75">Runtime diagnostics</p>
                        <div class="mt-2 space-y-1.5">
                          {#each runtimeDiagnostics as diagnostic (diagnostic.message)}
                            {@const isLong = diagnostic.message.length > 120}
                            {@const isExpanded = expandedDiagnostics[diagnostic.message]}
                            <div
                              class="text-xs {diagnostic.type === 'error'
                                ? 'text-error/75'
                                : diagnostic.type === 'warning'
                                  ? 'text-warning/75'
                                  : 'text-base-content/50'}"
                            >
                              <p class="break-words {isLong && !isExpanded ? 'line-clamp-2' : ''}">
                                {diagnostic.message}
                              </p>
                              {#if isLong}
                                <button
                                  onclick={() =>
                                    (expandedDiagnostics[diagnostic.message] = !isExpanded)}
                                  class="mt-0.5 text-[10px] text-base-content/40 hover:text-base-content/70 transition-colors"
                                >
                                  {isExpanded ? '▾ less' : '▸ more'}
                                </button>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      </div>
                    </Card.Root>
                  {/if}
                {:else if settingsSection === 'notifications'}
                  <Card.Root
                    size="sm"
                    class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                  >
                    <div class="divide-y divide-base-content/8">
                      <div class="flex items-center gap-3 px-4 py-3">
                        <div class="flex-1 min-w-0">
                          <p class="text-sm text-base-content/75">Notifications</p>
                          <p class="text-xs text-base-content/35 mt-0.5">
                            Global toggle for all push and page notifications.
                          </p>
                        </div>
                        <Switch
                          checked={notificationPrefs.enabled}
                          onCheckedChange={(v) => {
                            notificationPrefs.enabled = v;
                            if (
                              v &&
                              'Notification' in window &&
                              Notification.permission === 'default'
                            )
                              Notification.requestPermission();
                          }}
                          aria-label="Toggle all notifications"
                        />
                      </div>
                      <div
                        class="flex items-center gap-3 px-4 py-3 {notificationPrefs.enabled
                          ? ''
                          : 'opacity-40 pointer-events-none'}"
                      >
                        <div class="flex-1 min-w-0">
                          <p class="text-sm text-base-content/75">Response Complete</p>
                          <p class="text-xs text-base-content/35 mt-0.5">
                            Notify when the active session's agent finishes responding.
                          </p>
                        </div>
                        <Switch
                          checked={notificationPrefs.onComplete}
                          onCheckedChange={(v) => {
                            notificationPrefs.onComplete = v;
                          }}
                          disabled={!notificationPrefs.enabled}
                          aria-label="Toggle response complete notification"
                        />
                      </div>
                    </div>
                  </Card.Root>

                  {#if notificationPrefs.enabled}
                    <Card.Root
                      size="sm"
                      class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                    >
                      <div class="divide-y divide-base-content/8">
                        <div class="flex items-center gap-3 px-4 py-3">
                          <div class="flex-1 min-w-0">
                            <p class="text-sm text-base-content/75">Phone Push</p>
                            <p class="text-xs text-base-content/35 mt-0.5">
                              Webhook URL for push notifications when the browser is closed
                              (ntfy.sh, Pushover, Gotify). Leave empty to disable.
                            </p>
                          </div>
                        </div>
                        <div class="px-4 py-3">
                          <input
                            type="url"
                            class="w-full rounded-lg border border-base-content/12 bg-base-200/50 px-3 py-2 text-sm text-base-content/80 placeholder:text-base-content/25 outline-none focus:border-primary/50 transition-colors"
                            placeholder="https://ntfy.sh/my-pi-topic"
                            value={notificationWebhookUrl}
                            onblur={(e) => {
                              const val = (e.target as HTMLInputElement).value.trim();
                              notificationWebhookUrl = val;
                              send({ type: 'set_notification_webhook_url', url: val });
                            }}
                            onkeydown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            }}
                          />
                        </div>
                      </div>
                    </Card.Root>
                  {/if}
                {:else if settingsSection === 'shortcuts'}
                  <Card.Root
                    size="sm"
                    class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                  >
                    <div class="divide-y divide-base-content/8">
                      {#each SHORTCUTS as shortcut (shortcut.keys)}
                        <div class="flex items-center gap-4 px-4 py-3">
                          <kbd
                            class="min-w-32 rounded-lg border border-base-content/12 bg-base-content/[0.055] px-2 py-1 text-xs text-base-content/60 font-mono"
                            >{shortcut.keys}</kbd
                          >
                          <span class="text-sm text-base-content/70">{shortcut.action}</span>
                        </div>
                      {/each}
                    </div>
                  </Card.Root>
                  <p
                    class="text-xs font-semibold text-base-content/50 uppercase tracking-wider mt-5 mb-2"
                  >
                    Touch gestures
                  </p>
                  <Card.Root
                    size="sm"
                    class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                  >
                    <div class="divide-y divide-base-content/8">
                      {#each GESTURES as gesture (gesture.gesture)}
                        <div class="flex items-center gap-4 px-4 py-3">
                          <span
                            class="min-w-32 rounded-lg border border-base-content/12 bg-base-content/[0.055] px-2 py-1 text-xs text-base-content/60"
                            >{gesture.gesture}</span
                          >
                          <span class="text-sm text-base-content/70">{gesture.action}</span>
                        </div>
                      {/each}
                    </div>
                  </Card.Root>
                {:else if settingsSection === 'extensions'}
                  {#if !extensionsLoaded}
                    <div class="space-y-3 animate-pulse">
                      {#each [0, 1] as i (i)}
                        <div
                          class="rounded-xl border border-base-content/10 p-4 space-y-2 bg-base-100/60"
                        >
                          <div class="h-4 bg-base-content/8 rounded w-{['1/3', '1/4'][i]}"></div>
                          <div class="h-3 bg-base-content/5 rounded w-{['2/3', '1/2'][i]}"></div>
                          <div class="h-3 bg-base-content/5 rounded w-1/4"></div>
                        </div>
                      {/each}
                    </div>
                  {:else if extensionsList.length === 0 && extensionErrors.length === 0}
                    <p class="text-sm text-base-content/45">No extensions loaded.</p>
                  {:else}
                    {#each ['user', 'project', 'temporary'] as scope (scope)}
                      {@const scoped = extensionsList.filter((e) => e.scope === scope)}
                      {#if scoped.length > 0}
                        {@const bySource = Object.groupBy(scoped, (e) => e.source)}
                        <div class="mb-5">
                          <p
                            class="text-xs font-semibold text-base-content/50 uppercase tracking-wider mb-2"
                          >
                            {scope}
                          </p>
                          <div class="space-y-2">
                            {#each Object.entries(bySource).filter((e): e is [string, ExtensionSummary[]] => !!e[1]) as [source, exts] (source)}
                              {@const allTools = exts.flatMap((e) => e.tools)}
                              {@const allCommands = exts.flatMap((e) => e.commands)}
                              {@const allFlags = [
                                ...new Map(
                                  exts
                                    .flatMap((e) => e.flags ?? [])
                                    .map((flag) => [flag.name, flag])
                                ).values(),
                              ]}
                              {@const allShortcuts = exts.flatMap((e) => e.shortcuts ?? [])}
                              <Card.Root
                                size="sm"
                                class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                              >
                                <div class="divide-y divide-base-content/8">
                                  <div class="px-4 py-3">
                                    <div class="flex items-center gap-2">
                                      <p class="text-sm font-medium text-base-content/80">
                                        {source}
                                      </p>
                                      {#if exts.length > 1}
                                        <span
                                          class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-base-content/10 text-base-content/45"
                                          >{exts.length} files</span
                                        >
                                      {/if}
                                      <span
                                        class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-base-content/10 text-base-content/45"
                                      >
                                        {scope === 'user'
                                          ? 'User'
                                          : scope === 'project'
                                            ? 'Project'
                                            : 'Temporary'}
                                      </span>
                                    </div>
                                    {#if exts.length === 1}
                                      <p
                                        class="mt-0.5 text-xs text-base-content/35 font-mono truncate"
                                        title={exts[0].path}
                                      >
                                        {exts[0].path}
                                      </p>
                                    {:else}
                                      <p class="mt-0.5 text-xs text-base-content/35">
                                        {exts.map((e) => e.path).join(', ')}
                                      </p>
                                    {/if}
                                  </div>
                                  {#if allTools.length > 0}
                                    <details class="group px-4 py-2">
                                      <summary
                                        class="cursor-pointer text-xs font-medium text-base-content/55 hover:text-base-content/75 transition-colors list-none flex items-center gap-1.5"
                                      >
                                        <ChevronRight
                                          class="w-3 h-3 transition-transform group-open:rotate-90"
                                        />
                                        Tools ({allTools.length})
                                      </summary>
                                      <div class="mt-1.5 ml-4 space-y-1">
                                        {#each allTools as tool (tool.name)}
                                          <div>
                                            <p class="text-xs text-base-content/70 font-mono">
                                              {tool.name}
                                            </p>
                                            {#if tool.description}
                                              <p
                                                class="text-[11px] text-base-content/40 leading-snug"
                                              >
                                                {tool.description}
                                              </p>
                                            {/if}
                                          </div>
                                        {/each}
                                      </div>
                                    </details>
                                  {/if}
                                  {#if allCommands.length > 0}
                                    <details class="group px-4 py-2">
                                      <summary
                                        class="cursor-pointer text-xs font-medium text-base-content/55 hover:text-base-content/75 transition-colors list-none flex items-center gap-1.5"
                                      >
                                        <ChevronRight
                                          class="w-3 h-3 transition-transform group-open:rotate-90"
                                        />
                                        Commands ({allCommands.length})
                                      </summary>
                                      <div class="mt-1.5 ml-4 space-y-1">
                                        {#each allCommands as cmd (cmd.name)}
                                          <div>
                                            <p class="text-xs text-base-content/70 font-mono">
                                              /{cmd.name}
                                            </p>
                                            {#if cmd.description}
                                              <p
                                                class="text-[11px] text-base-content/40 leading-snug"
                                              >
                                                {cmd.description}
                                              </p>
                                            {/if}
                                          </div>
                                        {/each}
                                      </div>
                                    </details>
                                  {/if}
                                  {#if allShortcuts.length > 0}
                                    <div class="px-4 py-2 space-y-1.5">
                                      <p class="text-[11px] font-medium text-base-content/45">
                                        Shortcuts
                                      </p>
                                      {#each allShortcuts as shortcut (shortcut.shortcut)}
                                        <button
                                          class="w-full flex items-center justify-between gap-3 text-left text-xs hover:text-primary transition-colors"
                                          onclick={() =>
                                            send({
                                              type: 'invoke_extension_shortcut',
                                              shortcut: shortcut.shortcut,
                                            })}
                                        >
                                          <span class="font-mono text-base-content/65"
                                            >{shortcut.shortcut}</span
                                          >
                                          <span class="text-base-content/40 truncate"
                                            >{shortcut.description ?? ''}</span
                                          >
                                        </button>
                                      {/each}
                                    </div>
                                  {/if}
                                  {#if allFlags.length > 0}
                                    <div class="px-4 py-2 space-y-2">
                                      {#each allFlags as flag (flag.name)}
                                        <div class="flex items-center gap-3">
                                          <div class="min-w-0 flex-1">
                                            <p class="text-xs font-mono text-base-content/65">
                                              {flag.name}
                                            </p>
                                            {#if flag.description}
                                              <p class="text-[11px] text-base-content/40">
                                                {flag.description}
                                              </p>
                                            {/if}
                                          </div>
                                          {#if flag.type === 'boolean'}
                                            <Switch
                                              checked={flag.value === true}
                                              onCheckedChange={(value) =>
                                                send({
                                                  type: 'set_extension_flag',
                                                  name: flag.name,
                                                  value,
                                                })}
                                              aria-label={`Toggle ${flag.name}`}
                                            />
                                          {:else}
                                            <input
                                              class="w-36 rounded border border-base-content/12 bg-base-200/50 px-2 py-1 text-xs font-mono"
                                              value={String(flag.value ?? flag.default ?? '')}
                                              onchange={(event) =>
                                                send({
                                                  type: 'set_extension_flag',
                                                  name: flag.name,
                                                  value: (event.currentTarget as HTMLInputElement)
                                                    .value,
                                                })}
                                            />
                                          {/if}
                                        </div>
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
                        <summary
                          class="cursor-pointer text-xs font-medium text-error/70 hover:text-error transition-colors list-none flex items-center gap-1.5"
                        >
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
                {:else if settingsSection === 'packages'}
                  <div class="space-y-4">
                    <Card.Root
                      size="sm"
                      class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                    >
                      <div class="px-4 py-3 space-y-3">
                        <div>
                          <p class="text-sm text-base-content/75">Configured packages</p>
                          <p class="text-xs text-base-content/35 mt-0.5">
                            Install or remove SDK extension packages.
                          </p>
                        </div>
                        <div class="flex flex-col sm:flex-row gap-2">
                          <input
                            class="min-w-0 flex-1 rounded-lg border border-base-content/12 bg-base-200/50 px-3 py-2 text-xs font-mono outline-none focus:border-primary/50"
                            placeholder="npm package or git URL"
                            bind:value={packageSource}
                            disabled={packageBusy}
                          />

                          <Select.Root
                            type="single"
                            value={packageScope}
                            onValueChange={(v: string) => (packageScope = v as 'user' | 'project')}
                          >
                            <Select.Trigger size="sm" class="w-28">{packageScope}</Select.Trigger>
                            <Select.Content>
                              <Select.Item value="user">user</Select.Item>
                              <Select.Item
                                value="project"
                                disabled={projectTrust?.decision !== 'trusted'}>project</Select.Item
                              >
                            </Select.Content>
                          </Select.Root>
                          <Button
                            size="sm"
                            disabled={!packageSource.trim() ||
                              packageBusy ||
                              (packageScope === 'project' && projectTrust?.decision !== 'trusted')}
                            onclick={() => {
                              packageBusy = true;
                              send({
                                type: 'install_package',
                                source: packageSource.trim(),
                                scope: packageScope,
                              });
                            }}>Install</Button
                          >
                        </div>
                        {#if packageProgress}
                          <p class="text-xs text-base-content/45">
                            {packageProgress.message ?? packageProgress.phase}
                          </p>
                        {/if}
                      </div>
                    </Card.Root>
                    {#if !packagesLoaded}
                      <p class="text-sm text-base-content/45">Loading packages…</p>
                    {:else if packagesList.length === 0}
                      <p class="text-sm text-base-content/45">No configured packages.</p>
                    {:else}
                      <Card.Root
                        size="sm"
                        class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                      >
                        <div class="divide-y divide-base-content/8">
                          {#each packagesList as pkg (`${pkg.scope}:${pkg.source}`)}
                            <div class="flex items-center gap-3 px-4 py-3">
                              <div class="min-w-0 flex-1">
                                <p class="text-xs font-mono text-base-content/70 truncate">
                                  {pkg.source}
                                </p>
                                <p class="text-[11px] text-base-content/35">
                                  {pkg.scope}{pkg.filtered ? ' · filtered' : ''}
                                </p>
                              </div>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={packageBusy}
                                onclick={() => {
                                  packageBusy = true;
                                  send({
                                    type: 'remove_package',
                                    source: pkg.source,
                                    scope: pkg.scope,
                                  });
                                }}>Remove</Button
                              >
                            </div>
                          {/each}
                        </div>
                      </Card.Root>
                    {/if}
                    {#if packageUpdates.length > 0}
                      <p class="text-xs text-warning/75">
                        {packageUpdates.length} package update(s) available.
                      </p>
                    {/if}
                  </div>
                {:else if settingsSection === 'updates'}
                  <div class="space-y-4">
                    <Card.Root
                      size="sm"
                      class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                    >
                      <div class="divide-y divide-base-content/8">
                        <div class="flex items-center gap-3 px-4 py-3">
                          <div class="flex-1 min-w-0">
                            <p class="text-sm text-base-content/75">Update status</p>
                            <p class="text-xs text-base-content/35 mt-0.5">
                              Checks npm for latest versions. Update actions run on the server.
                            </p>
                          </div>
                          <button
                            onclick={refreshUpdateStatus}
                            disabled={wsState !== 'open' || updateLoading || updateRunning}
                            class="px-3 py-1.5 text-xs rounded-lg font-medium transition-colors {wsState ===
                              'open' &&
                            !updateLoading &&
                            !updateRunning
                              ? 'text-primary hover:bg-primary/10'
                              : 'text-base-content/25 cursor-default'}"
                            >{updateLoading ? 'Checking…' : 'Check'}</button
                          >
                        </div>

                        <div
                          class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-base-content/8"
                        >
                          <div class="px-4 py-3 space-y-3">
                            <div>
                              <p class="text-xs text-base-content/35">pi-ui</p>
                              <p class="mt-1 text-sm text-base-content/75 font-mono">
                                {versionText(updateStatus?.ui.current ?? uiVersion)}
                              </p>
                              <p class="mt-0.5 text-xs text-base-content/40">
                                Latest: {versionText(updateStatus?.ui.latest)}
                              </p>
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
                              disabled={wsState !== 'open' ||
                                updateRunning ||
                                !updateStatus?.canUpdateUi}
                              class="w-full px-3 py-2 text-xs rounded-lg font-medium transition-colors {wsState ===
                                'open' &&
                              !updateRunning &&
                              updateStatus?.canUpdateUi
                                ? 'bg-primary/15 text-primary hover:bg-primary/25'
                                : 'bg-base-content/8 text-base-content/28 cursor-default'}"
                              >{updateRunning && updateTarget === 'ui'
                                ? 'Updating pi-ui…'
                                : 'Update pi-ui'}</button
                            >
                            {#if updateStatus && !updateStatus.canUpdateUi}
                              <p class="text-[11px] text-base-content/35 leading-snug">
                                This run is ephemeral; restart with the latest package instead.
                              </p>
                            {/if}
                          </div>

                          <div class="px-4 py-3 space-y-3">
                            <div>
                              <p class="text-xs text-base-content/35">pi SDK</p>
                              <p class="mt-1 text-sm text-base-content/75 font-mono">
                                {versionText(updateStatus?.sdk.current ?? piVersion)}
                              </p>
                              <p class="mt-0.5 text-xs text-base-content/40">
                                Latest: {versionText(updateStatus?.sdk.latest)}
                              </p>
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
                              disabled={wsState !== 'open' ||
                                updateRunning ||
                                !updateStatus?.canUpdateSdk}
                              class="w-full px-3 py-2 text-xs rounded-lg font-medium transition-colors {wsState ===
                                'open' &&
                              !updateRunning &&
                              updateStatus?.canUpdateSdk
                                ? 'bg-primary/15 text-primary hover:bg-primary/25'
                                : 'bg-base-content/8 text-base-content/28 cursor-default'}"
                              >{updateRunning && updateTarget === 'sdk'
                                ? 'Updating SDK…'
                                : 'Update SDK'}</button
                            >
                            {#if updateStatus && !updateStatus.canUpdateSdk}
                              <p class="text-[11px] text-base-content/35 leading-snug">
                                SDK-only updates are available from source checkouts only. Package
                                installs update the SDK with pi-ui.
                              </p>
                            {/if}
                          </div>
                        </div>

                        {#if updateStatus}
                          <div class="px-4 py-3 space-y-1.5">
                            <p class="text-xs text-base-content/35">App directory</p>
                            <p class="text-xs text-base-content/65 font-mono break-all">
                              {updateStatus.appRoot}
                            </p>
                            <p class="text-xs text-base-content/35">
                              Mode: {updateStatus.mode === 'source'
                                ? 'source checkout'
                                : updateStatus.mode === 'ephemeral'
                                  ? 'ephemeral run'
                                  : 'package install'}
                            </p>
                            {#if updateStatus.updateCommand}
                              <p class="text-xs text-base-content/35">
                                Update command: <span class="font-mono text-base-content/60"
                                  >{updateStatus.updateCommand}</span
                                >
                              </p>
                            {/if}
                          </div>
                        {/if}
                      </div>
                    </Card.Root>

                    {#if updateFeedback}
                      <Card.Root
                        size="sm"
                        class="py-0 overflow-hidden {updateFeedback.success
                          ? 'bg-success/5 border-success/20'
                          : 'bg-error/5 border-error/20'}"
                      >
                        <div class="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                          <div class="flex-1 min-w-0">
                            <p
                              class="text-sm {updateFeedback.success
                                ? 'text-success/85'
                                : 'text-error/85'}"
                            >
                              {updateFeedback.message}
                            </p>
                            {#if updateFeedback.restartRequired}
                              <p class="text-xs text-base-content/40 mt-0.5">
                                Restart is required before the new version is loaded.
                              </p>
                            {/if}
                          </div>
                          {#if updateFeedback.restartRequired}
                            <button
                              onclick={() => restartServer(Boolean(updateFeedback?.reloadRequired))}
                              class="px-3 py-1.5 text-xs rounded-lg font-medium text-primary bg-primary/12 hover:bg-primary/20 transition-colors"
                              >{updateFeedback.reloadRequired
                                ? 'Restart + reload'
                                : 'Restart now'}</button
                            >
                          {/if}
                        </div>
                      </Card.Root>
                    {/if}

                    {#if updateStatus?.notes.length}
                      <Card.Root
                        size="sm"
                        class="py-0 overflow-hidden bg-base-100/45 border-base-content/10"
                      >
                        <div class="px-4 py-3 space-y-1">
                          {#each updateStatus.notes as note (note)}
                            <p class="text-xs text-base-content/42 leading-snug">{note}</p>
                          {/each}
                        </div>
                      </Card.Root>
                    {/if}

                    {#if updateLog}
                      <pre
                        class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-base-content/10 bg-base-300/70 p-3 text-[11px] leading-relaxed text-base-content/60 font-mono">{updateLog}</pre>
                    {/if}
                  </div>
                {:else}
                  <Card.Root
                    size="sm"
                    class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                  >
                    <div class="divide-y divide-base-content/8">
                      <div class="px-4 py-3">
                        <p class="text-xs text-base-content/35 mb-2">Theme</p>
                        <div class="flex flex-wrap gap-1.5">
                          {#each THEMES as theme (theme.id)}
                            <button
                              onclick={() => setTheme(theme.id)}
                              class="px-2.5 py-1 text-xs rounded-lg border transition-colors {selectedTheme ===
                              theme.id
                                ? 'border-primary/50 bg-primary/12 text-primary'
                                : 'border-base-content/12 text-base-content/50 hover:text-base-content/75 hover:border-base-content/25'}"
                              >{theme.name}</button
                            >
                          {/each}
                        </div>
                      </div>
                      <div class="px-4 py-3">
                        <p class="text-xs text-base-content/35">Working directory</p>
                        <p class="mt-1 text-xs text-base-content/65 font-mono break-all">
                          {cwd || 'unknown'}
                        </p>
                      </div>
                      <div
                        class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-base-content/8"
                      >
                        <div class="px-4 py-3">
                          <p class="text-xs text-base-content/35">pi-ui</p>
                          <p class="mt-1 text-sm text-base-content/70 font-mono">
                            {uiVersion ? `v${uiVersion}` : 'unknown'}
                          </p>
                        </div>
                        <div class="px-4 py-3">
                          <p class="text-xs text-base-content/35">pi SDK</p>
                          <p class="mt-1 text-sm text-base-content/70 font-mono">
                            {piVersion ? `v${piVersion}` : 'unknown'}
                          </p>
                        </div>
                      </div>
                      <div class="flex items-center gap-3 px-4 py-3">
                        <div class="flex-1 min-w-0">
                          <p class="text-sm text-base-content/75">Restart server</p>
                          <p class="text-xs text-base-content/35 mt-0.5">
                            Reconnects after the Bun process restarts.
                          </p>
                        </div>
                        <button
                          onclick={() => restartServer()}
                          class="px-3 py-1.5 text-xs rounded-lg font-medium transition-colors {wsState ===
                          'open'
                            ? 'text-error/75 hover:text-error hover:bg-error/10'
                            : 'text-base-content/25 cursor-default'}"
                          disabled={wsState !== 'open'}
                          aria-label="Restart server">Restart</button
                        >
                      </div>
                      {#if sessionStats}
                        <div class="px-4 py-3">
                          <div class="flex items-center justify-between gap-3">
                            <p class="text-sm text-base-content/75">Session usage</p>
                            <div class="flex gap-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                onclick={() => send({ type: 'export_session', format: 'html' })}
                                >HTML</Button
                              >
                              <Button
                                size="sm"
                                variant="ghost"
                                onclick={() => send({ type: 'export_session', format: 'jsonl' })}
                                >JSONL</Button
                              >
                            </div>
                          </div>
                          <div class="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                            <span class="text-base-content/50"
                              >Messages <b class="text-base-content/75"
                                >{sessionStats.totalMessages}</b
                              ></span
                            >
                            <span class="text-base-content/50"
                              >Tools <b class="text-base-content/75">{sessionStats.toolCalls}</b
                              ></span
                            >
                            <span class="text-base-content/50"
                              >Tokens <b class="text-base-content/75"
                                >{sessionStats.tokens.total.toLocaleString()}</b
                              ></span
                            >
                            <span class="text-base-content/50"
                              >Cost <b class="text-base-content/75">{fmtCost(sessionStats.cost)}</b
                              ></span
                            >
                          </div>
                          {#if exportFeedback}
                            <p class="mt-2 text-[11px] text-base-content/45">{exportFeedback}</p>
                          {/if}
                        </div>
                      {/if}
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
        class="fixed inset-0 z-[60] flex items-center justify-center bg-base-100/76 px-3 py-6 backdrop-blur-md sm:px-6"
      >
        <div
          class="relative w-full max-w-3xl"
          role="dialog"
          aria-label="Extension terminal"
          aria-modal="true"
          tabindex="-1"
        >
          <span id="extension-terminal-instructions" class="sr-only">
            Arrow keys, Page Up/Down, Home, End, and Enter are forwarded to the extension. Press
            Escape to close.
          </span>
          <!-- Keep dismissal outside the extension's own drawn border so it never
               overlaps its corner glyphs. -->
          <button
            onclick={modalCancel}
            class="absolute top-3 right-3 z-20 flex h-11 w-11 items-center justify-center rounded-full border border-base-content/10 bg-base-200/95 text-base-content/65 shadow-lg shadow-black/30 backdrop-blur-md transition-all hover:scale-105 hover:border-primary/30 hover:bg-primary/15 hover:text-base-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 sm:-top-3 sm:-right-3"
            aria-label="Close extension overlay"
          >
            <X class="w-3.5 h-3.5" />
          </button>
          <div
            class="flex h-[min(30rem,calc(100dvh-4rem))] flex-col overflow-hidden rounded-2xl border border-base-content/10 bg-base-200/95 shadow-2xl shadow-black/40 ring-1 ring-primary/[0.06] backdrop-blur-xl"
          >
            <div
              aria-hidden="true"
              class="flex h-10 shrink-0 items-center border-b border-base-content/8 bg-gradient-to-r from-primary/[0.08] via-base-content/[0.025] to-transparent px-4"
            >
              <div class="flex items-center gap-1.5">
                <span class="h-2 w-2 rounded-full bg-error/70"></span>
                <span class="h-2 w-2 rounded-full bg-warning/70"></span>
                <span class="h-2 w-2 rounded-full bg-success/70"></span>
              </div>
              <div class="ml-3 flex min-w-0 items-center gap-2 font-mono">
                <span
                  class="truncate text-[10px] font-medium uppercase tracking-[0.16em] text-base-content/55"
                  >extension terminal</span
                >
                <span class="h-1 w-1 shrink-0 rounded-full bg-success/80"></span>
                <span class="text-[9px] uppercase tracking-[0.14em] text-base-content/40">live</span
                >
              </div>
              <span
                class="ml-auto hidden rounded-md border border-base-content/10 bg-base-content/[0.035] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-base-content/35 sm:inline"
                >esc</span
              >
            </div>
            <div
              bind:this={overlayViewportEl}
              class="min-h-0 flex-1 overflow-y-auto bg-base-100/35"
            >
              <pre
                bind:this={overlayPreEl}
                class="min-h-full select-text whitespace-pre-wrap px-4 py-2 font-mono text-[13px] leading-[1.55] text-base-content/85">{#if modal.htmlLines}{#each modal.htmlLines as line, i (i)}<div>{@html line ||
                        '&nbsp;'}</div>{/each}{:else}{(modal.lines ?? []).join('\n')}{/if}</pre>
            </div>
          </div>
          <!-- Hidden input to capture keystrokes, paste, and IME composition. -->
          <input
            type="text"
            class="sr-only"
            aria-label="Extension terminal input"
            aria-describedby="extension-terminal-instructions"
            tabindex="-1"
            onkeydown={overlayKeydown}
            onpaste={overlayPaste}
            oncompositionend={overlayCompositionEnd}
            bind:this={modalFocusEl}
          />
        </div>
      </div>
    {/if}
  </div>
</Tooltip.Provider>

<!-- ── Restarting overlay ───────────────────────────────────────────────────── -->
{#if isRestarting}
  <div
    class="aurora fixed inset-0 z-50 flex flex-col items-center justify-center bg-base-100/92 backdrop-blur-sm gap-4"
  >
    <span class="pi-glyph pi-glyph-breathe text-6xl font-light leading-none select-none">π</span>
    <p class="font-mono text-base-content/70 text-sm">restarting server…</p>
    <p class="font-mono text-base-content/35 text-xs">reconnecting automatically</p>
  </div>
{/if}
<!-- ── Extension UI modal ─────────────────────────────────────────────────────── -->
<Dialog.Root
  open={!!modal && !(modal.method === 'custom' && modal.interactive)}
  onOpenChange={(v) => {
    if (!v && modal) modalCancel();
  }}
>
  <Dialog.Content
    class="flex w-full max-w-[min(42rem,calc(100vw_-_1.5rem))] min-h-0 max-h-[min(44rem,calc(100dvh_-_2rem))] flex-col gap-0 overflow-hidden rounded-2xl border border-base-content/10 bg-base-100/96 p-0 shadow-2xl shadow-black/45 ring-1 ring-primary/12 backdrop-blur-xl sm:max-w-2xl"
    showCloseButton={false}
    onkeydown={modalContentKeydown}
  >
    <Dialog.Header
      class="min-w-0 shrink-0 border-b border-base-content/8 bg-gradient-to-br from-primary/[0.08] via-base-100/65 to-transparent px-4 py-4 sm:px-5 sm:py-5"
    >
      <div class="flex min-w-0 items-start gap-3">
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/15"
        >
          <Blocks class="h-[1.125rem] w-[1.125rem]" />
        </div>
        <div class="min-w-0 flex-1 pt-0.5">
          <p class="text-[10px] font-medium uppercase tracking-[0.18em] text-primary/65">
            Extension question
          </p>
          <Dialog.Title
            class="min-w-0 whitespace-normal break-words text-[0.95rem] font-semibold leading-snug text-base-content [overflow-wrap:anywhere]"
            >{modal?.title}</Dialog.Title
          >
        </div>
      </div>
      {#if modal?.method === 'confirm' && modal.message}
        <Dialog.Description
          class="mt-3 max-h-[min(12rem,30dvh)] min-w-0 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-base-content/65 [overflow-wrap:anywhere]"
          >{modal.message}</Dialog.Description
        >
      {/if}
    </Dialog.Header>

    {#if modal?.method === 'input'}
      <div class="min-h-0 min-w-0 flex-1 px-4 py-4 sm:px-5">
        <input
          bind:this={modalFocusEl}
          type={modal.secret ? 'password' : 'text'}
          bind:value={modalInput}
          placeholder={modal.placeholder ?? ''}
          class="dialog-input w-full rounded-xl px-3.5 py-2.5 text-sm outline-none placeholder-muted-foreground transition-colors"
        />
      </div>
    {:else if modal?.method === 'select'}
      <div
        class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 sm:px-5 sm:py-4"
      >
        {#if modal.options.length > 0}
          {#if modal.options.length > 10}
            <div class="relative mb-3">
              <input
                bind:this={modalFocusEl}
                type="search"
                bind:value={selectFilter}
                oninput={() => (selectOptionIndex = 0)}
                placeholder="Filter options…"
                aria-label="Filter options"
                autocomplete="off"
                class="w-full rounded-xl border border-base-content/10 bg-base-content/[0.035] px-3.5 py-2.5 pr-14 text-sm outline-none transition-colors placeholder:text-base-content/35 focus:border-primary/45 focus:bg-base-content/[0.06]"
              />
              <span
                class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] tabular-nums uppercase tracking-wide text-base-content/30"
                >{filteredSelectOptions.length}/{modal.options.length}</span
              >
            </div>
          {/if}
          {#if filteredSelectOptions.length > 0}
            <div role="listbox" aria-label={modal.title} class="min-w-0 space-y-2">
              {#each filteredSelectOptions as item, i (item.index + ':' + item.value)}
                {@const option = item.option}
                <!-- svelte-ignore a11y_autofocus -->
                <button
                  type="button"
                  data-extension-option="true"
                  data-extension-option-index={i}
                  role="option"
                  aria-selected={selectOptionIndex === i}
                  aria-posinset={i + 1}
                  aria-setsize={filteredSelectOptions.length}
                  autofocus={i === 0 && !selectFilter}
                  class="group flex w-full min-w-0 max-w-full items-start gap-3 overflow-hidden rounded-2xl border border-base-content/10 bg-base-content/[0.025] px-3.5 py-3 text-left transition-[border-color,background-color,transform] duration-150 hover:border-primary/35 hover:bg-primary/[0.06] focus-visible:border-primary/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 active:scale-[0.995]"
                  onclick={() => extensionUiState.answerSelect(item.value)}
                  onfocus={() => (selectOptionIndex = i)}
                >
                  <span
                    class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-xs font-semibold tabular-nums text-primary/85 ring-1 ring-primary/10"
                    >{option.index}</span
                  >
                  <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <span
                      class="block min-w-0 whitespace-normal break-words text-sm font-medium leading-snug text-base-content/85 group-hover:text-base-content [overflow-wrap:anywhere]"
                      >{option.label}</span
                    >
                    {#if option.description}
                      <span
                        class="mt-1 block min-w-0 whitespace-normal break-words text-xs leading-relaxed text-base-content/50 group-hover:text-base-content/65 [overflow-wrap:anywhere]"
                        >{option.description}</span
                      >
                    {/if}
                  </span>
                  <ChevronRight
                    class="mt-1 h-4 w-4 shrink-0 text-base-content/25 transition-transform group-hover:translate-x-0.5 group-hover:text-primary/70"
                  />
                </button>
              {/each}
            </div>
          {:else}
            <p
              class="rounded-xl border border-dashed border-base-content/10 px-4 py-8 text-center text-sm text-muted-foreground"
            >
              No matching options.
            </p>
          {/if}
        {:else}
          <p
            class="rounded-xl border border-dashed border-base-content/10 px-4 py-8 text-center text-sm text-muted-foreground"
          >
            No options were provided.
          </p>
        {/if}
      </div>
    {:else if modal?.method === 'editor'}
      <div class="min-h-0 min-w-0 flex-1 px-4 py-4 sm:px-5">
        <textarea
          bind:this={modalFocusEl}
          bind:value={modalInput}
          rows={8}
          autocapitalize="off"
          spellcheck={false}
          use:autoCorrectOff
          class="dialog-input min-h-48 w-full resize-none rounded-xl p-3.5 text-sm leading-relaxed transition-colors"
        ></textarea>
      </div>
    {:else if modal?.method === 'custom'}
      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        {#if modal.parsed}
          <ExtensionComponent
            component={modal.parsed}
            interactive
            onaction={modalComponentAction}
            bind:inputValue={modalInput}
          />
          {#if customModalNeedsTextInput(modal.parsed)}
            <input
              bind:this={modalFocusEl}
              type="text"
              bind:value={modalInput}
              placeholder="Type your response…"
              class="dialog-input mt-4 w-full rounded-xl px-3.5 py-2.5 text-sm placeholder-muted-foreground transition-colors"
            />
          {/if}
        {:else}
          <p class="mb-2 text-sm text-muted-foreground">Extension request:</p>
          <input
            bind:this={modalFocusEl}
            type="text"
            bind:value={modalInput}
            placeholder="Type your response…"
            class="dialog-input w-full rounded-xl px-3.5 py-2.5 text-sm placeholder-muted-foreground transition-colors"
          />
        {/if}
      </div>
    {/if}

    <Dialog.Footer
      class="extension-dialog-footer shrink-0 flex-row justify-end gap-2 border-t border-base-content/8 bg-base-200/35 px-4 py-3 sm:px-5"
    >
      {#if modal?.method === 'select'}
        <span class="mr-auto hidden text-[11px] text-base-content/35 sm:inline"
          >↑↓ move · Enter select · Esc cancel</span
        >
      {/if}
      <Button
        variant="ghost"
        size="sm"
        class="text-muted-foreground/80 hover:text-base-content"
        onclick={modalCancel}>Cancel</Button
      >
      {#if modal?.method === 'confirm'}
        <Button size="sm" onclick={() => extensionUiState.answerConfirm(true)}>Confirm</Button>
      {:else if modal?.method === 'input' || modal?.method === 'editor'}
        <Button size="sm" onclick={modalSubmitValue}>Submit</Button>
      {:else if modal?.method === 'custom' && !modal.interactive && (customModalNeedsTextInput(modal.parsed) || parsedComponentHasInput(modal.parsed) || parsedComponentHasCheckbox(modal.parsed) || parsedComponentIsDisplayOnly(modal.parsed))}
        <Button size="sm" onclick={modalSubmitValue}
          >{parsedComponentIsDisplayOnly(modal.parsed) ? 'OK' : 'Submit'}</Button
        >
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- ── Fork session dialog ──────────────────────────────────────────────────── -->
{#if showForkDialog}
  {#await import('#lib/components/dialogs/fork-dialog.svelte') then { default: ForkDialog }}
    <ForkDialog
      open={showForkDialog}
      loading={forkLoading}
      {forkPoints}
      {forkAt}
      onClose={() => (showForkDialog = false)}
    />
  {/await}
{/if}

<!-- ── Session tree modal ──────────────────────────────────────────────────── -->
{#if showTreeModal}
  {#await import('#lib/components/dialogs/session-tree-modal.svelte') then { default: SessionTreeModal }}
    <SessionTreeModal
      open={showTreeModal}
      loading={treeLoading}
      {treeData}
      onClose={() => (showTreeModal = false)}
    />
  {/await}
{/if}

{#if fileViewerOpen}
  {#await import('#lib/components/file-viewer-modal.svelte') then { default: FileViewerModal }}
    <FileViewerModal
      open={fileViewerOpen}
      path={fileViewerPath}
      line={fileViewerLine}
      content={fileViewerContent}
      loading={fileViewerLoading}
      error={fileViewerError}
      saving={fileSaving}
      onclose={() => {
        fileViewerOpen = false;
      }}
      onsave={handleFileSave}
      oninsert={() => {
        const ref = fileViewerPath.includes('/')
          ? (fileViewerPath.split('/').pop() ?? fileViewerPath)
          : fileViewerPath;
        input = input + `@${ref} `;
        fileViewerOpen = false;
        tick().then(() => {
          autoResizeTextarea();
          inputEl?.focus();
        });
      }}
    />
  {/await}
{/if}

<!-- ── Confirmation dialog (replaces window.confirm for delete/update/restart) ── -->

<ConfirmDialog {pendingConfirm} onClose={() => (pendingConfirm = null)} />
