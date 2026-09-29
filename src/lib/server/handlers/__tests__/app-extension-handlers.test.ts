import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  APP_EXTENSION_ERROR_LIMIT_CHARS,
  appExtensionEventRecipients,
  cancelAppExtensionCallsForSocket,
  dispatchAppExtensionMessage,
  type AppExtensionHandlerDependencies,
  type AppExtensionHandlerRuntime,
} from '../app-extension-handlers';
import type {
  AppExtensionCallContext,
  AppExtensionOperationDeclaration,
  AppExtensionScope,
  AppExtensionSummary,
} from '../../../app-extensions/types';
import type { ProjectInfo } from '../../../ws/protocol';
import type { SessionFileInfo } from '../../session-scan';

type TestDependencies = AppExtensionHandlerDependencies & {
  socket: { send: Mock };
  list: Mock;
  operations: Mock;
  read: Mock;
  invoke: Mock;
  listProjects: Mock;
  listSessions: Mock;
  clientUrl: Mock;
  refresh: Mock;
  setEnabled: Mock;
  eventNames: Mock;
};

function op(
  id: string,
  kind: 'read' | 'action',
  scope?: 'app' | 'project' | 'session'
): AppExtensionOperationDeclaration {
  return { id, kind, description: `${id} op`, ...(scope ? { scope } : {}) };
}

function summary(id: string, enabled = true): AppExtensionSummary {
  return { id, name: id, version: '1.0.0', enabled, views: [], capabilities: [] };
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

function setup(
  options: {
    operations?: AppExtensionOperationDeclaration[];
    summaries?: AppExtensionSummary[];
    projects?: ProjectInfo[];
    sessions?: SessionFileInfo[];
    readImpl?: AppExtensionHandlerRuntime['read'];
    invokeImpl?: AppExtensionHandlerRuntime['invoke'];
    listImpl?: AppExtensionHandlerRuntime['list'];
    refreshImpl?: () => void | Promise<void>;
    setEnabledImpl?: (extensionId: string, enabled: boolean) => void | Promise<void>;
    reloadImpl?: (extensionId: string) => void | Promise<void>;
    eventNamesImpl?: (extensionId: string) => string[];
  } = {}
): TestDependencies {
  const socket = { send: vi.fn() };
  const list = vi.fn(options.listImpl ?? (() => options.summaries ?? [summary('notes')]));
  const operations = vi.fn(() => options.operations ?? []);
  const read = vi.fn(options.readImpl ?? (async () => ({ ok: 1 })));
  const invoke = vi.fn(options.invokeImpl ?? (async () => ({ ok: 1 })));
  const listProjects = vi.fn(async () => options.projects ?? []);
  const listSessions = vi.fn(async () => options.sessions ?? []);
  const clientUrl = vi.fn((id: string) => `/extensions/${id}/client.js`);
  const refresh = vi.fn(options.refreshImpl ?? (async () => {}));
  const setEnabled = vi.fn(options.setEnabledImpl ?? (async () => {}));
  const reload = vi.fn(options.reloadImpl ?? (async () => {}));
  const runtime: AppExtensionHandlerRuntime = { list, operations, read, invoke };

  return {
    socket,
    list,
    operations,
    read,
    invoke,
    listProjects,
    listSessions,
    clientUrl,
    refresh,
    setEnabled,
    reload,
    runtime,
    projectCatalog: { list: listProjects },
    sessionCatalog: { list: listSessions },
    eventNames: vi.fn(options.eventNamesImpl ?? (() => ['changed'])),
  };
}

function lastPayload(socket: { send: Mock }): Record<string, unknown> {
  return JSON.parse(socket.send.mock.lastCall![0] as string) as Record<string, unknown>;
}

function lastCtx(deps: TestDependencies, method: 'read' | 'invoke'): AppExtensionCallContext {
  return (deps[method].mock.lastCall! as unknown[])[3] as AppExtensionCallContext;
}

describe('dispatchAppExtensionMessage', () => {
  it('returns false for unrelated messages without effects', async () => {
    const deps = setup();
    expect(await dispatchAppExtensionMessage({ type: 'ping' }, deps.socket, deps)).toBe(false);
    expect(deps.socket.send).not.toHaveBeenCalled();
    expect(deps.list).not.toHaveBeenCalled();
    expect(deps.operations).not.toHaveBeenCalled();
  });

  it('routes events only to sockets with validated exact-scope subscriptions', async () => {
    const deps = setup({
      projects: [project('/work/a'), project('/work/b')],
      sessions: [session('session-a', '/work/a')],
    });
    const projectSocket = deps.socket;
    const sessionSocket = { send: vi.fn() };
    const otherProjectSocket = { send: vi.fn() };
    const invalidSocket = { send: vi.fn() };

    const subscribe = (socket: { send: Mock }, subscriptionId: string, scope: AppExtensionScope) =>
      dispatchAppExtensionMessage(
        {
          type: 'app_extension_subscribe',
          subscriptionId,
          extensionId: 'notes',
          eventName: 'changed',
          scope,
        },
        socket,
        deps
      );
    await subscribe(projectSocket, 'project', { projectId: '/work/a' });
    await subscribe(sessionSocket, 'session', { sessionId: 'session-a' });
    await subscribe(otherProjectSocket, 'other', { projectId: '/work/b' });
    await subscribe(invalidSocket, 'invalid-project', { projectId: '/work/private' });
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_subscribe',
        subscriptionId: 'invalid-event',
        extensionId: 'notes',
        eventName: 'undeclared',
        scope: { projectId: '/work/a' },
      },
      invalidSocket,
      deps
    );

    expect(appExtensionEventRecipients('notes', 'changed', { projectId: '/work/a' })).toEqual([
      projectSocket,
    ]);
    expect(
      appExtensionEventRecipients('notes', 'changed', {
        projectId: '/work/a',
        sessionId: 'session-a',
      })
    ).toEqual([sessionSocket]);
    expect(appExtensionEventRecipients('notes', 'changed', { projectId: '/work/b' })).toEqual([
      otherProjectSocket,
    ]);
    expect(lastPayload(invalidSocket)).toMatchObject({
      type: 'app_extension_subscription_result',
      extensionId: 'notes',
      ok: false,
    });
    cancelAppExtensionCallsForSocket(sessionSocket);
    expect(
      appExtensionEventRecipients('notes', 'changed', {
        projectId: '/work/a',
        sessionId: 'session-a',
      })
    ).toEqual([]);

    await dispatchAppExtensionMessage(
      { type: 'app_extension_unsubscribe', subscriptionId: 'other' },
      otherProjectSocket,
      deps
    );
    expect(appExtensionEventRecipients('notes', 'changed', { projectId: '/work/b' })).toEqual([]);
    for (const socket of [projectSocket, sessionSocket, otherProjectSocket, invalidSocket]) {
      cancelAppExtensionCallsForSocket(socket);
    }
  });

  it('lists extensions and decorates enabled summaries with clientUrl', async () => {
    const deps = setup({ summaries: [summary('notes'), summary('off', false)] });
    expect(
      await dispatchAppExtensionMessage({ type: 'get_app_extensions' }, deps.socket, deps)
    ).toBe(true);
    const payload = lastPayload(deps.socket);
    expect(payload.type).toBe('app_extensions_list');
    const extensions = payload.extensions as Array<Record<string, unknown>>;
    expect(extensions).toHaveLength(2);
    expect(extensions[0]).toMatchObject({ id: 'notes', clientUrl: '/extensions/notes/client.js' });
    expect(extensions[1]).toMatchObject({ id: 'off' });
    expect(extensions[1]).not.toHaveProperty('clientUrl');
  });

  it('omits clientUrl when no builder is configured and stays empty on list failure', async () => {
    const deps = setup({ summaries: [summary('notes')] });
    const withoutBuilder: AppExtensionHandlerDependencies = { ...deps };
    delete withoutBuilder.clientUrl;
    await dispatchAppExtensionMessage({ type: 'get_app_extensions' }, deps.socket, withoutBuilder);
    expect(lastPayload(deps.socket).extensions).toMatchObject([{ id: 'notes' }]);
    expect(lastPayload(deps.socket).extensions as unknown[]).toHaveLength(1);
    expect(
      (lastPayload(deps.socket).extensions as Array<Record<string, unknown>>)[0]
    ).not.toHaveProperty('clientUrl');

    const failing = setup({
      listImpl: () => {
        throw new Error('boom');
      },
    });
    await dispatchAppExtensionMessage({ type: 'get_app_extensions' }, failing.socket, failing);
    expect(lastPayload(failing.socket)).toEqual({ type: 'app_extensions_list', extensions: [] });
  });

  it('dispatches app-scoped reads with an empty scope and ui-only caller', async () => {
    const deps = setup({ operations: [op('stats', 'read')] });
    const ok = await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c1',
        extensionId: 'notes',
        operationId: 'stats',
        kind: 'read',
        input: { q: 1 },
        scope: {},
      },
      deps.socket,
      deps
    );
    expect(ok).toBe(true);
    expect(deps.read).toHaveBeenCalledTimes(1);
    expect(deps.invoke).not.toHaveBeenCalled();
    expect(deps.read.mock.lastCall!.slice(0, 3)).toEqual(['notes', 'stats', { q: 1 }]);
    expect(lastCtx(deps, 'read')).toEqual({
      scope: {},
      caller: { kind: 'ui' },
      signal: expect.any(AbortSignal),
    });
    expect(lastPayload(deps.socket)).toMatchObject({
      type: 'app_extension_result',
      callId: 'c1',
      extensionId: 'notes',
      ok: true,
      result: { ok: 1 },
    });
  });

  it('strips ambient project/session ids from app-scoped operations', async () => {
    const deps = setup({
      operations: [op('stats', 'read')],
      projects: [project('/work')],
      sessions: [session('s1', '/work')],
    });
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c1',
        extensionId: 'notes',
        operationId: 'stats',
        kind: 'read',
        scope: { projectId: '/work' },
      },
      deps.socket,
      deps
    );
    expect(deps.read).toHaveBeenCalledTimes(1);
    expect(lastCtx(deps, 'read')).toEqual({
      scope: {},
      caller: { kind: 'ui' },
      signal: expect.any(AbortSignal),
    });
    expect(lastPayload(deps.socket)).toMatchObject({ ok: true });
  });

  it('dispatches project-scoped actions with canonical project scope', async () => {
    const deps = setup({
      operations: [op('reindex', 'action', 'project')],
      projects: [project('/work')],
    });
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c1',
        extensionId: 'notes',
        operationId: 'reindex',
        kind: 'action',
        scope: { projectId: '/work' },
      },
      deps.socket,
      deps
    );
    expect(deps.invoke).toHaveBeenCalledTimes(1);
    expect(lastCtx(deps, 'invoke')).toEqual({
      scope: { projectId: '/work' },
      caller: { kind: 'ui' },
      signal: expect.any(AbortSignal),
    });
    expect(lastPayload(deps.socket)).toMatchObject({ ok: true });
  });

  it('passes caller sessionId when a project call names a session of that project', async () => {
    const deps = setup({
      operations: [op('reindex', 'action', 'project')],
      projects: [project('/work')],
      sessions: [session('s1', '/work')],
    });
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c1',
        extensionId: 'notes',
        operationId: 'reindex',
        kind: 'action',
        scope: { projectId: '/work', sessionId: 's1' },
      },
      deps.socket,
      deps
    );
    expect(lastCtx(deps, 'invoke')).toEqual({
      scope: { projectId: '/work', sessionId: 's1' },
      caller: { kind: 'ui', sessionId: 's1' },
      signal: expect.any(AbortSignal),
    });
    expect(lastPayload(deps.socket)).toMatchObject({ ok: true });
  });

  it('rejects project calls with missing, unknown, or arbitrary project ids', async () => {
    const deps = setup({
      operations: [op('reindex', 'action', 'project')],
      projects: [project('/work')],
      sessions: [session('s1', '/work')],
    });
    const call = (scope: Record<string, string>) =>
      dispatchAppExtensionMessage(
        {
          type: 'app_extension_call',
          callId: 'c1',
          extensionId: 'notes',
          operationId: 'reindex',
          kind: 'action',
          scope,
        },
        deps.socket,
        deps
      );

    await call({});
    expect(lastPayload(deps.socket)).toMatchObject({ ok: false });

    // Arbitrary cwd never present in the catalog must not dispatch.
    await call({ projectId: '/etc/shadow-owner' });
    expect(lastPayload(deps.socket)).toMatchObject({ ok: false });
    expect(String((lastPayload(deps.socket) as { error: string }).error)).toMatch(
      /unknown project/
    );

    await call({ projectId: '/work', sessionId: 'nope' });
    expect(String((lastPayload(deps.socket) as { error: string }).error)).toMatch(
      /unknown session/
    );

    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it('rejects project calls when the session belongs to another project', async () => {
    const deps = setup({
      operations: [op('reindex', 'action', 'project')],
      projects: [project('/work'), project('/other')],
      sessions: [session('s9', '/other')],
    });
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c1',
        extensionId: 'notes',
        operationId: 'reindex',
        kind: 'action',
        scope: { projectId: '/work', sessionId: 's9' },
      },
      deps.socket,
      deps
    );
    expect(deps.invoke).not.toHaveBeenCalled();
    expect(String((lastPayload(deps.socket) as { error: string }).error)).toMatch(
      /does not belong to project/
    );
  });

  it('enforces explicit sessions for session-scoped operations', async () => {
    const deps = setup({
      operations: [op('summarize', 'read', 'session')],
      projects: [project('/work'), project('/other')],
      sessions: [session('s1', '/work')],
    });
    const call = (scope: Record<string, string>) =>
      dispatchAppExtensionMessage(
        {
          type: 'app_extension_call',
          callId: 'c1',
          extensionId: 'notes',
          operationId: 'summarize',
          kind: 'read',
          scope,
        },
        deps.socket,
        deps
      );

    await call({});
    expect(String((lastPayload(deps.socket) as { error: string }).error)).toMatch(
      /requires an explicit sessionId/
    );

    await call({ sessionId: 'ghost' });
    expect(String((lastPayload(deps.socket) as { error: string }).error)).toMatch(
      /unknown session/
    );

    await call({ sessionId: 's1', projectId: '/other' });
    expect(String((lastPayload(deps.socket) as { error: string }).error)).toMatch(
      /does not match session/
    );
    expect(deps.read).not.toHaveBeenCalled();

    await call({ sessionId: 's1' });
    expect(lastCtx(deps, 'read')).toEqual({
      scope: { projectId: '/work', sessionId: 's1' },
      caller: { kind: 'ui', sessionId: 's1' },
      signal: expect.any(AbortSignal),
    });

    await call({ sessionId: 's1', projectId: '/work' });
    expect(lastCtx(deps, 'read')).toEqual({
      scope: { projectId: '/work', sessionId: 's1' },
      caller: { kind: 'ui', sessionId: 's1' },
      signal: expect.any(AbortSignal),
    });
    expect(deps.read).toHaveBeenCalledTimes(2);
  });

  it('never falls back to socket focus: socket data is untouched', async () => {
    const deps = setup({ operations: [op('stats', 'read'), op('summarize', 'read', 'session')] });
    const touchySocket = {
      send: deps.socket.send,
      get data(): unknown {
        throw new Error('focus fallback is forbidden');
      },
    };
    // App-scoped success path must not read focus state.
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c1',
        extensionId: 'notes',
        operationId: 'stats',
        kind: 'read',
        scope: {},
      },
      touchySocket,
      deps
    );
    expect(lastPayload(deps.socket)).toMatchObject({ ok: true });

    // Session-scoped call without an explicit sessionId fails instead of
    // borrowing any ambient/focused session.
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c2',
        extensionId: 'notes',
        operationId: 'summarize',
        kind: 'read',
        scope: {},
      },
      touchySocket,
      deps
    );
    expect(lastPayload(deps.socket)).toMatchObject({ ok: false });
    expect(deps.read).toHaveBeenCalledTimes(1);
  });

  it('returns wrong-kind errors without dispatching', async () => {
    const deps = setup({ operations: [op('do-thing', 'action', 'app')] });
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c1',
        extensionId: 'notes',
        operationId: 'do-thing',
        kind: 'read',
        scope: {},
      },
      deps.socket,
      deps
    );
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.invoke).not.toHaveBeenCalled();
    expect(lastPayload(deps.socket)).toMatchObject({ ok: false });
    expect(String((lastPayload(deps.socket) as { error: string }).error)).toMatch(/is an action/);
  });

  it('returns unknown-operation errors without dispatching', async () => {
    const deps = setup({ operations: [op('stats', 'read')] });
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c1',
        extensionId: 'notes',
        operationId: 'missing',
        kind: 'read',
        scope: {},
      },
      deps.socket,
      deps
    );
    expect(deps.read).not.toHaveBeenCalled();
    expect(String((lastPayload(deps.socket) as { error: string }).error)).toMatch(
      /unknown operation/
    );
  });

  it('bounds operation error strings', async () => {
    const deps = setup({
      operations: [op('stats', 'read')],
      readImpl: () => Promise.reject(new Error(`boom ${'x'.repeat(5000)}`)),
    });
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c1',
        extensionId: 'notes',
        operationId: 'stats',
        kind: 'read',
        scope: {},
      },
      deps.socket,
      deps
    );
    const payload = lastPayload(deps.socket) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error.length).toBeLessThanOrEqual(APP_EXTENSION_ERROR_LIMIT_CHARS);
    expect(payload.error).toMatch(/truncated/);
  });

  it('rejects results over the 128 KiB cap and unserializable results', async () => {
    const huge = setup({
      operations: [op('stats', 'read')],
      readImpl: () => Promise.resolve('x'.repeat(200 * 1024)),
    });
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c1',
        extensionId: 'notes',
        operationId: 'stats',
        kind: 'read',
        scope: {},
      },
      huge.socket,
      huge
    );
    const capped = lastPayload(huge.socket) as { ok: boolean; error: string };
    expect(capped.ok).toBe(false);
    expect(capped.error).toMatch(/128 KiB/);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bad = setup({
      operations: [op('stats', 'read')],
      readImpl: () => Promise.resolve(circular),
    });
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c1',
        extensionId: 'notes',
        operationId: 'stats',
        kind: 'read',
        scope: {},
      },
      bad.socket,
      bad
    );
    const payload = lastPayload(bad.socket) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/JSON-serializable/);
  });

  it('rejects inputs over the 64 KiB cap before dispatch', async () => {
    const deps = setup({ operations: [op('stats', 'read')] });
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'big',
        extensionId: 'notes',
        operationId: 'stats',
        kind: 'read',
        input: { blob: 'x'.repeat(70 * 1024) },
        scope: {},
      },
      deps.socket,
      deps
    );
    expect(deps.read).not.toHaveBeenCalled();
    expect(lastPayload(deps.socket)).toMatchObject({ ok: false });
    expect((lastPayload(deps.socket) as { error: string }).error).toMatch(/64 KiB/);
  });

  it('rate-limits burst callers per connection', async () => {
    const deps = setup({ operations: [op('stats', 'read')] });
    const call = (callId: string) =>
      dispatchAppExtensionMessage(
        {
          type: 'app_extension_call',
          callId,
          extensionId: 'notes',
          operationId: 'stats',
          kind: 'read',
          scope: {},
        },
        deps.socket,
        deps
      );
    for (let i = 0; i < 120; i++) await call(`c${i}`);
    expect(deps.read).toHaveBeenCalledTimes(120);
    await call('c120');
    expect(deps.read).toHaveBeenCalledTimes(120);
    expect(lastPayload(deps.socket)).toMatchObject({ ok: false });
    expect((lastPayload(deps.socket) as { error: string }).error).toMatch(/rate exceeded/);
  });
});

describe('set_app_extension_enabled', () => {
  function payloads(socket: { send: Mock }): Array<Record<string, unknown>> {
    return socket.send.mock.calls.map(
      (call) => JSON.parse(call[0] as string) as Record<string, unknown>
    );
  }

  it('enables an extension, refreshes the catalog, and reports success', async () => {
    let enabled = false;
    const deps = setup({
      summaries: [summary('notes', false)],
      listImpl: () => [summary('notes', enabled)],
      setEnabledImpl: async (_id, next) => {
        enabled = next;
      },
    });
    const ok = await dispatchAppExtensionMessage(
      { type: 'set_app_extension_enabled', extensionId: 'notes', enabled: true },
      deps.socket,
      deps
    );
    expect(ok).toBe(true);
    expect(deps.setEnabled).toHaveBeenCalledWith('notes', true);
    const frames = payloads(deps.socket);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: 'app_extensions_list' });
    expect((frames[0]!.extensions as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'notes',
      enabled: true,
      clientUrl: '/extensions/notes/client.js',
    });
    expect(frames[1]).toMatchObject({
      type: 'app_extension_toggle_result',
      extensionId: 'notes',
      enabled: true,
      ok: true,
    });
  });

  it('disables an extension, purges its subscriptions, and strips its clientUrl', async () => {
    let enabled = true;
    const deps = setup({
      listImpl: () => [summary('notes', enabled)],
      setEnabledImpl: async (_id, next) => {
        enabled = next;
      },
    });
    const listenerSocket = { send: vi.fn() };
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_subscribe',
        subscriptionId: 'listen-notes',
        extensionId: 'notes',
        eventName: 'changed',
        scope: {},
      },
      listenerSocket,
      deps
    );
    expect(appExtensionEventRecipients('notes', 'changed', {})).toEqual([listenerSocket]);

    await dispatchAppExtensionMessage(
      { type: 'set_app_extension_enabled', extensionId: 'notes', enabled: false },
      deps.socket,
      deps
    );
    expect(appExtensionEventRecipients('notes', 'changed', {})).toEqual([]);
    const frames = payloads(deps.socket);
    expect(frames).toHaveLength(2);
    const catalog = frames[0]!.extensions as Array<Record<string, unknown>>;
    expect(catalog[0]).toMatchObject({ id: 'notes', enabled: false });
    expect(catalog[0]).not.toHaveProperty('clientUrl');
    expect(frames[1]).toMatchObject({
      type: 'app_extension_toggle_result',
      extensionId: 'notes',
      enabled: false,
      ok: true,
    });
  });

  it('reports a failure toggle result when setEnabled rejects', async () => {
    const deps = setup({
      summaries: [summary('notes', false)],
      setEnabledImpl: async () => {
        throw new Error('nope: install missing');
      },
    });
    const ok = await dispatchAppExtensionMessage(
      { type: 'set_app_extension_enabled', extensionId: 'notes', enabled: true },
      deps.socket,
      deps
    );
    expect(ok).toBe(true);
    const frames = payloads(deps.socket);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'app_extension_toggle_result',
      extensionId: 'notes',
      enabled: true,
      ok: false,
    });
    expect(String((frames[0] as { error?: string }).error)).toMatch(/nope/);
  });

  it('prunes subscriptions for extensions removed by catalog refresh', async () => {
    let installed = true;
    const deps = setup({
      listImpl: () => (installed ? [summary('notes')] : []),
      refreshImpl: () => {
        installed = false;
      },
    });
    const listenerSocket = { send: vi.fn() };
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_subscribe',
        subscriptionId: 'listen-notes',
        extensionId: 'notes',
        eventName: 'changed',
        scope: {},
      },
      listenerSocket,
      deps
    );
    expect(appExtensionEventRecipients('notes', 'changed', {})).toEqual([listenerSocket]);

    await dispatchAppExtensionMessage({ type: 'get_app_extensions' }, deps.socket, deps);
    expect(appExtensionEventRecipients('notes', 'changed', {})).toEqual([]);
  });

  it('refreshes the catalog before listing on get_app_extensions', async () => {
    const order: string[] = [];
    const deps = setup({
      summaries: [summary('notes')],
      refreshImpl: async () => {
        order.push('refresh');
      },
      listImpl: () => {
        order.push('list');
        return [summary('notes')];
      },
    });
    await dispatchAppExtensionMessage({ type: 'get_app_extensions' }, deps.socket, deps);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['refresh', 'list']);
    expect(lastPayload(deps.socket)).toMatchObject({ type: 'app_extensions_list' });
  });

  it('never touches socket focus state on toggle', async () => {
    const deps = setup({
      summaries: [summary('notes', false)],
      setEnabledImpl: async () => {},
    });
    const touchySocket = {
      send: deps.socket.send,
      get data(): unknown {
        throw new Error('focus fallback is forbidden');
      },
    };
    await dispatchAppExtensionMessage(
      { type: 'set_app_extension_enabled', extensionId: 'notes', enabled: true },
      touchySocket,
      deps
    );
    expect(deps.socket.send).toHaveBeenCalled();
  });
});

describe('app_extension_cancel over WebSocket', () => {
  async function waitForCall(read: Mock): Promise<void> {
    for (let i = 0; i < 200 && read.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(read).toHaveBeenCalled();
  }

  it('delivers AbortSignal to the handler and aborts the in-flight call', async () => {
    let captured: AbortSignal | undefined;
    const readImpl = vi.fn(
      (
        _extensionId: string,
        _operationId: string,
        _input: Record<string, unknown>,
        ctx: AppExtensionCallContext
      ) =>
        new Promise<unknown>((_resolve, reject) => {
          captured = ctx.signal;
          captured?.addEventListener(
            'abort',
            () => reject(captured?.reason ?? new Error('aborted')),
            { once: true }
          );
        })
    );
    const deps = setup({ operations: [op('stats', 'read')], readImpl });
    const callPromise = dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c-cancel',
        extensionId: 'notes',
        operationId: 'stats',
        kind: 'read',
        scope: {},
      },
      deps.socket,
      deps
    );
    await waitForCall(deps.read);
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
    expect(
      await dispatchAppExtensionMessage(
        { type: 'app_extension_cancel', callId: 'c-cancel' },
        deps.socket,
        deps
      )
    ).toBe(true);
    expect(captured!.aborted).toBe(true);
    await callPromise;
    const payload = lastPayload(deps.socket) as { type: string; ok: boolean; error?: string };
    expect(payload.type).toBe('app_extension_result');
    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toMatch(/cancelled/);
    // Cancellation entry is cleaned up: the same callId can run again.
    deps.read.mockImplementationOnce(async () => ({ ok: 2 }));
    await dispatchAppExtensionMessage(
      {
        type: 'app_extension_call',
        callId: 'c-cancel',
        extensionId: 'notes',
        operationId: 'stats',
        kind: 'read',
        scope: {},
      },
      deps.socket,
      deps
    );
    expect(lastPayload(deps.socket)).toMatchObject({ ok: true, result: { ok: 2 } });
  });

  it('ignores cancel frames for unknown callIds', async () => {
    const deps = setup({ operations: [op('stats', 'read')] });
    expect(
      await dispatchAppExtensionMessage(
        { type: 'app_extension_cancel', callId: 'ghost' },
        deps.socket,
        deps
      )
    ).toBe(true);
    expect(deps.socket.send).not.toHaveBeenCalled();
    expect(deps.read).not.toHaveBeenCalled();
  });
});

describe('reload_app_extension', () => {
  function payloads(socket: { send: Mock }): Array<Record<string, unknown>> {
    return socket.send.mock.calls.map(
      (call) => JSON.parse(call[0] as string) as Record<string, unknown>
    );
  }

  it('rescans, reloads, and republishes the catalog', async () => {
    const order: string[] = [];
    const deps = setup({
      summaries: [summary('notes')],
      refreshImpl: () => {
        order.push('refresh');
      },
      reloadImpl: async () => {
        order.push('reload');
      },
    });
    const ok = await dispatchAppExtensionMessage(
      { type: 'reload_app_extension', extensionId: 'notes' },
      deps.socket,
      deps
    );
    expect(ok).toBe(true);
    // The manifest is rescanned before the import, so a manifest edited since the last catalog
    // read is the one that gets loaded.
    expect(order).toEqual(['refresh', 'reload']);
    expect(deps.reload).toHaveBeenCalledWith('notes');
    expect(deps.setEnabled).not.toHaveBeenCalled();
    const frames = payloads(deps.socket);
    expect(frames[0]).toMatchObject({ type: 'app_extensions_list' });
    expect(frames[1]).toMatchObject({
      type: 'app_extension_reload_result',
      extensionId: 'notes',
      ok: true,
    });
  });

  it('reports a failure result, bounded, when reload rejects', async () => {
    const deps = setup({
      reloadImpl: async () => {
        throw new Error('server entry threw: boom');
      },
    });
    const ok = await dispatchAppExtensionMessage(
      { type: 'reload_app_extension', extensionId: 'notes' },
      deps.socket,
      deps
    );
    expect(ok).toBe(true);
    const frame = lastPayload(deps.socket);
    expect(frame).toMatchObject({
      type: 'app_extension_reload_result',
      extensionId: 'notes',
      ok: false,
    });
    expect(String(frame.error)).toMatch(/boom/);
  });

  it('fails cleanly when the host has no reload wired', async () => {
    const deps = setup({});
    (deps as { reload?: unknown }).reload = undefined;
    const ok = await dispatchAppExtensionMessage(
      { type: 'reload_app_extension', extensionId: 'notes' },
      deps.socket,
      deps
    );
    expect(ok).toBe(true);
    expect(lastPayload(deps.socket)).toMatchObject({
      type: 'app_extension_reload_result',
      ok: false,
    });
  });
});
