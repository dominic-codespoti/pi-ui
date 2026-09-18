import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  dispatchProjectMessage,
  type ProjectHandlerDependencies,
  type ProjectHandlerResidentEntry,
} from '../project-handlers';
import type { ProjectInfo } from '../../../ws/protocol';
import type { SessionFileInfo } from '../../session-scan';

type TestDependencies = ProjectHandlerDependencies & {
  socket: { send: Mock };
  applyProject: Mock;
  applySession: Mock;
  mkdir: Mock;
  removeFile: Mock;
  disposeSession: Mock;
  broadcast: Mock;
  withGlobalLock: ProjectHandlerDependencies['residentStore']['withGlobalLock'];
  withGlobalLockCallCount: number;
};

function session(id: string, cwd: string): SessionFileInfo {
  const now = new Date('2025-01-01T00:00:00.000Z');
  return {
    id,
    path: `${cwd}/sessions/${id}.jsonl`,
    cwd,
    created: now,
    modified: now,
    messageCount: 1,
    firstMessage: `message ${id}`,
  };
}

function project(cwd: string): ProjectInfo {
  return {
    cwd,
    name: cwd.split('/').at(-1) ?? cwd,
    pinned: false,
    exists: true,
    registered: true,
    sessionCount: 0,
    lastActivity: 0,
  };
}

function setup(
  options: {
    activeCwd?: string;
    sessions?: SessionFileInfo[];
    projects?: ProjectInfo[];
    pinned?: Set<string>;
    residentIds?: string[];
  } = {}
): TestDependencies {
  const sessions = options.sessions ?? [];
  const projects = options.projects ?? [];
  const pinned = options.pinned ?? new Set<string>();
  const residents = new Set(options.residentIds ?? []);
  const socket = { send: vi.fn() };
  const applyProject = vi.fn();
  const applySession = vi.fn();
  const mkdir = vi.fn(async () => undefined);
  const removeFile = vi.fn(async () => undefined);
  const disposeSession = vi.fn();
  const broadcast = vi.fn();

  let withGlobalLockCallCount = 0;

  async function withGlobalLock<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    withGlobalLockCallCount += 1;
    return operation();
  }

  return {
    socket,
    applyProject,
    applySession,
    mkdir,
    removeFile,
    disposeSession,
    broadcast,
    withGlobalLock,
    get withGlobalLockCallCount() {
      return withGlobalLockCallCount;
    },
    projectCatalog: {
      list: vi.fn(async () => projects),
      apply: applyProject,
    },
    sessionCatalog: {
      list: vi.fn(async () => sessions),
      listForCwd: vi.fn(async (cwd: string) => sessions.filter((item) => item.cwd === cwd)),
      apply: applySession,
    },
    residentStore: {
      get: vi.fn((id: string): ProjectHandlerResidentEntry | undefined =>
        residents.has(id) ? { id } : undefined
      ),
      isPinned: vi.fn((entry: ProjectHandlerResidentEntry) => pinned.has(entry.id)),
      withGlobalLock,
    },
    activeCwd: () => options.activeCwd ?? '/active',
  };
}

describe('dispatchProjectMessage', () => {
  it('returns false for unrelated messages without effects', async () => {
    const deps = setup();

    expect(await dispatchProjectMessage({ type: 'ping' }, deps.socket, deps)).toBe(false);
    expect(deps.socket.send).not.toHaveBeenCalled();
    expect(deps.applyProject).not.toHaveBeenCalled();
  });

  it('returns serialized all-session and project list responses', async () => {
    const item = session('s1', '/work');
    const deps = setup({ sessions: [item], projects: [project('/work')] });

    expect(await dispatchProjectMessage({ type: 'get_all_sessions' }, deps.socket, deps)).toBe(
      true
    );
    expect(deps.socket.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: 'all_sessions_list',
        sessions: [
          {
            ...item,
            created: item.created.getTime(),
            modified: item.modified.getTime(),
            turns: undefined,
            parentSession: undefined,
          },
        ],
      })
    );

    await dispatchProjectMessage({ type: 'get_projects' }, deps.socket, deps);
    expect(deps.socket.send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'projects_list', projects: [project('/work')] })
    );
  });

  it('normalizes add paths and rejects empty or null-byte paths', async () => {
    const deps = setup();
    const target = resolve(homedir(), 'workspace');

    expect(
      await dispatchProjectMessage(
        { type: 'add_project', path: '  ~/workspace  ' },
        deps.socket,
        deps
      )
    ).toBe(true);
    expect(deps.mkdir).toHaveBeenCalledTimes(1);
    expect(deps.mkdir).toHaveBeenCalledWith(target, { recursive: true });
    expect(deps.applyProject).toHaveBeenCalledTimes(1);
    expect(deps.applyProject).toHaveBeenCalledWith({
      kind: 'touch',
      path: target,
    });

    deps.socket.send.mockClear();
    await dispatchProjectMessage({ type: 'add_project', path: '   ' }, deps.socket, deps);
    expect(deps.mkdir).toHaveBeenCalledTimes(1);
    expect(deps.applyProject).toHaveBeenCalledTimes(1);
    expect(deps.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'sessions_error', message: 'Invalid project path.' })
    );

    deps.socket.send.mockClear();
    await dispatchProjectMessage({ type: 'add_project', path: '  \0bad' }, deps.socket, deps);
    expect(deps.mkdir).toHaveBeenCalledTimes(1);
    expect(deps.applyProject).toHaveBeenCalledTimes(1);
    expect(deps.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'sessions_error', message: 'Invalid project path.' })
    );
  });

  it('rejects removing the active project before acquiring the lock', async () => {
    const deps = setup({ activeCwd: '/work' });
    await dispatchProjectMessage({ type: 'remove_project', cwd: '/work' }, deps.socket, deps);
    expect(deps.withGlobalLockCallCount).toBe(0);
    expect(deps.applyProject).not.toHaveBeenCalled();
    expect(deps.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'sessions_error', message: 'Cannot forget the active project.' })
    );
  });

  it('applies pin and rename mutations for non-empty paths', async () => {
    const deps = setup();

    await dispatchProjectMessage(
      { type: 'pin_project', cwd: '/work', pinned: true },
      deps.socket,
      deps
    );
    await dispatchProjectMessage(
      { type: 'rename_project', cwd: '/work', name: 'Workspace' },
      deps.socket,
      deps
    );
    expect(deps.applyProject).toHaveBeenNthCalledWith(1, {
      kind: 'setPinned',
      path: '/work',
      pinned: true,
    });
    expect(deps.applyProject).toHaveBeenNthCalledWith(2, {
      kind: 'rename',
      path: '/work',
      name: 'Workspace',
    });
  });

  it('deletes under the global lock, disposes residents, removes files, and sends resulting list', async () => {
    const sessions = [session('s1', '/gone'), session('s2', '/gone')];
    const deps = setup({ sessions, residentIds: ['s1', 's2'] });

    await dispatchProjectMessage({ type: 'delete_project', cwd: '/gone' }, deps.socket, deps);
    expect(deps.withGlobalLockCallCount).toBe(1);
    expect(deps.removeFile).toHaveBeenCalledWith(sessions[0].path);
    expect(deps.removeFile).toHaveBeenCalledWith(sessions[1].path);
    expect(deps.disposeSession).toHaveBeenNthCalledWith(1, 's1', 'deleted');
    expect(deps.disposeSession).toHaveBeenNthCalledWith(2, 's2', 'deleted');
    expect(deps.broadcast).toHaveBeenCalledTimes(2);
    expect(deps.applyProject).toHaveBeenCalledWith({ kind: 'remove', path: '/gone' });
    expect(deps.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'sessions_list', sessions: [] })
    );
  });

  it('keeps the existing error envelopes when listing or deleting fails', async () => {
    const listError = new Error('scan failed');
    const deps = setup();
    deps.sessionCatalog.list = vi.fn(async () => {
      throw listError;
    });
    deps.logError = vi.fn();
    await dispatchProjectMessage({ type: 'get_all_sessions' }, deps.socket, deps);
    expect(deps.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'all_sessions_list', sessions: [] })
    );

    deps.socket.send.mockClear();
    deps.sessionCatalog.listForCwd = vi.fn(async () => {
      throw new Error('scan failed');
    });
    await dispatchProjectMessage({ type: 'delete_project', cwd: '/gone' }, deps.socket, deps);
    expect(deps.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'sessions_error', message: 'Error: scan failed' })
    );
  });
});
