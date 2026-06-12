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

import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { ClientMessage, ProjectInfo, SessionSummary } from '$lib/ws/protocol';

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
  /** Wired by the page to the live WebSocket sender. */
  send: (msg: ClientMessage) => void = () => {};

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
  /** Collapsed project cwds in the sidebar — persisted across reloads. */
  collapsed = new SvelteSet<string>(loadCollapsed());
  /** Projects whose full session list is expanded past the preview limit. */
  expandedGroups = new SvelteSet<string>();

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
      .filter((g) => g.sessions.length > 0 || g.name.toLowerCase().includes(q) || g.cwd.toLowerCase().includes(q));
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

  /** Refresh both lists — called on connect and when the sidebar opens. */
  refresh(): void {
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
        this.projects = (msg.projects as ProjectInfo[]) ?? [];
        return true;
      case 'all_sessions_list':
        this.allSessions = (msg.sessions as SessionSummary[]) ?? [];
        return true;
      case 'sessions_list':
        // all_sessions_list is the source of truth — just clear transient state.
        this.error = null;
        return true;
      case 'sessions_error':
        this.error = (msg.message as string) ?? 'Unknown error';
        this.pendingNewSession = false;
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
    return wasPending;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  switchSession(path: string): void {
    this.send({ type: 'switch_session', path });
    const s = this.allSessions.find((s) => s.path === path);
    if (s) this.uncheckedSessions.delete(s.id);
  }

  newSession(targetCwd?: string): void {
    this.send(targetCwd ? { type: 'new_session', targetCwd } : { type: 'new_session' });
    this.pendingNewSession = true;
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
    this.projects = this.projects.map((p) => (p.cwd === cwd ? { ...p, pinned } : p));
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
