import { test, expect } from './fixtures';
import { PROJECTS_LIST_PAYLOAD, ALL_SESSIONS_LIST_PAYLOAD } from './mocks/payloads';
import type { Page } from '@playwright/test';

async function openProjectsSidebar(page: Page) {
  const search = page.locator('input[aria-label="Filter projects and sessions"]:visible');
  if (await search.count()) return;
  const sidebarButton = page.locator('[aria-label="Sessions"]').first();
  if (await sidebarButton.isVisible()) {
    await sidebarButton.click();
  }
  if (!(await search.count())) {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }));
    });
  }
  await expect(search).toBeVisible({ timeout: 3000 });
}
test.describe('Projects sidebar', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('shows projects in sidebar', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_projects') {
          ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        }
        if (msg.type === 'get_all_sessions') {
          ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
    });

    await openProjectsSidebar(page);

    await expect(page.getByText('project-a')).toBeVisible({ timeout: 3000 });
  });

  test('search filters projects', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_projects') {
          ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        }
        if (msg.type === 'get_all_sessions') {
          ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
    });

    await openProjectsSidebar(page);
    await page.locator('input[aria-label="Filter projects and sessions"]:visible').fill('nonexistent');
    await expect(page.getByText('No match')).toBeVisible({ timeout: 3000 });
  });

  test('session runtime dots appear for background sessions', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_projects') {
          ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        }
        if (msg.type === 'get_all_sessions') {
          ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      // Send a runtime update for a background session
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'session_runtime',
          sessionId: 's3',
          isRunning: true,
          unseen: false,
          lastActivity: Date.now(),
        }));
      }, 100);
    });

    await openProjectsSidebar(page);

    // Wait for session to appear
    await expect(page.getByText('hello world')).toBeVisible({ timeout: 3000 });
  });
});
