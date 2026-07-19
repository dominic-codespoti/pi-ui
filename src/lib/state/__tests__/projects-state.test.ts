import { describe, it, expect, vi, beforeEach } from 'vitest';
import { projectsState, pathBasename, type ProjectGroup } from '../projects-state.svelte';

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
    projectsState.dirCompletions = [];
    projectsState.collapsed.clear();
    projectsState.expandedGroups.clear();
  });

  describe('groups derived', () => {
    it('returns empty groups when no projects or sessions', () => {
      expect(projectsState.groups).toEqual([]);
    });

    it('creates groups from projects list', () => {
      projectsState.projects = [
        { cwd: '/a', name: 'A', pinned: false, exists: true, registered: true, sessionCount: 0, lastActivity: 100 },
      ];
      expect(projectsState.groups).toHaveLength(1);
      expect(projectsState.groups[0].name).toBe('A');
    });

    it('creates fallback groups from sessions without matching projects', () => {
      projectsState.allSessions = [
        { id: 's1', path: '/s1', cwd: '/orphan', name: '', created: 1, modified: 2, messageCount: 0, firstMessage: '' },
      ];
      const groups = projectsState.groups;
      const orphan = groups.find((g) => g.cwd === '/orphan');
      expect(orphan).toBeDefined();
      expect(orphan!.registered).toBe(false);
      expect(orphan!.sessions).toHaveLength(1);
    });

    it('sorts pinned projects first, then by lastActivity', () => {
      projectsState.projects = [
        { cwd: '/a', name: 'A', pinned: false, exists: true, registered: true, sessionCount: 0, lastActivity: 10 },
        { cwd: '/b', name: 'B', pinned: true, exists: true, registered: true, sessionCount: 0, lastActivity: 5 },
        { cwd: '/c', name: 'C', pinned: false, exists: true, registered: true, sessionCount: 0, lastActivity: 20 },
      ];
      expect(projectsState.groups[0].cwd).toBe('/b');
      expect(projectsState.groups[1].cwd).toBe('/c');
      expect(projectsState.groups[2].cwd).toBe('/a');
    });

    it('attaches matching sessions to projects', () => {
      projectsState.projects = [
        { cwd: '/p', name: 'P', pinned: false, exists: true, registered: true, sessionCount: 1, lastActivity: 100 },
      ];
      projectsState.allSessions = [
        { id: 's1', path: '/p/s1.jsonl', cwd: '/p', name: '', created: 1, modified: 2, messageCount: 5, firstMessage: 'hi' },
      ];
      expect(projectsState.groups[0].sessions).toHaveLength(1);
      expect(projectsState.groups[0].sessions[0].id).toBe('s1');
    });
  });

  describe('filteredGroups', () => {
    it('returns all groups when filter is empty', () => {
      projectsState.projects = [
        { cwd: '/a', name: 'Alpha', pinned: false, exists: true, registered: true, sessionCount: 0, lastActivity: 0 },
        { cwd: '/b', name: 'Beta', pinned: false, exists: true, registered: true, sessionCount: 0, lastActivity: 0 },
      ];
      expect(projectsState.filteredGroups).toHaveLength(2);
    });

    it('filters groups by project name', () => {
      projectsState.projects = [
        { cwd: '/a', name: 'Alpha', pinned: false, exists: true, registered: true, sessionCount: 0, lastActivity: 0 },
        { cwd: '/b', name: 'Beta', pinned: false, exists: true, registered: true, sessionCount: 0, lastActivity: 0 },
      ];
      projectsState.filter = 'alpha';
      expect(projectsState.filteredGroups).toHaveLength(1);
      expect(projectsState.filteredGroups[0].name).toBe('Alpha');
    });

    it('filters sessions within groups by session name', () => {
      projectsState.projects = [
        { cwd: '/p', name: 'P', pinned: false, exists: true, registered: true, sessionCount: 2, lastActivity: 100 },
      ];
      projectsState.allSessions = [
        { id: 's1', path: '/p/s1.jsonl', cwd: '/p', name: 'Feature X', created: 1, modified: 2, messageCount: 0, firstMessage: '' },
        { id: 's2', path: '/p/s2.jsonl', cwd: '/p', name: 'Bug Y', created: 1, modified: 2, messageCount: 0, firstMessage: '' },
      ];
      projectsState.filter = 'feature';
      expect(projectsState.filteredGroups[0].sessions).toHaveLength(1);
    });
  });

  describe('activeProject', () => {
    it('returns null when no cwd is set', () => {
      expect(projectsState.activeProject).toBeNull();
    });

    it('returns the group matching cwd', () => {
      projectsState.projects = [
        { cwd: '/active', name: 'Active', pinned: false, exists: true, registered: true, sessionCount: 0, lastActivity: 0 },
      ];
      projectsState.cwd = '/active';
      expect(projectsState.activeProject?.cwd).toBe('/active');
    });
  });

  describe('handleMessage', () => {
    it('handles projects_list', () => {
      projectsState.handleMessage({ type: 'projects_list', projects: [{ cwd: '/p', name: 'P' }] } as { type: string } & Record<string, unknown>);
      expect(projectsState.projects).toHaveLength(1);
    });

    it('handles all_sessions_list', () => {
      projectsState.handleMessage({ type: 'all_sessions_list', sessions: [{ id: 's1' }] } as { type: string } & Record<string, unknown>);
      expect(projectsState.allSessions).toHaveLength(1);
    });

    it('handles sessions_error', () => {
      projectsState.handleMessage({ type: 'sessions_error', message: 'oops' } as { type: string } & Record<string, unknown>);
      expect(projectsState.error).toBe('oops');
    });

    it('handles dir_completions', () => {
      projectsState.handleMessage({ type: 'dir_completions', entries: ['/a/', '/b/'] } as { type: string } & Record<string, unknown>);
      expect(projectsState.dirCompletions).toEqual(['/a/', '/b/']);
    });
  });

  describe('actions', () => {
    it('switchSession sends message and clears unchecked', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.allSessions = [
        { id: 's1', path: '/s1', cwd: '', name: '', created: 1, modified: 2, messageCount: 0, firstMessage: '' },
      ];
      projectsState.uncheckedSessions.add('s1');
      projectsState.switchSession('/s1');
      expect(send).toHaveBeenCalledWith({ type: 'switch_session', path: '/s1' });
      expect(projectsState.uncheckedSessions.has('s1')).toBe(false);
    });

    it('newSession sets pending flag when send succeeds', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.newSession();
      expect(send).toHaveBeenCalledWith({ type: 'new_session' });
      expect(projectsState.pendingNewSession).toBe(true);
    });

    it('newSession does not set pending when send fails', () => {
      const send = vi.fn().mockReturnValue(false);
      projectsState.send = send;
      projectsState.newSession();
      expect(projectsState.pendingNewSession).toBe(false);
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
        { cwd: '/p', name: 'P', pinned: false, exists: true, registered: true, sessionCount: 0, lastActivity: 0 },
      ];
      projectsState.setPinned('/p', true);
      expect(projectsState.projects[0].pinned).toBe(true);
      expect(send).toHaveBeenCalledWith({ type: 'pin_project', cwd: '/p', pinned: true });
    });

    it('renameSession sends message', () => {
      const send = vi.fn().mockReturnValue(true);
      projectsState.send = send;
      projectsState.renameSession('/path', 'New Name');
      expect(send).toHaveBeenCalledWith({ type: 'rename_session', path: '/path', name: 'New Name' });
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

    it('onSessionLoaded clears pending and returns true', () => {
      projectsState.pendingNewSession = true;
      expect(projectsState.onSessionLoaded()).toBe(true);
      expect(projectsState.pendingNewSession).toBe(false);
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

    it('visibleSessions limits to SESSION_PREVIEW_LIMIT', () => {
      const group = {
        sessions: Array.from({ length: 10 }, (_, i) => ({
          id: `s${i}`, path: '', cwd: '', name: '', created: 0, modified: 0, messageCount: 0, firstMessage: '',
        })),
      } as ProjectGroup;
      expect(projectsState.visibleSessions(group)).toHaveLength(5);
    });
  });
});
