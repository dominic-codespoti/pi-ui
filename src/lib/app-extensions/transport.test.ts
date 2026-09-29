import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '#lib/ws/protocol.js';
import { AppExtensionTransport } from './transport.js';

describe('AppExtensionTransport', () => {
  it('sends explicit-scope calls and resolves the matching result', async () => {
    const sent: ClientMessage[] = [];
    const transport = new AppExtensionTransport((message) => {
      sent.push(message);
      return true;
    });
    const scope = { projectId: '/work/demo', sessionId: 'session-1' };
    const result = transport.call('action', 'board', 'move-card', { id: 'c1' }, scope);
    const request = sent[0];
    expect(request).toMatchObject({
      type: 'app_extension_call',
      extensionId: 'board',
      operationId: 'move-card',
      kind: 'action',
      input: { id: 'c1' },
      scope,
    });
    if (request?.type !== 'app_extension_call') throw new Error('expected call frame');

    expect(
      transport.handle({
        type: 'app_extension_result',
        callId: request.callId,
        extensionId: 'board',
        ok: true,
        result: { moved: true },
      } as ServerMessage)
    ).toBe(true);
    await expect(result).resolves.toEqual({ moved: true });
    transport.dispose();
  });

  it('rejects a failed operation and cleans pending state on dispose', async () => {
    const sent: ClientMessage[] = [];
    const transport = new AppExtensionTransport((message) => {
      sent.push(message);
      return true;
    });
    const failed = transport.call('read', 'board', 'list', undefined, {});
    const failedFrame = sent[0];
    if (failedFrame?.type !== 'app_extension_call') throw new Error('expected call frame');
    transport.handle({
      type: 'app_extension_result',
      callId: failedFrame.callId,
      extensionId: 'board',
      ok: false,
      error: 'Unavailable',
    } as ServerMessage);
    await expect(failed).rejects.toThrow('Unavailable');

    const pending = transport.call('action', 'board', 'save', {}, {});
    transport.dispose('socket gone');
    await expect(pending).rejects.toThrow('socket gone');
  });

  it('requires a scope object and rejects calls that cannot be sent', async () => {
    const transport = new AppExtensionTransport(() => false);
    await expect(
      transport.call('read', 'board', 'list', undefined, undefined as never)
    ).rejects.toThrow('explicit app-extension scope');
    await expect(transport.call('read', 'board', 'list', undefined, {})).rejects.toThrow(
      'could not be sent'
    );
    transport.dispose();
  });

  it('notifies extension catalog listeners', () => {
    const transport = new AppExtensionTransport(() => true);
    const listener = vi.fn();
    const unsubscribe = transport.onExtensions(listener);
    const extensions = [
      {
        id: 'board',
        name: 'Board',
        version: '1.0.0',
        enabled: true,
        views: [{ id: 'main', title: 'Board', slot: 'workspace' as const }],
      },
    ];
    transport.handle({ type: 'app_extensions_list', extensions } as ServerMessage);
    expect(listener).toHaveBeenCalledWith(extensions);
    unsubscribe();
    transport.handle({ type: 'app_extensions_list', extensions } as ServerMessage);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('sends enable/disable requests and delivers toggle results', () => {
    const sent: ClientMessage[] = [];
    const transport = new AppExtensionTransport((message) => {
      sent.push(message);
      return true;
    });
    const listener = vi.fn();
    transport.onToggleResult(listener);

    expect(transport.setEnabled('board', true)).toBe(true);
    expect(sent[0]).toMatchObject({
      type: 'set_app_extension_enabled',
      extensionId: 'board',
      enabled: true,
    });
    transport.handle({
      type: 'app_extension_toggle_result',
      extensionId: 'board',
      enabled: true,
      ok: false,
      error: 'Load failed',
    } as ServerMessage);
    expect(listener).toHaveBeenCalledWith({
      extensionId: 'board',
      enabled: true,
      ok: false,
      error: 'Load failed',
    });
    transport.dispose();
  });

  it('registers, restores, and removes server-side subscriptions', () => {
    const sent: ClientMessage[] = [];
    const transport = new AppExtensionTransport((message) => {
      sent.push(message);
      return true;
    });
    const unsubscribe = transport.subscribe('board', 'changed', vi.fn(), {
      projectId: '/work/demo',
      sessionId: 'session-1',
    });
    const original = sent.find((message) => message.type === 'app_extension_subscribe');
    expect(original).toMatchObject({
      type: 'app_extension_subscribe',
      extensionId: 'board',
      eventName: 'changed',
      scope: { projectId: '/work/demo', sessionId: 'session-1' },
    });

    expect(transport.requestExtensions()).toBe(true);
    expect(sent.filter((message) => message.type === 'app_extension_subscribe')).toEqual([
      original,
      original,
    ]);
    unsubscribe();
    expect(sent.at(-1)).toEqual({
      type: 'app_extension_unsubscribe',
      subscriptionId: original?.type === 'app_extension_subscribe' ? original.subscriptionId : '',
    });
    transport.dispose();
  });

  it('drops rejected subscriptions so reconnect does not retry them forever', () => {
    const sent: ClientMessage[] = [];
    const transport = new AppExtensionTransport((message) => {
      sent.push(message);
      return true;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    transport.subscribe('board', 'missing', vi.fn(), {});
    const subscription = sent.find((message) => message.type === 'app_extension_subscribe');
    if (subscription?.type !== 'app_extension_subscribe') throw new Error('expected subscription');

    transport.handle({
      type: 'app_extension_subscription_result',
      subscriptionId: subscription.subscriptionId,
      extensionId: 'board',
      ok: false,
      error: 'unknown event',
    } as ServerMessage);
    const beforeReconnect = sent.length;
    transport.requestExtensions();
    expect(sent.slice(beforeReconnect).filter((message) => message.type === 'app_extension_subscribe')).toEqual(
      []
    );
    expect(log).toHaveBeenCalled();
    log.mockRestore();
    transport.dispose();
  });

  it('filters events by extension, event name, and exact explicit scope', () => {
    const transport = new AppExtensionTransport(() => true);
    const projectListener = vi.fn();
    const globalListener = vi.fn();
    const unsubscribe = transport.subscribe('board', 'changed', projectListener, {
      projectId: '/work/demo',
    });
    transport.subscribe('board', 'changed', globalListener);
    transport.handle({
      type: 'app_extension_event',
      extensionId: 'board',
      eventName: 'changed',
      data: 1,
      scope: { projectId: '/work/other' },
    } as ServerMessage);
    transport.handle({
      type: 'app_extension_event',
      extensionId: 'board',
      eventName: 'changed',
      data: 2,
      scope: { projectId: '/work/demo' },
    } as ServerMessage);
    expect(projectListener).toHaveBeenCalledTimes(1);
    expect(projectListener).toHaveBeenCalledWith(2);
    expect(globalListener).not.toHaveBeenCalled();
    unsubscribe();
    transport.dispose();
  });

  it('does not treat a malformed event scope as a global event', () => {
    const transport = new AppExtensionTransport(() => true);
    const listener = vi.fn();
    transport.subscribe('board', 'changed', listener, {});
    transport.handle({
      type: 'app_extension_event',
      extensionId: 'board',
      eventName: 'changed',
      data: 'malformed string scope',
      scope: '/work/demo',
    } as unknown as ServerMessage);
    transport.handle({
      type: 'app_extension_event',
      extensionId: 'board',
      eventName: 'changed',
      data: 'malformed field scope',
      scope: { projectId: 0 },
    } as unknown as ServerMessage);
    expect(listener).not.toHaveBeenCalled();
    transport.dispose();
  });

  it('matches a session-only listener to that session with its canonical project scope', () => {
    const transport = new AppExtensionTransport(() => true);
    const listener = vi.fn();
    transport.subscribe('board', 'changed', listener, { sessionId: 'session-1' });
    transport.handle({
      type: 'app_extension_event',
      extensionId: 'board',
      eventName: 'changed',
      data: 'matching session',
      scope: { projectId: '/work/demo', sessionId: 'session-1' },
    } as ServerMessage);
    transport.handle({
      type: 'app_extension_event',
      extensionId: 'board',
      eventName: 'changed',
      data: 'different session',
      scope: { projectId: '/work/demo', sessionId: 'session-2' },
    } as ServerMessage);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('matching session');
    transport.dispose();
  });

  it('delivers reload results to reload listeners', () => {
    const transport = new AppExtensionTransport(() => true);
    const listener = vi.fn();
    transport.onReloadResult(listener);
    expect(
      transport.handle({
        type: 'app_extension_reload_result',
        extensionId: 'board',
        ok: true,
      } as ServerMessage)
    ).toBe(true);
    expect(listener).toHaveBeenCalledWith({ extensionId: 'board', ok: true });
    transport.dispose();
  });

  it('ignores unrelated messages', () => {
    const transport = new AppExtensionTransport(() => true);
    expect(transport.handle({ type: 'message_end' } as ServerMessage)).toBe(false);
    transport.dispose();
  });
});
