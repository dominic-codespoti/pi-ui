import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  dispatchFilesystemMessage,
  type FilesystemAutocompleteProvider,
  type FilesystemCompletionCache,
  type FilesystemHandlerDependencies,
  type FilesystemResidentTarget,
} from '../filesystem-handlers.ts';

function cache(): FilesystemCompletionCache {
  return { file: new Map(), dir: new Map() };
}

function target(root: string): FilesystemResidentTarget {
  return {
    session: {
      sessionManager: { getCwd: () => root },
      extensionRunner: { getCommand: () => undefined },
    },
  };
}

describe('dispatchFilesystemMessage', () => {
  let root: string;
  let outside: string;
  let resident: FilesystemResidentTarget;
  let dependencies: FilesystemHandlerDependencies;
  let send: Mock<(data: string) => unknown>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'filesystem-handlers-'));
    outside = await mkdtemp(join(tmpdir(), 'filesystem-handlers-outside-'));
    resident = target(root);
    send = vi.fn<(data: string) => unknown>();
    dependencies = {
      activeCwd: () => root,
      getResidentSession: (sessionId) => (sessionId === 'session-1' ? resident : undefined),
      autocompleteProviderFor: () => null,
      getCommandCompletions: async () => [],
      isInsideWorkspace: (path) => path === root || path.startsWith(root + sep),
      uploadStagingDir: (workspaceRoot) => join(workspaceRoot, '.pi-ui-uploads'),
      readFile: (path) => readFile(path, 'utf8'),
      writeFile: (path, data) => writeFile(path, data),
      maxUploadBytes: 10 * 1024 * 1024,
      maxStagedFiles: 20,
      completionCache: cache(),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('returns false and sends nothing for an unrelated message', async () => {
    expect(await dispatchFilesystemMessage({ type: 'ping' }, { send }, dependencies)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns correlated workspace file completions for a resident session', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'main.ts'), 'export {}');
    await writeFile(join(root, 'README.md'), '# test');

    expect(
      await dispatchFilesystemMessage(
        { type: 'file_complete', sessionId: 'session-1', requestId: 'request-7', query: 'MAIN' },
        { send },
        dependencies
      )
    ).toBe(true);

    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: 'file_completions',
      sessionId: 'session-1',
      requestId: 'request-7',
      query: 'MAIN',
      entries: ['src/main.ts'],
    });
  });

  it('reports a stale or missing resident target with correlation fields', async () => {
    await dispatchFilesystemMessage(
      { type: 'file_complete', sessionId: 'gone', requestId: 'request-8', query: 'x' },
      { send },
      dependencies
    );

    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: 'file_completions',
      sessionId: 'gone',
      requestId: 'request-8',
      query: 'x',
      entries: [],
      error: 'Session is not resident.',
    });
  });

  it('rejects null-byte and outside-workspace paths', async () => {
    await dispatchFilesystemMessage(
      { type: 'read_file', path: 'bad\0path' },
      { send },
      dependencies
    );
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: 'file_content',
      path: 'bad\0path',
      content: '',
      error: 'Invalid path',
    });

    send.mockClear();
    await dispatchFilesystemMessage(
      { type: 'write_file', path: resolve(outside, 'escape.txt'), content: 'nope' },
      { send },
      dependencies
    );
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: 'file_saved',
      path: resolve(outside, 'escape.txt'),
      error: 'Path escapes workspace root',
    });
  });

  it('successfully writes and reads a workspace file', async () => {
    await dispatchFilesystemMessage(
      { type: 'write_file', path: 'notes.txt', content: 'hello from the handler' },
      { send },
      dependencies
    );
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({ type: 'file_saved', path: 'notes.txt' });
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('hello from the handler');

    send.mockClear();
    await dispatchFilesystemMessage(
      { type: 'read_file', path: 'notes.txt' },
      { send },
      dependencies
    );
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: 'file_content',
      path: 'notes.txt',
      content: 'hello from the handler',
    });
  });

  it('rejects an invalid upload and stages a valid base64 upload', async () => {
    await dispatchFilesystemMessage(
      { type: 'upload_file', name: 'bad\0name.txt', data: 'aGVsbG8=' },
      { send },
      dependencies
    );
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: 'file_staged',
      name: 'bad\0name.txt',
      path: 'bad\0name.txt',
      error: 'Error: Invalid filename',
    });

    send.mockClear();
    await dispatchFilesystemMessage(
      { type: 'upload_file', name: 'invalid.txt', data: 'not base64' },
      { send },
      dependencies
    );
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: 'file_staged',
      name: 'invalid.txt',
      path: 'invalid.txt',
      error: 'Error: Invalid base64 data',
    });

    send.mockClear();
    await dispatchFilesystemMessage(
      { type: 'upload_file', name: 'nested\\hello.txt', data: 'aGVsbG8=' },
      { send },
      dependencies
    );
    const frame = JSON.parse(send.mock.calls[0][0]);
    expect(frame).toMatchObject({ type: 'file_staged', name: 'nested\\hello.txt' });
    expect(frame.path).toMatch(/^\.pi-ui-uploads\/\d+-[a-f0-9]{6}-hello\.txt$/);
    expect(await readFile(join(root, frame.path), 'utf8')).toBe('hello');
  });

  it('retains all extension and command completion correlation fields', async () => {
    const provider: FilesystemAutocompleteProvider = {
      async getSuggestions() {
        return { items: [{ label: 'suggestion', value: 'suggestion' }] };
      },
    };
    dependencies.autocompleteProviderFor = () => provider;
    await dispatchFilesystemMessage(
      {
        type: 'get_extension_autocomplete',
        sessionId: 'session-1',
        requestId: 'request-9',
        trigger: '@',
        query: 'hel',
      },
      { send },
      dependencies
    );
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: 'extension_completions',
      sessionId: 'session-1',
      requestId: 'request-9',
      trigger: '@',
      query: 'hel',
      items: [{ label: 'suggestion', value: 'suggestion' }],
    });

    dependencies.getCommandCompletions = async () => [
      { label: 'argument', value: '--argument', description: 'an argument' },
    ];
    send.mockClear();
    await dispatchFilesystemMessage(
      {
        type: 'get_command_completions',
        sessionId: 'session-1',
        requestId: 'request-10',
        command: 'deploy',
        prefix: '--arg',
      },
      { send },
      dependencies
    );
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: 'command_completions',
      sessionId: 'session-1',
      requestId: 'request-10',
      command: 'deploy',
      prefix: '--arg',
      items: [{ label: 'argument', value: '--argument', description: 'an argument' }],
    });
  });
});
