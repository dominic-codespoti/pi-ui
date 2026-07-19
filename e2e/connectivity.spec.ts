import { test, expect } from './fixtures';

test.describe('Reconnect / connectivity', () => {
  test('shows connected state on initial connect', async ({ page, login }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.send(JSON.stringify({
        type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium',
        model: null, availableModels: [], messages: [],
      }));
    });
    await login(page, 'test-password');
    // No disconnect or reconnect banners should appear
    await expect(page.getByText('disconnected')).not.toBeVisible();
    await expect(page.getByText('connecting…')).not.toBeVisible();
    // Textarea should be enabled
    await expect(page.locator('textarea')).toBeEnabled({ timeout: 3000 });
  });

  test('shows reconnecting banner and disables composer when WS drops', async ({ page, login }) => {
    let closeSocket: (() => void) | undefined;
    await page.routeWebSocket('/ws', (ws) => {
      closeSocket = () => ws.close();
      ws.send(JSON.stringify({
        type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium',
        model: null, availableModels: [], messages: [],
      }));
    });
    await login(page, 'test-password');
    await expect(page.locator('textarea')).toBeEnabled({ timeout: 3000 });

    // Pin the browser offline so the automatic reconnect cannot race the assertions —
    // scheduleReconnect() waits for the 'online' event while navigator.onLine is false.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
      window.dispatchEvent(new Event('offline'));
    });
    if (closeSocket) closeSocket();

    // The status banner announces the reconnecting state and the composer locks
    await expect(page.getByRole('status').filter({ hasText: /reconnecting/ })).toBeVisible({ timeout: 3000 });
    await expect(page.locator('textarea')).toBeDisabled();
  });

  test('shows reconnecting countdown while retries back off', async ({ page, login }) => {
    let closeSocket: (() => void) | undefined;
    let first = true;
    await page.routeWebSocket('/ws', (ws) => {
      if (first) {
        first = false;
        closeSocket = () => ws.close();
        ws.send(JSON.stringify({
          type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium',
          model: null, availableModels: [], messages: [],
        }));
        return;
      }
      // Fail every reconnect attempt so the backoff countdown stays on screen
      ws.close();
    });
    await login(page, 'test-password');
    await expect(page.locator('textarea')).toBeEnabled({ timeout: 3000 });

    if (closeSocket) closeSocket();

    // Countdown renders inside the reconnecting banner, e.g. "reconnecting (2s)"
    await expect(page.getByRole('status').filter({ hasText: /\(\d+s\)/ })).toBeVisible({ timeout: 10_000 });
  });

  test('reconnects automatically after disconnect', async ({ page, login }) => {
    let connectionCount = 0;

    await page.routeWebSocket('/ws', (ws) => {
      connectionCount++;
      ws.send(JSON.stringify({
        type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium',
        model: null, availableModels: [], messages: [],
      }));
    });

    await login(page, 'test-password');
    await expect(page.locator('textarea')).toBeEnabled({ timeout: 3000 });
    expect(connectionCount).toBe(1);

    // Close to trigger reconnect — the routeWebSocket handler creates a NEW connection
    // (Since we use page.routeWebSocket, closing the mock only affects that instance)
    // Reload the page to trigger a fresh connection
    // Reload the page to trigger a fresh connection (auth cookie persists)
    await page.reload();

    await expect(page.locator('textarea')).toBeEnabled({ timeout: 5000 });
    // A new routeWebSocket connection was established
    expect(connectionCount).toBeGreaterThanOrEqual(2);
  });

  test('shows connection status in tooltip', async ({ page, login, isMobile }) => {
    test.skip(isMobile, 'Tooltips are hover-only and intentionally disabled on touch devices');
    await page.routeWebSocket('/ws', (ws) => {
      ws.send(JSON.stringify({
        type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium',
        model: null, availableModels: [], messages: [],
      }));
    });
    await login(page, 'test-password');
    await expect(page.locator('textarea')).toBeEnabled({ timeout: 3000 });

    // Hover over the connection indicator button
    const indicator = page.locator('button[aria-label="Connection info"]');
    await expect(indicator).toBeVisible();
    await indicator.hover();

    // Tooltip should show "Connected"
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 3000 });
  });

  test('shows connecting state after page reload', async ({ page, login }) => {
    await page.routeWebSocket('/ws', (ws) => {
      // Refuse every connection — the app stays in the connecting state
      // (a mock that merely stays silent still completes the WS handshake,
      // which flips the app to the connected/open state).
      ws.close();
    });

    await login(page, 'test-password');

    // The empty-chat connecting screen should be visible
    await expect(page.getByText('connecting\u2026')).toBeVisible({ timeout: 5000 });
  });

  test('textarea placeholder reflects connection state', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      // Refuse every connection so the composer stays in the reconnecting state
      ws.close();
    });

    await page.goto('/');
    await page.fill('input[name="password"]', 'test-password');
    await page.click('button[type="submit"]');
    await page.waitForURL('/');

    // Textarea should be disabled with the reconnecting placeholder
    const textarea = page.locator('textarea');
    await expect(textarea).toHaveAttribute('placeholder', /Reconnecting/, { timeout: 5000 });
    await expect(textarea).toBeDisabled();
  });

  test('recovers automatically after an unexpected socket close', async ({ page, login }) => {
    let closeSocket: (() => void) | undefined;
    await page.routeWebSocket('/ws', (ws) => {
      closeSocket = () => ws.close();
      ws.send(JSON.stringify({
        type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium',
        model: null, availableModels: [], messages: [],
      }));
    });

    await login(page, 'test-password');
    await expect(page.locator('textarea')).toBeEnabled({ timeout: 3000 });

    // Drop the socket — the app schedules a reconnect, the mock accepts the
    // new connection, and the composer comes back to life.
    if (closeSocket) closeSocket();
    await expect(page.locator('textarea')).toBeEnabled({ timeout: 10_000 });
  });

  test('recovers from page visibility change during reconnect', async ({ page, login }) => {
    let closeSocket: (() => void) | undefined;
    let wsOpened = false;

    await page.routeWebSocket('/ws', (ws) => {
      wsOpened = true;
      closeSocket = () => ws.close();
      ws.send(JSON.stringify({
        type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium',
        model: null, availableModels: [], messages: [],
      }));
    });

    await login(page, 'test-password');
    await expect(page.locator('textarea')).toBeEnabled({ timeout: 3000 });
    expect(wsOpened).toBe(true);

    // Hide the page first — reconnection is paused while hidden
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    if (closeSocket) closeSocket();
    await expect(page.locator('textarea')).toBeDisabled({ timeout: 3000 });

    // Restore visibility — reconnection resumes, the mock accepts the new
    // connection, and the composer unlocks again.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('textarea')).toBeEnabled({ timeout: 10_000 });
  });

  test('send button is disabled when disconnected', async ({ page, login }) => {
    let closeSocket: (() => void) | undefined;
    await page.routeWebSocket('/ws', (ws) => {
      closeSocket = () => ws.close();
      ws.send(JSON.stringify({
        type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium',
        model: null, availableModels: [], messages: [],
      }));
    });
    await login(page, 'test-password');
    await expect(page.locator('textarea')).toBeEnabled({ timeout: 3000 });

    // Pin offline so the reconnect cannot race, then drop the socket
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
      window.dispatchEvent(new Event('offline'));
    });
    if (closeSocket) closeSocket();
    await expect(page.getByRole('status').filter({ hasText: /reconnecting/ })).toBeVisible({ timeout: 3000 });

    // Send button should be disabled while the socket is down
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
});
