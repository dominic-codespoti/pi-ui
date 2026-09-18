import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProjectCatalogPatch } from '../project-catalog.ts';
import type { SessionCatalogPatch } from '../session-catalog.ts';
import { expandTilde, serializeSession } from '../ws-helpers.ts';
import type { SessionFileInfo } from '../session-scan.ts';
import type { ClientMessage, ProjectInfo, ServerMessage } from '../../ws/protocol.ts';

export interface ProjectHandlerSocket {
  send(data: string): unknown;
}

/** Narrow structural view of the project catalog used by project messages. */
export interface ProjectHandlerProjectCatalog {
  list(): Promise<ProjectInfo[]>;
  apply(patch: ProjectCatalogPatch): void;
}

/** Narrow structural view of the session catalog used by project messages. */
export interface ProjectHandlerSessionCatalog {
  list(): Promise<SessionFileInfo[]>;
  listForCwd(cwd: string): Promise<SessionFileInfo[]>;
  apply(patch: SessionCatalogPatch): void;
}

export interface ProjectHandlerResidentEntry {
  readonly id: string;
}

/** Narrow structural view of resident-session coordination. */
export interface ProjectHandlerResidentStore {
  get(id: string): ProjectHandlerResidentEntry | undefined;
  isPinned(entry: ProjectHandlerResidentEntry): boolean;
  withGlobalLock<T>(operation: () => T | PromiseLike<T>): Promise<T>;
}

export interface ProjectHandlerDependencies {
  projectCatalog: ProjectHandlerProjectCatalog;
  sessionCatalog: ProjectHandlerSessionCatalog;
  residentStore: ProjectHandlerResidentStore;
  activeCwd: () => string;
  disposeSession: (sessionId: string, reason: string) => void;
  broadcast: (payload: ServerMessage) => void;
  /** Filesystem operations are injected so mutations remain independently testable. */
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
  removeFile: (path: string) => Promise<void>;
  logError?: (...args: unknown[]) => void;
}

const defaultDependencies = {
  mkdir: (path: string, options: { recursive: true }) => mkdir(path, options),
  removeFile: (path: string) => rm(path),
};

function sendError(socket: ProjectHandlerSocket, message: string): void {
  socket.send(JSON.stringify({ type: 'sessions_error', message }));
}

function logError(dependencies: ProjectHandlerDependencies, ...args: unknown[]): void {
  dependencies.logError?.(...args);
}

/**
 * Dispatch project and project-wide session inventory messages. Returning false
 * leaves unrelated messages to the other dispatchers in the composition root.
 */
export async function dispatchProjectMessage(
  message: ClientMessage,
  socket: ProjectHandlerSocket,
  dependencies: ProjectHandlerDependencies
): Promise<boolean> {
  switch (message.type) {
    case 'get_all_sessions': {
      try {
        // The live session is in the overlay, so the merged list needs no
        // manual prepend.
        const all = await dependencies.sessionCatalog.list();
        socket.send(
          JSON.stringify({ type: 'all_sessions_list', sessions: all.map(serializeSession) })
        );
      } catch (err) {
        logError(dependencies, '[pifrontier] get_all_sessions error:', err);
        socket.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
      }
      return true;
    }

    case 'get_projects':
      socket.send(
        JSON.stringify({
          type: 'projects_list',
          projects: await dependencies.projectCatalog.list(),
        })
      );
      return true;

    case 'add_project': {
      try {
        const raw = message.path ?? '';
        if (!raw.trim() || raw.includes('\0')) {
          sendError(socket, 'Invalid project path.');
          return true;
        }
        const target = resolve(expandTilde(raw.trim()));
        // Same trust level as new_session: create the folder if it is brand new.
        await dependencies.mkdir(target, { recursive: true });
        dependencies.projectCatalog.apply({ kind: 'touch', path: target });
      } catch (err) {
        logError(dependencies, '[pifrontier] add_project error:', err);
        sendError(socket, String(err));
      }
      return true;
    }

    case 'remove_project': {
      const target = message.cwd ?? '';
      if (target === dependencies.activeCwd()) {
        sendError(socket, 'Cannot forget the active project.');
        return true;
      }
      await dependencies.residentStore.withGlobalLock(async () => {
        dependencies.projectCatalog.apply({ kind: 'remove', path: target });
      });
      return true;
    }

    case 'delete_project':
      await dependencies.residentStore.withGlobalLock(async () => {
        try {
          const target = message.cwd ?? '';
          if (!target.trim()) {
            sendError(socket, 'No project specified.');
            return;
          }
          if (target === dependencies.activeCwd()) {
            sendError(socket, 'Cannot delete the active project.');
            return;
          }
          // listForCwd already includes nested/subagent sessions.
          const sessions = await dependencies.sessionCatalog.listForCwd(target);
          if (
            sessions.some((session) => {
              const residentEntry = dependencies.residentStore.get(session.id);
              return (
                residentEntry !== undefined && dependencies.residentStore.isPinned(residentEntry)
              );
            })
          ) {
            sendError(socket, 'Cannot delete a project with a running or busy resident session.');
            return;
          }
          for (const session of sessions) {
            try {
              await dependencies.removeFile(session.path);
            } catch (err) {
              logError(
                dependencies,
                `[pifrontier] delete_project: failed to remove ${session.path}:`,
                err
              );
              continue;
            }
            const residentEntry = dependencies.residentStore.get(session.id);
            if (residentEntry) {
              dependencies.broadcast({
                type: 'session_runtime',
                sessionId: session.id,
                phase: 'idle',
                isRunning: false,
                lastActivity: Date.now(),
                unread: false,
                needsAttention: false,
                resident: false,
              });
              dependencies.disposeSession(session.id, 'deleted');
            }
          }
          dependencies.projectCatalog.apply({ kind: 'remove', path: target });
          socket.send(JSON.stringify({ type: 'sessions_list', sessions: [] }));
        } catch (err) {
          logError(dependencies, '[pifrontier] delete_project error:', err);
          sendError(socket, String(err));
        }
      });
      return true;

    case 'pin_project':
      if (typeof message.cwd === 'string' && message.cwd.trim()) {
        dependencies.projectCatalog.apply({
          kind: 'setPinned',
          path: message.cwd,
          pinned: Boolean(message.pinned),
        });
      }
      return true;

    case 'rename_project':
      if (typeof message.cwd === 'string' && message.cwd.trim()) {
        dependencies.projectCatalog.apply({
          kind: 'rename',
          path: message.cwd,
          name: typeof message.name === 'string' ? message.name : '',
        });
      }
      return true;

    default:
      return false;
  }
}

// Keep the default filesystem adapters available to the integration root while
// making the dispatcher itself use only its narrow injected surface.
export const projectHandlerFilesystem = defaultDependencies;
