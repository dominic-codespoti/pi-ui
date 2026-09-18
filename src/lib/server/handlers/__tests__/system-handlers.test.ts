import { describe, expect, it, vi } from 'vitest';
import { dispatchSystemMessage, type SystemHandlerDependencies } from '../system-handlers';
function dependencies(): SystemHandlerDependencies & {
  settings: Record<string, unknown>;
  webhookUrl: string | null;
} {
  const state: {
    settings: Record<string, unknown>;
    webhookUrl: string | null;
  } = {
    settings: { theme: 'dark' } as Record<string, unknown>,
    webhookUrl: 'https://hooks.example.test/old',
  };
  const addPushSubscription = vi.fn<SystemHandlerDependencies['addPushSubscription']>();
  const getWebhookUrl = vi.fn<SystemHandlerDependencies['getWebhookUrl']>(() => state.webhookUrl);
  const deps: SystemHandlerDependencies & typeof state = {
    ...state,
    broadcast: vi.fn(),
    readSettings: vi.fn(() => state.settings),
    updateSettings: vi.fn((values: Record<string, unknown>) => {
      state.settings = { ...state.settings, ...values };
      return state.settings;
    }),
    addPushSubscription,
    removePushSubscription: vi.fn(),
    getWebhookUrl,
    setWebhookUrl: vi.fn((url: string | null | undefined) => {
      state.webhookUrl = url || null;
    }),
  };
  return deps;
}

function socket() {
  return { send: vi.fn() };
}

describe('dispatchSystemMessage', () => {
  it('handles pong and settings requests/updates', () => {
    const deps = dependencies();
    const ws = socket();

    expect(dispatchSystemMessage({ type: 'ping' }, ws, deps)).toBe(true);
    expect(ws.send).toHaveBeenCalledWith('{"type":"pong"}');

    ws.send.mockClear();
    expect(dispatchSystemMessage({ type: 'get_settings' }, ws, deps)).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'settings', settings: { theme: 'dark' } })
    );

    expect(
      dispatchSystemMessage({ type: 'set_settings', settings: { fontSize: 16 } }, ws, deps)
    ).toBe(true);
    expect(deps.updateSettings).toHaveBeenCalledWith({ fontSize: 16 });
    expect(deps.broadcast).toHaveBeenCalledWith({
      type: 'settings',
      settings: { theme: 'dark', fontSize: 16 },
    });
  });

  it('accepts valid push subscriptions and rejects malformed ones', () => {
    const deps = dependencies();
    const ws = socket();
    const valid = {
      type: 'push_subscribe' as const,
      endpoint: 'https://push.example.test/subscription',
      keys: { p256dh: 'public-key', auth: 'auth-secret' },
      expirationTime: 123,
    };

    expect(dispatchSystemMessage(valid, ws, deps)).toBe(true);
    expect(deps.addPushSubscription).toHaveBeenCalledWith({
      endpoint: valid.endpoint,
      keys: valid.keys,
      expirationTime: 123,
    });

    const addCalls = vi.mocked(deps.addPushSubscription).mock.calls.length;
    const malformed = [
      { type: 'push_subscribe', endpoint: 'http://push.example.test', keys: valid.keys },
      { type: 'push_subscribe', endpoint: valid.endpoint, keys: { p256dh: '', auth: 4 } },
      { type: 'push_subscribe', endpoint: 42, keys: valid.keys },
    ];
    for (const message of malformed) {
      expect(dispatchSystemMessage(message as never, ws, deps)).toBe(true);
    }
    expect(deps.addPushSubscription).toHaveBeenCalledTimes(addCalls);

    expect(
      dispatchSystemMessage({ type: 'push_unsubscribe', endpoint: valid.endpoint }, ws, deps)
    ).toBe(true);
    expect(deps.removePushSubscription).toHaveBeenCalledWith(valid.endpoint);
  });

  it('updates and broadcasts the current webhook URL', () => {
    const deps = dependencies();
    const ws = socket();

    expect(
      dispatchSystemMessage(
        { type: 'set_notification_webhook_url', url: 'https://hooks.example.test/new' },
        ws,
        deps
      )
    ).toBe(true);
    expect(deps.setWebhookUrl).toHaveBeenCalledWith('https://hooks.example.test/new');
    expect(deps.getWebhookUrl).toHaveBeenCalled();
    expect(deps.broadcast).toHaveBeenCalledWith({
      type: 'notification_webhook_url',
      url: 'https://hooks.example.test/new',
    });
  });

  it('returns false for unrelated messages without invoking dependencies', () => {
    const deps = dependencies();
    const ws = socket();

    expect(dispatchSystemMessage({ type: 'session_focus', sessionId: null }, ws, deps)).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
    expect(deps.updateSettings).not.toHaveBeenCalled();
  });
});
