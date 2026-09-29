import { describe, expect, it, vi } from 'vitest';
import type { AppExtensionHostConfirm } from './client-loader';
import {
  buildAppExtensionClientApi,
  isAppExtensionClientModule,
  loadAppExtensionClientModule,
  teardownAppExtensionClient,
  trackAppExtensionSubscriptions,
} from './client-loader';

describe('isAppExtensionClientModule', () => {
  it('accepts modules exposing a mount function', () => {
    expect(isAppExtensionClientModule({ mount: () => {} })).toBe(true);
  });

  it('rejects null, primitives, and modules without mount', () => {
    expect(isAppExtensionClientModule(null)).toBe(false);
    expect(isAppExtensionClientModule(undefined)).toBe(false);
    expect(isAppExtensionClientModule('mount')).toBe(false);
    expect(isAppExtensionClientModule({})).toBe(false);
    expect(isAppExtensionClientModule({ mount: 'not-a-function' })).toBe(false);
  });
});

describe('loadAppExtensionClientModule', () => {
  it('rejects a missing client URL without attempting an import', async () => {
    await expect(loadAppExtensionClientModule('')).rejects.toThrow(/missing client URL/);
    await expect(loadAppExtensionClientModule('   ')).rejects.toThrow(/missing client URL/);
  });
});

describe('buildAppExtensionClientApi', () => {
  it('enforces the operation kind on read vs invoke', async () => {
    const call = vi.fn(async () => 'ok');
    const subscribe = vi.fn(() => () => {});
    const api = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: { projectId: 'p1' },
      call,
      subscribe,
    });

    expect(api.extensionId).toBe('ext-a');
    expect(api.scope).toEqual({ projectId: 'p1' });
    await api.read('get-data', { limit: 5 });
    await api.invoke('do-thing', { force: true });

    expect(call).toHaveBeenNthCalledWith(1, 'read', 'get-data', { limit: 5 }, { projectId: 'p1' });
    expect(call).toHaveBeenNthCalledWith(
      2,
      'action',
      'do-thing',
      { force: true },
      {
        projectId: 'p1',
      }
    );
  });

  it('forwards subscriptions with scope and returns the host unsubscribe', () => {
    const unsubscribe = () => {};
    const subscribe = vi.fn(() => unsubscribe);
    const listener = () => {};
    const api = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: { sessionId: 's1' },
      call: vi.fn(async () => null),
      subscribe,
    });

    expect(api.subscribe('progress', listener)).toBe(unsubscribe);
    expect(subscribe).toHaveBeenCalledWith('progress', listener, { sessionId: 's1' });
  });

  it('allows event subscriptions to override the active view scope', () => {
    const subscribe = vi.fn(() => () => {});
    const api = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: { projectId: '/work/demo', sessionId: 's1' },
      call: vi.fn(async () => null),
      subscribe,
    });

    api.subscribe('host-event', vi.fn(), {});
    expect(subscribe).toHaveBeenCalledWith('host-event', expect.any(Function), {});
  });

  it('forwards notify when provided and no-ops otherwise', () => {
    const notify = vi.fn();
    const withNotify = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: {},
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
      notify,
    });
    withNotify.notify('hello', 'success');
    expect(notify).toHaveBeenCalledWith('hello', 'success');

    const withoutNotify = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: {},
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
    });
    expect(() => withoutNotify.notify('silent')).not.toThrow();
  });

  it('submits chat prompts with the view scope snapshot', async () => {
    const prompt = vi.fn(async () => {});
    const api = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: { projectId: 'p1', sessionId: 's1' },
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
      prompt,
    });
    await api.prompt('Summarize this.');
    expect(prompt).toHaveBeenCalledWith('Summarize this.', { projectId: 'p1', sessionId: 's1' });
  });

  it('rejects blank prompts and missing prompt hosts without calling out', async () => {
    const prompt = vi.fn(async () => {});
    const api = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: { sessionId: 's1' },
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
      prompt,
    });
    await expect(api.prompt('   ')).rejects.toThrow('non-empty');
    expect(prompt).not.toHaveBeenCalled();

    const withoutPrompt = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: { sessionId: 's1' },
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
    });
    await expect(withoutPrompt.prompt('Hi')).rejects.toThrow('unavailable');
  });

  it('propagates prompt host failures', async () => {
    const api = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: { sessionId: 's1' },
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => {
        throw new Error('socket closed');
      }),
    });
    await expect(api.prompt('Hi')).rejects.toThrow('socket closed');
  });

  it('replaces composer drafts with the view scope snapshot', async () => {
    const draft = vi.fn(async () => {});
    const api = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: { projectId: 'p1', sessionId: 's1' },
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
      draft,
    });
    await api.setComposerDraft('fix the typo');
    expect(draft).toHaveBeenCalledWith('fix the typo', { projectId: 'p1', sessionId: 's1' });
    await expect(api.setComposerDraft(42 as unknown as string)).rejects.toThrow('must be a string');
    expect(draft).toHaveBeenCalledTimes(1);

    const withoutDraft = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: {},
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
    });
    await expect(withoutDraft.setComposerDraft('hi')).rejects.toThrow('unavailable');
  });

  it('confirms actions and coerces the host verdict to boolean', async () => {
    const confirm = vi.fn(async () => true);
    const api = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: { sessionId: 's1' },
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
      confirm,
    });
    await expect(api.confirm({ message: 'Delete everything?' })).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith({ message: 'Delete everything?' }, { sessionId: 's1' });
    await expect(api.confirm({ title: 'Run', message: 'Go?', confirmLabel: 'Go' })).resolves.toBe(true);
    await expect(api.confirm({ message: '   ' })).rejects.toThrow('non-empty');
    await expect(api.confirm(null as unknown as { message: string })).rejects.toThrow('must be an object');
    const loose = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: {},
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
      confirm: (async () => 1) as unknown as AppExtensionHostConfirm,
    });
    await expect(loose.confirm({ message: 'Go?' })).resolves.toBe(true);

    const withoutConfirm = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: {},
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
    });
    await expect(withoutConfirm.confirm({ message: 'Go?' })).rejects.toThrow('unavailable');
  });

  it('validates project-relative file paths before opening', async () => {
    const openFile = vi.fn(async () => {});
    const api = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: { projectId: '/work/demo' },
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
      openFile,
    });
    await api.openFile('src/index.ts');
    expect(openFile).toHaveBeenCalledWith('src/index.ts', { projectId: '/work/demo' });
    for (const bad of ['', '/abs/path.ts', '../escape.ts', 'a\\b.ts', 'a/./b.ts']) {
      await expect(api.openFile(bad)).rejects.toThrow();
    }
    expect(openFile).toHaveBeenCalledTimes(1);
  });

  it('switches sessions by ID and reports missing hosts', async () => {
    const switchSession = vi.fn(async () => {});
    const api = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: {},
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
      switchSession,
    });
    await api.switchSession('session-9');
    expect(switchSession).toHaveBeenCalledWith('session-9', {});
    await expect(api.switchSession('')).rejects.toThrow('non-empty');

    const withoutHost = buildAppExtensionClientApi({
      extensionId: 'ext-a',
      scope: {},
      call: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
    });
    await expect(withoutHost.switchSession('s1')).rejects.toThrow('unavailable');
  });
});

describe('trackAppExtensionSubscriptions', () => {
  it('runs remaining event cleanups when a view is disposed', () => {
    const unsubscribeA = vi.fn();
    const unsubscribeB = vi.fn();
    const subscribe = vi.fn().mockReturnValueOnce(unsubscribeA).mockReturnValueOnce(unsubscribeB);
    const tracked = trackAppExtensionSubscriptions(subscribe);
    const listener = vi.fn();
    const stopA = tracked.subscribe('changed', listener, { projectId: '/work/demo' });
    tracked.subscribe('changed', listener, { projectId: '/work/demo' });

    stopA();
    expect(unsubscribeA).toHaveBeenCalledTimes(1);
    tracked.cleanup();
    tracked.cleanup();
    expect(unsubscribeA).toHaveBeenCalledTimes(1);
    expect(unsubscribeB).toHaveBeenCalledTimes(1);
  });

  it('continues cleaning subscriptions when one unsubscribe throws', () => {
    const secondUnsubscribe = vi.fn();
    const subscribe = vi
      .fn()
      .mockReturnValueOnce(() => {
        throw new Error('unsubscribe failed');
      })
      .mockReturnValueOnce(secondUnsubscribe);
    const tracked = trackAppExtensionSubscriptions(subscribe);
    tracked.subscribe('changed', vi.fn(), {});
    tracked.subscribe('changed', vi.fn(), {});

    expect(() => tracked.cleanup()).not.toThrow();
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('teardownAppExtensionClient', () => {
  it('invokes function cleanups and unmount objects', () => {
    const fn = vi.fn();
    const unmount = vi.fn();
    teardownAppExtensionClient(fn);
    teardownAppExtensionClient({ unmount });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(unmount).toHaveBeenCalledTimes(1);
  });

  it('ignores empty results and swallows teardown errors', () => {
    expect(() => teardownAppExtensionClient(undefined)).not.toThrow();
    expect(() => teardownAppExtensionClient(null)).not.toThrow();
    expect(() => teardownAppExtensionClient({})).not.toThrow();
    expect(() =>
      teardownAppExtensionClient(() => {
        throw new Error('cleanup blew up');
      })
    ).not.toThrow();
    expect(() =>
      teardownAppExtensionClient({
        unmount: () => {
          throw new Error('unmount blew up');
        },
      })
    ).not.toThrow();
  });
});
