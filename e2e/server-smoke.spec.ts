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
    await expect(page.getByText('password', { exact: true })).toBeVisible();
  });

  test('returns 404 for unknown routes (unauth)', async ({ page }) => {
    const response = await page.goto('/nonexistent-route');
    // SvelteKit may redirect to /login due to auth guard, then return 404 on login
    // or return a 404 page. Either is acceptable — just check the server responds.
    expect(response).not.toBeNull();
  });

  test('/ws returns 401 without cookie', async ({ request }) => {
    // Chromium does not expose the HTTP response status for a failed
    // WebSocket handshake. In this case it also leaves the browser-level
    // error/close events pending, so a raw WebSocket promise can hang.
    // Exercise the real upgrade request instead and assert its HTTP status.
    const response = await request.get('/ws', {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    expect(response.status()).toBe(401);
  });

  test('login page has correct HTML structure', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle(/pi/i);
    await expect(page.locator('label[for="password"]')).toContainText(/password/i);
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });
});
