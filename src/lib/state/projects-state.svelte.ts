/**
 * Shared client state for the projects / sessions system.
 *
 * Single runes-based store consumed by the projects sidebar, the project
 * picker, and the main page. The page wires `send` to the live WebSocket and
 * forwards relevant server messages into `handleMessage`.
 *
 * The app runs with ssr=false, so this module only ever executes in the
 * browser — localStorage access is still guarded for svelte-check.
 */

import { untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import type { ClientMessage, ProjectInfo, SessionSummary } from '#lib/ws/protocol.js';

/** Runtime status for one session, keyed by session id in `ProjectsState.runtime`. */
export interface SessionRuntimeStatus {
  sessionId: string;
  phase: 'idle' | 'running' | 'awaiting-input' | 'error';
  isRunning: boolean;
  activeToolName?: string;
  lastActivity: number;
  unread: boolean;
  needsAttention: boolean;
  resident: boolean;
}

/** A project with its sessions attached — the unit the UI renders. */
export interface ProjectGroup extends ProjectInfo {
  sessions: SessionRow[];
}

/** One flattened display row: a session plus its nesting depth and children. */
export interface SessionRow {
  session: SessionSummary;
  depth: number;
  hasChildren: boolean;
}

/**
 * Build display rows for one project: sessions whose `parentSession` points at
 * another session in the list nest under it; every sibling level (roots and
 * children) sorts by its subtree's most recent activity so a parent sits at
 * the position of its liveliest descendant. Pure — the output row set always
 * equals the input; orphan parents, cycles and duplicate paths render as roots.
 *
 * `parentSession` arrives in two shapes (both written by the SDK): forks
 * reference the parent's absolute file path, subagent task sessions a bare
 * parent session id — either form resolves the parent here.
 */
export function buildSessionRows(sessions: SessionSummary[]): SessionRow[] {
  interface Node {
    session: SessionSummary;
    children: Node[];
    /** Most recent `modified` anywhere in this subtree. */
    latest: number;
    attached: boolean;
    duplicate: boolean;
  }

  const byPath = new SvelteMap<string, Node>();
  const byId = new SvelteMap<string, Node>();
  const nodes: Node[] = [];
  for (const s of sessions) {
    const node: Node = {
      session: s,
      children: [],
      latest: s.modified,
      attached: false,
      duplicate: false,
    };
    nodes.push(node);
    // Duplicate paths (pooled in-memory sessions all report '(in-memory)')
    // stay unmapped — each copy renders as its own root.
    if (byPath.has(s.path)) node.duplicate = true;
    else byPath.set(s.path, node);
    if (!byId.has(s.id)) byId.set(s.id, node);
  }

  const resolveParent = (ref: string): Node | undefined => byPath.get(ref) ?? byId.get(ref);

  for (const node of nodes) {
    if (node.duplicate || !node.session.parentSession) continue;
    const parent = resolveParent(node.session.parentSession);
    if (!parent || parent === node) continue;
    // Walk the parent chain; if it loops back into this subtree the attach
    // would hide rows, so the session stays a root instead.
    const seen = new SvelteSet<string>([node.session.path]);
    let cyclic = false;
    for (let cursor: Node | undefined = parent; cursor && !cyclic;) {
      if (seen.has(cursor.session.path)) {
        cyclic = true;
        break;
      }
      seen.add(cursor.session.path);
      cursor = cursor.session.parentSession
        ? resolveParent(cursor.session.parentSession)
        : undefined;
    }
    if (!cyclic) {
      parent.children.push(node);
      node.attached = true;
    }
  }

  const measure = (node: Node): number => {
    let latest = node.session.modified;
    for (const child of node.children) latest = Math.max(latest, measure(child));
    return (node.latest = latest);
  };

  const roots = nodes.filter((n) => !n.attached);
  for (const root of roots) measure(root);

  const rows: SessionRow[] = [];
  const flatten = (level: Node[], depth: number): void => {
    level.sort((a, b) => b.latest - a.latest);
    for (const node of level) {
      rows.push({ session: node.session, depth, hasChildren: node.children.length > 0 });
      flatten(node.children, depth + 1);
    }
  };
  flatten(roots, 0);
  return rows;
}

const COLLAPSED_KEY = 'pifrontier:collapsed-projects';

/** How many sessions each project shows before the "show more" toggle. */
export const SESSION_PREVIEW_LIMIT = 3;

/**
 * How long a new_session / switch_session may stay unanswered before the UI
 * gives up and re-enables. The server normally replies with session_loaded in
 * tens of ms, but a dropped socket or a busy SDK must not leave sidebar
 * controls blocked forever — before this watchdog only a full reload healed
 * a lost reply.
 */
export const SESSION_OP_TIMEOUT_MS = 20_000;

function loadCollapsed(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function pathBasename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

class ProjectsState {
  /** Wired by the page to the live WebSocket sender. Returns true if the message was sent. */
  send: (msg: ClientMessage) => boolean = () => false;
  /** Optional callback invoked before switching to a new session. */
  onBeforeSwitch?: (targetPath: string) => void;

  /** Merged project list from the server (registry + session dirs). */
  projects = $state<ProjectInfo[]>([]);
  /** All sessions across all projects. */
  allSessions = $state<SessionSummary[]>([]);
  /** Active session's working directory (synced from connected/session_loaded). */
  cwd = $state('');
  /** Active session id (synced from the page). */
  activeSessionId = $state<string | null>(null);
  /** Whether the active session is currently streaming (synced from the page). */
  isStreaming = $state(false);
  /** Name of the active session's running tool (if any). */
  activeToolName = $state<string | undefined>(undefined);
  /** Authoritative liveness for every session currently resident on the server. */
  runtime = new SvelteMap<string, SessionRuntimeStatus>();
  /** Highest-priority activity in any non-active session. */
  backgroundActivity = $derived.by<'running' | 'unread' | null>(() => {
    const active = this.activeSessionId;
    for (const [id, status] of this.runtime) {
      if (id !== active && (status.phase === 'running' || status.activeToolName)) return 'running';
    }
    for (const [id, status] of this.runtime) {
      if (id !== active && status.unread) return 'unread';
    }
    return null;
  });
  /** Number of sessions that completed while no socket was focused on them. */
  unreadCount = $derived.by<number>(() => {
    let count = 0;
    for (const status of this.runtime.values()) {
      if (status.unread) count++;
    }
    return count;
  });

  /** Sidebar search text. */
  filter = $state('');
  /** Last error from session/project operations. */
  error = $state<string | null>(null);
  /** True while waiting for the server to answer new_session. */
  pendingNewSession = $state(false);
  /** Directory completions for the directory picker inputs. */
  dirCompletions = $state<string[]>([]);

  /** Session path from the most recent switch_session — consumed by the page for URL sync. */
  pendingSwitchPath: string | null = null;
  /** Optimistic ?session= URL updates are revertible until confirmed: set by
   * switchSession after its shallow goto, consumed by the page on success
   * (param rewritten from pendingSwitchPath), reverted on failure/timeout. */
  pendingUrlRevert = false;
  private urlParamBeforeSwitch: string | null = null;
  /** True while a session switch is in flight — shows skeleton instead of stale chat. */
  sessionLoading = $state(false);
  /** Correlation token for the in-flight new_session/switch_session request. */
  pendingRequestId = $state<string | null>(null);
  /** True while recovering from a timed-out new_session via resync_session. */
  pendingResync = $state(false);
  /** Watchdog for in-flight new_session/switch_session — see SESSION_OP_TIMEOUT_MS. */
  private opTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Request ids whose responses can no longer change the visible session. */
  private retiredRequestIds = new Set<string>();
  private requestSequence = 0;
  collapsed = new SvelteSet<string>(loadCollapsed());
  /** Projects whose full session list is expanded past the preview limit. */
  expandedGroups = new SvelteSet<string>();
  /** Nested session branches expanded in the sidebar; intentionally ephemeral. */
  expandedSubsessions = new SvelteSet<string>();
  /**
   * When the server last pushed a full list (all_sessions_list/projects_list).
   * Guards `refresh()`: the server now pushes coalesced session_updated
   * deltas during turns, so re-requesting both full lists on every sidebar
   * open is redundant — skip when a full list arrived recently.
   */
  private lastFullListAt = 0;

  /** Projects merged with their sessions. Pinned first, then recent. */
  groups = $derived.by<ProjectGroup[]>(() => {
    const byCwd = new SvelteMap<string, SessionSummary[]>();
    for (const s of this.allSessions) {
      const key = s.cwd ?? '';
      if (!key) continue;
      const list = byCwd.get(key);
      if (list) list.push(s);
      else byCwd.set(key, [s]);
    }

    // Subtree-recency order within a project (parents sit at the position of
    // their liveliest descendant, children nested under them). The server
    // sorts full lists by recency, but live session_updated deltas upsert in
    // place — without this re-derivation a session that just ran would keep
    // its old row position until the next full list.
    const out: ProjectGroup[] = this.projects.map((p) => ({
      ...p,
      sessions: buildSessionRows(byCwd.get(p.cwd) ?? []),
    }));

    // Sessions in directories the server list doesn't know yet (e.g. before
    // the first projects_list arrives) still need a group.
    for (const [dir, sessions] of byCwd) {
      if (out.some((g) => g.cwd === dir)) continue;
      out.push({
        cwd: dir,
        name: pathBasename(dir),
        pinned: false,
        exists: true,
        registered: false,
        sessionCount: sessions.length,
        lastActivity: Math.max(0, ...sessions.map((s) => s.modified)),
        sessions: buildSessionRows(sessions),
      });
    }

    return out.sort((a, b) =>
      a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.lastActivity - a.lastActivity
    );
  });

  /** Groups filtered by the sidebar search text. */
  filteredGroups = $derived.by<ProjectGroup[]>(() => {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.groups;
    return this.groups
      .map((g) => {
        if (g.name.toLowerCase().includes(q) || g.cwd.toLowerCase().includes(q)) return g;
        // Keep a row when it matches or any of its descendants does — a match
        // deep in a substack stays anchored under its parent chain. DFS order
        // lets one depth-keyed ancestor walk mark whole chains.
        const keep = new Array<boolean>(g.sessions.length).fill(false);
        const path: number[] = [];
        for (let i = 0; i < g.sessions.length; i++) {
          const row = g.sessions[i];
          path.length = row.depth;
          const s = row.session;
          if (
            (s.name ?? '').toLowerCase().includes(q) ||
            (s.firstMessage ?? '').toLowerCase().includes(q)
          ) {
            keep[i] = true;
            for (const anc of path) keep[anc] = true;
          }
          path.push(i);
        }
        const sessions = g.sessions.filter((_, i) => keep[i]);
        return sessions.length === g.sessions.length ? g : { ...g, sessions };
      })
      .filter(
        (g) =>
          g.sessions.length > 0 ||
          g.name.toLowerCase().includes(q) ||
          g.cwd.toLowerCase().includes(q)
      );
  });

  /** The project group for the active session's cwd, when known. */
  activeProject = $derived.by<ProjectGroup | null>(() => {
    if (!this.cwd) return null;
    return this.groups.find((g) => g.cwd === this.cwd) ?? null;
  });

  /** Display name for the active project (custom name → basename → ''). */
  activeProjectName = $derived.by<string>(() => {
    if (this.activeProject) return this.activeProject.name;
    return this.cwd ? pathBasename(this.cwd) : '';
  });
  /** Whether a session is actively running according to its runtime frame. */
  isSessionRunning(id: string): boolean {
    return this.runtime.get(id)?.phase === 'running';
  }

  /** The currently executing tool for a session, if any. */
  sessionToolName(id: string): string | undefined {
    return this.runtime.get(id)?.activeToolName;
  }

  /** Whether a session finished while no client was focused on it. */
  isSessionUnread(id: string): boolean {
    return this.runtime.get(id)?.unread ?? false;
  }

  /** Whether a session is awaiting input or has entered an error state. */
  sessionNeedsAttention(id: string): boolean {
    return this.runtime.get(id)?.needsAttention ?? false;
  }

  /** Highest-priority runtime state across the sessions in one project. */
  projectActivity(group: ProjectGroup): 'running' | 'unread' | null {
    if (
      group.sessions.some(
        (row) =>
          this.isSessionRunning(row.session.id) || Boolean(this.sessionToolName(row.session.id))
      )
    ) {
      return 'running';
    }
    if (group.sessions.some((row) => this.isSessionUnread(row.session.id))) return 'unread';
    return null;
  }

  /** Remove runtime snapshots for sessions that disappeared from the authoritative list. */
  private pruneRuntimeState(previousSessionIds: Set<string>): void {
    const knownIds = new Set(this.allSessions.map((session) => session.id));
    for (const id of this.runtime.keys()) {
      // A runtime frame can beat the first all_sessions_list response. Keep
      // that status until its row arrives, but discard statuses for sessions
      // that were present in the previous authoritative list and have since
      // been removed.
      if (!knownIds.has(id) && previousSessionIds.has(id)) {
        this.runtime.delete(id);
      }
    }
  }

  /** Upsert the latest server-authoritative runtime snapshot for a session. */
  applyRuntime(status: SessionRuntimeStatus): void {
    this.runtime.set(status.sessionId, status);
    if (status.sessionId === this.activeSessionId) {
      this.isStreaming = status.isRunning;
      this.activeToolName = status.activeToolName;
    }
  }

  // ── Server message intake ────────────────────────────────────────────────
  /**
   * Apply a partial state update atomically.
   * `groups` is derived from both `projects` and `allSessions` — updating them
   * through this single method makes the relationship explicit and ensures any
   * future cross-field invariants are enforced in one place.
   */
  applyState(payload: { projects?: ProjectInfo[]; sessions?: SessionSummary[] }): void {
    if (payload.projects !== undefined) this.projects = payload.projects;
    if (payload.sessions !== undefined) {
      const previousSessionIds = new Set(this.allSessions.map((session) => session.id));
      this.allSessions = payload.sessions;
      this.pruneRuntimeState(previousSessionIds);
    }
  }

  /** Refresh both lists — called on connect (force) and when the sidebar opens. */
  refresh(opts?: { force?: boolean }): void {
    const fresh =
      !opts?.force &&
      Date.now() - this.lastFullListAt < 2000 &&
      (this.projects.length > 0 || this.allSessions.length > 0);
    if (fresh) return;
    this.send({ type: 'get_projects' });
    this.send({ type: 'get_all_sessions' });
  }

  /**
   * Consume project/session related server messages.
   * Returns true when the message was handled.
   */
  handleMessage(msg: { type: string } & Record<string, unknown>): boolean {
    switch (msg.type) {
      case 'projects_list':
        this.applyState({ projects: (msg.projects as ProjectInfo[]) ?? [] });
        this.lastFullListAt = Date.now();
        return true;
      case 'all_sessions_list':
        this.applyState({ sessions: (msg.sessions as SessionSummary[]) ?? [] });
        this.lastFullListAt = Date.now();
        return true;
      case 'session_updated': {
        // Disk-derived sidebar deltas upsert by id — the derived groups re-sort
        // by recency automatically.
        const s = msg.session as SessionSummary | undefined;
        if (s && typeof s.id === 'string') {
          const idx = this.allSessions.findIndex((x) => x.id === s.id);
          if (idx === -1) {
            this.allSessions = [...this.allSessions, s];
          } else if (this.allSessions[idx] !== s) {
            const next = this.allSessions.slice();
            next[idx] = s;
            this.allSessions = next;
          }
        }
        return true;
      }
      case 'sessions_list':
        // all_sessions_list is the source of truth — just clear transient state.
        this.error = null;
        return true;
      case 'sessions_error': {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
        // Only a correlated in-flight operation (or a legacy unstamped
        // response while one is pending) may settle the current operation.
        // Retired responses are late duplicates; an unstamped error with no
        // operation has no safe owner.
        if (
          (requestId !== undefined && this.isRetiredRequest(requestId)) ||
          (requestId === undefined && !this.pendingNewSession && !this.sessionLoading) ||
          (this.pendingRequestId !== null &&
            requestId !== undefined &&
            requestId !== this.pendingRequestId)
        ) {
          return false;
        }
        this.clearOpTimeout();
        this.error = (msg.message as string) ?? 'Unknown error';
        this.pendingNewSession = false;
        this.sessionLoading = false;
        this.pendingSwitchPath = null;
        this.pendingResync = false;
        this.retirePendingRequest();
        // A rejected switch must not leave the optimistically-set ?session=
        // param pointing at a session that was never actually opened.
        this.revertOptimisticSessionUrl();
        return true;
      }
      case 'dir_completions':
        this.dirCompletions = (msg.entries as string[]) ?? [];
        return true;
      default:
        return false;
    }
  }
  /** Reconcile the active session's authoritative runtime snapshot. */
  reconcileActiveRuntime(
    sessionId: string,
    isRunning: boolean,
    activeToolName: string | undefined
  ): void {
    const previous = this.runtime.get(sessionId);
    this.activeSessionId = sessionId;
    this.applyRuntime({
      sessionId,
      phase: isRunning ? 'running' : 'idle',
      isRunning,
      ...(activeToolName ? { activeToolName } : {}),
      lastActivity: previous?.lastActivity ?? Date.now(),
      unread: previous?.unread ?? false,
      needsAttention: previous?.needsAttention ?? false,
      resident: previous?.resident ?? true,
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  private nextRequestId(): string {
    this.requestSequence++;
    return `${Date.now().toString(36)}-${this.requestSequence}-${Math.random().toString(36).slice(2)}`;
  }

  /** Whether a response belongs to an operation that has already been settled or abandoned. */
  isRetiredRequest(requestId: string): boolean {
    return this.retiredRequestIds.has(requestId);
  }

  private retirePendingRequest(): void {
    if (this.pendingRequestId) {
      this.retiredRequestIds.add(this.pendingRequestId);
      // Keep this bounded for long-lived tabs while retaining enough history
      // to reject duplicate/late frames from recent operations.
      if (this.retiredRequestIds.size > 64) {
        const oldest = this.retiredRequestIds.values().next().value;
        if (typeof oldest === 'string') this.retiredRequestIds.delete(oldest);
      }
    }
    this.pendingRequestId = null;
  }

  /** Clear the current operation token when its request can no longer settle this tab. */
  clearPendingRequest(): void {
    this.retirePendingRequest();
  }

  /** Arm the in-flight-op watchdog — clears the loading flags if no reply comes. */
  private startOpTimeout(): void {
    this.clearOpTimeout();
    const kind = this.pendingNewSession ? 'new' : 'switch';
    this.opTimeout = setTimeout(() => {
      this.opTimeout = null;
      if (this.pendingNewSession || this.sessionLoading) {
        if (kind === 'new') this.error = 'New chat timed out — server did not respond in time';
        else this.error = 'Session switch timed out';
        if (kind === 'new') this.pendingResync = this.send({ type: 'resync_session' });
        this.pendingNewSession = false;
        this.sessionLoading = false;
        this.pendingSwitchPath = null;
        this.retirePendingRequest();
        this.revertOptimisticSessionUrl();
      }
    }, SESSION_OP_TIMEOUT_MS);
  }

  private clearOpTimeout(): void {
    if (this.opTimeout !== null) {
      clearTimeout(this.opTimeout);
      this.opTimeout = null;
    }
  }

  /**
   * Abort any in-flight session open. Called when the socket reconnects: the
   * old request is orphaned (its reply would land on the dead socket), and the
   * connected payload carries the authoritative session state — so any
   * half-applied flags and a stale pending switch path must not survive.
   */
  cancelPendingOps(): void {
    this.clearOpTimeout();
    this.pendingNewSession = false;
    this.sessionLoading = false;
    this.pendingResync = false;
    this.pendingSwitchPath = null;
    this.retirePendingRequest();
    // Context unknown (disconnect/reset) — drop any revert intent silently.
    this.pendingUrlRevert = false;
  }

  /**
   * Accept an authoritative session snapshot and clear any pending operation.
   * Returns true when an operation was settled so callers can close
   * operation-specific UI such as the session drawer.
   *
   * Newer servers stamp the requester's snapshot with `requestId`, but older
   * servers (and the E2E protocol mocks) do not. In that case a switch can be
   * correlated by its requested path; a new-session response has no path to
   * compare and is therefore accepted as the current authoritative snapshot.
   */
  onSessionLoaded(requestId?: string, sessionPath?: string): boolean {
    const hadPendingOperation = this.pendingNewSession || this.sessionLoading;
    if (this.pendingRequestId !== null) {
      const requestMatches = requestId !== undefined && requestId === this.pendingRequestId;
      const legacyMatches =
        requestId === undefined &&
        (this.pendingSwitchPath === null || this.pendingSwitchPath === sessionPath);
      if (!requestMatches && !legacyMatches) return false;
    }
    this.clearOpTimeout();
    this.pendingNewSession = false;
    this.sessionLoading = false;
    this.pendingResync = false;
    this.error = null;
    this.pendingUrlRevert = false;
    this.urlParamBeforeSwitch = null;
    this.retirePendingRequest();
    return hadPendingOperation;
  }

  switchSession(path: string): 'ok' | 'busy' | 'offline' {
    if (this.pendingNewSession || this.sessionLoading) return 'busy';
    const requestId = this.nextRequestId();
    this.pendingResync = false;
    this.pendingRequestId = requestId;
    this.pendingSwitchPath = path;
    this.sessionLoading = true;
    this.startOpTimeout();
    const sent = this.send({ type: 'switch_session', path, requestId });
    if (!sent) {
      this.clearOpTimeout();
      this.sessionLoading = false;
      this.pendingSwitchPath = null;
      this.retirePendingRequest();
      return 'offline';
    }
    // Optimistic URL update is revertible: remember the previous ?session=
    // param so a rejected switch restores it instead of leaving a dead link.
    try {
      this.urlParamBeforeSwitch = new URL(window.location.href).searchParams.get('session');
    } catch {
      this.urlParamBeforeSwitch = null;
    }
    this.pendingUrlRevert = true;
    const url = new URL(window.location.href);
    url.searchParams.set('session', path);
    // Shallow navigation — updates the URL bar (and page.state) without
    // navigating or re-running load. `replace` keeps a single history entry
    // per session switch; `state` preserves the current page state (e.g. the
    // mobile drawer marker) instead of resetting it — read untracked so
    // effect-driven callers don't subscribe to page.state. The read is also
    // guarded because the server/test variant of `$app/state` throws outside
    // request context.
    let state: App.PageState = {};
    try {
      state = untrack(() => page.state);
    } catch {
      /* not in a browser context — nothing to preserve */
    }
    if (this.onBeforeSwitch) {
      try {
        this.onBeforeSwitch(path);
      } catch {
        /* non-fatal */
      }
    }
    goto(url, {
      shallow: true,
      replace: true,
      state: { ...state, piUiOptimisticSession: path },
    }).catch(() => {
      /* best-effort URL sync — never block session switching */
    });
    return 'ok';
  }

  /** Restore the pre-switch ?session= param after a failed/rejected switch. */
  revertOptimisticSessionUrl(): void {
    if (!this.pendingUrlRevert) return;
    this.pendingUrlRevert = false;
    try {
      const url = new URL(window.location.href);
      if (this.urlParamBeforeSwitch === null) url.searchParams.delete('session');
      else url.searchParams.set('session', this.urlParamBeforeSwitch);
      let state: App.PageState = {};
      try {
        state = untrack(() => page.state);
      } catch {
        /* not in a browser context */
      }
      const maybePromise = goto(url, {
        shallow: true,
        replace: true,
        state: { ...state, piUiOptimisticSession: null },
      }) as unknown;
      if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === 'function') {
        (maybePromise as Promise<unknown>).catch(() => {});
      }
    } catch {
      /* no window (SSR/test env) or goto unavailable */
    }
  }

  newSession(targetCwd?: string): void {
    if (this.pendingNewSession || this.sessionLoading) return;
    const requestId = this.nextRequestId();
    this.pendingResync = false;
    this.pendingRequestId = requestId;
    this.pendingNewSession = true;
    this.sessionLoading = true;
    this.startOpTimeout();
    const sent = this.send(
      targetCwd ? { type: 'new_session', targetCwd, requestId } : { type: 'new_session', requestId }
    );
    if (!sent) {
      this.clearOpTimeout();
      this.pendingNewSession = false;
      this.sessionLoading = false;
      this.retirePendingRequest();
    }
    this.dirCompletions = [];
  }

  addProject(path: string): void {
    this.send({ type: 'add_project', path });
    this.dirCompletions = [];
  }

  removeProject(cwd: string): void {
    this.send({ type: 'remove_project', cwd });
  }

  deleteProject(cwd: string): void {
    this.send({ type: 'delete_project', cwd });
  }

  setPinned(cwd: string, pinned: boolean): void {
    // Optimistic — server broadcast confirms.
    this.applyState({
      projects: this.projects.map((p) => (p.cwd === cwd ? { ...p, pinned } : p)),
    });
    this.send({ type: 'pin_project', cwd, pinned });
  }

  renameProject(cwd: string, name: string): void {
    this.send({ type: 'rename_project', cwd, name });
  }

  renameSession(path: string, name: string): void {
    this.send({ type: 'rename_session', path, name });
  }

  deleteSession(path: string): void {
    this.send({ type: 'delete_session', path });
  }

  requestDirCompletions(prefix: string): void {
    this.send({ type: 'dir_complete', prefix });
  }

  toggleCollapsed(cwd: string): void {
    if (this.collapsed.has(cwd)) this.collapsed.delete(cwd);
    else this.collapsed.add(cwd);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this.collapsed]));
      }
    } catch {
      /* quota */
    }
  }

  toggleExpandedGroup(cwd: string): void {
    if (this.expandedGroups.has(cwd)) this.expandedGroups.delete(cwd);
    else this.expandedGroups.add(cwd);
  }

  toggleSubsessions(sessionId: string): void {
    if (this.expandedSubsessions.has(sessionId)) this.expandedSubsessions.delete(sessionId);
    else this.expandedSubsessions.add(sessionId);
  }

  /**
   * Rows visible for a project in the sidebar. Search still shows every
   * matching row; otherwise the preview limit counts top-level rows only and
   * nested branches stay collapsed until their parent is expanded.
   *
   * The active session's ancestor path remains visible when its branch is
   * collapsed, so switching to a nested session never makes it disappear.
   */
  visibleSessions(g: ProjectGroup): SessionRow[] {
    let rows = g.sessions;
    if (!this.filter && !this.expandedGroups.has(g.cwd)) {
      rows = [];
      let roots = 0;
      for (const row of g.sessions) {
        if (row.depth === 0 && ++roots > SESSION_PREVIEW_LIMIT) break;
        rows.push(row);
      }
    }
    if (this.filter) return rows;

    const activeIndex = this.activeSessionId
      ? rows.findIndex((row) => row.session.id === this.activeSessionId)
      : -1;
    const activePath = new SvelteSet<number>();
    if (activeIndex >= 0) {
      let targetDepth = rows[activeIndex].depth;
      for (let i = activeIndex - 1; i >= 0; i--) {
        if (rows[i].depth < targetDepth) {
          activePath.add(i);
          targetDepth = rows[i].depth;
        }
      }
    }

    const out: SessionRow[] = [];
    const stack: SessionRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      while (stack.length > 0 && stack[stack.length - 1].depth >= row.depth) {
        stack.pop();
      }
      const blocked = stack.some(
        (ancestor) => ancestor.hasChildren && !this.expandedSubsessions.has(ancestor.session.id)
      );
      if (!blocked || i === activeIndex || activePath.has(i)) out.push(row);
      stack.push(row);
    }
    return out;
  }
}

export const projectsState = new ProjectsState();
