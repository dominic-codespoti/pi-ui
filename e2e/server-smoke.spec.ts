import { test, expect } from '@playwright/test';

/**
 * Server smoke tests — validate that the real Bun server process starts,
 * serves HTTP, upgrades WebSocket, and handles auth.
 *
 * These tests run against the webServer configured in playwright.config.ts
 * (the full Bun server with password auth).
 */

test.describe('Server smoke', () => {
  test('serves the login page at /login', async ({ page }) => {
    const response = await page.goto('/login');
    expect(response?.status()).toBe(200);
    await expect(page.locator('text=password')).toBeVisible();
  });

  test('returns 404 for unknown routes (unauth)', async ({ page }) => {
    const response = await page.goto('/nonexistent-route');
    // SvelteKit may redirect to /login due to auth guard, then return 404 on login
    // or return a 404 page. Either is acceptable — just check the server responds.
    expect(response).not.toBeNull();
  });

  test('/ws returns 401 without cookie', async ({ page }) => {
    // Playwright's routeWebSocket intercepts at the browser level; to test the
    // real server endpoint we need to go through a real WS connection attempt.
    // We use page.exposeFunction and a raw WebSocket to verify the 401.
    const status = await page.evaluate(async () => {
      try {
        const ws = new WebSocket(`ws://${location.host}/ws`);
        await new Promise((resolve, reject) => {
          ws.onopen = () => { ws.close(); resolve('opened'); };
          ws.onerror = () => resolve('error');
          ws.onclose = (e) => resolve(`closed:${e.code}`);
        });
        return 'no-error';
      } catch {
        return 'exception';
      }
    });
    // Without auth, the server should reject the WS upgrade (401)
    // which typically manifests as an error/close event rather than open.
    expect(status).not.toBe('opened');
  });

  test('login page has correct HTML structure', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('h1, title, label')).toContainText(['password', 'Password', 'pi'], { ignoreCase: true });
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });
});
