import { describe, expect, test } from 'vitest';
import {
  APP_EXTENSION_API_VERSION,
  type AppExtensionCallContext,
  type AppExtensionManifest,
} from '../../app-extensions/types.ts';
import { AppExtensionError, AppExtensionRuntime } from './runtime.ts';

function manifest(overrides?: Partial<AppExtensionManifest>): AppExtensionManifest {
  return {
    schemaVersion: 1,
    apiVersion: APP_EXTENSION_API_VERSION,
    id: 'demo.notes',
    name: 'Notes',
    version: '1.0.0',
    clientEntry: 'dist/client.js',
    serverEntry: 'dist/server.js',
    views: [{ id: 'main', title: 'Notes', slot: 'sidebar' }],
    operations: [
      { id: 'list', kind: 'read', description: 'List notes' },
      { id: 'create', kind: 'action', description: 'Create a note' },
    ],
    ...overrides,
  };
}

function handlers() {
  return {
    reads: {
      list: async (input: Record<string, unknown>) => ({ notes: [], input }),
    },
    actions: {
      create: async (input: Record<string, unknown>, ctx: AppExtensionCallContext) => ({
        created: input,
        caller: ctx.caller,
        scope: ctx.scope,
      }),
    },
  };
}

function ctxFor(caller: 'ui' | 'agent' = 'ui'): AppExtensionCallContext {
  return { scope: { projectId: 'proj-1', sessionId: 'sess-1' }, caller: { kind: caller } };
}

async function expectCode(
  promise: Promise<unknown>,
  code: 'not-registered' | 'disabled' | 'unknown-operation' | 'wrong-kind',
) {
  await expect(promise).rejects.toSatisfy(
    (err) => err instanceof AppExtensionError && err.code === code,
  );
}

describe('AppExtensionRuntime registry lifecycle', () => {
  test('register → list → disable → enable → unregister', async () => {
    const rt = new AppExtensionRuntime();
    const summary = rt.register(manifest(), handlers());
    expect(summary).toMatchObject({ id: 'demo.notes', enabled: true });
    expect(rt.list()).toHaveLength(1);

    rt.disable('demo.notes');
    expect(rt.get('demo.notes')?.enabled).toBe(false);
    await expectCode(rt.read('demo.notes', 'list', {}, ctxFor()), 'disabled');

    rt.enable('demo.notes');
    expect(rt.get('demo.notes')?.enabled).toBe(true);
    expect(await rt.read('demo.notes', 'list', {}, ctxFor())).toEqual({
      notes: [],
      input: {},
    });

    expect(rt.unregister('demo.notes')).toBe(true);
    expect(rt.unregister('demo.notes')).toBe(false);
    expect(rt.list()).toEqual([]);
    expect(rt.get('demo.notes')).toBeUndefined();
  });

  test('duplicate registration is rejected', () => {
    const rt = new AppExtensionRuntime();
    rt.register(manifest(), handlers());
    expect(() => rt.register(manifest(), handlers())).toThrowError(AppExtensionError);
  });

  test('invalid manifests are rejected', () => {
    const rt = new AppExtensionRuntime();
    expect(() => rt.register(manifest({ id: '' }), handlers())).toThrowError(AppExtensionError);
    expect(() => rt.register(manifest({ apiVersion: 999 as never }), handlers())).toThrowError(
      AppExtensionError,
    );
    expect(() =>
      rt.register(
        manifest({
          operations: [
            { id: 'dup', kind: 'read', description: 'a' },
            { id: 'dup', kind: 'action', description: 'b' },
          ],
        }),
        { reads: { dup: async () => null }, actions: { dup: async () => null } },
      ),
    ).toThrowError(AppExtensionError);
  });

  test('capabilities must be unique known values and surface in summaries', () => {
    const rt = new AppExtensionRuntime();
    const summary = rt.register(manifest({ capabilities: ['session.read'] }), handlers());
    expect(summary.capabilities).toEqual(['session.read']);
    expect(() =>
      rt.register(manifest({ id: 'bad1', capabilities: ['shell.exec' as never] }), handlers())
    ).toThrowError(AppExtensionError);
    expect(() =>
      rt.register(manifest({ id: 'bad2', capabilities: ['session.read', 'session.read'] }), handlers())
    ).toThrowError(AppExtensionError);
  });

  test('missing, undeclared, and wrong-kind handlers are rejected', () => {
    const rt = new AppExtensionRuntime();
    // Missing action handler.
    expect(() => rt.register(manifest(), { reads: { list: async () => null } })).toThrowError(
      AppExtensionError,
    );
    // Undeclared read handler.
    expect(() =>
      rt.register(manifest(), {
        reads: { list: async () => null, ghost: async () => null },
        actions: { create: async () => null },
      }),
    ).toThrowError(AppExtensionError);
    // Read handler supplied for an action operation.
    expect(() =>
      rt.register(manifest(), {
        reads: { create: async () => null, list: async () => null },
        actions: { create: async () => null },
      }),
    ).toThrowError(AppExtensionError);
    expect(rt.list()).toEqual([]);
  });
});

describe('AppExtensionRuntime dispatch', () => {
  test('missing extension and unknown operation fail with codes', async () => {
    const rt = new AppExtensionRuntime();
    await expectCode(rt.read('nope', 'list', {}, ctxFor()), 'not-registered');
    await expectCode(rt.invoke('nope', 'create', {}, ctxFor()), 'not-registered');
    rt.register(manifest(), handlers());
    await expectCode(rt.read('demo.notes', 'missing', {}, ctxFor()), 'unknown-operation');
    await expectCode(rt.invoke('demo.notes', 'missing', {}, ctxFor()), 'unknown-operation');
  });

  test('wrong-kind dispatch is rejected in both directions', async () => {
    const rt = new AppExtensionRuntime();
    rt.register(manifest(), handlers());
    await expectCode(rt.read('demo.notes', 'create', {}, ctxFor()), 'wrong-kind');
    await expectCode(rt.invoke('demo.notes', 'list', {}, ctxFor()), 'wrong-kind');
  });

  test('handlers receive input and the unchanged context (scope/caller)', async () => {
    const rt = new AppExtensionRuntime();
    let seenCtx: AppExtensionCallContext | undefined;
    let seenInput: unknown;
    rt.register(manifest(), {
      reads: {
        list: async (input, ctx) => {
          seenInput = input;
          seenCtx = ctx;
          return 'ok';
        },
      },
      actions: { create: async () => 'created' },
    });
    const ctx = ctxFor('agent');
    expect(await rt.read('demo.notes', 'list', { q: 'x' }, ctx)).toBe('ok');
    expect(seenInput).toEqual({ q: 'x' });
    // Same reference: the runtime must not rebuild scope/caller or invent focus.
    expect(seenCtx).toBe(ctx);
  });

  test('the same action is invokable by any caller kind through one invoke()', async () => {
    const rt = new AppExtensionRuntime();
    rt.register(manifest(), handlers());
    const viaUi = (await rt.invoke('demo.notes', 'create', { t: 'a' }, ctxFor('ui'))) as {
      caller: unknown;
    };
    const viaAgent = (await rt.invoke(
      'demo.notes',
      'create',
      { t: 'b' },
      ctxFor('agent'),
    )) as { caller: unknown };
    expect(viaUi.caller).toEqual({ kind: 'ui' });
    expect(viaAgent.caller).toEqual({ kind: 'agent' });
  });
});

describe('AppExtensionRuntime events', () => {
  test('emit reaches subscribers with scope; unsubscribe stops delivery', () => {
    const rt = new AppExtensionRuntime();
    rt.register(manifest(), handlers());
    const received: unknown[] = [];
    const unsub = rt.subscribe('demo.notes', 'note-changed', (e) => received.push(e));
    rt.emit('demo.notes', 'note-changed', { id: 1 }, { projectId: 'proj-1' });
    expect(received).toEqual([
      {
        extensionId: 'demo.notes',
        eventName: 'note-changed',
        data: { id: 1 },
        scope: { projectId: 'proj-1' },
      },
    ]);

    unsub();
    rt.emit('demo.notes', 'note-changed', { id: 2 });
    expect(received).toHaveLength(1);
    // Second unsubscribe is a no-op.
    unsub();
  });

  test('events are isolated per extension and event name', () => {
    const rt = new AppExtensionRuntime();
    rt.register(manifest(), handlers());
    rt.register(
      manifest({ id: 'demo.other', name: 'Other', operations: [] }),
      { reads: {}, actions: {} },
    );
    const hits: string[] = [];
    rt.subscribe('demo.notes', 'a', () => hits.push('notes:a'));
    rt.subscribe('demo.notes', 'b', () => hits.push('notes:b'));
    rt.subscribe('demo.other', 'a', () => hits.push('other:a'));
    rt.emit('demo.notes', 'a', {});
    expect(hits).toEqual(['notes:a']);
  });

  test('subscribe/emit on unknown extensions fail; unregister drops listeners', () => {
    const rt = new AppExtensionRuntime();
    expect(() => rt.subscribe('nope', 'a', () => {})).toThrowError(AppExtensionError);
    expect(() => rt.emit('nope', 'a', {})).toThrowError(AppExtensionError);
    rt.register(manifest(), handlers());
    let calls = 0;
    rt.subscribe('demo.notes', 'a', () => calls++);
    rt.unregister('demo.notes');
    expect(() => rt.emit('demo.notes', 'a', {})).toThrowError(AppExtensionError);
    expect(calls).toBe(0);
  });
});
