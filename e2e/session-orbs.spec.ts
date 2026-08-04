import { test, expect } from './fixtures';
import {
  PROJECTS_LIST_PAYLOAD,
  ALL_SESSIONS_LIST_PAYLOAD,
  sessionRuntimePayload,
} from './mocks/payloads';
import type { Page } from '@playwright/test';

async function openProjectsSidebar(page: Page) {
  const search = page.locator('input[aria-label="Filter projects and sessions"]');
  // The panel is a fixed off-canvas drawer on mobile: it keeps a non-empty
  // bounding box (translateX(-100%)) even when closed, so `:visible` cannot
  // detect openness. Judge by actual position/size instead, then toggle via
  // the real header button (opens the drawer on mobile, the inline sidebar on
  // desktop).
  const isOpen = async () => {
    const box = await search.boundingBox();
    return !!box && box.width > 0 && box.x >= -1;
  };
  if (await isOpen()) return;
  const toggle = page.locator('[aria-label="Toggle session panel"]');
  // The toggle's listener may not be attached yet during initial hydration —
  // verify the drawer actually opened and retry if the click no-opped.
  for (let i = 0; i < 5; i++) {
    if (await isOpen()) break;
    await toggle.click();
    await page.waitForTimeout(250); // drawer slide-in transition (220ms)
  }
  await expect(search).toBeVisible({ timeout: 3000 });
}

/** Connected payload for the ACTIVE session s1 (matches ALL_SESSIONS_LIST_PAYLOAD). */
const CONNECTED_S1 = {
  type: 'connected',
  sessionId: 's1',
  isStreaming: false,
  thinkingLevel: 'medium',
  model: null,
  availableModels: [],
  messages: [],
  cwd: '/home/user/project-a',
  sessionMode: 'persisted',
};

function sessionLoadedFor(path: string) {
  const isProjectB = path.includes('project-b');
  return {
    type: 'session_loaded',
    sessionId: isProjectB ? 's3' : 's1',
    isStreaming: false,
    thinkingLevel: 'medium',
    model: null,
    availableModels: [],
    messages: [],
    cwd: isProjectB ? '/home/user/project-b' : '/home/user/project-a',
    sessionName: isProjectB ? undefined : 'Bug fix',
    sessionPath: path,
    sessionMode: 'persisted',
    contextUsage: null,
  };
}

test.describe('Session status orbs', () => {
  test('orb lifecycle: running → ready-to-check → grey after opening and leaving', async ({
    page,
    login,
  }) => {
    await page.routeWebSocket('/ws', (ws) => {
      // s3 runs in the background for as long as the test has not opened it.
      // The broadcast is message-anchored: it stops on the first switch, so
      // assertions never race a fixed timer.
      let bgRunning = true;
      let switchCount = 0;
      const bgTimer = setInterval(() => {
        if (bgRunning) {
          ws.send(JSON.stringify(sessionRuntimePayload('s3', true, true)));
        }
      }, 300);
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_projects') {
          ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        }
        if (msg.type === 'get_all_sessions') {
          ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
        }
        if (msg.type === 'switch_session') {
          switchCount++;
          bgRunning = false;
          clearInterval(bgTimer);
          // Real server also re-broadcasts runtime snapshots after a switch.
          ws.send(JSON.stringify(sessionLoadedFor(msg.path)));
          ws.send(JSON.stringify(sessionRuntimePayload('s1', false, false)));
          // Switch #2 is "back to s1" — s3's background run finished unseen.
          ws.send(JSON.stringify(sessionRuntimePayload('s3', false, switchCount === 2)));
        }
      });
      ws.send(JSON.stringify(CONNECTED_S1));
    });
    await login(page, 'test-password');

    await openProjectsSidebar(page);
    await expect(page.getByText('hello world')).toBeVisible({ timeout: 3000 });

    // s3 running in background → green pulsing orb (broadcast persists until
    // the first click, so this can never miss the transient state).
    await expect(page.getByLabel('Running in background')).toBeVisible({ timeout: 3000 });

    // Open (check) s3 → orb goes grey.
    await page.getByRole('button', { name: /hello world/ }).click();
    await expect(page.getByLabel('Running in background')).toHaveCount(0);
    await expect(page.getByLabel('Unchecked result')).toHaveCount(0);

    // Leave to s1 → s3 finished while background → "ready to check" orb.
    await page.getByRole('button', { name: /Bug fix/ }).click();
    await expect(page.getByLabel('Unchecked result')).toBeVisible({ timeout: 3000 });
    await expect(page.getByLabel('Running in background')).toHaveCount(0);

    // Open s3 again → grey.
    await page.getByRole('button', { name: /hello world/ }).click();
    await expect(page.getByLabel('Unchecked result')).toHaveCount(0);

    // Leave again → s3 must STAY grey (regression: a finished background
    // session used to flash green "Running in background" forever because its
    // runtime updates were dropped while non-active).
    await page.getByRole('button', { name: /Bug fix/ }).click();
    await expect(page.getByLabel('Running in background')).toHaveCount(0);
    await expect(page.getByLabel('Unchecked result')).toHaveCount(0);
  });

  test('active session streams with a green orb and greys out on finish', async ({
    page,
    login,
  }) => {
    await page.routeWebSocket('/ws', (ws) => {
      // s1 (active) streams until the test clicks its row — the click sends
      // switch_session, which stops the broadcast and reports the finish.
      let running = true;
      const timer = setInterval(() => {
        if (running) {
          ws.send(JSON.stringify(sessionRuntimePayload('s1', true, false)));
        }
      }, 300);
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_projects') {
          ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        }
        if (msg.type === 'get_all_sessions') {
          ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
        }
        if (msg.type === 'switch_session') {
          running = false;
          clearInterval(timer);
          ws.send(JSON.stringify(sessionLoadedFor(msg.path)));
          ws.send(JSON.stringify(sessionRuntimePayload('s1', false, false)));
          ws.send(JSON.stringify(sessionRuntimePayload('s3', false, false)));
        }
      });
      ws.send(JSON.stringify(CONNECTED_S1));
    });
    await login(page, 'test-password');

    await openProjectsSidebar(page);
    await expect(page.getByText('Bug fix')).toBeVisible({ timeout: 3000 });

    // Active + streaming → green "Streaming" orb.
    await expect(page.getByLabel('Streaming')).toBeVisible({ timeout: 3000 });

    // Clicking the row "switches" to it; the mock reports the run finished.
    await page.getByRole('button', { name: /Bug fix/ }).click();
    await expect(page.getByLabel('Streaming')).toHaveCount(0);
  });
});
