import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import type { WebSocketRoute } from 'playwright-core';

/**
 * Sidebar recency ordering — live session_updated deltas must reposition rows
 * within a project, not just full all_sessions_list snapshots.
 */

const NOW = Date.now();

const OLD_SESSION = {
  id: 's-old',
  path: '/home/user/project-a/old.jsonl',
  cwd: '/home/user/project-a',
  name: 'Older session',
  created: NOW - 86_400_000,
  modified: NOW - 3_600_000,
  messageCount: 4,
  firstMessage: 'older first message',
};

const NEW_SESSION = {
  id: 's-new',
  path: '/home/user/project-a/new.jsonl',
  cwd: '/home/user/project-a',
  name: 'Newer session',
  created: NOW - 43_200_000,
  modified: NOW - 1_800_000,
  messageCount: 2,
  firstMessage: 'newer first message',
};

/** Y positions of both session titles — lower y renders higher in the sidebar. */
async function rowY(page: Page): Promise<[number, number]> {
  const older = (await page.getByText('Older session').boundingBox())?.y ?? -1;
  const newer = (await page.getByText('Newer session').boundingBox())?.y ?? -1;
  return [older, newer];
}

/** Sidebar content is lazily mounted and off-canvas on mobile — open it for real. */
async function openProjectsSidebar(page: Page): Promise<void> {
  const search = page.locator('input[aria-label="Filter projects and sessions"]');
  const isOpen = async () => {
    try {
      await search.waitFor({ state: 'attached', timeout: 300 });
    } catch {
      return false;
    }
    const box = await search.boundingBox();
    return !!box && box.width > 0 && box.x >= -1;
  };
  if (await isOpen()) return;
  const toggle = page.locator('[aria-label="Toggle session panel"]');
  for (let i = 0; i < 5; i++) {
    if (await isOpen()) return;
    await toggle.click();
    await page.waitForTimeout(250); // drawer slide-in transition (220ms)
  }
  await expect(search).toBeVisible({ timeout: 3000 });
}

test('session_updated delta moves a ran session to the top of its project', async ({
  page,
  login,
}) => {
  let server!: WebSocketRoute;
  await page.routeWebSocket('/ws', (ws) => {
    server = ws;
    ws.onMessage(() => {});
    ws.send(
      JSON.stringify({
        type: 'connected',
        sessionId: 's-new',
        isStreaming: false,
        thinkingLevel: 'off',
        messages: [],
      })
    );
    ws.send(
      JSON.stringify({
        type: 'projects_list',
        projects: [
          {
            cwd: '/home/user/project-a',
            name: 'project-a',
            pinned: false,
            exists: true,
            registered: true,
            sessionCount: 2,
            lastActivity: NEW_SESSION.modified,
          },
        ],
      })
    );
    ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [NEW_SESSION, OLD_SESSION] }));
  });
  await login(page);
  await openProjectsSidebar(page);

  await expect(page.getByText('Newer session')).toBeVisible();
  await expect(page.getByText('Older session')).toBeVisible();

  // Initial recency order: newer above older.
  let [olderY, newerY] = await rowY(page);
  expect(newerY).toBeLessThan(olderY);

  // Coalesced server delta: the older session just ran (modified bumped).
  server.send(
    JSON.stringify({
      type: 'session_updated',
      session: { ...OLD_SESSION, modified: Date.now(), messageCount: 5 },
    })
  );

  await expect
    .poll(async () => (await rowY(page))[0])
    .toBeLessThan((await rowY(page))[1]);
  [olderY, newerY] = await rowY(page);
  expect(olderY).toBeLessThan(newerY);
});
