import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Vitest resolves SvelteKit's navigation module through its server condition.
vi.mock('$app/navigation', () => ({
  goto: vi.fn(() => Promise.resolve()),
  replaceState: vi.fn(() => Promise.resolve()),
}));
import type { SessionSummary } from '#lib/ws/protocol.js';
import {
  buildSessionRows,
  projectsState,
  pathBasename,
  SESSION_OP_TIMEOUT_MS,
  type ProjectGroup,
  type SessionRuntimeStatus as ProjectsSessionRuntimeStatus,
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
const mkRuntime = (
  sessionId: string,
  overrides: Partial<Omit<ProjectsSessionRuntimeStatus, 'sessionId'>> = {}
): ProjectsSessionRuntimeStatus => ({
  sessionId,
  phase: 'idle',
  isRunning: false,
  lastActivity: 0,
  unread: false,
  needsAttention: false,
  resident: true,
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
    projectsState.runtime.clear();
    projectsState.filter = '';
    projectsState.error = null;
    projectsState.cancelPendingOps();
    projectsState.dirCompletions = [];
    projectsState.collapsed.clear();
    projectsState.expandedGroups.clear();
    projectsState.expandedSubsessions.clear();
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

    it('handles a matching sessions_error', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.newSession();
      const requestId = projectsState.pendingRequestId;
      projectsState.handleMessage({
        type: 'sessions_error',
        message: 'oops',
        requestId,
      } as { type: string } & Record<string, unknown>);
      expect(projectsState.error).toBe('oops');
      expect(projectsState.sessionOperation.kind).toBe('idle');
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
    it('updates one normalized session without rebuilding untouched project groups', () => {
      const project = (cwd: string, lastActivity = 0) => ({
        cwd,
        name: cwd.slice(1).toUpperCase(),
        pinned: false,
        exists: true,
        registered: true,
        sessionCount: 2,
        lastActivity,
      });
      projectsState.projects = [project('/a'), project('/b')];
      const untouched = mkSession('b1', { cwd: '/b', path: '/shared.jsonl' });
      const affected = mkSession('a1', { cwd: '/a', path: '/shared.jsonl', modified: 1 });
      projectsState.allSessions = [affected, untouched];

      const untouchedGroup = projectsState.groups.find((group) => group.cwd === '/b');
      const affectedGroup = projectsState.groups.find((group) => group.cwd === '/a');
      expect(untouchedGroup).toBeDefined();
      expect(affectedGroup).toBeDefined();

      projectsState.handleMessage({
        type: 'session_updated',
        session: { ...affected, name: 'updated', modified: 20 },
      } as { type: string } & Record<string, unknown>);

      expect(projectsState.allSessions.find((session) => session.id === 'b1')).toBe(untouched);
      expect(projectsState.groups.find((group) => group.cwd === '/b')).toBe(untouchedGroup);
      expect(projectsState.groups.find((group) => group.cwd === '/a')).not.toBe(affectedGroup);
    });

    it('keeps duplicate paths distinct when a delta targets one stable id', () => {
      const first = mkSession('mem-1', { path: '(in-memory)', name: 'first' });
      const second = mkSession('mem-2', { path: '(in-memory)', name: 'second' });
      projectsState.allSessions = [first, second];

      projectsState.handleMessage({
        type: 'session_updated',
        session: { ...second, name: 'renamed second' },
      } as { type: string } & Record<string, unknown>);

      expect(projectsState.allSessions).toHaveLength(2);
      expect(projectsState.allSessions.find((session) => session.id === 'mem-1')).toBe(first);
      expect(projectsState.allSessions.find((session) => session.id === 'mem-2')).toMatchObject({
        name: 'renamed second',
        path: '(in-memory)',
      });
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

    it('retries the missing project list when only sessions are fresh', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.handleMessage({ type: 'all_sessions_list', sessions: [{ id: 's1' }] } as {
        type: string;
      } & Record<string, unknown>);
      projectsState.refresh();
      expect(send).toHaveBeenCalledWith({ type: 'get_projects' });
      expect(send).not.toHaveBeenCalledWith({ type: 'get_all_sessions' });
    });

    it('retries the missing session list when only projects are fresh', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.handleMessage({ type: 'projects_list', projects: [{ cwd: '/p' }] } as {
        type: string;
      } & Record<string, unknown>);
      projectsState.refresh();
      expect(send).toHaveBeenCalledWith({ type: 'get_all_sessions' });
      expect(send).not.toHaveBeenCalledWith({ type: 'get_projects' });
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
    it('switchSession sends a correlated switch request', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      expect(projectsState.switchSession('/s1')).toBe('ok');
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'switch_session',
          path: '/s1',
          requestId: expect.any(String),
        })
      );
      expect(projectsState.pendingRequestId).toEqual(expect.any(String));
    });

    it('newSession sends the new-session message and sets pending flags', () => {
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

    it('renameSession sends the session ID', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.renameSession('session-2', 'New Name');
      expect(send).toHaveBeenCalledWith({
        type: 'rename_session',
        sessionId: 'session-2',
        name: 'New Name',
        requestId: expect.any(String),
      });
    });

    it('deleteSession sends the session ID', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.deleteSession('session-2');
      expect(send).toHaveBeenCalledWith({
        type: 'delete_session',
        sessionId: 'session-2',
        requestId: expect.any(String),
      });
    });

    it('uses distinct IDs for pooled sessions that share a path', () => {
      const pooledSessions = [
        mkSession('mem-1', { path: '(in-memory)' }),
        mkSession('mem-2', { path: '(in-memory)' }),
      ];
      expect(buildSessionRows(pooledSessions).map((row) => row.session.id)).toEqual([
        'mem-1',
        'mem-2',
      ]);

      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.renameSession(pooledSessions[1].id, 'Only second');
      projectsState.deleteSession(pooledSessions[0].id);
      expect(send).toHaveBeenNthCalledWith(1, {
        type: 'rename_session',
        sessionId: 'mem-2',
        name: 'Only second',
        requestId: expect.any(String),
      });
      expect(send).toHaveBeenNthCalledWith(2, {
        type: 'delete_session',
        sessionId: 'mem-1',
        requestId: expect.any(String),
      });
    });

    it('requestDirCompletions sends message', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.requestDirCompletions('~/projects/');
      expect(send).toHaveBeenCalledWith({ type: 'dir_complete', prefix: '~/projects/' });
    });

    it('onSessionLoaded without a pending operation is a no-op success', () => {
      expect(projectsState.onSessionLoaded()).toBe(false);
    });
    it('a session_loaded snapshot without a token does not settle a pending switch', () => {
      projectsState.send = vi.fn().mockReturnValue(true);
      expect(projectsState.switchSession('/s2')).toBe('ok');
      expect(projectsState.pendingSwitchPath).toBe('/s2');
      expect(projectsState.shouldApplySessionLoaded()).toBe(false);
      expect(projectsState.onSessionLoaded()).toBe(false);
      expect(projectsState.sessionLoading).toBe(true);
    });

    it('only the matching request token settles a pending switch', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      expect(projectsState.switchSession('/s2')).toBe('ok');
      const request = send.mock.calls[0][0];
      if (!request || typeof request !== 'object' || !('requestId' in request)) {
        throw new Error('switch request was not correlated');
      }
      const requestId = request.requestId;
      if (typeof requestId !== 'string') throw new Error('request id was not a string');
      expect(projectsState.onSessionLoaded('foreign-request')).toBe(false);
      expect(projectsState.pendingRequestId).toBe(requestId);
      expect(projectsState.onSessionLoaded(requestId)).toBe(true);
      expect(projectsState.pendingRequestId).toBeNull();
    });
    it('superseded switch responses cannot settle the newer operation', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.switchSession('/first');
      const firstRequestId = send.mock.calls[0][0].requestId as string;
      projectsState.switchSession('/second');
      const secondRequestId = send.mock.calls[1][0].requestId as string;
      expect(projectsState.onSessionLoaded(firstRequestId)).toBe(false);
      expect(projectsState.pendingRequestId).toBe(secondRequestId);
      expect(projectsState.onSessionLoaded(secondRequestId)).toBe(true);
    });

    it('a timed-out new-session resync cannot overwrite a newer switch', () => {
      vi.useFakeTimers();
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.newSession();
      vi.advanceTimersByTime(SESSION_OP_TIMEOUT_MS + 1);
      const resyncRequestId = projectsState.pendingRequestId;
      expect(resyncRequestId).toEqual(expect.any(String));
      projectsState.switchSession('/newer');
      const switchRequestId = projectsState.pendingRequestId;
      expect(switchRequestId).not.toBe(resyncRequestId);
      expect(projectsState.onSessionLoaded(resyncRequestId ?? undefined)).toBe(false);
      expect(projectsState.pendingRequestId).toBe(switchRequestId);
    });

    it('clears optimistic URL rollback after a confirmed session load', () => {
      projectsState.send = vi.fn().mockReturnValue(true);
      projectsState.switchSession('/s2');
      expect(projectsState.pendingUrlRevert).toBe(true);
      const requestId = projectsState.pendingRequestId;
      expect(requestId).toEqual(expect.any(String));
      projectsState.onSessionLoaded(requestId ?? undefined);
      expect(projectsState.pendingUrlRevert).toBe(false);
    });

    it('newSession timeout enters a correlated resync operation', () => {
      vi.useFakeTimers();
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.newSession();
      expect(projectsState.pendingNewSession).toBe(true);
      expect(projectsState.sessionLoading).toBe(true);
      vi.advanceTimersByTime(SESSION_OP_TIMEOUT_MS + 1);
      expect(projectsState.pendingNewSession).toBe(false);
      expect(projectsState.sessionLoading).toBe(false);
      expect(projectsState.pendingResync).toBe(true);
      expect(projectsState.sessionOperation.kind).toBe('resyncing');
      expect(send).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'resync_session', requestId: expect.any(String) })
      );
      expect(projectsState.error).toBe('New chat timed out — server did not respond in time');
    });
    it('watchdog is cancelled by session_loaded', () => {
      vi.useFakeTimers();
      projectsState.send = vi.fn().mockReturnValue(true);
      projectsState.newSession();
      const requestId = projectsState.pendingRequestId;
      expect(requestId).toEqual(expect.any(String));
      expect(projectsState.onSessionLoaded(requestId ?? undefined)).toBe(true);
      vi.advanceTimersByTime(SESSION_OP_TIMEOUT_MS + 1);
      expect(projectsState.pendingNewSession).toBe(false);
      expect(projectsState.sessionLoading).toBe(false);
      expect(projectsState.error).toBeNull();
    });

    it('switchSession timeout un-sticks the UI but keeps honoring a late reply', () => {
      vi.useFakeTimers();
      projectsState.send = vi.fn().mockReturnValue(true);
      projectsState.switchSession('/s1');
      const requestId = projectsState.pendingRequestId;
      expect(requestId).toEqual(expect.any(String));
      expect(projectsState.sessionLoading).toBe(true);
      vi.advanceTimersByTime(SESSION_OP_TIMEOUT_MS + 1);
      // UI unblocks so the sidebar/composer are usable again...
      expect(projectsState.sessionLoading).toBe(false);
      expect(projectsState.error).toBeTruthy();
      // ...but the request is not discarded: the server may still answer it.
      expect(projectsState.pendingRequestId).toBe(requestId);
      expect(projectsState.isRetiredRequest(requestId ?? '')).toBe(false);
      // A late reply for that exact request is still honored, not dropped.
      expect(projectsState.onSessionLoaded(requestId ?? undefined)).toBeDefined();
      expect(projectsState.error).toBeNull();
      expect(projectsState.pendingRequestId).toBeNull();
    });

    it('sessions_error cancels the watchdog', () => {
      vi.useFakeTimers();
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.newSession();
      const requestId = projectsState.pendingRequestId;
      expect(requestId).toEqual(expect.any(String));
      projectsState.handleMessage({
        type: 'sessions_error',
        message: 'oops',
        requestId,
      } as { type: string } & Record<string, unknown>);
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

    it('reconcileActiveRuntime records the active session runtime', () => {
      projectsState.reconcileActiveRuntime('active', true, 'bash');
      expect(projectsState.activeSessionId).toBe('active');
      expect(projectsState.isStreaming).toBe(true);
      expect(projectsState.activeToolName).toBe('bash');

      projectsState.reconcileActiveRuntime('active', false, undefined);
      expect(projectsState.activeSessionId).toBe('active');
      expect(projectsState.isStreaming).toBe(false);
      expect(projectsState.activeToolName).toBeUndefined();
    });

    it('routes compatibility writes through the active runtime record', () => {
      projectsState.reconcileActiveRuntime('active', true, 'bash');

      projectsState.isStreaming = false;
      projectsState.activeToolName = 'grep';

      expect(projectsState.runtime.get('active')).toMatchObject({
        isRunning: false,
        phase: 'idle',
        activeToolName: 'grep',
      });
      expect(projectsState.isStreaming).toBe(false);
      expect(projectsState.activeToolName).toBe('grep');
    });
    it('upserts runtime snapshots by session id', () => {
      const first = mkRuntime('s1', { phase: 'running', isRunning: true, lastActivity: 10 });
      projectsState.applyRuntime(first);
      projectsState.applyRuntime({
        ...first,
        phase: 'idle',
        isRunning: false,
        lastActivity: 20,
      });

      expect(projectsState.runtime.size).toBe(1);
      expect(projectsState.runtime.get('s1')).toMatchObject({
        phase: 'idle',
        isRunning: false,
        lastActivity: 20,
      });
    });

    it('prunes runtime snapshots when the authoritative session list changes', () => {
      const s1 = mkSession('s1');
      const s2 = mkSession('s2');
      projectsState.applyState({ sessions: [s1, s2] });
      projectsState.applyRuntime(mkRuntime('s1', { isRunning: true, phase: 'running' }));
      projectsState.applyRuntime(mkRuntime('s2', { unread: true }));

      projectsState.applyState({ sessions: [s1] });

      expect(projectsState.runtime.has('s1')).toBe(true);
      expect(projectsState.runtime.has('s2')).toBe(false);
    });

    it('reports running, tool, unread, attention, and project activity', () => {
      const running = mkRuntime('running', {
        phase: 'running',
        isRunning: true,
        activeToolName: 'bash',
      });
      const attention = mkRuntime('attention', {
        phase: 'error',
        needsAttention: true,
      });
      const unread = mkRuntime('unread', { unread: true });
      projectsState.applyRuntime(running);
      projectsState.applyRuntime(attention);
      projectsState.applyRuntime(unread);

      expect(projectsState.isSessionRunning('running')).toBe(true);
      expect(projectsState.sessionToolName('running')).toBe('bash');
      expect(projectsState.sessionNeedsAttention('attention')).toBe(true);
      expect(projectsState.isSessionUnread('unread')).toBe(true);
      expect(
        projectsState.projectActivity({
          cwd: '/p',
          name: 'P',
          pinned: false,
          exists: true,
          registered: true,
          sessionCount: 3,
          lastActivity: 0,
          sessions: buildSessionRows([
            mkSession('running'),
            mkSession('attention'),
            mkSession('unread'),
          ]),
        })
      ).toBe('running');
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

    it('visibleSessions collapses nested subtrees without spending preview slots', () => {
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

      expect(projectsState.visibleSessions(group).map((r) => r.session.id)).toEqual([
        'r1',
        'r2',
        'stack',
      ]);

      projectsState.toggleSubsessions('stack');
      expect(projectsState.visibleSessions(group).map((r) => r.session.id)).toEqual([
        'r1',
        'r2',
        'stack',
        'c1',
        'c2',
        'c3',
      ]);

      // Three top-level slots still push only the fourth root out of preview.
      expect(projectsState.visibleSessions(group).some((r) => r.session.id === 'r4')).toBe(false);
    });

    it('visibleSessions keeps the active nested session path visible', () => {
      const group = {
        cwd: '/p',
        sessions: buildSessionRows([
          mkSession('parent'),
          mkSession('child', { parentSession: '/p/parent.jsonl' }),
          mkSession('grandchild', { parentSession: '/p/child.jsonl' }),
          mkSession('sibling', { parentSession: '/p/parent.jsonl' }),
        ]),
      } as ProjectGroup;
      projectsState.activeSessionId = 'grandchild';

      expect(projectsState.visibleSessions(group).map((r) => r.session.id)).toEqual([
        'parent',
        'child',
        'grandchild',
      ]);
    });
    it('visibleSessions keeps a top-level active session past the preview limit visible', () => {
      const group = {
        cwd: '/p',
        sessions: buildSessionRows(
          Array.from({ length: 5 }, (_, i) => mkSession(`s${i}`, { modified: 100 - i }))
        ),
      } as ProjectGroup;
      projectsState.activeSessionId = 's4';

      expect(projectsState.visibleSessions(group).map((r) => r.session.id)).toEqual([
        's0',
        's1',
        's2',
        's4',
      ]);
    });
    it('visibleSessions keeps the preview limit exact when the active session is in preview', () => {
      const group = {
        cwd: '/p',
        sessions: buildSessionRows(
          Array.from({ length: 5 }, (_, i) => mkSession(`s${i}`, { modified: 100 - i }))
        ),
      } as ProjectGroup;
      projectsState.activeSessionId = 's1';

      expect(projectsState.visibleSessions(group).map((r) => r.session.id)).toEqual([
        's0',
        's1',
        's2',
      ]);
    });
  });
});
