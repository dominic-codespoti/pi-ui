import { test, expect } from './fixtures';
import { generateKeyPairSync } from 'node:crypto';
import { CONNECTED_PAYLOAD, PROJECTS_LIST_PAYLOAD } from './mocks/payloads';

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
type SwScope = typeof globalThis & {
  registration: ServiceWorkerRegistration & {
    showNotification: (title: string, options?: NotificationOptions) => Promise<void>;
  };
  clients: {
    matchAll: () => Promise<Array<{ visibilityState?: string }>>;
  };
  PushEvent: new (type: string, init: { data?: string }) => Event;
};

type NotifCall = { title: string; options?: NotificationOptions };

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
          // app stays in the sessionLoading state (composer disabled).
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

    await page.evaluate(() => navigator.serviceWorker.ready);
    const sw = context.serviceWorkers()[0];
    expect(sw).toBeTruthy();

    await test.step('2 sw notification surface', async () => {
      await sw.evaluate(() => {
        const scope = globalThis as unknown as SwScope;
        const calls: NotifCall[] = [];
        scope.registration.showNotification = async (
          title: string,
          options?: NotificationOptions
        ) => {
          calls.push({ title, options });
        };
        (globalThis as Record<string, unknown>).__notifCalls = calls;
      });
      await page.evaluate(() => {
        void navigator.serviceWorker.ready.then((reg) => {
          reg.active?.postMessage({
            type: 'show_notification',
            title: 'Response Complete',
            body: 'pi finished responding.',
            tag: 'pi-agent-end',
            data: { kind: 'response_complete' },
          });
        });
      });
      await expect
        .poll(() =>
          sw.evaluate(() => {
            const holder = globalThis as Record<string, unknown>;
            return ((holder.__notifCalls ?? []) as NotifCall[]).length;
          })
        )
        .toBe(1);
      const surface = await sw.evaluate(() => {
        const holder = globalThis as Record<string, unknown>;
        const calls = (holder.__notifCalls ?? []) as NotifCall[];
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
        .poll(() => wsMessages.some((m) => m.type === 'switch_session'), { timeout: 10_000 })
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
      await sw.evaluate(() => {
        const scope = globalThis as unknown as SwScope;
        const shown: string[] = [];
        scope.registration.showNotification = async (title: string) => {
          shown.push(title);
        };
        (globalThis as Record<string, unknown>).__pushShown = shown;
        scope.clients.matchAll = async () => [{ visibilityState: 'visible' }];
      });
      const firePush = (title: string) =>
        sw.evaluate((t) => {
          const scope = globalThis as unknown as SwScope;
          scope.dispatchEvent(
            new scope.PushEvent('push', {
              data: JSON.stringify({
                kind: 'response_complete',
                title: t,
                body: 'b',
                tag: `tag-${t}`,
              }),
            })
          );
        }, title);
      await firePush('visible-push');
      await page.waitForTimeout(400);
      expect(
        await sw.evaluate(() => {
          const holder = globalThis as Record<string, unknown>;
          return (holder.__pushShown ?? []) as string[];
        })
      ).toEqual([]);

      await sw.evaluate(() => {
        const scope = globalThis as unknown as SwScope;
        scope.clients.matchAll = async () => [];
      });
      await firePush('background-push');
      await expect
        .poll(() =>
          sw.evaluate(() => {
            const holder = globalThis as Record<string, unknown>;
            return (holder.__pushShown ?? []) as string[];
          })
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
});
