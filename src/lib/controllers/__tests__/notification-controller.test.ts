import { describe, expect, it } from 'vitest';
import {
  NotificationController,
  type NotificationStoragePort,
} from '../notification-controller.js';

function storage(
  values: Record<string, string> = {}
): NotificationStoragePort & { values: typeof values } {
  return {
    values,
    getItem(key) {
      return this.values[key] ?? null;
    },
    setItem(key, value) {
      this.values[key] = value;
    },
  };
}

function notification(permission: NotificationPermission = 'granted') {
  return {
    permission,
    requestPermission: async () => permission,
    show: () => {},
  };
}

describe('NotificationController', () => {
  it('persists preferences and marks the permission nudge seen', () => {
    const saved = storage();
    let visible = false;
    const controller = new NotificationController({
      storage: saved,
      notification: notification('default'),
      send: () => true,
      onNudgeVisibilityChanged: (next) => (visible = next),
    });

    controller.setEnabled(false);
    expect(JSON.parse(saved.values['pifrontier:notifications']!)).toEqual({
      enabled: false,
      onComplete: true,
    });
    controller.enableNotifications();
    expect(saved.values['pifrontier:notif-nudge-seen']).toBe('1');
    expect(controller.isNudgeSeen).toBe(true);
    expect(visible).toBe(false);
  });

  it('syncs and removes the existing push subscription', async () => {
    const sent: unknown[] = [];
    let unsubscribed = false;
    const subscription = {
      endpoint: 'https://push.test/sub',
      expirationTime: null,
      toJSON: () => ({ keys: { p256dh: 'p256dh', auth: 'auth' } }),
      unsubscribe: async () => {
        unsubscribed = true;
        return true;
      },
    };
    const registration = {
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => subscription,
      },
    };
    const controller = new NotificationController({
      notification: notification('granted'),
      serviceWorker: { ready: Promise.resolve(registration) },
      send: (message) => {
        sent.push(message);
        return true;
      },
    });
    controller.setPushVapidKey('key');
    controller.setConnectionOpen(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toContainEqual({
      type: 'push_subscribe',
      endpoint: 'https://push.test/sub',
      keys: { p256dh: 'p256dh', auth: 'auth' },
      expirationTime: null,
    });

    controller.setEnabled(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toContainEqual({ type: 'push_unsubscribe', endpoint: subscription.endpoint });
    expect(unsubscribed).toBe(true);
  });

  it('deduplicates background completion notices and chooses visible notice vs push delivery', () => {
    const notices: string[] = [];
    let hidden = false;
    const sent: unknown[] = [];
    const controller = new NotificationController({
      storage: storage(),
      notification: {
        permission: 'granted',
        requestPermission: async () => 'granted',
        show: (title, options) => sent.push({ type: 'show_notification', title, ...options }),
      },
      send: (message) => {
        sent.push(message);
        return true;
      },
      isHidden: () => hidden,
      getSessionSummary: () => ({ path: '/tmp/example', name: 'Example' }),
      showNotice: (message) => notices.push(message),
    });
    const runtime = { sessionId: 's1', lastActivity: 10 };
    controller.notifyBackgroundCompletion(runtime);
    controller.notifyBackgroundCompletion(runtime);
    expect(notices).toEqual(['Example finished responding.']);

    hidden = true;
    controller.notifyBackgroundCompletion({ sessionId: 's1', lastActivity: 11 });
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'show_notification', body: 'Example finished responding.' })
    );
  });

  it('updates and clears the app badge', async () => {
    const calls: string[] = [];
    const controller = new NotificationController({
      send: () => true,
      badge: {
        setAppBadge: async (count) => {
          calls.push(`set:${count}`);
        },
        clearAppBadge: async () => {
          calls.push('clear');
        },
      },
    });
    controller.updateBadge(3);
    controller.updateBadge(0);
    await Promise.resolve();
    expect(calls).toEqual(['set:3', 'clear']);
  });
});
