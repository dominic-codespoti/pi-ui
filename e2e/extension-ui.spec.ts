import { test, expect } from './fixtures';
import {
  extensionConfirmPayload,
  extensionInputPayload,
  extensionSelectPayload,
  extensionNotifyPayload,
} from './mocks/payloads';

test.describe('Extension UI modals', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('shows confirm dialog', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionConfirmPayload('c1', 'Continue?', 'Are you sure?')));
        }
        if (msg.type === 'extension_ui_response' && msg.id === 'c1') {
          ws.send(JSON.stringify(extensionConfirmPayload('c2', 'Done', 'Confirmed!')));
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.fill('textarea', 'Confirm action');
    await page.press('textarea', 'Enter');

    await expect(page.getByText('Continue?')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Are you sure?')).toBeVisible();
  });

  test('confirm dialog sends response on button click', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        wsMessages.push(String(data));
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    // Re-setup with confirm trigger
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionConfirmPayload('c1', 'Continue?', 'Are you sure?')));
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.fill('textarea', 'Test confirm');
    await page.press('textarea', 'Enter');

    await expect(page.getByText('Continue?')).toBeVisible({ timeout: 3000 });
    // Click the confirm button
    await page.getByRole('button', { name: /confirm/i }).click();
    // Check a response was sent
    const hasResponse = wsMessages.some((m) => {
      try { const p = JSON.parse(m); return p.type === 'extension_ui_response'; }
      catch { return false; }
    });
    expect(hasResponse).toBe(true);
  });

  test('shows input dialog', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionInputPayload('i1', 'Enter name', 'Your name...')));
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.fill('textarea', 'Input test');
    await page.press('textarea', 'Enter');

    await expect(page.getByText('Enter name')).toBeVisible({ timeout: 3000 });
    await expect(page.getByPlaceholder('Your name...')).toBeVisible();
  });

  test('shows toast notification', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionNotifyPayload('Operation complete', 'success')));
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.fill('textarea', 'Notify');
    await page.press('textarea', 'Enter');

    await expect(page.getByText('Operation complete')).toBeVisible({ timeout: 3000 });
  });
});
