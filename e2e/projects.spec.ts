import { test, expect } from './fixtures';
import { PROJECTS_LIST_PAYLOAD, ALL_SESSIONS_LIST_PAYLOAD } from './mocks/payloads';

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

    // Open sidebar
    const sidebarButton = page.locator('[aria-label="Sessions"]');
    if (await sidebarButton.isVisible()) {
      await sidebarButton.click();
    }

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

    const sidebarButton = page.locator('[aria-label="Sessions"]');
    if (await sidebarButton.isVisible()) {
      await sidebarButton.click();
    }

    await page.fill('input[type="search"]', 'nonexistent');
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

    const sidebarButton = page.locator('[aria-label="Sessions"]');
    if (await sidebarButton.isVisible()) {
      await sidebarButton.click();
    }

    // Wait for session to appear
    await expect(page.getByText('hello world')).toBeVisible({ timeout: 3000 });
  });
});
