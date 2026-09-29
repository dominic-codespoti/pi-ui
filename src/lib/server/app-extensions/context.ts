/**
 * Server-side host services for trusted app-extension backend operations.
 *
 * SERVER-ONLY: uses node:fs/node:path/node:child_process. Supplied to
 * operation handlers as an `AppExtensionExecutionContext` (see
 * `src/lib/app-extensions/types.ts`).
 *
 * Convenience services, not a sandbox: extension code is explicitly trusted,
 * full-code execution (same posture as the package loader). These helpers
 * only make the common operations convenient and bounded:
 * - workspace reads are confined to the explicitly resolved project root
 *   (lexical + symlink-aware realpath containment, 2 MiB read cap);
 * - `cli.run` takes the executable and argv separately (no shell), resolves
 *   its cwd exclusively from `resolveProjectRoot(scope.projectId)` — callers
 *   can never inject a cwd — and caps output (default 64 KiB per stream);
 * - storage is a small app-namespaced JSON store with safe keys and atomic
 *   writes (1 MiB value cap);
 * - `emit` forwards events with the extension ID and the exact call scope.
 */

import { spawn } from 'node:child_process';
import {
  mkdir as nodeMkdir,
  readdir as nodeReaddir,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
  rename as nodeRename,
  stat as nodeStat,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type {
  AppExtensionExecResult,
  AppExtensionExecutionContext,
  AppExtensionProjectSummary,
  AppExtensionScope,
  AppExtensionSessionMessage,
  AppExtensionSessionSummary,
} from '../../app-extensions/types.ts';

export type AppExtensionContextErrorCode =
  | 'missing-scope'
  | 'invalid-path'
  | 'outside-root'
  | 'missing-file'
  | 'too-large'
  | 'invalid-json'
  | 'invalid-key'
  | 'invalid-extension'
  | 'invalid-event'
  | 'invalid-caller'
  | 'storage-error'
  | 'cli-error'
  | 'missing-capability'
  | 'missing-session'
  | 'invalid-argument'
  | 'unavailable';

export class AppExtensionContextError extends Error {
  readonly code: AppExtensionContextErrorCode;
  constructor(code: AppExtensionContextErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts as ErrorOptions);
    this.name = 'AppExtensionContextError';
    this.code = code;
  }
}

/** Workspace file reads are capped so one operation cannot load huge files. */
export const APP_EXTENSION_WORKSPACE_MAX_READ_BYTES = 2 * 1024 * 1024;

/** Directory listings return at most this many sorted entries. */
export const APP_EXTENSION_WORKSPACE_MAX_LIST_ENTRIES = 1000;

/** Default per-stream cap for `cli.run` stdout/stderr. */
export const APP_EXTENSION_CLI_DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Serialized JSON storage values are capped so the store stays small. */
export const APP_EXTENSION_STORAGE_MAX_VALUE_BYTES = 1024 * 1024;

/** Key count per extension is capped so the store cannot grow without bound. */
export const APP_EXTENSION_STORAGE_MAX_KEYS = 256;

/** Storage keys (and extension IDs) are capped at this length. */
export const APP_EXTENSION_STORAGE_MAX_KEY_LENGTH = 128;

/** Workspace file writes are capped so one operation cannot fill the disk. */
export const APP_EXTENSION_WORKSPACE_MAX_WRITE_BYTES = 1024 * 1024;

/** Default/max message count for `session.getMessages`. */
export const APP_EXTENSION_SESSION_DEFAULT_MESSAGE_LIMIT = 50;
export const APP_EXTENSION_SESSION_MAX_MESSAGE_LIMIT = 200;

/** Per-message text cap and total JSON cap for projected transcripts. */
export const APP_EXTENSION_SESSION_MAX_MESSAGE_TEXT_CHARS = 4000;
export const APP_EXTENSION_SESSION_MAX_TOTAL_BYTES = 256 * 1024;

const EXTENSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface AppExtensionRunCommandOptions {
  /** Resolved exclusively from `resolveProjectRoot` — never caller-supplied. */
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export type AppExtensionRunCommand = (
  program: string,
  args: readonly string[],
  options: AppExtensionRunCommandOptions,
) => Promise<AppExtensionExecResult>;

/** Minimal filesystem surface used by workspace + storage (injectable for tests). */
export interface AppExtensionHostFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Array<{ name: string }>>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<{ size: number; isFile(): boolean; isDirectory(): boolean }>;
}

const defaultFs: AppExtensionHostFs = {
  readFile: (path, encoding) => nodeReadFile(path, encoding),
  readdir: (path, options) => nodeReaddir(path, options),
  realpath: (path) => nodeRealpath(path),
  mkdir: (path, options) => nodeMkdir(path, options),
  writeFile: (path, data, encoding) => nodeWriteFile(path, data, encoding),
  rename: (oldPath, newPath) => nodeRename(oldPath, newPath),
  unlink: (path) => nodeUnlink(path),
  stat: (path) => nodeStat(path),
};

export interface CreateAppExtensionExecutionContextOptions {
  extensionId: string;
  /** Explicit call scope; project operations require `scope.projectId`. */
  scope: AppExtensionScope;
  caller: { kind: 'ui' | 'agent'; sessionId?: string };
  signal?: AbortSignal;
  /** Registry-ID → absolute project directory. The only source of cwd/root. */
  resolveProjectRoot: (projectId: string) => string;
  /** Root directory under which per-extension storage namespaces live. */
  extensionDataRoot: string;
  emit: (
    extensionId: string,
    eventName: string,
    data: unknown,
    scope: AppExtensionScope,
  ) => void;
  /** Injected command runner (tests). Defaults to a spawn-based runner, no shell. */
  runCommand?: AppExtensionRunCommand;
  /** Declared manifest capabilities gating sensitive namespaces. */
  capabilities?: string[];
  /**
   * Transcript source for `session.getMessages` (wired by the server from
   * resident sessions). Must return JSON-safe SDK messages for the given
   * session ID.
   */
  getSessionMessages?: (sessionId: string) => Promise<unknown[]>;
  /** Project catalog source for `projects.list` (wired by the server). */
  listProjects?: () => Promise<AppExtensionProjectSummary[]>;
  /** Session catalog source for `sessions.list` (wired by the server). */
  listSessions?: () => Promise<AppExtensionSessionSummary[]>;
  /** Optional filesystem overrides; merged over the node:fs defaults. */
  fs?: Partial<AppExtensionHostFs>;
}

function assertExtensionId(extensionId: unknown): asserts extensionId is string {
  if (
    typeof extensionId !== 'string' ||
    extensionId.length === 0 ||
    extensionId.length > APP_EXTENSION_STORAGE_MAX_KEY_LENGTH ||
    !EXTENSION_ID_PATTERN.test(extensionId)
  ) {
    throw new AppExtensionContextError(
      'invalid-extension',
      `extension id must match ${String(EXTENSION_ID_PATTERN)} (got ${JSON.stringify(extensionId)})`,
    );
  }
}

function assertStorageKey(key: unknown): asserts key is string {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > APP_EXTENSION_STORAGE_MAX_KEY_LENGTH ||
    !STORAGE_KEY_PATTERN.test(key)
  ) {
    throw new AppExtensionContextError(
      'invalid-key',
      `storage key must match ${String(STORAGE_KEY_PATTERN)} within ${APP_EXTENSION_STORAGE_MAX_KEY_LENGTH} chars (got ${JSON.stringify(key)})`,
    );
  }
}

/**
 * Validate a workspace-relative path: non-empty, forward-slash, no null
 * bytes, no absolute paths, no `..`/empty/`.` segments. Returns the cleaned
 * relative path (`.` and `` normalized to `` by the caller for listFiles).
 */
function assertWorkspaceRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppExtensionContextError(
      'invalid-path',
      'workspace path must be a non-empty project-relative path',
    );
  }
  if (value.includes('\0')) {
    throw new AppExtensionContextError('invalid-path', 'workspace path must not contain null bytes');
  }
  if (value.includes('\\')) {
    throw new AppExtensionContextError(
      'invalid-path',
      'workspace path must use forward slashes (backslashes are ambiguous)',
    );
  }
  if (isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new AppExtensionContextError(
      'invalid-path',
      `workspace path must be project-relative (got ${JSON.stringify(value)})`,
    );
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new AppExtensionContextError(
        'invalid-path',
        `workspace path must not contain empty segments (got ${JSON.stringify(value)})`,
      );
    }
    if (segment === '..' || segment === '.') {
      throw new AppExtensionContextError(
        'invalid-path',
        `workspace path must not contain ".." or "." segments (got ${JSON.stringify(value)})`,
      );
    }
  }
  return value;
}

const SESSION_TEXT_TRUNCATION_MARKER = '…(truncated)';

function boundSessionText(text: string): string {
  if (text.length <= APP_EXTENSION_SESSION_MAX_MESSAGE_TEXT_CHARS) return text;
  return (
    text.slice(0, APP_EXTENSION_SESSION_MAX_MESSAGE_TEXT_CHARS - SESSION_TEXT_TRUNCATION_MARKER.length) +
    SESSION_TEXT_TRUNCATION_MARKER
  );
}

function sessionMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (typeof block === 'object' && block !== null) {
        const record = block as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/** Project one SDK message to a bounded, JSON-safe transcript entry. */
function projectSessionMessage(message: unknown): AppExtensionSessionMessage | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  const rawRole =
    typeof record.role === 'string' ? record.role.toLowerCase().replace(/_/g, '') : '';
  const role: AppExtensionSessionMessage['role'] =
    rawRole === 'user'
      ? 'user'
      : rawRole === 'assistant'
        ? 'assistant'
        : rawRole === 'tool' || rawRole === 'toolresult'
          ? 'tool'
          : 'other';
  const entry: AppExtensionSessionMessage = {
    role,
    text: boundSessionText(sessionMessageText(record.content)),
  };
  if (typeof record.toolName === 'string') entry.toolName = record.toolName;
  if (record.isError === true) entry.isError = true;
  return entry;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

async function defaultRunCommand(
  program: string,
  args: readonly string[],
  opts: AppExtensionRunCommandOptions,
): Promise<AppExtensionExecResult> {
  const maxOutputBytes = opts.maxOutputBytes ?? APP_EXTENSION_CLI_DEFAULT_MAX_OUTPUT_BYTES;
  if (opts.signal?.aborted) {
    return { stdout: '', stderr: '', exitCode: null, timedOut: false, killed: true };
  }
  return new Promise<AppExtensionExecResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, [...args], { cwd: opts.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      rejectPromise(
        new AppExtensionContextError('cli-error', `failed to spawn ${JSON.stringify(program)}`, {
          cause: err,
        }),
      );
      return;
    }
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let killedByUs = false;
    const onAbort = () => {
      killedByUs = true;
      try {
        child.kill();
      } catch {
        // Already exited; close handler settles the promise.
      }
    };
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            killedByUs = true;
            try {
              child.kill('SIGKILL');
            } catch {
              // Already exited; close handler settles the promise.
            }
          }, opts.timeoutMs)
        : undefined;
    // Clear the timer even if the platform never fires it (timeoutMs: 0).
    timer?.unref?.();
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const cappedPush = (
      chunks: Buffer[],
      used: number,
      data: Buffer,
    ): number => {
      if (used >= maxOutputBytes) return used;
      const take = data.subarray(0, maxOutputBytes - used);
      chunks.push(take);
      return used + take.length;
    };
    child.stdout?.on('data', (data: Buffer) => {
      outBytes = cappedPush(outChunks, outBytes, Buffer.from(data));
    });
    child.stderr?.on('data', (data: Buffer) => {
      errBytes = cappedPush(errChunks, errBytes, Buffer.from(data));
    });
    child.on('error', (err) => {
      settle(() => {
        cleanup();
        rejectPromise(
          new AppExtensionContextError(
            'cli-error',
            `failed to run ${JSON.stringify(program)}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          ),
        );
      });
    });
    child.on('close', (code) => {
      settle(() => {
        cleanup();
        resolvePromise({
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          exitCode: code,
          timedOut,
          killed: killedByUs || code === null,
        });
      });
    });
  });
}

/**
 * Build the server-side services for one extension call. Scope is explicit:
 * workspace and `cli.run` resolve the project root from `scope.projectId`
 * via `resolveProjectRoot` and reject project-scoped work without one.
 */
export function createAppExtensionExecutionContext(
  options: CreateAppExtensionExecutionContextOptions,
): AppExtensionExecutionContext {
  assertExtensionId(options.extensionId);
  const { extensionId, scope, caller, signal } = options;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new AppExtensionContextError('missing-scope', 'execution context requires an explicit scope object');
  }
  if (!caller || typeof caller !== 'object' || (caller.kind !== 'ui' && caller.kind !== 'agent')) {
    throw new AppExtensionContextError(
      'invalid-caller',
      'execution context requires a caller of kind "ui" or "agent"',
    );
  }
  if (typeof options.resolveProjectRoot !== 'function') {
    throw new AppExtensionContextError('missing-scope', 'execution context requires a resolveProjectRoot dependency');
  }
  if (typeof options.extensionDataRoot !== 'string' || options.extensionDataRoot.length === 0) {
    throw new AppExtensionContextError('storage-error', 'execution context requires an extensionDataRoot directory');
  }
  if (typeof options.emit !== 'function') {
    throw new AppExtensionContextError('invalid-event', 'execution context requires an emit dependency');
  }
  const fs: AppExtensionHostFs = { ...defaultFs, ...options.fs };
  const runCommand = options.runCommand ?? defaultRunCommand;
  const grantedCapabilities = new Set(options.capabilities ?? []);
  const requireCapability = (capability: string): void => {
    if (!grantedCapabilities.has(capability)) {
      throw new AppExtensionContextError(
        'missing-capability',
        `extension "${extensionId}" does not declare the "${capability}" capability — add it to "capabilities" in pi-ui.extension.json`
      );
    }
  };
  const getSessionMessages: (sessionId: string) => Promise<unknown[]> =
    options.getSessionMessages ??
    (async () => {
      throw new AppExtensionContextError('unavailable', 'session transcript is unavailable');
    });
  const listProjects: () => Promise<AppExtensionProjectSummary[]> =
    options.listProjects ??
    (async () => {
      throw new AppExtensionContextError('unavailable', 'project catalog is unavailable');
    });
  const listSessions: () => Promise<AppExtensionSessionSummary[]> =
    options.listSessions ??
    (async () => {
      throw new AppExtensionContextError('unavailable', 'session catalog is unavailable');
    });

  const requireProjectId = (): string => {
    const projectId = scope.projectId;
    if (typeof projectId !== 'string' || projectId.length === 0) {
      throw new AppExtensionContextError(
        'missing-scope',
        'this operation requires an explicit scope.projectId — it is never inferred from global or focused state',
      );
    }
    return projectId;
  };

  let canonicalRootPromise: Promise<string> | undefined;
  const canonicalProjectRoot = (): Promise<string> => {
    canonicalRootPromise ??= (async () => {
      const projectId = requireProjectId();
      let rawRoot: string;
      try {
        rawRoot = options.resolveProjectRoot(projectId);
      } catch (err) {
        throw new AppExtensionContextError(
          'missing-scope',
          `unknown projectId ${JSON.stringify(projectId)}`,
          { cause: err },
        );
      }
      if (typeof rawRoot !== 'string' || rawRoot.length === 0) {
        throw new AppExtensionContextError(
          'missing-scope',
          `unknown projectId ${JSON.stringify(projectId)}`,
        );
      }
      try {
        return await fs.realpath(rawRoot);
      } catch (err) {
        throw new AppExtensionContextError(
          'missing-file',
          `project root not found for projectId ${JSON.stringify(projectId)}`,
          { cause: err },
        );
      }
    })();
    return canonicalRootPromise;
  };

  /**
   * Resolve a validated relative path inside the canonical project root.
   * Lexical check first, then symlink-aware realpath containment so a
   * symlink inside the project pointing outside is rejected.
   */
  const resolveWorkspacePath = async (relativePath: string): Promise<string> => {
    const canonicalRoot = await canonicalProjectRoot();
    const joined = resolve(canonicalRoot, relativePath);
    if (joined !== canonicalRoot && !joined.startsWith(canonicalRoot + sep)) {
      throw new AppExtensionContextError(
        'outside-root',
        `workspace path escapes the project root: ${JSON.stringify(relativePath)}`,
      );
    }
    let real: string;
    try {
      real = await fs.realpath(joined);
    } catch (err) {
      throw new AppExtensionContextError(
        'missing-file',
        `workspace file not found: ${relativePath}`,
        { cause: err },
      );
    }
    if (real !== canonicalRoot && !real.startsWith(canonicalRoot + sep)) {
      throw new AppExtensionContextError(
        'outside-root',
        `workspace symlink escapes the project root: ${JSON.stringify(relativePath)}`,
      );
    }
    return real;
  };

  const readWorkspaceText = async (relativePath: string): Promise<string> => {
    const safe = assertWorkspaceRelativePath(relativePath);
    const abs = await resolveWorkspacePath(safe);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) {
        throw new AppExtensionContextError('invalid-path', `workspace path is not a file: ${safe}`);
      }
      if (st.size > APP_EXTENSION_WORKSPACE_MAX_READ_BYTES) {
        throw new AppExtensionContextError(
          'too-large',
          `workspace file exceeds the ${APP_EXTENSION_WORKSPACE_MAX_READ_BYTES}-byte read cap: ${safe}`,
        );
      }
    } catch (err) {
      if (err instanceof AppExtensionContextError) throw err;
      if (isEnoent(err)) {
        throw new AppExtensionContextError('missing-file', `workspace file not found: ${safe}`, {
          cause: err,
        });
      }
      throw err;
    }
    const text = await fs.readFile(abs, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > APP_EXTENSION_WORKSPACE_MAX_READ_BYTES) {
      throw new AppExtensionContextError(
        'too-large',
        `workspace file exceeds the ${APP_EXTENSION_WORKSPACE_MAX_READ_BYTES}-byte read cap: ${safe}`,
      );
    }
    return text;
  };

  const storageDir = (): string => join(options.extensionDataRoot, extensionId);

  const storagePathFor = (key: string): string => {
    assertStorageKey(key);
    return join(storageDir(), `${key}.json`);
  };

  let tmpCounter = 0;
  const atomicWriteJson = async (target: string, serialized: string): Promise<void> => {
    await fs.mkdir(storageDir(), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
    try {
      await fs.writeFile(tmp, serialized, 'utf8');
      await fs.rename(tmp, target);
    } catch (err) {
      try {
        await fs.unlink(tmp);
      } catch {
        // Best effort: leave no stray tmp file behind.
      }
      throw new AppExtensionContextError('storage-error', `failed to write storage key for extension "${extensionId}"`, {
        cause: err,
      });
    }
  };

  return {
    scope,
    caller,
    ...(signal !== undefined ? { signal } : {}),

    workspace: {
      readText: (relativePath: string) => readWorkspaceText(relativePath),

      readJson: async (relativePath: string): Promise<unknown> => {
        const text = await readWorkspaceText(relativePath);
        try {
          return JSON.parse(text) as unknown;
        } catch (err) {
          throw new AppExtensionContextError(
            'invalid-json',
            `workspace file is not valid JSON: ${relativePath}`,
            { cause: err },
          );
        }
      },

      writeText: async (
        relativePath: string,
        content: string
      ): Promise<{ bytesWritten: number }> => {
        requireCapability('workspace.write');
        const safe = assertWorkspaceRelativePath(relativePath);
        if (typeof content !== 'string') {
          throw new AppExtensionContextError('invalid-argument', 'workspace content must be a string');
        }
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > APP_EXTENSION_WORKSPACE_MAX_WRITE_BYTES) {
          throw new AppExtensionContextError(
            'too-large',
            `workspace content exceeds the ${APP_EXTENSION_WORKSPACE_MAX_WRITE_BYTES}-byte write cap: ${safe}`
          );
        }
        const canonicalRoot = await canonicalProjectRoot();
        const dirPart = safe.includes('/') ? safe.slice(0, safe.lastIndexOf('/')) : '';
        const absDir = dirPart === '' ? canonicalRoot : resolve(canonicalRoot, dirPart);
        if (absDir !== canonicalRoot && !absDir.startsWith(canonicalRoot + sep)) {
          throw new AppExtensionContextError(
            'outside-root',
            `workspace path escapes the project root: ${JSON.stringify(relativePath)}`
          );
        }
        await fs.mkdir(absDir, { recursive: true });
        let realDir: string;
        try {
          realDir = await fs.realpath(absDir);
        } catch (err) {
          throw new AppExtensionContextError(
            'missing-file',
            `workspace directory not found: ${dirPart === '' ? '.' : dirPart}`,
            { cause: err }
          );
        }
        if (realDir !== canonicalRoot && !realDir.startsWith(canonicalRoot + sep)) {
          throw new AppExtensionContextError(
            'outside-root',
            `workspace symlink escapes the project root: ${JSON.stringify(relativePath)}`
          );
        }
        const target = join(realDir, basename(safe));
        try {
          const st = await fs.stat(target);
          if (!st.isFile()) {
            throw new AppExtensionContextError('invalid-path', `workspace path is not a file: ${safe}`);
          }
        } catch (err) {
          if (err instanceof AppExtensionContextError) throw err;
          if (!isEnoent(err)) throw err;
        }
        const tmp = `${target}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
        try {
          await fs.writeFile(tmp, content, 'utf8');
          await fs.rename(tmp, target);
        } catch (err) {
          try {
            await fs.unlink(tmp);
          } catch {
            // Best effort: leave no stray tmp file behind.
          }
          throw new AppExtensionContextError('storage-error', `failed to write workspace file: ${safe}`, {
            cause: err,
          });
        }
        return { bytesWritten: bytes };
      },

      listFiles: async (relativePath?: string): Promise<string[]> => {
        const rel =
          relativePath === undefined || relativePath === '' || relativePath === '.'
            ? ''
            : assertWorkspaceRelativePath(relativePath);
        const canonicalRoot = await canonicalProjectRoot();
        const abs =
          rel === '' ? canonicalRoot : await resolveWorkspacePath(rel);
        let entries: Array<{ name: string }>;
        try {
          const st = await fs.stat(abs);
          if (!st.isDirectory()) {
            throw new AppExtensionContextError(
              'invalid-path',
              `workspace path is not a directory: ${rel === '' ? '.' : rel}`,
            );
          }
          entries = await fs.readdir(abs, { withFileTypes: true });
        } catch (err) {
          if (err instanceof AppExtensionContextError) throw err;
          if (isEnoent(err)) {
            throw new AppExtensionContextError(
              'missing-file',
              `workspace directory not found: ${rel === '' ? '.' : rel}`,
              { cause: err },
            );
          }
          throw err;
        }
        return entries
          .map((e) => e.name)
          .sort()
          .slice(0, APP_EXTENSION_WORKSPACE_MAX_LIST_ENTRIES)
          .map((name) => (rel === '' ? name : `${rel}/${name}`));
      },
    },

    cli: {
      run: async (
        program: string,
        args: string[],
        runOptions?: { timeoutMs?: number; maxOutputBytes?: number },
      ): Promise<AppExtensionExecResult> => {
        // cwd comes exclusively from the resolved project root: any extra
        // caller-supplied fields (e.g. a smuggled `cwd`) are ignored.
        const projectId = requireProjectId();
        if (typeof program !== 'string' || program.length === 0) {
          throw new AppExtensionContextError('cli-error', 'cli program must be a non-empty string');
        }
        if (program.includes('\0')) {
          throw new AppExtensionContextError('cli-error', 'cli program must not contain null bytes');
        }
        if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
          throw new AppExtensionContextError(
            'cli-error',
            'cli args must be an array of strings without null bytes',
          );
        }
        const { timeoutMs, maxOutputBytes } = runOptions ?? {};
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
          throw new AppExtensionContextError('cli-error', 'cli timeoutMs must be a finite number >= 0');
        }
        const cappedBytes = maxOutputBytes ?? APP_EXTENSION_CLI_DEFAULT_MAX_OUTPUT_BYTES;
        if (!Number.isFinite(cappedBytes) || cappedBytes <= 0) {
          throw new AppExtensionContextError('cli-error', 'cli maxOutputBytes must be a finite number > 0');
        }
        let rawRoot: string;
        try {
          rawRoot = options.resolveProjectRoot(projectId);
        } catch (err) {
          throw new AppExtensionContextError('missing-scope', `unknown projectId ${JSON.stringify(projectId)}`, {
            cause: err,
          });
        }
        if (typeof rawRoot !== 'string' || rawRoot.length === 0) {
          throw new AppExtensionContextError('missing-scope', `unknown projectId ${JSON.stringify(projectId)}`);
        }
        let cwd: string;
        try {
          cwd = await fs.realpath(rawRoot);
        } catch (err) {
          throw new AppExtensionContextError(
            'cli-error',
            `project root not found for projectId ${JSON.stringify(projectId)}`,
            { cause: err },
          );
        }
        return runCommand(program, [...args], {
          cwd,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          maxOutputBytes: cappedBytes,
          ...(signal !== undefined ? { signal } : {}),
        });
      },
    },

    storage: {
      get: async (key: string): Promise<unknown | null> => {
        const target = storagePathFor(key);
        let text: string;
        try {
          text = await fs.readFile(target, 'utf8');
        } catch (err) {
          if (isEnoent(err)) return null;
          throw new AppExtensionContextError(
            'storage-error',
            `failed to read storage key ${JSON.stringify(key)} for extension "${extensionId}"`,
            { cause: err },
          );
        }
        try {
          return JSON.parse(text) as unknown;
        } catch (err) {
          throw new AppExtensionContextError(
            'storage-error',
            `storage key ${JSON.stringify(key)} for extension "${extensionId}" holds invalid JSON`,
            { cause: err },
          );
        }
      },

      set: async (key: string, value: unknown): Promise<void> => {
        const target = storagePathFor(key);
        const exists = await fs.stat(target).then(
          () => true,
          (err: unknown) => {
            if (isEnoent(err)) return false;
            throw new AppExtensionContextError(
              'storage-error',
              `failed to access storage key ${JSON.stringify(key)} for extension "${extensionId}"`,
              { cause: err }
            );
          }
        );
        if (!exists) {
          let names: Array<{ name: string }>;
          try {
            names = await fs.readdir(storageDir(), { withFileTypes: true });
          } catch (err) {
            if (!isEnoent(err)) {
              throw new AppExtensionContextError(
                'storage-error',
                `failed to list storage for extension "${extensionId}"`,
                { cause: err }
              );
            }
            names = [];
          }
          const used = names.filter((entry) => entry.name.endsWith('.json')).length;
          if (used >= APP_EXTENSION_STORAGE_MAX_KEYS) {
            throw new AppExtensionContextError(
              'too-large',
              `storage key limit (${APP_EXTENSION_STORAGE_MAX_KEYS} keys) reached for extension "${extensionId}" — delete unused keys`
            );
          }
        }
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(value);
        } catch (err) {
          throw new AppExtensionContextError(
            'storage-error',
            `storage value for key ${JSON.stringify(key)} is not JSON-serializable`,
            { cause: err },
          );
        }
        if (typeof serialized !== 'string') {
          throw new AppExtensionContextError(
            'storage-error',
            `storage value for key ${JSON.stringify(key)} is not JSON-serializable`,
          );
        }
        if (Buffer.byteLength(serialized, 'utf8') > APP_EXTENSION_STORAGE_MAX_VALUE_BYTES) {
          throw new AppExtensionContextError(
            'too-large',
            `storage value for key ${JSON.stringify(key)} exceeds the ${APP_EXTENSION_STORAGE_MAX_VALUE_BYTES}-byte cap`,
          );
        }
        await atomicWriteJson(target, serialized);
      },

      delete: async (key: string): Promise<boolean> => {
        const target = storagePathFor(key);
        try {
          await fs.unlink(target);
          return true;
        } catch (err) {
          if (isEnoent(err)) return false;
          throw new AppExtensionContextError(
            'storage-error',
            `failed to delete storage key ${JSON.stringify(key)} for extension "${extensionId}"`,
            { cause: err },
          );
        }
      },
    },

    session: {
      getMessages: async (
        callOptions?: { limit?: number; kinds?: Array<AppExtensionSessionMessage['role']> }
      ): Promise<AppExtensionSessionMessage[]> => {
        requireCapability('session.read');
        const sessionId = scope.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new AppExtensionContextError(
            'missing-scope',
            'ctx.session requires a session-scoped call — it is never inferred from global or focused state'
          );
        }
        const limit = callOptions?.limit ?? APP_EXTENSION_SESSION_DEFAULT_MESSAGE_LIMIT;
        if (!Number.isInteger(limit) || limit < 1) {
          throw new AppExtensionContextError(
            'invalid-argument',
            'getMessages limit must be a positive integer'
          );
        }
        if (limit > APP_EXTENSION_SESSION_MAX_MESSAGE_LIMIT) {
          throw new AppExtensionContextError(
            'too-large',
            `getMessages limit exceeds the ${APP_EXTENSION_SESSION_MAX_MESSAGE_LIMIT}-message cap`
          );
        }
        const kinds = callOptions?.kinds;
        let kindFilter: Set<AppExtensionSessionMessage['role']> | undefined;
        if (kinds !== undefined) {
          if (
            !Array.isArray(kinds) ||
            kinds.some((kind) => kind !== 'user' && kind !== 'assistant' && kind !== 'tool' && kind !== 'other')
          ) {
            throw new AppExtensionContextError(
              'invalid-argument',
              'getMessages kinds must be an array of "user", "assistant", "tool", "other"'
            );
          }
          kindFilter = new Set(kinds);
        }
        let raw: unknown[];
        try {
          raw = await getSessionMessages(sessionId);
        } catch (err) {
          if (err instanceof AppExtensionContextError) throw err;
          throw new AppExtensionContextError(
            'missing-session',
            `session transcript unavailable for session ${JSON.stringify(sessionId)}`,
            { cause: err }
          );
        }
        if (!Array.isArray(raw)) {
          throw new AppExtensionContextError('missing-session', 'session transcript is unavailable');
        }
        const projected: AppExtensionSessionMessage[] = [];
        for (const message of raw.slice(-limit)) {
          const entry = projectSessionMessage(message);
          if (!entry) continue;
          if (kindFilter && !kindFilter.has(entry.role)) continue;
          projected.push(entry);
        }
        let encoded = JSON.stringify(projected);
        while (
          projected.length > 0 &&
          Buffer.byteLength(encoded, 'utf8') > APP_EXTENSION_SESSION_MAX_TOTAL_BYTES
        ) {
          projected.shift();
          encoded = JSON.stringify(projected);
        }
        return projected;
      },
    },

    projects: {
      list: async (): Promise<AppExtensionProjectSummary[]> => {
        requireCapability('catalog.list');
        let entries: AppExtensionProjectSummary[];
        try {
          entries = await listProjects();
        } catch (err) {
          if (err instanceof AppExtensionContextError) throw err;
          throw new AppExtensionContextError('unavailable', 'project catalog is unavailable', {
            cause: err,
          });
        }
        if (!Array.isArray(entries)) {
          throw new AppExtensionContextError('unavailable', 'project catalog is unavailable');
        }
        return entries
          .filter((entry) => typeof entry?.cwd === 'string' && typeof entry?.name === 'string')
          .map((entry) => ({ cwd: entry.cwd, name: entry.name }));
      },
    },

    sessions: {
      list: async (): Promise<AppExtensionSessionSummary[]> => {
        requireCapability('catalog.list');
        const projectId = scope.projectId;
        if (typeof projectId !== 'string' || projectId.length === 0) {
          throw new AppExtensionContextError(
            'missing-scope',
            'ctx.sessions requires a project-scoped call — it lists sessions in the calling project only'
          );
        }
        let entries: AppExtensionSessionSummary[];
        try {
          entries = await listSessions();
        } catch (err) {
          if (err instanceof AppExtensionContextError) throw err;
          throw new AppExtensionContextError('unavailable', 'session catalog is unavailable', {
            cause: err,
          });
        }
        if (!Array.isArray(entries)) {
          throw new AppExtensionContextError('unavailable', 'session catalog is unavailable');
        }
        return entries
          .filter((entry) => typeof entry?.id === 'string' && entry?.cwd === projectId)
          .map((entry) => ({
            id: entry.id,
            cwd: entry.cwd,
            ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
            messageCount: typeof entry.messageCount === 'number' ? entry.messageCount : 0,
          }));
      },
    },

    emit: (eventName: string, data?: unknown): void => {
      if (typeof eventName !== 'string' || eventName.length === 0) {
        throw new AppExtensionContextError('invalid-event', 'event name must be a non-empty string');
      }
      if (eventName.includes('\0')) {
        throw new AppExtensionContextError('invalid-event', 'event name must not contain null bytes');
      }
      options.emit(extensionId, eventName, data, scope);
    },
  };
}
