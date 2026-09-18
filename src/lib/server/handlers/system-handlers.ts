import type { ClientMessage, ServerMessage } from '../../ws/protocol.ts';

export interface SystemHandlerSocket {
  send(data: string): unknown;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime: number | null;
}

export interface SystemHandlerDependencies {
  broadcast: (payload: ServerMessage) => void;
  readSettings: () => Record<string, unknown>;
  updateSettings: (values: Record<string, unknown>) => Record<string, unknown>;
  addPushSubscription: (subscription: PushSubscriptionInput) => void;
  removePushSubscription: (endpoint: string) => void;
  getWebhookUrl: () => string | null;
  setWebhookUrl: (url: string | null | undefined) => void;
}

/**
 * Dispatch the small server-wide/control message group. Returning false lets
 * the composition root continue treating the message as an unrelated case.
 */
export function dispatchSystemMessage(
  message: ClientMessage,
  socket: SystemHandlerSocket,
  dependencies: SystemHandlerDependencies
): boolean {
  switch (message.type) {
    case 'ping':
      // Keep the heartbeat frame byte-for-byte compatible with existing clients.
      socket.send('{"type":"pong"}');
      return true;

    case 'get_settings':
      socket.send(JSON.stringify({ type: 'settings', settings: dependencies.readSettings() }));
      return true;

    case 'set_settings': {
      const updated = dependencies.updateSettings(message.settings);
      dependencies.broadcast({ type: 'settings', settings: updated });
      return true;
    }

    case 'push_subscribe': {
      const { endpoint, keys } = message;
      if (
        typeof endpoint === 'string' &&
        endpoint.startsWith('https://') &&
        keys &&
        typeof keys.p256dh === 'string' &&
        typeof keys.auth === 'string'
      ) {
        dependencies.addPushSubscription({
          endpoint,
          keys,
          expirationTime: message.expirationTime ?? null,
        });
      }
      return true;
    }

    case 'push_unsubscribe':
      if (typeof message.endpoint === 'string') {
        dependencies.removePushSubscription(message.endpoint);
      }
      return true;

    case 'set_notification_webhook_url':
      dependencies.setWebhookUrl(message.url);
      dependencies.broadcast({
        type: 'notification_webhook_url',
        url: dependencies.getWebhookUrl(),
      });
      return true;

    default:
      return false;
  }
}
