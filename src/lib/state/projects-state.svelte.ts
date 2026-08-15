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
  sessions: SessionSummary[];
}

const COLLAPSED_KEY = 'pifrontier:collapsed-projects';

/** How many sessions a project shows before the "show more" toggle. */
export const SESSION_PREVIEW_LIMIT = 5;

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
  /** True while a session switch is in flight. Set by switchSession, cleared by session_loaded. */
  sessionLoading = $state(false);
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

    const out: ProjectGroup[] = this.projects.map((p) => ({
      ...p,
      sessions: byCwd.get(p.cwd) ?? [],
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
        lastActivity: Math.max(...sessions.map((s) => s.modified)),
        sessions,
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
      .map((g) => ({
        ...g,
        sessions: g.sessions.filter(
          (s) =>
            g.name.toLowerCase().includes(q) ||
            (s.name ?? '').toLowerCase().includes(q) ||
            (s.firstMessage ?? '').toLowerCase().includes(q)
        ),
      }))
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
      case 'sessions_error':
        this.error = (msg.message as string) ?? 'Unknown error';
        this.pendingNewSession = false;
        this.sessionLoading = false;
        return true;
      case 'dir_completions':
        this.dirCompletions = (msg.entries as string[]) ?? [];
        return true;
      default:
        return false;
    }
  }

  /**
   * Called by the page when session_loaded arrives.
   * Returns true when this completed a pending new-session request.
   */
  onSessionLoaded(): boolean {
    const wasPending = this.pendingNewSession;
    this.pendingNewSession = false;
    this.sessionLoading = false;
    return wasPending;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  switchSession(path: string): void {
    if (this.pendingNewSession || this.sessionLoading) return;
    const sent = this.send({ type: 'switch_session', path });
    if (!sent) return;
    this.pendingSwitchPath = path;
    this.sessionLoading = true;
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
    goto(url, { shallow: true, replace: true, state }).catch(() => {
      /* best-effort URL sync — never block session switching */
    });
  }

  newSession(targetCwd?: string): void {
    if (this.pendingNewSession || this.sessionLoading) return;
    const sent = this.send(
      targetCwd ? { type: 'new_session', targetCwd } : { type: 'new_session' }
    );
    if (sent) {
      this.pendingNewSession = true;
      this.sessionLoading = true;
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

  visibleSessions(g: ProjectGroup): SessionSummary[] {
    return this.expandedGroups.has(g.cwd) ? g.sessions : g.sessions.slice(0, SESSION_PREVIEW_LIMIT);
  }
}

export const projectsState = new ProjectsState();
