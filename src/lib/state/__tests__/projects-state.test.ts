import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionSummary } from '#lib/ws/protocol.js';
import {
  buildSessionRows,
  projectsState,
  pathBasename,
  SESSION_OP_TIMEOUT_MS,
  type ProjectGroup,
} from '../projects-state.svelte';

/** Minimal SessionSummary with per-field overrides for tree/filter fixtures. */
const mkSession = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  path: `/p/${id}.jsonl`,
  cwd: '/p',
  name: '',
  created: 0,
  modified: 0,
  messageCount: 0,
  firstMessage: '',
  ...overrides,
});

describe('pathBasename', () => {
  it('extracts basename from path', () => {
    expect(pathBasename('/home/user/project')).toBe('project');
  });

  it('handles trailing slash', () => {
    expect(pathBasename('/home/user/project/')).toBe('project');
  });

  it('handles root path', () => {
    expect(pathBasename('/')).toBe('/');
  });

  it('handles empty string', () => {
    expect(pathBasename('')).toBe('');
  });
});

describe('buildSessionRows', () => {
  it('nests a child under its parent with depth 1', () => {
    const rows = buildSessionRows([
      mkSession('parent'),
      mkSession('child', { parentSession: '/p/parent.jsonl' }),
    ]);
    expect(rows.map((r) => [r.session.id, r.depth])).toEqual([
      ['parent', 0],
      ['child', 1],
    ]);
  });

  it('nests a subagent task session referencing its parent by bare id', () => {
    // Subagent tasks write parentSession as the parent's session id, not path.
    const rows = buildSessionRows([
      mkSession('parent'),
      mkSession('task', { parentSession: 'parent' }),
    ]);
    expect(rows.map((r) => [r.session.id, r.depth])).toEqual([
      ['parent', 0],
      ['task', 1],
    ]);
  });

  it('orders sibling children by subtree recency, not input order', () => {
    const rows = buildSessionRows([
      mkSession('parent', { modified: 5 }),
      mkSession('old-child', { parentSession: '/p/parent.jsonl', modified: 10 }),
      mkSession('new-child', { parentSession: '/p/parent.jsonl', modified: 20 }),
    ]);
    expect(rows.map((r) => r.session.id)).toEqual(['parent', 'new-child', 'old-child']);
  });

  it('keeps a newer child attached below its root instead of floating above other roots', () => {
    const rows = buildSessionRows([
      mkSession('root-a'),
      mkSession('root-b'),
      mkSession('child-of-a', { parentSession: '/p/root-a.jsonl', modified: 999 }),
    ]);
    expect(rows.map((r) => [r.session.id, r.depth])).toEqual([
      ['root-a', 0],
      ['child-of-a', 1],
      ['root-b', 0],
    ]);
  });

  it('renders an orphan child (unknown parent path) as a root', () => {
    const rows = buildSessionRows([mkSession('orphan', { parentSession: '/p/gone.jsonl' })]);
    expect(rows.map((r) => [r.session.id, r.depth])).toEqual([['orphan', 0]]);
  });

  it('renders a self-parenting session as a root', () => {
    const rows = buildSessionRows([mkSession('loop', { parentSession: '/p/loop.jsonl' })]);
    expect(rows.map((r) => [r.session.id, r.depth])).toEqual([['loop', 0]]);
  });

  it('renders a two-session parentSession cycle as roots — nothing dropped', () => {
    const rows = buildSessionRows([
      mkSession('a', { parentSession: '/p/b.jsonl' }),
      mkSession('b', { parentSession: '/p/a.jsonl' }),
    ]);
    expect(rows.map((r) => [r.session.id, r.depth])).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
  });

  it('renders duplicate-path sessions (pooled in-memory) as separate roots', () => {
    const rows = buildSessionRows([
      mkSession('m1', { path: '(in-memory)' }),
      mkSession('m2', { path: '(in-memory)', parentSession: '(in-memory)' }),
    ]);
    expect(rows.map((r) => [r.session.id, r.depth])).toEqual([
      ['m1', 0],
      ['m2', 0],
    ]);
  });
});

describe('ProjectsState', () => {
  beforeEach(() => {
    // Reset state before each test
    projectsState.projects = [];
    projectsState.allSessions = [];
    projectsState.cwd = '';
    projectsState.activeSessionId = null;
    projectsState.isStreaming = false;
    projectsState.filter = '';
    projectsState.error = null;
    projectsState.pendingNewSession = false;
    projectsState.sessionLoading = false;
    projectsState.dirCompletions = [];
    projectsState.collapsed.clear();
    projectsState.expandedGroups.clear();
    projectsState.cancelPendingOps();
  });

  afterEach(() => {
    projectsState.cancelPendingOps();
    vi.useRealTimers();
  });

  describe('groups derived', () => {
    it('returns empty groups when no projects or sessions', () => {
      expect(projectsState.groups).toEqual([]);
    });

    it('creates groups from projects list', () => {
      projectsState.projects = [
        {
          cwd: '/a',
          name: 'A',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 0,
          lastActivity: 100,
        },
      ];
      expect(projectsState.groups).toHaveLength(1);
      expect(projectsState.groups[0].name).toBe('A');
    });

    it('creates fallback groups from sessions without matching projects', () => {
      projectsState.allSessions = [
        {
          id: 's1',
          path: '/s1',
          cwd: '/orphan',
          name: '',
          created: 1,
          modified: 2,
          messageCount: 0,
          firstMessage: '',
        },
      ];
      const groups = projectsState.groups;
      const orphan = groups.find((g) => g.cwd === '/orphan');
      expect(orphan).toBeDefined();
      expect(orphan!.registered).toBe(false);
      expect(orphan!.sessions).toHaveLength(1);
    });

    it('sorts pinned projects first, then by lastActivity', () => {
      projectsState.projects = [
        {
          cwd: '/a',
          name: 'A',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 0,
          lastActivity: 10,
        },
        {
          cwd: '/b',
          name: 'B',
          pinned: true,
          exists: true,
          registered: true,
          sessionCount: 0,
          lastActivity: 5,
        },
        {
          cwd: '/c',
          name: 'C',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 0,
          lastActivity: 20,
        },
      ];
      expect(projectsState.groups[0].cwd).toBe('/b');
      expect(projectsState.groups[1].cwd).toBe('/c');
      expect(projectsState.groups[2].cwd).toBe('/a');
    });

    it('attaches matching sessions to projects', () => {
      projectsState.projects = [
        {
          cwd: '/p',
          name: 'P',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 1,
          lastActivity: 100,
        },
      ];
      projectsState.allSessions = [
        {
          id: 's1',
          path: '/p/s1.jsonl',
          cwd: '/p',
          name: '',
          created: 1,
          modified: 2,
          messageCount: 5,
          firstMessage: 'hi',
        },
      ];
      expect(projectsState.groups[0].sessions).toHaveLength(1);
      expect(projectsState.groups[0].sessions[0].session.id).toBe('s1');
    });
  });

  describe('filteredGroups', () => {
    it('returns all groups when filter is empty', () => {
      projectsState.projects = [
        {
          cwd: '/a',
          name: 'Alpha',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 0,
          lastActivity: 0,
        },
        {
          cwd: '/b',
          name: 'Beta',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 0,
          lastActivity: 0,
        },
      ];
      expect(projectsState.filteredGroups).toHaveLength(2);
    });

    it('filters groups by project name', () => {
      projectsState.projects = [
        {
          cwd: '/a',
          name: 'Alpha',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 0,
          lastActivity: 0,
        },
        {
          cwd: '/b',
          name: 'Beta',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 0,
          lastActivity: 0,
        },
      ];
      projectsState.filter = 'alpha';
      expect(projectsState.filteredGroups).toHaveLength(1);
      expect(projectsState.filteredGroups[0].name).toBe('Alpha');
    });

    it('filters sessions within groups by session name', () => {
      projectsState.projects = [
        {
          cwd: '/p',
          name: 'P',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 2,
          lastActivity: 100,
        },
      ];
      projectsState.allSessions = [
        {
          id: 's1',
          path: '/p/s1.jsonl',
          cwd: '/p',
          name: 'Feature X',
          created: 1,
          modified: 2,
          messageCount: 0,
          firstMessage: '',
        },
        {
          id: 's2',
          path: '/p/s2.jsonl',
          cwd: '/p',
          name: 'Bug Y',
          created: 1,
          modified: 2,
          messageCount: 0,
          firstMessage: '',
        },
      ];
      projectsState.filter = 'feature';
      expect(projectsState.filteredGroups[0].sessions.map((r) => r.session.id)).toEqual(['s1']);
    });
    it('keeps a matching child anchored under its non-matching parent chain', () => {
      projectsState.projects = [
        {
          cwd: '/p',
          name: 'P',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 3,
          lastActivity: 100,
        },
      ];
      projectsState.allSessions = [
        mkSession('parent', { name: 'Refactor task' }),
        mkSession('kid-match', { parentSession: '/p/parent.jsonl', name: 'Feature X' }),
        mkSession('kid-quiet', { parentSession: '/p/parent.jsonl', name: 'Chores' }),
      ];
      projectsState.filter = 'feature';
      expect(projectsState.filteredGroups[0].sessions.map((r) => r.session.id)).toEqual([
        'parent',
        'kid-match',
      ]);
    });

    it('keeps every nested row when the project name matches', () => {
      projectsState.projects = [
        {
          cwd: '/p',
          name: 'P',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 3,
          lastActivity: 100,
        },
      ];
      projectsState.allSessions = [
        mkSession('parent', { name: 'Refactor task' }),
        mkSession('kid-match', { parentSession: '/p/parent.jsonl', name: 'Feature X' }),
        mkSession('kid-quiet', { parentSession: '/p/parent.jsonl', name: 'Chores' }),
      ];
      projectsState.filter = 'p';
      expect(projectsState.filteredGroups[0].sessions).toHaveLength(3);
    });
  });

  describe('activeProject', () => {
    it('returns null when no cwd is set', () => {
      expect(projectsState.activeProject).toBeNull();
    });

    it('returns the group matching cwd', () => {
      projectsState.projects = [
        {
          cwd: '/active',
          name: 'Active',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 0,
          lastActivity: 0,
        },
      ];
      projectsState.cwd = '/active';
      expect(projectsState.activeProject?.cwd).toBe('/active');
    });
  });

  describe('handleMessage', () => {
    it('handles projects_list', () => {
      projectsState.handleMessage({
        type: 'projects_list',
        projects: [{ cwd: '/p', name: 'P' }],
      } as { type: string } & Record<string, unknown>);
      expect(projectsState.projects).toHaveLength(1);
    });

    it('handles all_sessions_list', () => {
      projectsState.handleMessage({ type: 'all_sessions_list', sessions: [{ id: 's1' }] } as {
        type: string;
      } & Record<string, unknown>);
      expect(projectsState.allSessions).toHaveLength(1);
    });

    it('handles sessions_error', () => {
      projectsState.sessionLoading = true;
      projectsState.pendingNewSession = true;
      projectsState.handleMessage({ type: 'sessions_error', message: 'oops' } as {
        type: string;
      } & Record<string, unknown>);
      expect(projectsState.error).toBe('oops');
      expect(projectsState.pendingNewSession).toBe(false);
      expect(projectsState.sessionLoading).toBe(false);
    });

    it('handles dir_completions', () => {
      projectsState.handleMessage({ type: 'dir_completions', entries: ['/a/', '/b/'] } as {
        type: string;
      } & Record<string, unknown>);
      expect(projectsState.dirCompletions).toEqual(['/a/', '/b/']);
    });

    it('appends a new session from session_updated', () => {
      projectsState.handleMessage({
        type: 'session_updated',
        session: {
          id: 'new1',
          path: '/p/new1.jsonl',
          cwd: '/p',
          name: '',
          created: 1,
          modified: 5,
          messageCount: 3,
          firstMessage: 'hi',
        },
      } as { type: string } & Record<string, unknown>);
      expect(projectsState.allSessions).toHaveLength(1);
      expect(projectsState.allSessions[0].id).toBe('new1');
    });

    it('replaces an existing session by id from session_updated', () => {
      projectsState.allSessions = [
        {
          id: 's1',
          path: '/p/s1.jsonl',
          cwd: '/p',
          name: 'old name',
          created: 1,
          modified: 2,
          messageCount: 1,
          firstMessage: 'before',
        },
      ];
      projectsState.handleMessage({
        type: 'session_updated',
        session: {
          id: 's1',
          path: '/p/s1.jsonl',
          cwd: '/p',
          name: 'renamed',
          created: 1,
          modified: 9,
          messageCount: 12,
          firstMessage: 'after',
        },
      } as { type: string } & Record<string, unknown>);
      expect(projectsState.allSessions).toHaveLength(1);
      expect(projectsState.allSessions[0]).toMatchObject({ name: 'renamed', messageCount: 12 });
    });

    it('re-sorts sessions within a project when a delta bumps recency', () => {
      projectsState.projects = [
        {
          cwd: '/p',
          name: 'P',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 2,
          lastActivity: 0,
        },
      ];
      projectsState.allSessions = [
        {
          id: 'older',
          path: '/p/older.jsonl',
          cwd: '/p',
          created: 1,
          modified: 100,
          messageCount: 1,
          firstMessage: 'old',
        },
        {
          id: 'newer',
          path: '/p/newer.jsonl',
          cwd: '/p',
          created: 1,
          modified: 200,
          messageCount: 1,
          firstMessage: 'new',
        },
      ];
      expect(projectsState.groups[0].sessions.map((r) => r.session.id)).toEqual(['newer', 'older']);

      // Live delta: 'older' runs again — its row must move to the top without
      // a full all_sessions_list arriving.
      projectsState.handleMessage({
        type: 'session_updated',
        session: {
          id: 'older',
          path: '/p/older.jsonl',
          cwd: '/p',
          created: 1,
          modified: 300,
          messageCount: 2,
          firstMessage: 'old but active',
        },
      } as { type: string } & Record<string, unknown>);
      expect(projectsState.groups[0].sessions.map((r) => r.session.id)).toEqual(['older', 'newer']);
    });

    it('keeps the list fresh-guarded after a full list arrives', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.handleMessage({ type: 'all_sessions_list', sessions: [{ id: 's1' }] } as {
        type: string;
      } & Record<string, unknown>);
      projectsState.refresh(); // fresh — must not re-request
      expect(send).not.toHaveBeenCalled();
    });

    it('refresh() skips when fresh and has data, force bypasses', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.handleMessage({ type: 'all_sessions_list', sessions: [] } as {
        type: string;
      } & Record<string, unknown>);
      projectsState.handleMessage({ type: 'projects_list', projects: [] } as {
        type: string;
      } & Record<string, unknown>);
      // projects.length === 0 — freshness guard needs data, so this fetches
      expect(send).toHaveBeenCalledTimes(0);
      projectsState.refresh();
      expect(send).toHaveBeenCalledTimes(2);
      // Now data exists and the list just arrived — skip
      projectsState.handleMessage({ type: 'all_sessions_list', sessions: [{ id: 's1' }] } as {
        type: string;
      } & Record<string, unknown>);
      projectsState.handleMessage({ type: 'projects_list', projects: [{ cwd: '/p' }] } as {
        type: string;
      } & Record<string, unknown>);
      send.mockClear();
      projectsState.refresh();
      expect(send).not.toHaveBeenCalled();
      // force bypasses the guard
      projectsState.refresh({ force: true });
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('actions', () => {
    it('switchSession sends message and clears unchecked', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.allSessions = [
        {
          id: 's1',
          path: '/s1',
          cwd: '',
          name: '',
          created: 1,
          modified: 2,
          messageCount: 0,
          firstMessage: '',
        },
      ];
      projectsState.uncheckedSessions.add('s1');
      projectsState.switchSession('/s1');
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'switch_session',
          path: '/s1',
          requestId: expect.any(String),
        })
      );
      expect(projectsState.uncheckedSessions.has('s1')).toBe(false);
    });

    it('newSession sets pending and loading flags when send succeeds', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.newSession();
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'new_session', requestId: expect.any(String) })
      );
      expect(projectsState.pendingNewSession).toBe(true);
      expect(projectsState.sessionLoading).toBe(true);
    });

    it('newSession ignores duplicate requests while one is pending', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.newSession();
      projectsState.newSession('/another/project');
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('newSession does not set pending or loading when send fails', () => {
      const send = vi.fn().mockReturnValue(false);
      projectsState.send = send;
      projectsState.newSession();
      expect(projectsState.pendingNewSession).toBe(false);
      expect(projectsState.sessionLoading).toBe(false);
    });

    it('addProject sends message and clears completions', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.dirCompletions = ['/a/'];
      projectsState.addProject('/a');
      expect(send).toHaveBeenCalledWith({ type: 'add_project', path: '/a' });
      expect(projectsState.dirCompletions).toEqual([]);
    });

    it('setPinned sends message and optimistically updates', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.projects = [
        {
          cwd: '/p',
          name: 'P',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 0,
          lastActivity: 0,
        },
      ];
      projectsState.setPinned('/p', true);
      expect(projectsState.projects[0].pinned).toBe(true);
      expect(send).toHaveBeenCalledWith({ type: 'pin_project', cwd: '/p', pinned: true });
    });

    it('renameSession sends message', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.renameSession('/path', 'New Name');
      expect(send).toHaveBeenCalledWith({
        type: 'rename_session',
        path: '/path',
        name: 'New Name',
      });
    });

    it('deleteSession sends message', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.deleteSession('/path');
      expect(send).toHaveBeenCalledWith({ type: 'delete_session', path: '/path' });
    });

    it('requestDirCompletions sends message', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.requestDirCompletions('~/projects/');
      expect(send).toHaveBeenCalledWith({ type: 'dir_complete', prefix: '~/projects/' });
    });

    it('onSessionLoaded clears pending and loading flags', () => {
      projectsState.pendingNewSession = true;
      projectsState.sessionLoading = true;
      expect(projectsState.onSessionLoaded()).toBe(true);
      expect(projectsState.pendingNewSession).toBe(false);
      expect(projectsState.sessionLoading).toBe(false);
    });
    it('rejects a late snapshot from a different session operation', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.activeSessionId = 's1';
      projectsState.switchSession('/s2');
      const requestId = send.mock.calls[0][0].requestId as string;

      expect(
        projectsState.acceptsSessionLoaded({
          sessionId: 's1',
          sessionPath: '/s1',
          requestId: 'stale-request',
        })
      ).toBe(false);
      expect(projectsState.onSessionLoaded({ sessionId: 's1', requestId: 'stale-request' })).toBe(
        false
      );
      expect(projectsState.sessionLoading).toBe(true);

      expect(
        projectsState.onSessionLoaded({
          sessionId: 's2',
          sessionPath: '/s2',
          requestId,
        })
      ).toBe(false);
      expect(projectsState.sessionLoading).toBe(false);
    });

    it('invalidates timed-out operation replies', () => {
      vi.useFakeTimers();
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.activeSessionId = 's1';
      projectsState.newSession();
      const requestId = send.mock.calls[0][0].requestId as string;

      vi.advanceTimersByTime(SESSION_OP_TIMEOUT_MS + 1);

      expect(projectsState.acceptsSessionLoaded({ sessionId: 's2', requestId })).toBe(false);
      expect(projectsState.sessionLoading).toBe(false);
    });

    it('newSession arms a watchdog that re-enables the UI when unanswered', () => {
      vi.useFakeTimers();
      projectsState.send = vi.fn().mockReturnValue(true);
      projectsState.newSession();
      expect(projectsState.pendingNewSession).toBe(true);
      expect(projectsState.sessionLoading).toBe(true);
      vi.advanceTimersByTime(SESSION_OP_TIMEOUT_MS + 1);
      expect(projectsState.pendingNewSession).toBe(false);
      expect(projectsState.sessionLoading).toBe(false);
      expect(projectsState.error).toBe('New chat timed out — server did not respond in time');
    });

    it('watchdog is cancelled by session_loaded', () => {
      vi.useFakeTimers();
      projectsState.send = vi.fn().mockReturnValue(true);
      projectsState.newSession();
      projectsState.onSessionLoaded();
      vi.advanceTimersByTime(SESSION_OP_TIMEOUT_MS + 1);
      expect(projectsState.pendingNewSession).toBe(false);
      expect(projectsState.sessionLoading).toBe(false);
      expect(projectsState.error).toBeNull();
    });

    it('switchSession arms the same watchdog', () => {
      vi.useFakeTimers();
      projectsState.send = vi.fn().mockReturnValue(true);
      projectsState.switchSession('/s1');
      expect(projectsState.sessionLoading).toBe(true);
      vi.advanceTimersByTime(SESSION_OP_TIMEOUT_MS + 1);
      expect(projectsState.sessionLoading).toBe(false);
      expect(projectsState.error).toBe('Session switch timed out');
    });
    it('sessions_error cancels the watchdog', () => {
      vi.useFakeTimers();
      projectsState.send = vi.fn().mockReturnValue(true);
      projectsState.newSession();
      projectsState.handleMessage({ type: 'sessions_error', message: 'oops' } as {
        type: string;
      } & Record<string, unknown>);
      vi.advanceTimersByTime(SESSION_OP_TIMEOUT_MS + 1);
      expect(projectsState.error).toBe('oops'); // untouched by the watchdog
      expect(projectsState.pendingNewSession).toBe(false);
    });

    it('cancelPendingOps clears flags, timer, and pending switch path', () => {
      vi.useFakeTimers();
      projectsState.send = vi.fn().mockReturnValue(true);
      projectsState.switchSession('/s1');
      projectsState.cancelPendingOps();
      expect(projectsState.sessionLoading).toBe(false);
      expect(projectsState.pendingSwitchPath).toBeNull();
      expect(projectsState.error).toBeNull();
      vi.advanceTimersByTime(SESSION_OP_TIMEOUT_MS + 1);
      expect(projectsState.sessionLoading).toBe(false);
      expect(projectsState.error).toBeNull();
    });

    it('markUnchecked adds to unchecked set', () => {
      projectsState.markUnchecked('s1');
      expect(projectsState.uncheckedSessions.has('s1')).toBe(true);
    });

    it('toggleCollapsed toggles and persists', () => {
      projectsState.toggleCollapsed('/p');
      expect(projectsState.collapsed.has('/p')).toBe(true);
      projectsState.toggleCollapsed('/p');
      expect(projectsState.collapsed.has('/p')).toBe(false);
    });

    it('toggleCollapsed toggles the active project too', () => {
      projectsState.cwd = '/p';
      projectsState.toggleCollapsed('/p');
      expect(projectsState.collapsed.has('/p')).toBe(true);
      projectsState.toggleCollapsed('/p');
      expect(projectsState.collapsed.has('/p')).toBe(false);
      projectsState.toggleCollapsed('/other');
      expect(projectsState.collapsed.has('/other')).toBe(true);
    });

    it('visibleSessions limits to SESSION_PREVIEW_LIMIT', () => {
      const group = {
        cwd: '/p',
        sessions: buildSessionRows(Array.from({ length: 10 }, (_, i) => mkSession(`s${i}`))),
      } as ProjectGroup;
      expect(projectsState.visibleSessions(group)).toHaveLength(3);
    });

    it('visibleSessions applies the preview limit to the active project', () => {
      projectsState.cwd = '/p';
      const group = {
        cwd: '/p',
        sessions: buildSessionRows(Array.from({ length: 10 }, (_, i) => mkSession(`s${i}`))),
      } as ProjectGroup;
      expect(projectsState.visibleSessions(group)).toHaveLength(3);
    });

    it('visibleSessions shows every match while filtering', () => {
      projectsState.filter = 'feature';
      const group = {
        cwd: '/p',
        sessions: buildSessionRows(Array.from({ length: 10 }, (_, i) => mkSession(`s${i}`))),
      } as ProjectGroup;
      expect(projectsState.visibleSessions(group)).toHaveLength(10);
    });

    it('visibleSessions keeps whole subtrees without spending slots on children', () => {
      const group = {
        cwd: '/p',
        sessions: buildSessionRows([
          mkSession('r1', { modified: 70 }),
          mkSession('r2', { modified: 60 }),
          mkSession('stack', { modified: 50 }),
          mkSession('c1', { parentSession: '/p/stack.jsonl', modified: 40 }),
          mkSession('c2', { parentSession: '/p/stack.jsonl', modified: 30 }),
          mkSession('c3', { parentSession: '/p/stack.jsonl', modified: 20 }),
          mkSession('r4', { modified: 10 }),
        ]),
      } as ProjectGroup;
      // Three top-level slots — the third rides in with its complete substack,
      // pushing only the fourth root (r4) out of the preview.
      expect(projectsState.visibleSessions(group).map((r) => r.session.id)).toEqual([
        'r1',
        'r2',
        'stack',
        'c1',
        'c2',
        'c3',
      ]);
    });
  });
});
