import { test, expect } from './fixtures';
import { CONNECTED_PAYLOAD } from './mocks/payloads';

test.describe('Session expiry', () => {
  test('redirects to /login when the server closes the socket as session expired', async ({
    page,
    login,
  }) => {
    let expireSocket: (() => void) | undefined;
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      expireSocket = () => ws.close({ code: 4001, reason: 'Session expired' });
    });

    await login(page, 'test-password');
    await expect(page.locator('textarea')).toBeVisible();

    // The real session cookie is still valid — the server closed the socket
    // because *its* view of the session expired, so drop the cookie to match.
    await page.context().clearCookies();
    expireSocket!();
    await page.waitForURL('**/login**');
  });

  test('redirects to /login when the session cookie is rejected after a socket failure', async ({
    page,
    login,
  }) => {
    let dropSocket: (() => void) | undefined;
    // Only the auth probe (HEAD /) is answered with a redirect; the document
    // navigation to / must still reach the real server.
    await page.route(
      (url) => url.pathname === '/',
      (route) => {
        if (route.request().method() === 'HEAD') {
          route.fulfill({ status: 302, headers: { location: '/login' } });
        } else {
          route.continue();
        }
      }
    );
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      dropSocket = () => ws.close({ code: 1001, reason: 'going away' });
    });

    await login(page, 'test-password');
    await expect(page.locator('textarea')).toBeVisible();

    // A rejected upgrade happens when the browser cookie is already stale.
    await page.context().clearCookies();
    dropSocket!();
    await page.waitForURL('**/login**');
  });

  test('keeps reconnecting while the session is still valid', async ({ page, login }) => {
    let wsConnects = 0;
    let dropSocket: (() => void) | undefined;
    await page.routeWebSocket('/ws', (ws) => {
      wsConnects++;
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      dropSocket = () => ws.close({ code: 1001, reason: 'going away' });
    });

    await login(page, 'test-password');
    await expect(page.locator('textarea')).toBeVisible();

    dropSocket!();
    // Valid cookie: the probe returns 200 and the reconnect loop re-establishes
    // the socket instead of redirecting to /login.
    await expect.poll(() => wsConnects).toBeGreaterThan(1);
    await expect(page.locator('textarea')).toBeVisible();
    expect(page.url()).not.toContain('/login');
  });
});
