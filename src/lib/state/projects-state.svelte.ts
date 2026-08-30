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

/** A project with its sessions attached — the unit the UI renders. */
export interface ProjectGroup extends ProjectInfo {
  sessions: SessionRow[];
}

/** One flattened display row: a session plus its nesting depth in the substack tree. */
export interface SessionRow {
  session: SessionSummary;
  depth: number;
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
      rows.push({ session: node.session, depth });
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
 * tens of ms, but a dropped socket or a busy SDK must not leave the sidebar
 * and composer disabled forever — before this watchdog only a full reload
 * healed a lost reply.
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

type SessionLoadedIdentity = {
  sessionId?: string;
  sessionPath?: string;
  requestId?: string;
};

type SessionOperationKind = 'new' | 'switch';

class ProjectsState {
  /** Wired by the page to the live WebSocket sender. Returns true if the message was sent. */
  send: (msg: ClientMessage) => boolean = () => false;
  /** Optional callback invoked before switching to a new session (e.g. to save view state). */
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

  /** Sidebar search text. */
  filter = $state('');
  /** Last error from session/project operations. */
  error = $state<string | null>(null);
  /** True while waiting for the server to answer new_session. */
  pendingNewSession = $state(false);
  /** Directory completions for the directory picker inputs. */
  dirCompletions = $state<string[]>([]);

  /** Session ids with unseen results since the last switch (ephemeral). */
  uncheckedSessions = new SvelteSet<string>();
  /** Session ids that are currently generating (agent_start … agent_end). */
  runningSessions = new SvelteSet<string>();
  /** Session path from the most recent switch_session — consumed by the page for URL sync. */
  pendingSwitchPath: string | null = null;
  /** Optimistic ?session= URL updates are revertible until confirmed: set by
   * switchSession after its shallow goto, consumed by the page on success
   * (param rewritten from pendingSwitchPath), reverted on failure/timeout. */
  pendingUrlRevert = false;
  private urlParamBeforeSwitch: string | null = null;
  /** True while a session switch is in flight. Set by switchSession, cleared by session_loaded. */
  sessionLoading = $state(false);
  /** Watchdog for in-flight new_session/switch_session — see SESSION_OP_TIMEOUT_MS. */
  private opTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic token used to reject late replies from timed-out operations. */
  private sessionOperationSeq = 0;
  private pendingSessionRequestId: string | null = null;
  private pendingSessionKind: 'new' | 'switch' | null = null;
  private pendingSessionBaseId: string | null = null;
  collapsed = new SvelteSet<string>(loadCollapsed());
  /** Projects whose full session list is expanded past the preview limit. */
  expandedGroups = new SvelteSet<string>();
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

  // ── Server message intake ────────────────────────────────────────────────

  /**
   * Apply a partial state update atomically.
   * `groups` is derived from both `projects` and `allSessions` — updating them
   * through this single method makes the relationship explicit and ensures any
   * future cross-field invariants are enforced in one place.
   */
  applyState(payload: { projects?: ProjectInfo[]; sessions?: SessionSummary[] }): void {
    if (payload.projects !== undefined) this.projects = payload.projects;
    if (payload.sessions !== undefined) this.allSessions = payload.sessions;
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
        // Live delta for one pooled session (coalesced server-side). Upsert by
        // id — the derived groups re-sort by recency automatically.
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
        const requestId = typeof msg.requestId === 'string' ? (msg.requestId as string) : undefined;
        if (!this.acceptsSessionOperation(requestId)) return true;
        this.clearOpTimeout();
        this.clearSessionOperation();
        this.error = (msg.message as string) ?? 'Unknown error';
        this.pendingNewSession = false;
        this.sessionLoading = false;
        this.pendingSwitchPath = null;
        return true;
      }
      case 'dir_completions':
        this.dirCompletions = (msg.entries as string[]) ?? [];
        return true;
      default:
        return false;
    }
  }

  /**
   * Whether a full session snapshot belongs to the current operation or
   * already-active session. The request token is authoritative; path/id
   * fallbacks keep older development servers usable.
   */
  acceptsSessionLoaded(identity: SessionLoadedIdentity): boolean {
    if (this.pendingSessionRequestId !== null) {
      if (identity.requestId) return identity.requestId === this.pendingSessionRequestId;
      if (this.pendingSessionKind === 'switch' && identity.sessionPath) {
        return identity.sessionPath === this.pendingSwitchPath;
      }
      return identity.sessionId !== this.pendingSessionBaseId;
    }
    // Internal operations (fork/edit/compaction) do not carry a requestId.
    // Correlated snapshots from a completed operation are only valid when
    // they still describe the active session; a late prior response is not.
    return identity.requestId === undefined || identity.sessionId === this.activeSessionId;
  }

  /** Whether an operation error belongs to the currently pending request. */
  acceptsSessionOperation(requestId?: string): boolean {
    return (
      this.pendingSessionRequestId === null ||
      requestId === undefined ||
      requestId === this.pendingSessionRequestId
    );
  }

  /**
   * Called by the page when session_loaded arrives.
   * Returns true when this completed a pending new-session request.
   */
  onSessionLoaded(identity?: SessionLoadedIdentity): boolean {
    if (identity && !this.acceptsSessionLoaded(identity)) return false;
    this.clearOpTimeout();
    const wasPending = this.pendingNewSession;
    this.clearSessionOperation();
    this.pendingNewSession = false;
    this.sessionLoading = false;
    return wasPending;
  }

  private clearSessionOperation(): void {
    this.pendingSessionRequestId = null;
    this.pendingSessionKind = null;
    this.pendingSessionBaseId = null;
  }

  private beginSessionOperation(kind: SessionOperationKind): string {
    const requestId = `session-op-${++this.sessionOperationSeq}`;
    this.pendingSessionRequestId = requestId;
    this.pendingSessionKind = kind;
    this.pendingSessionBaseId = this.activeSessionId;
    return requestId;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  /** Arm the in-flight-op watchdog — clears the loading flags if no reply comes. */
  private startOpTimeout(): void {
    this.clearOpTimeout();
    const requestId = this.pendingSessionRequestId;
    const kind = this.pendingSessionKind;
    this.opTimeout = setTimeout(() => {
      this.opTimeout = null;
      if (requestId !== this.pendingSessionRequestId) return;
      if (this.pendingNewSession || this.sessionLoading) {
        if (kind === 'new') this.error = 'New chat timed out — server did not respond in time';
        else if (kind === 'switch') this.error = 'Session switch timed out';
        this.clearSessionOperation();
        this.pendingNewSession = false;
        this.sessionLoading = false;
        this.pendingSwitchPath = null;
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
   * old request is orphaned (its reply would land on the dead socket), and
   * the connected payload carries the server's real active session — so any
   * half-applied flags and a stale pending switch path must not survive.
   */
  cancelPendingOps(): void {
    this.clearOpTimeout();
    this.clearSessionOperation();
    this.pendingNewSession = false;
    this.sessionLoading = false;
    this.pendingSwitchPath = null;
    // Context unknown (disconnect/reset) — drop any revert intent silently.
    this.pendingUrlRevert = false;
  }
  switchSession(path: string): 'ok' | 'busy' | 'offline' {
    if (this.pendingNewSession || this.sessionLoading) return 'busy';
    const requestId = this.beginSessionOperation('switch');
    this.pendingSwitchPath = path;
    this.sessionLoading = true;
    this.startOpTimeout();
    const sent = this.send({ type: 'switch_session', path, requestId });
    if (!sent) {
      this.clearOpTimeout();
      this.clearSessionOperation();
      this.sessionLoading = false;
      this.pendingSwitchPath = null;
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
    const s = this.allSessions.find((s) => s.path === path);
    if (s) this.uncheckedSessions.delete(s.id);
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
    goto(url, { shallow: true, replace: true, state }).catch(() => {
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
      const maybePromise = goto(url, { shallow: true, replace: true, state }) as unknown;
      if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === 'function') {
        (maybePromise as Promise<unknown>).catch(() => {});
      }
    } catch {
      /* no window (SSR/test env) or goto unavailable */
    }
  }

  newSession(targetCwd?: string): void {
    if (this.pendingNewSession || this.sessionLoading) return;
    const requestId = this.beginSessionOperation('new');
    this.pendingNewSession = true;
    this.sessionLoading = true;
    this.startOpTimeout();
    const sent = this.send(
      targetCwd ? { type: 'new_session', targetCwd, requestId } : { type: 'new_session', requestId }
    );
    if (!sent) {
      this.clearOpTimeout();
      this.clearSessionOperation();
      this.pendingNewSession = false;
      this.sessionLoading = false;
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

  markUnchecked(sessionId: string): void {
    this.uncheckedSessions.add(sessionId);
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

  /**
   * Rows visible for a project in the sidebar. A search filter shows every
   * match; otherwise the preview limit counts top-level rows only — each
   * shown root keeps its complete (always-expanded) substack, whose children
   * never consume slots.
   */
  visibleSessions(g: ProjectGroup): SessionRow[] {
    if (this.filter || this.expandedGroups.has(g.cwd)) return g.sessions;
    const out: SessionRow[] = [];
    let roots = 0;
    for (const row of g.sessions) {
      if (row.depth === 0 && ++roots > SESSION_PREVIEW_LIMIT) break; // next root + its subtree
      out.push(row);
    }
    return out;
  }
}

export const projectsState = new ProjectsState();
