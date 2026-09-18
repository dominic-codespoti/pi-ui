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

  /** Project metadata normalized by cwd; public access remains array-shaped. */
  private projectByCwd = new SvelteMap<string, ProjectInfo>();
  /** Session summaries normalized by stable session id. */
  private sessionById = new SvelteMap<string, SessionSummary>();
  /** Stable session ids grouped by cwd, preserving server/list insertion order. */
  private sessionIdsByCwd = new SvelteMap<string, SvelteSet<string>>();
  /** Materialized groups; only groups touched by a state delta are rebuilt. */
  private groupByCwd = new SvelteMap<string, ProjectGroup>();
  /** Invalidates derived public collections after batched map updates. */
  private groupRevision = $state(0);

  /** Merged project list from the server (registry + session dirs). */
  get projects(): ProjectInfo[] {
    return [...this.projectByCwd.values()];
  }
  set projects(value: ProjectInfo[]) {
    const previous = new SvelteMap(this.projectByCwd);
    const next = new SvelteMap<string, ProjectInfo>();
    for (const project of value) next.set(project.cwd, project);

    const affected = new SvelteSet<string>();
    for (const [cwd, project] of previous) {
      const replacement = next.get(cwd);
      if (
        !replacement ||
        replacement.name !== project.name ||
        replacement.pinned !== project.pinned ||
        replacement.exists !== project.exists ||
        replacement.registered !== project.registered ||
        replacement.sessionCount !== project.sessionCount ||
        replacement.lastActivity !== project.lastActivity
      ) {
        affected.add(cwd);
      }
    }
    for (const cwd of next.keys()) {
      if (!previous.has(cwd)) affected.add(cwd);
    }

    this.projectByCwd.clear();
    for (const [cwd, project] of next) this.projectByCwd.set(cwd, project);
    for (const cwd of affected) this.rebuildProjectGroup(cwd);
    this.groupRevision++;
  }

  /** All sessions across all projects, exposed as the historical array API. */
  get allSessions(): SessionSummary[] {
    return [...this.sessionById.values()];
  }
  set allSessions(value: SessionSummary[]) {
    const affected = new SvelteSet<string>();
    for (const session of this.sessionById.values()) {
      const cwd = session.cwd ?? '';
      if (cwd) affected.add(cwd);
    }

    // Map normalization makes pooled/in-memory sessions with the same path
    // independent and ensures every later delta addresses one stable id.
    const normalized = new SvelteMap<string, SessionSummary>();
    for (const session of value) normalized.set(session.id, session);

    this.sessionById.clear();
    this.sessionIdsByCwd.clear();
    for (const session of normalized.values()) {
      this.sessionById.set(session.id, session);
      const cwd = session.cwd ?? '';
      if (!cwd) continue;
      let ids = this.sessionIdsByCwd.get(cwd);
      if (!ids) {
        ids = new SvelteSet<string>();
        this.sessionIdsByCwd.set(cwd, ids);
      }
      ids.add(session.id);
      affected.add(cwd);
    }
    for (const cwd of affected) this.rebuildProjectGroup(cwd);
    this.groupRevision++;
  }

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
  private retiredRequestIds = new SvelteSet<string>();
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
    // No state delta has populated the indexes yet; reading the revision also
    // keeps this derived value invalidated when the batched indexes change.
    if (this.groupRevision === 0) return [];
    const out: ProjectGroup[] = [];
    const known = new SvelteSet<string>();
    for (const cwd of this.projectByCwd.keys()) {
      const group = this.groupByCwd.get(cwd);
      if (group) {
        out.push(group);
        known.add(cwd);
      }
    }
    // Sessions in directories the server list doesn't know yet (e.g. before
    // the first projects_list arrives) are materialized as fallback groups.
    for (const [cwd, group] of this.groupByCwd) {
      if (!known.has(cwd)) out.push(group);
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

  /** Rebuild one project group from its normalized session bucket. */
  private rebuildProjectGroup(cwd: string): void {
    const project = this.projectByCwd.get(cwd);
    const ids = this.sessionIdsByCwd.get(cwd);
    if (!project && (!ids || ids.size === 0)) {
      this.groupByCwd.delete(cwd);
      return;
    }

    const sessions: SessionSummary[] = [];
    let lastActivity = 0;
    if (ids) {
      for (const id of ids) {
        const session = this.sessionById.get(id);
        if (!session) continue;
        sessions.push(session);
        if (session.modified > lastActivity) lastActivity = session.modified;
      }
    }

    this.groupByCwd.set(
      cwd,
      project
        ? { ...project, sessions: buildSessionRows(sessions) }
        : {
            cwd,
            name: pathBasename(cwd),
            pinned: false,
            exists: true,
            registered: false,
            sessionCount: sessions.length,
            lastActivity,
            sessions: buildSessionRows(sessions),
          }
    );
  }

  /** Upsert one session and rebuild only its previous/current project groups. */
  private upsertSession(session: SessionSummary): void {
    const previous = this.sessionById.get(session.id);
    const previousCwd = previous?.cwd ?? '';
    const nextCwd = session.cwd ?? '';
    this.sessionById.set(session.id, session);

    if (previousCwd !== nextCwd) {
      if (previousCwd) {
        const oldIds = this.sessionIdsByCwd.get(previousCwd);
        oldIds?.delete(session.id);
        if (oldIds && oldIds.size === 0) this.sessionIdsByCwd.delete(previousCwd);
      }
      if (nextCwd) {
        let nextIds = this.sessionIdsByCwd.get(nextCwd);
        if (!nextIds) {
          nextIds = new SvelteSet<string>();
          this.sessionIdsByCwd.set(nextCwd, nextIds);
        }
        nextIds.add(session.id);
      }
    } else if (!previous && nextCwd) {
      let ids = this.sessionIdsByCwd.get(nextCwd);
      if (!ids) {
        ids = new SvelteSet<string>();
        this.sessionIdsByCwd.set(nextCwd, ids);
      }
      ids.add(session.id);
    }

    if (previousCwd) this.rebuildProjectGroup(previousCwd);
    if (nextCwd && nextCwd !== previousCwd) this.rebuildProjectGroup(nextCwd);
    this.groupRevision++;
  }

  /** Remove runtime snapshots for sessions that disappeared from the authoritative list. */
  private pruneRuntimeState(previousSessionIds: ReadonlySet<string>): void {
    const knownIds = new SvelteSet(this.sessionById.keys());
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
   * The normalized session/project indexes and materialized groups are updated
   * through this single method so cross-field invariants stay synchronized.
   */
  applyState(payload: { projects?: ProjectInfo[]; sessions?: SessionSummary[] }): void {
    if (payload.projects !== undefined) this.projects = payload.projects;
    if (payload.sessions !== undefined) {
      const previousSessionIds = new SvelteSet(this.sessionById.keys());
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
        const session = msg.session as SessionSummary | undefined;
        if (session && typeof session.id === 'string') this.upsertSession(session);
        return true;
      }
      case 'sessions_list':
        // all_sessions_list is the source of truth — just clear transient state.
        this.error = null;
        return true;
      case 'sessions_error': {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
        // Only a correlated in-flight operation may settle the current
        // operation. Retired responses are late duplicates; an unstamped error
        // with no operation has no safe owner.
        if (
          (requestId !== undefined && this.isRetiredRequest(requestId)) ||
          (requestId === undefined && !this.pendingNewSession && !this.sessionLoading) ||
          (this.pendingRequestId !== null && requestId !== this.pendingRequestId)
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
   * The server always stamps the requester's snapshot with `requestId`.
   * Unstamped snapshots are foreign-switch broadcasts from other tabs and
   * never settle a pending operation.
   */
  onSessionLoaded(requestId?: string): boolean {
    const hadPendingOperation = this.pendingNewSession || this.sessionLoading;
    if (this.pendingRequestId !== null) {
      if (requestId === undefined || requestId !== this.pendingRequestId) return false;
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

  renameSession(sessionId: string, name: string): void {
    this.send({ type: 'rename_session', sessionId, name });
  }

  deleteSession(sessionId: string): void {
    this.send({ type: 'delete_session', sessionId });
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
      // The active session and its ancestor path always stay visible, even
      // when ranked past the preview limit — otherwise the sidebar shows no
      // selection for the session currently in view.
      const keep = new SvelteSet<number>();
      if (this.activeSessionId) {
        const activeIndex = g.sessions.findIndex((row) => row.session.id === this.activeSessionId);
        if (activeIndex >= 0) {
          keep.add(activeIndex);
          let targetDepth = g.sessions[activeIndex].depth;
          for (let i = activeIndex - 1; i >= 0; i--) {
            if (g.sessions[i].depth < targetDepth) {
              keep.add(i);
              targetDepth = g.sessions[i].depth;
            }
          }
        }
      }
      rows = [];
      let roots = 0;
      let skipping = false;
      for (let i = 0; i < g.sessions.length; i++) {
        const row = g.sessions[i];
        if (row.depth === 0) skipping = ++roots > SESSION_PREVIEW_LIMIT && !keep.has(i);
        if (!skipping || keep.has(i)) rows.push(row);
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
