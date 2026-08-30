import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import type { WebSocketRoute } from 'playwright-core';
/**
 * Sidebar sub-session nesting — sessions carrying parentSession render nested
 * under their parent at the parent's stack position (ordered by subtree
 * recency), and a live session_updated delta reorders within the substack
 * without moving the parent row.
 */

const NOW = Date.now();

const PROJECT = '/home/user/nest-proj';

const PARENT = {
  id: 's-parent',
  path: `${PROJECT}/parent.jsonl`,
  cwd: PROJECT,
  name: 'Parent task',
  created: NOW - 400_000,
  modified: NOW - 300_000,
  messageCount: 6,
  firstMessage: '',
};

const SUB_ONE = {
  ...PARENT,
  id: 's-sub-one',
  path: `${PROJECT}/sub-one.jsonl`,
  name: 'Sub task one',
  created: NOW - 700_000,
  modified: NOW - 600_000,
  messageCount: 2,
  parentSession: PARENT.path,
};

const SUB_TWO = {
  ...PARENT,
  id: 's-sub-two',
  path: `${PROJECT}/sub-two.jsonl`,
  name: 'Sub task two',
  created: NOW - 200_000,
  modified: NOW - 120_000,
  messageCount: 3,
  parentSession: PARENT.path,
};

const FRESH_ROOT = {
  ...PARENT,
  id: 's-fresh',
  path: `${PROJECT}/fresh.jsonl`,
  name: 'Fresh root',
  created: NOW - 60_000,
  modified: NOW - 10_000,
  messageCount: 1,
};

const STALE_ROOT = {
  ...PARENT,
  id: 's-stale',
  path: `${PROJECT}/stale.jsonl`,
  name: 'Stale root',
  created: NOW - 950_000,
  modified: NOW - 900_000,
  messageCount: 8,
};

/** Initial handshake: connected + full project/session lists (scrambled order). */
function sendIntro(ws: WebSocketRoute): void {
  ws.send(
    JSON.stringify({
      type: 'connected',
      sessionId: PARENT.id,
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
          sessionCount: 5,
          lastActivity: FRESH_ROOT.modified,
        },
      ],
    })
  );
  ws.send(
    JSON.stringify({
      type: 'all_sessions_list',
      // Input order deliberately scrambled — the tree builder owns ordering.
      sessions: [SUB_ONE, STALE_ROOT, PARENT, FRESH_ROOT, SUB_TWO],
    })
  );
}

async function box(page: Page, text: string) {
  const b = await page.getByText(text).boundingBox();
  if (!b) throw new Error(`"${text}" has no bounding box`);
  return b;
}

async function openProjectsSidebar(page: Page): Promise<void> {
  const search = page.locator('input[aria-label="Filter projects and sessions"]');
  const isOpen = async () => {
    try {
      await search.waitFor({ state: 'attached', timeout: 300 });
    } catch {
      return false;
    }
    const b = await search.boundingBox();
    return !!b && b.width > 0 && b.x >= -1;
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

test('sub-sessions nest under their parent between unrelated roots', async ({ page, login }) => {
  await page.routeWebSocket('/ws', (ws) => {
    ws.onMessage(() => {});
    sendIntro(ws);
  });
  await login(page);
  await openProjectsSidebar(page);

  for (const title of ['Fresh root', 'Parent task', 'Sub task one', 'Sub task two', 'Stale root']) {
    await expect(page.getByText(title)).toBeVisible();
  }

  const fresh = await box(page, 'Fresh root');
  const parent = await box(page, 'Parent task');
  const subOne = await box(page, 'Sub task one');
  const subTwo = await box(page, 'Sub task two');
  const stale = await box(page, 'Stale root');

  // The whole stack sits below the fresher root and above the staler one.
  expect(parent.y).toBeGreaterThan(fresh.y);
  expect(stale.y).toBeGreaterThan(parent.y);
  // Children render inside the stack, never drifting to their own recency spot.
  expect(subTwo.y).toBeGreaterThan(parent.y);
  expect(subOne.y).toBeGreaterThan(subTwo.y);
  expect(stale.y).toBeGreaterThan(subOne.y);
  // Indented right of their parent.
  expect(subOne.x).toBeGreaterThan(parent.x);
  expect(subTwo.x).toBeGreaterThan(parent.x);
});

test('session_updated delta reorders within the substack without moving the parent', async ({
  page,
  login,
}) => {
  let server!: WebSocketRoute;
  await page.routeWebSocket('/ws', (ws) => {
    server = ws;
    ws.onMessage(() => {});
    sendIntro(ws);
  });
  await login(page);
  await openProjectsSidebar(page);

  await expect(page.getByText('Sub task two')).toBeVisible();
  const parentBefore = (await box(page, 'Parent task')).y;

  // Sub task one just ran — its bump stays older than Fresh root, so the
  // stack keeps its slot while the child jumps above its sibling.
  server.send(
    JSON.stringify({
      type: 'session_updated',
      session: { ...SUB_ONE, modified: NOW - 20_000, messageCount: 4 },
    })
  );

  await expect
    .poll(async () => {
      const one = await page.getByText('Sub task one').boundingBox();
      const two = await page.getByText('Sub task two').boundingBox();
      return !!one && !!two && one.y < two.y;
    })
    .toBe(true);

  expect(Math.abs((await box(page, 'Parent task')).y - parentBefore)).toBeLessThan(2);
});
