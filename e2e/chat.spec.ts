import { test, expect } from './fixtures';
import {
  agentStartPayload,
  assistantMessageStartPayload,
  textDeltaPayload,
  assistantMessageEndPayload,
  agentEndPayload,
} from './mocks/payloads';

test.describe('Chat / prompt streaming', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('shows composer after connect', async ({ page }) => {
    await expect(page.locator('textarea')).toBeVisible();
  });

  test('sends prompt message over WebSocket', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        wsMessages.push(String(data));
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.goto('/');
    await page.fill('input[name="password"]', 'test-password');
    await page.click('button[type="submit"]');
    await page.waitForURL('/');

    await page.fill('textarea', 'Hello pi');
    await page.press('textarea', 'Enter');

    const hasPrompt = wsMessages.some((m) => {
      try { const p = JSON.parse(m); return p.type === 'prompt' && p.message === 'Hello pi'; }
      catch { return false; }
    });
    expect(hasPrompt).toBe(true);
  });

  test('renders streaming text deltas', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {
        // Only respond to prompt after it's sent
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.goto('/');
    await page.fill('input[name="password"]', 'test-password');
    await page.click('button[type="submit"]');
    await page.waitForURL('/');

    // Re-setup WS with streaming responses
    await page.routeWebSocket('/ws', (ws) => {
      let streaming = false;
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt' && !streaming) {
          streaming = true;
          ws.send(JSON.stringify(agentStartPayload()));
          ws.send(JSON.stringify(assistantMessageStartPayload()));
          setTimeout(() => ws.send(JSON.stringify(textDeltaPayload('Hello'))), 50);
          setTimeout(() => ws.send(JSON.stringify(textDeltaPayload(' world'))), 100);
          setTimeout(() => {
            ws.send(JSON.stringify(assistantMessageEndPayload()));
            ws.send(JSON.stringify(agentEndPayload()));
          }, 150);
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.fill('textarea', 'Say hi');
    await page.press('textarea', 'Enter');

    // Wait for streaming text to appear
    await expect(page.getByText('Hello world')).toBeVisible({ timeout: 5000 });
  });

  test('renders existing messages from connected payload', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.send(JSON.stringify({
        type: 'connected',
        sessionId: 's1',
        isStreaming: false,
        thinkingLevel: 'medium',
        model: { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', reasoning: false },
        availableModels: [],
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() - 60000 },
          { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }], usage: { input: 5, output: 10, totalTokens: 15 }, stopReason: 'endTurn', timestamp: Date.now() - 55000 },
        ],
      }));
    });

    await page.goto('/');
    await page.fill('input[name="password"]', 'test-password');
    await page.click('button[type="submit"]');
    await page.waitForURL('/');

    await expect(page.getByText('Hi there!')).toBeVisible({ timeout: 3000 });
  });

  test('shows thinking deltas', async ({ page }) => {
    const { thinkingDeltaPayload } = await import('./mocks/payloads');

    await page.routeWebSocket('/ws', (ws) => {
      let streaming = false;
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt' && !streaming) {
          streaming = true;
          ws.send(JSON.stringify(agentStartPayload()));
          ws.send(JSON.stringify(assistantMessageStartPayload()));
          setTimeout(() => ws.send(JSON.stringify(thinkingDeltaPayload('Hmm, let me think...'))), 50);
          setTimeout(() => ws.send(JSON.stringify(textDeltaPayload('Here is my answer.'))), 100);
          setTimeout(() => {
            ws.send(JSON.stringify(assistantMessageEndPayload()));
            ws.send(JSON.stringify(agentEndPayload()));
          }, 150);
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.goto('/');
    await page.fill('input[name="password"]', 'test-password');
    await page.click('button[type="submit"]');
    await page.waitForURL('/');

    await page.fill('textarea', 'Think');
    await page.press('textarea', 'Enter');

    await expect(page.getByText('Here is my answer.')).toBeVisible({ timeout: 5000 });
  });
});
