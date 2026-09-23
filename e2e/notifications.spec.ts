import { test, expect } from './fixtures';
import type { Worker } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import {
  ALL_SESSIONS_LIST_PAYLOAD,
  CONNECTED_PAYLOAD,
  PROJECTS_LIST_PAYLOAD,
} from './mocks/payloads';

/**
 * PWA notification coverage. Headless Chromium's shell cannot grant the
 * notifications permission (known Playwright/Chromium limitation), so:
 *   · the page-side subscribe flow runs against stubbed PushManager methods
 *   · the SW surface and push-visibility gate are exercised with stubbed
 *     showNotification / clients.matchAll and REAL PushEvent dispatches
 *   · notification-click routing runs through the SW's click_simulate test
 *     hook (real handleNotificationClick code path)
 */

/** P-256 raw public key (65-byte uncompressed point) for pushManager.subscribe. */
function rawPublicKeyBase64Url(): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return Buffer.concat([Buffer.from([4]), x, y]).toString('base64url');
}

/** The service-worker global, for worker-scope evaluates. */
type SwClient = {
  visibilityState?: string;
  postMessage?: (message: unknown) => void;
};
type SwScope = typeof globalThis & {
  registration: ServiceWorkerRegistration & {
    showNotification: (title: string, options?: NotificationOptions) => Promise<void>;
  };
  clients: {
    matchAll: (options?: unknown) => Promise<SwClient[]>;
  };
  PushEvent: new (type: string, init: { data?: string }) => Event;
};

type TestNotificationOptions = Pick<NotificationOptions, 'tag' | 'requireInteraction'> & {
  actions?: Array<{ action: string; title: string }>;
};
type NotifCall = { title: string; options?: TestNotificationOptions };

test.describe('PWA notifications', () => {
  test('subscribe flow, SW surface, click routing, and push visibility gate', async ({
    page,
    context,
    login,
  }) => {
    // Page-side stubs: the browser-level permission cannot be granted headless,
    // so the app believes notifications are granted and PushManager works.
    await context.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', {
        get: () => 'granted',
        configurable: true,
      });
      Notification.requestPermission = () => Promise.resolve('granted' as NotificationPermission);
      PushManager.prototype.getSubscription = async () => null;
      PushManager.prototype.subscribe = async () =>
        ({
          endpoint: 'https://fcm.googleapis.com/fcm/send/pi-ui-test-device',
          expirationTime: null,
          toJSON: () => ({
            endpoint: 'https://fcm.googleapis.com/fcm/send/pi-ui-test-device',
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
          }),
        }) as unknown as PushSubscription;
    });

    const vapidKey = rawPublicKeyBase64Url();
    const wsMessages: Array<Record<string, unknown>> = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((m) => {
        const msg = JSON.parse(String(m)) as Record<string, unknown>;
        wsMessages.push(msg);
        if (msg.type === 'get_projects') ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        if (msg.type === 'switch_session') {
          // Real server replies session_loaded after a switch — without it the
          // app cannot finish applying the requested session state.
          ws.send(
            JSON.stringify({
              type: 'session_loaded',
              sessionId: String(msg.path),
              isStreaming: false,
              thinkingLevel: 'medium',
              model: null,
              availableModels: [],
              messages: [],
              cwd: String(msg.path),
              sessionName: undefined,
              isCompacting: false,
              requestId: String(msg.requestId),
            })
          );
        }
        if (msg.type === 'get_all_sessions') {
          ws.send(
            JSON.stringify({
              type: 'all_sessions_list',
              sessions: [
                {
                  id: 'mock-session-001',
                  path: '/mock/session',
                  cwd: '/mock',
                  name: 'Mock',
                  created: 0,
                  messageCount: 0,
                  totalTokens: 0,
                  lastActivity: 0,
                  isRunning: false,
                  unseen: false,
                },
                {
                  id: 's-other',
                  path: '/other',
                  cwd: '/other',
                  name: 'Other',
                  created: 0,
                  messageCount: 0,
                  totalTokens: 0,
                  lastActivity: 0,
                  isRunning: false,
                  unseen: false,
                },
              ],
            })
          );
        }
      });
      ws.send(JSON.stringify({ ...CONNECTED_PAYLOAD, pushVapidKey: vapidKey }));
    });
    await login(page, 'test-password');

    await test.step('1 client subscribes', async () => {
      await expect
        .poll(() => wsMessages.some((m) => m.type === 'push_subscribe'), { timeout: 10_000 })
        .toBe(true);
      const subMsg = wsMessages.find((m) => m.type === 'push_subscribe') as {
        endpoint?: string;
        keys?: { p256dh?: string; auth?: string };
      };
      expect(subMsg.endpoint).toBe('https://fcm.googleapis.com/fcm/send/pi-ui-test-device');
      expect(subMsg.keys?.p256dh).toBe('p256dh-key');
      expect(subMsg.keys?.auth).toBe('auth-key');
    });

    /** Resolve the currently running worker; Chromium may respawn it at any time. */
    const refreshSw = async (): Promise<Worker> => {
      await page.evaluate(() => navigator.serviceWorker.ready);
      const workers = context.serviceWorkers();
      return workers.length > 0
        ? workers[workers.length - 1]
        : context.waitForEvent('serviceworker', { timeout: 10_000 });
    };
    /** Re-resolve once when Chromium replaces the worker between operations. */
    const runSw = async <T>(operation: (worker: Worker) => Promise<T>): Promise<T> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const worker = await refreshSw();
        try {
          return await operation(worker);
        } catch (error) {
          if (
            attempt === 1 ||
            !/Service worker restarted|Target .* has been closed|context or browser has been closed/.test(
              String(error)
            )
          ) {
            throw error;
          }
        }
      }
      throw new Error('Service worker evaluation did not complete');
    };
    const evaluateSw = <T>(pageFunction: () => T | Promise<T>): Promise<T> =>
      runSw((worker) => worker.evaluate(pageFunction));
    type PushArgs = { title: string; visible: boolean };
    const evaluateSwWithArg = <T>(
      pageFunction: (arg: PushArgs) => T | Promise<T>,
      arg: PushArgs
    ): Promise<T> => runSw((worker) => worker.evaluate(pageFunction, arg));

    await page.evaluate(() => {
      const holder = globalThis as Record<string, unknown>;
      holder.__piTestNotifCalls = [];
      holder.__piTestPushShown = [];
      navigator.serviceWorker.addEventListener('message', (event) => {
        const data = event.data as {
          type?: string;
          call?: NotifCall;
          title?: string;
        };
        if (data?.type === '__pi_test_notification' && data.call) {
          (holder.__piTestNotifCalls as NotifCall[]).push(data.call);
        } else if (data?.type === '__pi_test_push_shown' && typeof data.title === 'string') {
          (holder.__piTestPushShown as string[]).push(data.title);
        }
      });
    });

    await test.step('2 sw notification surface', async () => {
      await evaluateSw(async () => {
        const scope = globalThis as unknown as SwScope;
        const clients = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
        scope.registration.showNotification = async (
          title: string,
          options?: NotificationOptions
        ) => {
          clients[0]?.postMessage?.({
            type: '__pi_test_notification',
            call: { title, options },
          });
        };
        let completion: Promise<unknown> = Promise.resolve();
        const event = new MessageEvent('message', {
          data: {
            type: 'show_notification',
            title: 'Response Complete',
            body: 'pi finished responding.',
            tag: 'pi-agent-end',
            data: { kind: 'response_complete' },
          },
        }) as MessageEvent & { waitUntil: (promise: Promise<unknown>) => void };
        event.waitUntil = (promise) => {
          completion = promise;
        };
        scope.dispatchEvent(event);
        await completion;
      });
      await expect
        .poll(() =>
          page.evaluate(
            () => ((globalThis as Record<string, unknown>).__piTestNotifCalls as unknown[]).length
          )
        )
        .toBe(1);
      const surface = await page.evaluate(() => {
        const holder = globalThis as Record<string, unknown>;
        const calls = (holder.__piTestNotifCalls ?? []) as NotifCall[];
        return {
          title: calls[0].title,
          tag: calls[0].options?.tag,
          actions: calls[0].options?.actions,
          requireInteraction: calls[0].options?.requireInteraction,
        };
      });
      expect(surface).toEqual({
        title: 'Response Complete',
        tag: 'pi-agent-end',
        actions: [{ action: 'steer', title: 'Steer pi' }],
        requireInteraction: true,
      });
    });

    await test.step('3 deep-link click', async () => {
      await page.evaluate(() => {
        void navigator.serviceWorker.ready.then((reg) => {
          reg.active?.postMessage({
            type: 'click_simulate',
            action: '',
            data: { kind: 'session_finished', sessionPath: '/other' },
          });
        });
      });
      await expect
        .poll(() => wsMessages.some((m) => m.type === 'switch_session'), { timeout: 15_000 })
        .toBe(true);
      expect(wsMessages.find((m) => m.type === 'switch_session')).toMatchObject({
        path: '/other',
      });
    });

    await test.step('4 steer action', async () => {
      await page.evaluate(() => {
        void navigator.serviceWorker.ready.then((reg) => {
          reg.active?.postMessage({ type: 'click_simulate', action: 'steer', data: {} });
        });
      });
      await expect
        .poll(
          () => page.evaluate(() => document.activeElement === document.querySelector('textarea')),
          { timeout: 10_000 }
        )
        .toBe(true);
    });
    await test.step('5 push visibility gate', async () => {
      const firePush = (title: string, visible: boolean) =>
        evaluateSwWithArg(
          async ({ title: pushTitle, visible: pushVisible }) => {
            const scope = globalThis as unknown as SwScope;
            const testScope = scope as SwScope & { __piTestClients?: SwClient[] };
            const clients =
              testScope.__piTestClients ??
              (await scope.clients.matchAll({ type: 'window', includeUncontrolled: true }));
            testScope.__piTestClients = clients;
            scope.clients.matchAll = async () =>
              pushVisible ? [{ visibilityState: 'visible' }] : [];
            scope.registration.showNotification = async (shownTitle: string) => {
              clients[0]?.postMessage?.({ type: '__pi_test_push_shown', title: shownTitle });
            };
            let completion: Promise<unknown> = Promise.resolve();
            const event = new scope.PushEvent('push', {
              data: JSON.stringify({
                kind: 'response_complete',
                title: pushTitle,
                body: 'b',
                tag: `tag-${pushTitle}`,
              }),
            }) as Event & { waitUntil: (promise: Promise<unknown>) => void };
            event.waitUntil = (promise) => {
              completion = promise;
            };
            scope.dispatchEvent(event);
            await completion;
          },
          { title, visible }
        );
      await firePush('visible-push', true);
      await page.waitForTimeout(400);
      expect(
        await page.evaluate(
          () => ((globalThis as Record<string, unknown>).__piTestPushShown ?? []) as string[]
        )
      ).toEqual([]);

      await firePush('background-push', false);
      await expect
        .poll(() =>
          page.evaluate(
            () => ((globalThis as Record<string, unknown>).__piTestPushShown ?? []) as string[]
          )
        )
        .toEqual(['background-push']);
    });

    // Cleanup: drop the SW subscription so no stray pushes target this browser
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    });
  });

  test('deep-link intent survives a dropped socket', async ({ page, login }) => {
    const wsMessages: Array<Record<string, unknown>> = [];
    let initCount = 0;
    let isFirstConnection = true;

    await page.routeWebSocket('/ws', (ws) => {
      if (isFirstConnection) {
        // Kill the first socket shortly after boot so the tap below lands in
        // the reconnect gap; the retry loop must bridge it.
        isFirstConnection = false;
        ws.onMessage((m) => wsMessages.push(JSON.parse(String(m))));
        ws.send(JSON.stringify({ ...CONNECTED_PAYLOAD }));
        setTimeout(() => ws.close(), 400);
        return;
      }
      ws.onMessage((m) => {
        const msg = JSON.parse(String(m)) as Record<string, unknown>;
        wsMessages.push(msg);
        if (msg.type === 'get_projects') ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        if (msg.type === 'get_all_sessions') ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
      });
      ws.send(JSON.stringify({ ...CONNECTED_PAYLOAD }));
      initCount += 1;
    });

    await login(page, 'test-password');
    await expect.poll(() => wsMessages.some((m) => m.type === 'get_all_sessions')).toBe(true);
    // Past the 400 ms kill — the tap now lands while the socket is down and
    // the client's reconnect backoff is still counting.
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'pi_focus_session', sessionPath: '/other' },
        })
      );
    });

    await expect
      .poll(() => wsMessages.some((m) => m.type === 'switch_session'), { timeout: 20_000 })
      .toBe(true);
    expect(wsMessages.find((m) => m.type === 'switch_session')).toMatchObject({ path: '/other' });
    expect(initCount).toBeGreaterThanOrEqual(1);
  });
});
