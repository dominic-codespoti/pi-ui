import { test, expect } from './fixtures';

test.describe('File viewer', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('shows file content when clicking a file link', async ({ page }) => {
    // We need the markdown renderer to produce a clickable file link.
    // Set up WS with messages containing file references.
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'read_file') {
          ws.send(JSON.stringify({
            type: 'file_content',
            path: msg.path,
            content: 'line1\nline2\nline3',
          }));
        }
      });
      ws.send(JSON.stringify({
        type: 'connected',
        sessionId: 's1',
        isStreaming: false,
        thinkingLevel: 'medium',
        model: null,
        availableModels: [],
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Check `src/lib/foo.ts` for details.' }],
            usage: { input: 10, output: 20, totalTokens: 30 },
            stopReason: 'endTurn',
            timestamp: Date.now(),
          },
        ],
      }));
    });

    await page.goto('/');

    // Find the file link and click it
    const fileLink = page.locator('a.file-link').first();
    await expect(fileLink).toBeVisible({ timeout: 3000 });
    await fileLink.click();

    // Wait for the file viewer modal to appear — the path renders as the dialog heading
    await expect(page.getByRole('heading', { name: 'src/lib/foo.ts' })).toBeVisible({ timeout: 3000 });
  });
});
