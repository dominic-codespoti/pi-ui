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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function notification(permission: NotificationPermission = 'granted') {
  return {
    permission,
    requestPermission: async () => permission,
    show: () => {},
  };
}

interface TestSubscription {
  endpoint: string;
  expirationTime: number | null;
  toJSON(): { keys: { p256dh: string; auth: string } };
  unsubscribe(): Promise<boolean>;
}

function makeSubscription(): TestSubscription {
  return {
    endpoint: 'https://push.test/sub',
    expirationTime: null,
    toJSON: () => ({ keys: { p256dh: 'p256dh', auth: 'auth' } }),
    unsubscribe: async () => true,
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
    const firstSend = deferred<void>();
    const secondSend = deferred<void>();
    const sent: unknown[] = [];
    let sendCount = 0;
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
      storage: storage(),
      notification: notification('granted'),
      serviceWorker: { ready: Promise.resolve(registration) },
      send: (message) => {
        sent.push(message);
        sendCount += 1;
        if (sendCount === 1) firstSend.resolve();
        if (sendCount === 2) secondSend.resolve();
        return true;
      },
    });
    controller.setPushVapidKey('key');
    controller.setConnectionOpen(true);
    await firstSend.promise;
    expect(sent).toContainEqual({
      type: 'push_subscribe',
      endpoint: 'https://push.test/sub',
      keys: { p256dh: 'p256dh', auth: 'auth' },
      expirationTime: null,
    });

    controller.setEnabled(false);
    await secondSend.promise;
    expect(sent).toContainEqual({ type: 'push_unsubscribe', endpoint: subscription.endpoint });
    expect(unsubscribed).toBe(true);
  });
  it('settles rapid disable-enable changes on the latest requested state', async () => {
    const getStarted = deferred<void>();
    const getSubscription = deferred<TestSubscription | null>();
    const subscription = makeSubscription();
    const sentPush = deferred<void>();
    const sent: unknown[] = [];
    const registration = {
      pushManager: {
        getSubscription: () => {
          getStarted.resolve();
          return getSubscription.promise;
        },
        subscribe: async () => subscription,
      },
    };
    const controller = new NotificationController({
      storage: storage(),
      notification: notification('granted'),
      serviceWorker: { ready: Promise.resolve(registration) },
      send: (message) => {
        sent.push(message);
        sentPush.resolve();
        return true;
      },
    });

    controller.setPushVapidKey('key');
    controller.setConnectionOpen(true);
    await getStarted.promise;
    controller.setEnabled(false);
    controller.setEnabled(true);
    getSubscription.resolve(subscription);
    await sentPush.promise;

    expect(sent).toEqual([
      {
        type: 'push_subscribe',
        endpoint: subscription.endpoint,
        keys: { p256dh: 'p256dh', auth: 'auth' },
        expirationTime: null,
      },
    ]);
  });

  it('does not send a stale subscribe after enable-disable during subscribe', async () => {
    const subscribe = deferred<TestSubscription>();
    const subscribeStarted = deferred<void>();
    const unsubscribeStarted = deferred<void>();
    const sentDone = deferred<void>();
    let currentSubscription: TestSubscription | null = null;
    const sent: unknown[] = [];
    const subscription = makeSubscription();
    const unsubscribe = deferred<boolean>();
    const registration = {
      pushManager: {
        getSubscription: async () => currentSubscription,
        subscribe: async () => {
          subscribeStarted.resolve();
          currentSubscription = subscription;
          return subscribe.promise;
        },
      },
    };
    subscription.unsubscribe = async () => {
      unsubscribeStarted.resolve();
      const result = await unsubscribe.promise;
      if (result) currentSubscription = null;
      return result;
    };
    const controller = new NotificationController({
      storage: storage(),
      notification: notification('granted'),
      serviceWorker: { ready: Promise.resolve(registration) },
      send: (message) => {
        sent.push(message);
        sentDone.resolve();
        return true;
      },
    });

    controller.setPushVapidKey('key');
    controller.setConnectionOpen(true);
    await subscribeStarted.promise;
    controller.setEnabled(false);
    subscribe.resolve(subscription);
    await unsubscribeStarted.promise;
    unsubscribe.resolve(true);
    await sentDone.promise;

    expect(sent).toEqual([{ type: 'push_unsubscribe', endpoint: subscription.endpoint }]);
  });

  it('restarts browser registration with the newest VAPID key', async () => {
    const getStarted = deferred<void>();
    const getSubscription = deferred<null>();
    const sentDone = deferred<void>();
    const keys: string[] = [];
    const subscription = makeSubscription();
    const sent: unknown[] = [];
    const registration = {
      pushManager: {
        getSubscription: () => {
          getStarted.resolve();
          return getSubscription.promise;
        },
        subscribe: async () => subscription,
      },
    };
    const controller = new NotificationController({
      storage: storage(),
      notification: notification('granted'),
      serviceWorker: { ready: Promise.resolve(registration) },
      decodeVapidKey: (key) => {
        keys.push(key);
        return new Uint8Array([1]);
      },
      send: (message) => {
        sent.push(message);
        sentDone.resolve();
        return true;
      },
    });

    controller.setPushVapidKey('old-key');
    controller.setConnectionOpen(true);
    await getStarted.promise;
    controller.setPushVapidKey('new-key');
    getSubscription.resolve(null);
    await sentDone.promise;

    expect(keys).toEqual(['new-key']);
    expect(sent).toHaveLength(1);
  });

  it('defers registration after disconnect during service-worker readiness', async () => {
    const ready = deferred<{
      pushManager: {
        getSubscription: () => Promise<TestSubscription | null>;
        subscribe: () => Promise<TestSubscription>;
      };
    }>();
    const readyRequested = deferred<void>();
    const sentDone = deferred<void>();
    let currentSubscription: TestSubscription | null = null;
    let getCalls = 0;
    const sent: unknown[] = [];
    const subscription = makeSubscription();
    const registration = {
      pushManager: {
        getSubscription: async () => {
          getCalls += 1;
          return currentSubscription;
        },
        subscribe: async () => {
          currentSubscription = subscription;
          return subscription;
        },
      },
    };
    const controller = new NotificationController({
      storage: storage(),
      notification: notification('granted'),
      serviceWorker: {
        get ready() {
          readyRequested.resolve();
          return ready.promise;
        },
      },
      decodeVapidKey: () => new Uint8Array([1]),
      send: (message) => {
        sent.push(message);
        sentDone.resolve();
        return true;
      },
    });

    controller.setPushVapidKey('key');
    controller.setConnectionOpen(true);
    await readyRequested.promise;
    controller.setConnectionOpen(false);
    ready.resolve(registration);
    controller.setConnectionOpen(true);
    await sentDone.promise;

    expect(sent).toHaveLength(1);
    expect(getCalls).toBe(1);
    expect(currentSubscription).toBe(subscription);
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
      storage: storage(),
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
