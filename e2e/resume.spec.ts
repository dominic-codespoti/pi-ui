import { test, expect } from './fixtures';

/**
 * Cold-start resume — the snapshot-hydrate path.
 *
 * Mobile OSes discard backgrounded PWAs; the next open is a full reload.
 * The app persists a text-only snapshot of the conversation to localStorage
 * and paints it immediately on boot, instead of a blank "connecting…" splash,
 * then reconciles with live server state when the WS connects.
 */

const SNAPSHOT_KEY = 'pi-session-snapshot';
const SESSION_PATH = '/home/user/.pi/sessions/proj/2026-01-01_mock.jsonl';

function snapshotPayload() {
  return {
    v: 1,
    sessionPath: SESSION_PATH,
    sessionName: 'Resumed session',
    savedAt: Date.now(),
    messages: [
      {
        id: 'snap-user-1',
        role: 'user',
        content: 'question from before the phone slept',
        streaming: false,
        createdAt: Date.now() - 60_000,
      },
      {
        id: 'snap-asst-1',
        role: 'assistant',
        content: 'answer rendered from the local snapshot',
        streaming: false,
        createdAt: Date.now() - 59_000,
      },
    ],
  };
}

test.describe('Cold-start resume', () => {
  test.beforeEach(async ({ page, mockWs, login }) => {
    await page.addInitScript(
      ([key, snap]) => localStorage.setItem(key, snap),
      [SNAPSHOT_KEY, JSON.stringify(snapshotPayload())] as const
    );
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('paints the snapshot instead of the splash while the WS is down', async ({ page }) => {
    // Refuse every WS connection — the app never reaches the connected state
    await page.routeWebSocket('/ws', (ws) => {
      ws.close();
    });
    await page.goto('/');

    // Conversation is visible immediately, from localStorage alone
    await expect(page.getByText('answer rendered from the local snapshot')).toBeVisible({
      timeout: 3000,
    });
    // No blank connecting splash — the snapshot suppressed it
    await expect(page.getByText('connecting\u2026')).not.toBeVisible();
    // The reconnecting status banner communicates the socket state instead
    await expect(page.getByRole('status').filter({ hasText: /reconnecting/ })).toBeVisible({
      timeout: 5000,
    });
  });

  test('live connected payload replaces the snapshot wholesale', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's-live',
          isStreaming: false,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          sessionPath: SESSION_PATH,
          messages: [
            { role: 'user', content: 'question from before the phone slept', timestamp: Date.now() - 60_000 },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'fresh answer from the live server' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
              stopReason: 'endTurn',
              timestamp: Date.now(),
            },
          ],
        })
      );
    });
    await page.goto('/');

    // Live state wins — snapshot-only content is gone, server content is in
    await expect(page.getByText('fresh answer from the live server')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText('answer rendered from the local snapshot')).not.toBeVisible();
  });
});
