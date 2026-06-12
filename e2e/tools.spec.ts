import { test, expect } from './fixtures';
import {
  toolExecutionStartPayload,
  toolExecutionUpdatePayload,
  toolExecutionEndPayload,
} from './mocks/payloads';

test.describe('Tool rendering', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('renders bash tool execution', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify({ type: 'agent_start' }));
          ws.send(JSON.stringify({
            type: 'tool_execution_start',
            toolName: 'bash',
            toolCallId: 'tc1',
            args: { command: 'ls -la' },
          }));
          setTimeout(() => ws.send(JSON.stringify(toolExecutionUpdatePayload('tc1', 'total 42\n-rw-r--r-- 1 user user 100 file.txt'))), 50);
          setTimeout(() => ws.send(JSON.stringify(toolExecutionEndPayload('tc1', 'total 42\n-rw-r--r-- 1 user user 100 file.txt'))), 100);
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.fill('textarea', 'Run ls');
    await page.press('textarea', 'Enter');
    await expect(page.getByText('file.txt')).toBeVisible({ timeout: 5000 });
  });

  test('renders tool error state', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify({ type: 'agent_start' }));
          ws.send(JSON.stringify({
            type: 'tool_execution_start',
            toolName: 'bash',
            toolCallId: 'tc-error',
            args: { command: 'invalid-command' },
          }));
          setTimeout(() => ws.send(JSON.stringify(toolExecutionEndPayload('tc-error', 'command not found', true))), 50);
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.fill('textarea', 'Run bad cmd');
    await page.press('textarea', 'Enter');
    await expect(page.getByText('command not found')).toBeVisible({ timeout: 5000 });
  });

  test('renders edit tool with diff output', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify({ type: 'agent_start' }));
          ws.send(JSON.stringify({
            type: 'tool_execution_start',
            toolName: 'edit',
            toolCallId: 'tc-edit',
            args: { filePath: 'src/index.ts' },
          }));
          setTimeout(() => ws.send(JSON.stringify({
            type: 'tool_execution_end',
            toolCallId: 'tc-edit',
            isError: false,
            result: {
              content: [{ type: 'text', text: 'Applied edit to src/index.ts' }],
              details: {
                diff: '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,4 @@\n line1\n-old\n+new\n line3',
              },
            },
          })), 50);
        }
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.fill('textarea', 'Fix file');
    await page.press('textarea', 'Enter');
    await expect(page.getByText('src/index.ts')).toBeVisible({ timeout: 5000 });
  });
});
