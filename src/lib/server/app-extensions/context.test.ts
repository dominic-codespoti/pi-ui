import { describe, expect, test, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppExtensionExecResult, AppExtensionScope } from '../../app-extensions/types.ts';
import {
  APP_EXTENSION_CLI_DEFAULT_MAX_OUTPUT_BYTES,
  APP_EXTENSION_STORAGE_MAX_VALUE_BYTES,
  APP_EXTENSION_WORKSPACE_MAX_READ_BYTES,
  AppExtensionContextError,
  createAppExtensionExecutionContext,
  type AppExtensionRunCommand,
  type CreateAppExtensionExecutionContextOptions,
} from './context.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

interface CtxHarness {
  projectRoot: string;
  dataRoot: string;
  emitted: Array<{ extensionId: string; eventName: string; data: unknown; scope: AppExtensionScope }>;
  runCalls: Array<{ program: string; args: readonly string[]; cwd: string; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal }>;
  runImpl: (
    result:
      | AppExtensionExecResult
      | ((program: string, args: readonly string[]) => AppExtensionExecResult)
  ) => void;
  options: (overrides?: Partial<CreateAppExtensionExecutionContextOptions>) => CreateAppExtensionExecutionContextOptions;
}

function harness(extensionId = 'test.ext'): CtxHarness {
  const projectRoot = tempDir('pi-ext-ctx-proj-');
  const dataRoot = tempDir('pi-ext-ctx-data-');
  const emitted: CtxHarness['emitted'] = [];
  const runCalls: CtxHarness['runCalls'] = [];
  let impl: (program: string, args: readonly string[]) => AppExtensionExecResult = () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    killed: false,
  });
  const runCommand: AppExtensionRunCommand = async (program, args, opts) => {
    runCalls.push({
      program,
      args,
      cwd: opts.cwd,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return impl(program, args);
  };
  return {
    projectRoot,
    dataRoot,
    emitted,
    runCalls,
    runImpl: (result) => {
      impl = typeof result === 'function' ? result : () => result;
    },
    options: (overrides = {}) => ({
      extensionId,
      scope: { projectId: 'proj-1' },
      caller: { kind: 'ui' },
      resolveProjectRoot: (id: string) => {
        if (id !== 'proj-1') throw new Error(`unknown project ${id}`);
        return projectRoot;
      },
      extensionDataRoot: dataRoot,
      emit: (eid, eventName, data, scope) => {
        emitted.push({ extensionId: eid, eventName, data, scope });
      },
      runCommand,
      ...overrides,
    }),
  };
}

async function expectContextCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (err) => err instanceof AppExtensionContextError && (err as { code: string }).code === code,
  );
}

describe('workspace reads', () => {
  test('readText/readJson round-trip nested files', async () => {
    const h = harness();
    mkdirSync(join(h.projectRoot, 'notes'), { recursive: true });
    writeFileSync(join(h.projectRoot, 'notes/a.txt'), 'hello');
    writeFileSync(join(h.projectRoot, 'notes/b.json'), JSON.stringify({ n: 1 }));
    const ctx = createAppExtensionExecutionContext(h.options());
    await expect(ctx.workspace.readText('notes/a.txt')).resolves.toBe('hello');
    await expect(ctx.workspace.readJson('notes/b.json')).resolves.toEqual({ n: 1 });
  });

  test('rejects null-byte, absolute, and traversal paths', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options());
    await expectContextCode(ctx.workspace.readText('a\0b.txt'), 'invalid-path');
    await expectContextCode(ctx.workspace.readText('/etc/passwd'), 'invalid-path');
    await expectContextCode(ctx.workspace.readText('../outside.txt'), 'invalid-path');
    await expectContextCode(ctx.workspace.readText('sub/../../evil.txt'), 'invalid-path');
    await expectContextCode(ctx.workspace.readJson('/abs/x.json'), 'invalid-path');
    await expectContextCode(ctx.workspace.listFiles('../..'), 'invalid-path');
  });

  test('rejects missing files', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options());
    await expectContextCode(ctx.workspace.readText('nope.txt'), 'missing-file');
    await expectContextCode(ctx.workspace.listFiles('nope-dir'), 'missing-file');
  });

  test('rejects symlink escape but follows links staying inside', async () => {
    const h = harness();
    const outside = tempDir('pi-ext-ctx-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    mkdirSync(join(h.projectRoot, 'docs'), { recursive: true });
    writeFileSync(join(h.projectRoot, 'docs/real.txt'), 'inside');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(h.projectRoot, 'leak.txt'));
      symlinkSync(join(h.projectRoot, 'docs/real.txt'), join(h.projectRoot, 'ok-link.txt'));
    } catch {
      // Symlinks need privileges on some platforms — skip when unsupported.
      expect(true).toBe(true);
      return;
    }
    const ctx = createAppExtensionExecutionContext(h.options());
    await expectContextCode(ctx.workspace.readText('leak.txt'), 'outside-root');
    await expect(ctx.workspace.readText('ok-link.txt')).resolves.toBe('inside');
  });

  test('enforces the 2 MiB read cap', async () => {
    const h = harness();
    writeFileSync(
      join(h.projectRoot, 'big.bin'),
      'x'.repeat(APP_EXTENSION_WORKSPACE_MAX_READ_BYTES + 1),
    );
    writeFileSync(join(h.projectRoot, 'small.txt'), 'ok');
    const ctx = createAppExtensionExecutionContext(h.options());
    await expectContextCode(ctx.workspace.readText('big.bin'), 'too-large');
    await expect(ctx.workspace.readText('small.txt')).resolves.toBe('ok');
  });

  test('readJson rejects invalid JSON', async () => {
    const h = harness();
    writeFileSync(join(h.projectRoot, 'bad.json'), '{ not json');
    const ctx = createAppExtensionExecutionContext(h.options());
    await expectContextCode(ctx.workspace.readJson('bad.json'), 'invalid-json');
  });

  test('listFiles returns sorted entries for root and subdirs', async () => {
    const h = harness();
    mkdirSync(join(h.projectRoot, 'sub'), { recursive: true });
    writeFileSync(join(h.projectRoot, 'b.txt'), 'b');
    writeFileSync(join(h.projectRoot, 'a.txt'), 'a');
    writeFileSync(join(h.projectRoot, 'sub/c.txt'), 'c');
    const ctx = createAppExtensionExecutionContext(h.options());
    await expect(ctx.workspace.listFiles()).resolves.toEqual(['a.txt', 'b.txt', 'sub']);
    await expect(ctx.workspace.listFiles('sub')).resolves.toEqual(['sub/c.txt']);
    await expectContextCode(ctx.workspace.listFiles('a.txt'), 'invalid-path');
  });

  test('workspace requires an explicit scope.projectId', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options({ scope: {} }));
    await expectContextCode(ctx.workspace.readText('a.txt'), 'missing-scope');
    await expectContextCode(ctx.workspace.listFiles(), 'missing-scope');
  });
});

describe('cli.run', () => {
  test('requires an explicit scope.projectId', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options({ scope: {} }));
    await expectContextCode(ctx.cli.run('echo', ['hi']), 'missing-scope');
  });

  test('passes program/argv separately with cwd from resolveProjectRoot', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options());
    h.runImpl({ stdout: 'out', stderr: '', exitCode: 0, timedOut: false, killed: false });
    const res = await ctx.cli.run('my-tool', ['a', 'b c'], { timeoutMs: 1234 });
    expect(res).toEqual({ stdout: 'out', stderr: '', exitCode: 0, timedOut: false, killed: false });
    expect(h.runCalls).toHaveLength(1);
    expect(h.runCalls[0]?.program).toBe('my-tool');
    expect(h.runCalls[0]?.args).toEqual(['a', 'b c']);
    // cwd is the resolved project root — never caller-supplied.
    expect(h.runCalls[0]?.cwd).toBe(h.projectRoot);
    expect(h.runCalls[0]?.timeoutMs).toBe(1234);
    expect(h.runCalls[0]?.maxOutputBytes).toBe(APP_EXTENSION_CLI_DEFAULT_MAX_OUTPUT_BYTES);
  });

  test('ignores caller-supplied cwd (no cwd injection)', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options());
    await ctx.cli.run('my-tool', [], { cwd: '/evil' } as unknown as { timeoutMs?: number });
    expect(h.runCalls[0]?.cwd).toBe(h.projectRoot);
  });

  test('forwards AbortSignal and honors custom output caps', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(
      h.options({ signal: new AbortController().signal }),
    );
    await ctx.cli.run('my-tool', [], { maxOutputBytes: 1024 });
    expect(h.runCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(h.runCalls[0]?.maxOutputBytes).toBe(1024);
  });

  test('validates program/args without a shell', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options());
    await expectContextCode(ctx.cli.run('', []), 'cli-error');
    await expectContextCode(ctx.cli.run('ok', ['a\0b']), 'cli-error');
    await expectContextCode(ctx.cli.run('ok', 'nope' as unknown as string[]), 'cli-error');
    expect(h.runCalls).toHaveLength(0);
  });

  test('default runner executes argv without a shell and times out', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options({ runCommand: undefined }));
    const ok = await ctx.cli.run(process.execPath, ['-e', 'process.stdout.write("he" + "llo")']);
    expect(ok.stdout).toBe('hello');
    expect(ok.exitCode).toBe(0);
    expect(ok.timedOut).toBe(false);
    const slow = await ctx.cli.run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 150,
    });
    expect(slow.timedOut).toBe(true);
    expect(slow.killed).toBe(true);
    expect(slow.exitCode).toBeNull();
  });

  test('default runner honors AbortSignal cancellation', async () => {
    const h = harness();
    const controller = new AbortController();
    const ctx = createAppExtensionExecutionContext(
      h.options({ runCommand: undefined, signal: controller.signal }),
    );
    const pending = ctx.cli.run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    setTimeout(() => controller.abort(), 50);
    const res = await pending;
    expect(res.killed).toBe(true);
    expect(res.exitCode).toBeNull();
  });
});

describe('storage', () => {
  test('round-trips set/get/delete; missing keys return null/false', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options());
    await expect(ctx.storage.get('prefs')).resolves.toBeNull();
    await expect(ctx.storage.delete('prefs')).resolves.toBe(false);
    await ctx.storage.set('prefs', { theme: 'dark', n: 3 });
    await expect(ctx.storage.get('prefs')).resolves.toEqual({ theme: 'dark', n: 3 });
    await expect(ctx.storage.delete('prefs')).resolves.toBe(true);
    await expect(ctx.storage.get('prefs')).resolves.toBeNull();
  });

  test('namespaces values per extension id', async () => {
    const h = harness();
    const a = createAppExtensionExecutionContext(h.options());
    const b = createAppExtensionExecutionContext(h.options({ extensionId: 'other.ext' }));
    await a.storage.set('shared', { owner: 'a' });
    await expect(b.storage.get('shared')).resolves.toBeNull();
    await b.storage.set('shared', { owner: 'b' });
    await expect(a.storage.get('shared')).resolves.toEqual({ owner: 'a' });
  });

  test('rejects unsafe keys', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options());
    for (const bad of ['', '../evil', '/abs', 'a/b', 'a\\b', 'a\0b', '.hidden', '..']) {
      await expectContextCode(ctx.storage.get(bad), 'invalid-key');
      await expectContextCode(ctx.storage.set(bad, 1), 'invalid-key');
      await expectContextCode(ctx.storage.delete(bad), 'invalid-key');
    }
  });

  test('rejects oversized values (1 MiB cap)', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options());
    await expectContextCode(
      ctx.storage.set('big', 'x'.repeat(APP_EXTENSION_STORAGE_MAX_VALUE_BYTES + 1)),
      'too-large',
    );
    await expect(ctx.storage.get('big')).resolves.toBeNull();
  });

  test('rejects invalid extension ids at creation', () => {
    const h = harness();
    expect(() => createAppExtensionExecutionContext(h.options({ extensionId: '' }))).toThrow(
      AppExtensionContextError,
    );
    expect(() => createAppExtensionExecutionContext(h.options({ extensionId: '../evil' }))).toThrow(
      AppExtensionContextError,
    );
  });
});

describe('emit', () => {
  test('forwards the extension id, event name, data, and exact scope', () => {
    const h = harness();
    const scope: AppExtensionScope = { projectId: 'proj-1', sessionId: 'sess-1' };
    const ctx = createAppExtensionExecutionContext(h.options({ scope }));
    const emitSpy = vi.fn();
    const ctx2 = createAppExtensionExecutionContext(h.options({ scope, emit: emitSpy }));
    void ctx;
    ctx2.emit('note-changed', { id: 1 });
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('test.ext', 'note-changed', { id: 1 }, scope);
    expect(h.emitted).toHaveLength(0);
  });

  test('rejects blank event names', () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options());
    expect(() => ctx.emit('')).toThrow(AppExtensionContextError);
  });
});

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppExtensionContextError);
    expect((err as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code "${code}"`);
}

describe('workspace writes', () => {
  test('writeText round-trips and creates parent directories', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options({ capabilities: ['workspace.write'] }));
    await expect(ctx.workspace.writeText('notes/a.txt', 'hello')).resolves.toEqual({ bytesWritten: 5 });
    await expect(ctx.workspace.readText('notes/a.txt')).resolves.toBe('hello');
  });

  test('writeText requires the workspace.write capability', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options());
    await expectCode(ctx.workspace.writeText('a.txt', 'x'), 'missing-capability');
  });

  test('writeText enforces caps, traversal rules, and file targets', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(h.options({ capabilities: ['workspace.write'] }));
    await expectCode(ctx.workspace.writeText('big.txt', 'x'.repeat(1024 * 1024 + 1)), 'too-large');
    await expectCode(ctx.workspace.writeText('../escape.txt', 'x'), 'invalid-path');
    mkdirSync(join(h.projectRoot, 'dir'));
    await expectCode(ctx.workspace.writeText('dir', 'x'), 'invalid-path');
  });
});

describe('session transcript', () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    { role: 'toolResult', toolName: 'read', toolCallId: 'c1', content: 'file contents' },
    { role: 'system', content: 'note' },
  ];
  const sessionOptions = (h: CtxHarness) =>
    h.options({
      capabilities: ['session.read'],
      scope: { projectId: 'proj-1', sessionId: 'sess-1' },
      getSessionMessages: async (sessionId: string) => {
        if (sessionId !== 'sess-1') throw new Error('unknown session');
        return messages;
      },
    });

  test('projects messages with roles, limits, and kind filters', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(sessionOptions(h));
    await expect(ctx.session.getMessages()).resolves.toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
      { role: 'tool', text: 'file contents', toolName: 'read' },
      { role: 'other', text: 'note' },
    ]);
    await expect(ctx.session.getMessages({ limit: 2 })).resolves.toHaveLength(2);
    await expect(ctx.session.getMessages({ kinds: ['user'] })).resolves.toEqual([
      { role: 'user', text: 'hello' },
    ]);
  });

  test('requires the session.read capability and a session scope', async () => {
    const h = harness();
    await expectCode(
      createAppExtensionExecutionContext(h.options()).session.getMessages(),
      'missing-capability'
    );
    await expectCode(
      createAppExtensionExecutionContext(
        h.options({ capabilities: ['session.read'], getSessionMessages: async () => [] })
      ).session.getMessages(),
      'missing-scope'
    );
  });

  test('validates limits and kinds, and maps unknown sessions', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(sessionOptions(h));
    await expectCode(ctx.session.getMessages({ limit: 0 }), 'invalid-argument');
    await expectCode(ctx.session.getMessages({ limit: 201 }), 'too-large');
    await expectCode(ctx.session.getMessages({ kinds: ['bogus' as never] }), 'invalid-argument');
    const missing = createAppExtensionExecutionContext(
      h.options({
        capabilities: ['session.read'],
        scope: { projectId: 'proj-1', sessionId: 'gone' },
        getSessionMessages: async () => {
          throw new Error('not resident');
        },
      })
    );
    await expectCode(missing.session.getMessages(), 'missing-session');
  });

  test('truncates long message texts', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(
      h.options({
        capabilities: ['session.read'],
        scope: { projectId: 'proj-1', sessionId: 'sess-1' },
        getSessionMessages: async () => [{ role: 'user', content: 'y'.repeat(5000) }],
      })
    );
    const entries = await ctx.session.getMessages();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text.length).toBe(4000);
    expect(entries[0]?.text.endsWith('…(truncated)')).toBe(true);
  });
});

describe('catalog listing', () => {
  test('projects.list requires the catalog.list capability', async () => {
    const h = harness();
    await expectCode(createAppExtensionExecutionContext(h.options()).projects.list(), 'missing-capability');
  });

  test('projects.list returns cwd/name pairs', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(
      h.options({
        capabilities: ['catalog.list'],
        listProjects: async () => [
          { cwd: '/work/a', name: 'a' },
          { cwd: '/work/b', name: 'b' },
        ],
      })
    );
    await expect(ctx.projects.list()).resolves.toEqual([
      { cwd: '/work/a', name: 'a' },
      { cwd: '/work/b', name: 'b' },
    ]);
  });

  test('sessions.list stays inside the calling project', async () => {
    const h = harness();
    const ctx = createAppExtensionExecutionContext(
      h.options({
        capabilities: ['catalog.list'],
        listSessions: async () => [
          { id: 's1', cwd: 'proj-1', name: 'one', messageCount: 3 },
          { id: 's2', cwd: 'proj-9', messageCount: 1 },
        ],
      })
    );
    await expect(ctx.sessions.list()).resolves.toEqual([
      { id: 's1', cwd: 'proj-1', name: 'one', messageCount: 3 },
    ]);
    const appCtx = createAppExtensionExecutionContext(
      h.options({ capabilities: ['catalog.list'], scope: {}, listSessions: async () => [] })
    );
    await expectCode(appCtx.sessions.list(), 'missing-scope');
  });
});
