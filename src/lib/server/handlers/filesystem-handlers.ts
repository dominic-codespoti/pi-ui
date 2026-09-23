import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ClientMessage, CompletionItem } from '../../ws/protocol.ts';
import type { CommandCompletionItem, ExtensionCommandResolver } from '../extension-completions.ts';

export interface FilesystemHandlerSocket {
  send(data: string): unknown;
  readonly data?: { readonly focusedSessionId?: string };
}

export interface FilesystemUploadTarget {
  readonly workspaceRoot: string;
  readonly sessionId: string | null;
}

/** The only resident-session shape needed by filesystem completions. */
export interface FilesystemResidentTarget {
  readonly session: {
    readonly sessionManager: {
      getCwd(): string | undefined;
    };
    readonly extensionRunner: ExtensionCommandResolver;
  };
}

export interface FilesystemAutocompleteProvider {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorColumn: number,
    options: { signal: AbortSignal }
  ): Promise<{ items?: readonly unknown[] } | null> | { items?: readonly unknown[] } | null;
}

export interface FilesystemCompletionCache {
  readonly file: Map<string, { at: number; entries: string[] }>;
  readonly dir: Map<string, { at: number; entries: string[] }>;
}

export interface FilesystemHandlerDependencies {
  /** Current workspace root used by read/write operations. */
  activeCwd: () => string;
  /** Lookup is intentionally explicit: completion requests never use socket focus. */
  getResidentSession: (sessionId: string) => FilesystemResidentTarget | undefined;
  /** Resolve an extension autocomplete provider for a resident session. */
  autocompleteProviderFor: (sessionId: string) => FilesystemAutocompleteProvider | null;
  /** Resolve command argument completions for a resident session. */
  getCommandCompletions: (
    target: FilesystemResidentTarget,
    command: string,
    prefix: string
  ) => Promise<readonly CommandCompletionItem[]>;
  /** Check an already-resolved path against a workspace root (including symlinks). */
  isInsideWorkspace: (resolvedPath: string, workspaceRoot?: string) => boolean;
  /**
   * Resolve the upload workspace and session before any asynchronous staging work.
   * An unresolved explicit/focused session returns the active workspace and null.
   */
  resolveUploadTarget: (
    requestedSessionId: string | undefined,
    focusedSessionId: string | undefined
  ) => FilesystemUploadTarget;
  /** Directory where uploads are staged, derived from the workspace root. */
  uploadStagingDir: (workspaceRoot: string) => string;
  /** Filesystem operations are injected so file messages remain independently testable. */
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
  maxUploadBytes: number;
  maxStagedFiles: number;
  completionCache: FilesystemCompletionCache;
  logError?: (...args: unknown[]) => void;
}

function decodeBase64(data: string): Buffer {
  const paddingStart = data.indexOf('=');
  const payload = paddingStart === -1 ? data : data.slice(0, paddingStart);
  const padding = paddingStart === -1 ? '' : data.slice(paddingStart);
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
    payload.length % 4 === 1 ||
    (padding && data.length % 4 !== 0)
  ) {
    throw new Error('Invalid base64 data');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== payload) {
    throw new Error('Invalid base64 data');
  }
  return bytes;
}

const FILE_COMPLETE_TTL_MS = 5_000;
const FILE_COMPLETE_CACHE_MAX = 50;
const DIR_COMPLETE_TTL_MS = 2_000;
const DIR_COMPLETE_CACHE_MAX = 50;
const MAX_FILE_COMPLETIONS = 40;
const MAX_DIR_COMPLETIONS = 20;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const AUTOCOMPLETE_TIMEOUT_MS = 2_000;

function normalizeCompletionItems(items: readonly unknown[] | undefined): CompletionItem[] {
  if (!items) return [];
  const normalized: CompletionItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const value =
      typeof record.value === 'string'
        ? record.value
        : typeof record.label === 'string'
          ? record.label
          : undefined;
    if (value === undefined) continue;
    const label = typeof record.label === 'string' ? record.label : value;
    const description = typeof record.description === 'string' ? record.description : undefined;
    normalized.push(description === undefined ? { value, label } : { value, label, description });
  }
  return normalized;
}

function expandTilde(path: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1));
  return path;
}

function evictOldest(cache: Map<string, { at: number; entries: string[] }>, maximum: number): void {
  if (cache.size <= maximum) return;
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [key, value] of cache) {
    if (value.at < oldestAt) {
      oldestAt = value.at;
      oldestKey = key;
    }
  }
  if (oldestKey) cache.delete(oldestKey);
}

function errorLog(dependencies: FilesystemHandlerDependencies, ...args: unknown[]): void {
  dependencies.logError?.(...args);
}

/**
 * Dispatch filesystem and completion requests. Unknown messages return false so
 * the composition root can continue with its remaining protocol handlers.
 */
export async function dispatchFilesystemMessage(
  message: ClientMessage,
  socket: FilesystemHandlerSocket,
  dependencies: FilesystemHandlerDependencies
): Promise<boolean> {
  switch (message.type) {
    case 'dir_complete': {
      try {
        const prefix = expandTilde(message.prefix);
        const isDir = prefix.endsWith('/');
        const dir = isDir ? prefix : dirname(prefix);
        const resolvedDir = resolve(dir);
        const fragment = isDir ? '' : basename(prefix).toLowerCase();
        const cacheKey = `${resolvedDir}\u0000${dir}\u0000${fragment}`;
        const cachedHit = dependencies.completionCache.dir.get(cacheKey);
        if (cachedHit && Date.now() - cachedHit.at < DIR_COMPLETE_TTL_MS) {
          socket.send(
            JSON.stringify({ type: 'dir_completions', prefix, entries: cachedHit.entries })
          );
          return true;
        }
        let entries: string[] = [];
        try {
          const dirents = await readdir(resolvedDir, { withFileTypes: true });
          entries = dirents
            .filter(
              (entry) =>
                entry.isDirectory() &&
                (fragment === '' || entry.name.toLowerCase().startsWith(fragment))
            )
            .map((entry) => join(dir, entry.name) + '/')
            .slice(0, MAX_DIR_COMPLETIONS);
        } catch {
          entries = [];
        }
        dependencies.completionCache.dir.set(cacheKey, { at: Date.now(), entries });
        evictOldest(dependencies.completionCache.dir, DIR_COMPLETE_CACHE_MAX);
        socket.send(JSON.stringify({ type: 'dir_completions', prefix, entries }));
      } catch (err) {
        errorLog(dependencies, '[pifrontier] dir_complete error:', err);
        socket.send(JSON.stringify({ type: 'dir_completions', prefix: '', entries: [] }));
      }
      return true;
    }

    case 'file_complete': {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const requestedQuery = typeof message.query === 'string' ? message.query : '';
      const query = requestedQuery.toLowerCase();
      const target = sessionId ? dependencies.getResidentSession(sessionId) : undefined;
      if (!target) {
        socket.send(
          JSON.stringify({
            type: 'file_completions',
            sessionId,
            requestId,
            query: requestedQuery,
            entries: [],
            error: 'Session is not resident.',
          })
        );
        return true;
      }
      try {
        const root = target.session.sessionManager.getCwd() || dependencies.activeCwd();
        const cacheKey = `${root}\u0000${query}`;
        const cachedHit = dependencies.completionCache.file.get(cacheKey);
        if (cachedHit && Date.now() - cachedHit.at < FILE_COMPLETE_TTL_MS) {
          socket.send(
            JSON.stringify({
              type: 'file_completions',
              sessionId,
              requestId,
              query: requestedQuery,
              entries: cachedHit.entries,
            })
          );
          return true;
        }
        const entries: string[] = [];
        const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
        while (queue.length > 0 && entries.length < MAX_FILE_COMPLETIONS) {
          const item = queue.shift()!;
          let dirents: Array<{
            name: string;
            isFile(): boolean;
            isDirectory(): boolean;
          }>;
          try {
            dirents = (await readdir(item.dir, { withFileTypes: true })) as typeof dirents;
          } catch {
            continue;
          }
          for (const dirent of dirents) {
            if (dirent.name.startsWith('.') && dirent.name !== '.env') continue;
            if (SKIP_DIRS.has(dirent.name)) continue;
            const abs = join(item.dir, dirent.name);
            const rel = relative(root, abs);
            if (dirent.isFile() && (!query || rel.toLowerCase().includes(query))) {
              entries.push(rel);
              if (entries.length >= MAX_FILE_COMPLETIONS) break;
            } else if (dirent.isDirectory() && item.depth < 3) {
              queue.push({ dir: abs, depth: item.depth + 1 });
            }
          }
        }
        dependencies.completionCache.file.set(cacheKey, { at: Date.now(), entries });
        evictOldest(dependencies.completionCache.file, FILE_COMPLETE_CACHE_MAX);
        socket.send(
          JSON.stringify({
            type: 'file_completions',
            sessionId,
            requestId,
            query: requestedQuery,
            entries,
          })
        );
      } catch (err) {
        errorLog(dependencies, '[pifrontier] file_complete error:', err);
        socket.send(
          JSON.stringify({
            type: 'file_completions',
            sessionId,
            requestId,
            query: requestedQuery,
            entries: [],
            error: String(err),
          })
        );
      }
      return true;
    }

    case 'get_extension_autocomplete': {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const trigger = typeof message.trigger === 'string' ? message.trigger : '';
      const query = typeof message.query === 'string' ? message.query : '';
      const target = sessionId ? dependencies.getResidentSession(sessionId) : undefined;
      if (!target) {
        socket.send(
          JSON.stringify({
            type: 'extension_completions',
            sessionId,
            requestId,
            trigger,
            query,
            items: [],
            error: 'Session is not resident.',
          })
        );
        return true;
      }
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const provider = dependencies.autocompleteProviderFor(sessionId);
        if (!provider) {
          socket.send(
            JSON.stringify({
              type: 'extension_completions',
              sessionId,
              requestId,
              trigger,
              query,
              items: [],
            })
          );
          return true;
        }
        const inputText = `${trigger}${query}`;
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), AUTOCOMPLETE_TIMEOUT_MS);
        const result = await provider.getSuggestions([inputText], 0, inputText.length, {
          signal: controller.signal,
        });
        socket.send(
          JSON.stringify({
            type: 'extension_completions',
            sessionId,
            requestId,
            trigger,
            query,
            items: normalizeCompletionItems(result?.items),
          })
        );
      } catch (err) {
        errorLog(dependencies, '[pifrontier] get_extension_autocomplete error:', err);
        socket.send(
          JSON.stringify({
            type: 'extension_completions',
            sessionId,
            requestId,
            trigger,
            query,
            items: [],
            error: String(err),
          })
        );
      } finally {
        clearTimeout(timeoutId);
      }
      return true;
    }

    case 'get_command_completions': {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const command = typeof message.command === 'string' ? message.command : '';
      const prefix = typeof message.prefix === 'string' ? message.prefix : '';
      const target = sessionId ? dependencies.getResidentSession(sessionId) : undefined;
      if (!target) {
        socket.send(
          JSON.stringify({
            type: 'command_completions',
            sessionId,
            requestId,
            command,
            prefix,
            items: [],
            error: 'Session is not resident.',
          })
        );
        return true;
      }
      try {
        const items = await dependencies.getCommandCompletions(target, command, prefix);
        socket.send(
          JSON.stringify({
            type: 'command_completions',
            sessionId,
            requestId,
            command,
            prefix,
            items: normalizeCompletionItems(items),
          })
        );
      } catch (err) {
        errorLog(dependencies, '[pifrontier] get_command_completions error:', err);
        socket.send(
          JSON.stringify({
            type: 'command_completions',
            sessionId,
            requestId,
            command,
            prefix,
            items: [],
            error: String(err),
          })
        );
      }
      return true;
    }

    case 'read_file': {
      const filePath = message.path;
      try {
        if (filePath.includes('\0')) {
          socket.send(
            JSON.stringify({
              type: 'file_content',
              path: filePath,
              content: '',
              error: 'Invalid path',
            })
          );
          return true;
        }
        const resolved = resolve(dependencies.activeCwd(), expandTilde(filePath));
        if (!dependencies.isInsideWorkspace(resolved)) {
          socket.send(
            JSON.stringify({
              type: 'file_content',
              path: filePath,
              content: '',
              error: 'Path escapes workspace root',
            })
          );
          return true;
        }
        let fileSize: number;
        try {
          fileSize = (await stat(resolved)).size;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            socket.send(
              JSON.stringify({
                type: 'file_content',
                path: filePath,
                content: '',
                error: 'File not found',
              })
            );
            return true;
          }
          throw err;
        }
        if (fileSize > MAX_READ_BYTES) {
          socket.send(
            JSON.stringify({
              type: 'file_content',
              path: filePath,
              content: '',
              error: `File too large to view (${(fileSize / 1024 / 1024).toFixed(1)} MB > 2 MB)`,
            })
          );
          return true;
        }
        const content = await dependencies.readFile(resolved);
        socket.send(JSON.stringify({ type: 'file_content', path: filePath, content }));
      } catch (err) {
        errorLog(dependencies, '[pifrontier] read_file error:', err);
        socket.send(
          JSON.stringify({ type: 'file_content', path: filePath, content: '', error: String(err) })
        );
      }
      return true;
    }

    case 'write_file': {
      const filePath = message.path;
      const fileContent = message.content;
      try {
        if (filePath.includes('\0')) {
          socket.send(
            JSON.stringify({ type: 'file_saved', path: filePath, error: 'Invalid path' })
          );
          return true;
        }
        const resolved = resolve(dependencies.activeCwd(), expandTilde(filePath));
        if (!dependencies.isInsideWorkspace(resolved)) {
          socket.send(
            JSON.stringify({
              type: 'file_saved',
              path: filePath,
              error: 'Path escapes workspace root',
            })
          );
          return true;
        }
        await dependencies.writeFile(resolved, fileContent);
        socket.send(JSON.stringify({ type: 'file_saved', path: filePath }));
      } catch (err) {
        errorLog(dependencies, '[pifrontier] write_file error:', err);
        socket.send(JSON.stringify({ type: 'file_saved', path: filePath, error: String(err) }));
      }
      return true;
    }

    case 'upload_file': {
      const uploadId = message.uploadId;
      const originalName = message.name;
      const uploadData = message.data;
      let workspaceRoot: string;
      let sessionId: string | null = null;
      try {
        workspaceRoot = dependencies.activeCwd();
        const uploadTarget = dependencies.resolveUploadTarget(
          message.sessionId,
          socket.data?.focusedSessionId
        );
        workspaceRoot = uploadTarget.workspaceRoot;
        sessionId = uploadTarget.sessionId;
        if (originalName.includes('\0')) throw new Error('Invalid filename');
        const sanitizedName = basename(originalName.replaceAll('\\', '/')).replace(
          /[^A-Za-z0-9._-]/g,
          '_'
        );
        const extensionIndex = sanitizedName.lastIndexOf('.');
        const extension =
          extensionIndex > 0 ? sanitizedName.slice(extensionIndex, extensionIndex + 100) : '';
        const stem = extensionIndex > 0 ? sanitizedName.slice(0, extensionIndex) : sanitizedName;
        const safeName = `${stem.slice(0, 100 - extension.length)}${extension}`;
        const uniqueName = `${Date.now()}-${crypto
          .randomUUID()
          .replaceAll('-', '')
          .slice(0, 6)}-${safeName}`;
        const stagingDir = dependencies.uploadStagingDir(workspaceRoot);
        const resolved = resolve(stagingDir, uniqueName);
        if (!dependencies.isInsideWorkspace(resolved, workspaceRoot))
          throw new Error('Path escapes workspace root');
        if ((uploadData.length * 3) / 4 > dependencies.maxUploadBytes) {
          throw new Error(
            `File too large (maximum ${dependencies.maxUploadBytes / 1024 / 1024} MB)`
          );
        }
        const bytes = decodeBase64(uploadData);
        if (bytes.byteLength > dependencies.maxUploadBytes) {
          throw new Error(
            `File too large (maximum ${dependencies.maxUploadBytes / 1024 / 1024} MB)`
          );
        }
        await mkdir(stagingDir, { recursive: true });
        if (!dependencies.isInsideWorkspace(resolved, workspaceRoot))
          throw new Error('Path escapes workspace root');
        await dependencies.writeFile(resolved, bytes);
        try {
          const names = await readdir(stagingDir);
          if (names.length > dependencies.maxStagedFiles) {
            const candidates = names
              .filter((name) => name !== uniqueName)
              .map((name) => {
                try {
                  return { n: name, mtime: statSync(join(stagingDir, name)).mtimeMs };
                } catch {
                  return null;
                }
              })
              .filter((candidate): candidate is { n: string; mtime: number } => candidate !== null)
              .sort((a, b) => a.mtime - b.mtime);
            let total = names.length;
            for (const candidate of candidates) {
              if (total <= dependencies.maxStagedFiles) break;
              try {
                await rm(join(stagingDir, candidate.n));
                total -= 1;
              } catch {
                /* best effort */
              }
            }
          }
        } catch {
          /* prune is best effort; the staged reply stands */
        }
        const stagedPath = relative(workspaceRoot, resolved).split(sep).join('/');
        socket.send(
          JSON.stringify({
            type: 'file_staged',
            uploadId,
            name: originalName,
            path: stagedPath,
            sessionId,
          })
        );
      } catch (err) {
        errorLog(dependencies, '[pifrontier] upload_file error:', err);
        socket.send(
          JSON.stringify({
            type: 'file_staged',
            uploadId,
            name: originalName,
            path: originalName,
            sessionId,
            error: String(err),
          })
        );
      }
      return true;
    }

    default:
      return false;
  }
}

/** Directory names omitted from workspace file completion walks. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.svelte-kit',
  'build',
  'dist',
  '.cache',
]);
