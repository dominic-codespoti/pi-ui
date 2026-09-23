import { test, expect } from './fixtures';
import {
  PROJECTS_LIST_PAYLOAD,
  ALL_SESSIONS_LIST_PAYLOAD,
  sessionRuntimePayload,
} from './mocks/payloads';
import type { Page } from '@playwright/test';

async function openProjectsSidebar(page: Page) {
  const search = page.locator('input[aria-label="Filter projects and sessions"]');
  const panel = page.locator('[role="complementary"][aria-label^="projects"]');
  // Sidebar content is lazily mounted (module loads on first open) and the
  // panel is a fixed off-canvas drawer on mobile — use its state attribute,
  // not its transitioning geometry, to decide whether it is open.
  const waitForPanelTransition = async () => {
    await panel.evaluate(async (element) => {
      const animations = element.getAnimations();
      if (animations.length === 0) return;
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    });
  };
  const isOpen = async () => {
    try {
      await panel.waitFor({ state: 'attached', timeout: 300 });
    } catch {
      return false;
    }
    await waitForPanelTransition();
    return (await panel.getAttribute('aria-hidden')) === 'false';
  };
  const toggle = page.locator('[aria-label="Toggle session panel"]');
  // The toggle's listener may not be attached yet during initial hydration —
  // verify the drawer actually opened and retry if the click no-opped.
  if (!(await isOpen())) {
    for (let i = 0; i < 5; i++) {
      if (await isOpen()) break;
      await toggle.click();
      await page.waitForTimeout(250); // drawer slide-in transition (220ms)
    }
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
          ws.send(JSON.stringify(sessionRuntimePayload('s3', { phase: 'running' })));
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
          ws.send(JSON.stringify({ ...sessionLoadedFor(msg.path), requestId: msg.requestId }));
          ws.send(JSON.stringify(sessionRuntimePayload('s1', { phase: 'idle' })));
          // Switch #2 is "back to s1" — s3's background run finished unread.
          ws.send(
            JSON.stringify(
              sessionRuntimePayload('s3', { phase: 'idle', unread: switchCount === 2 })
            )
          );
        }
      });
      ws.send(JSON.stringify(CONNECTED_S1));
    });
    await login(page, 'test-password');

    await openProjectsSidebar(page);
    await expect(page.getByText('hello world')).toBeVisible({ timeout: 3000 });
    const backgroundRow = page.getByRole('button', { name: /hello world/ });

    // s3 running in background → green pulsing orb (broadcast persists until
    // the first click, so this can never miss the transient state).
    await expect(backgroundRow.getByText('Running in background', { exact: true })).toHaveCount(1);

    // Open (check) s3 → orb goes grey.
    await backgroundRow.click();
    await expect(backgroundRow.getByText('Running in background', { exact: true })).toHaveCount(0);
    await expect(backgroundRow.getByText('Unchecked result', { exact: true })).toHaveCount(0);

    // Leave to s1 → s3 finished while background → "ready to check" orb.
    await openProjectsSidebar(page);
    await page.getByRole('button', { name: /Bug fix|Fix the login bug/ }).click();
    await openProjectsSidebar(page);
    await expect(backgroundRow.getByText('Unchecked result', { exact: true })).toHaveCount(1);
    await expect(backgroundRow.getByText('Running in background', { exact: true })).toHaveCount(0);

    // Open s3 again → grey.
    await backgroundRow.click();
    await expect(backgroundRow.getByText('Unchecked result', { exact: true })).toHaveCount(0);

    // Leave again → s3 must STAY grey (regression: a finished background
    // session used to flash green "Running in background" forever because its
    // runtime updates were dropped while non-active).
    await openProjectsSidebar(page);
    await page.getByRole('button', { name: /Bug fix|Fix the login bug/ }).click();
    await openProjectsSidebar(page);
    await expect(backgroundRow.getByText('Running in background', { exact: true })).toHaveCount(0);
    await expect(backgroundRow.getByText('Unchecked result', { exact: true })).toHaveCount(0);
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
          ws.send(JSON.stringify(sessionRuntimePayload('s1', { phase: 'running' })));
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
          ws.send(JSON.stringify({ ...sessionLoadedFor(msg.path), requestId: msg.requestId }));
          ws.send(JSON.stringify(sessionRuntimePayload('s1', { phase: 'idle' })));
          ws.send(JSON.stringify(sessionRuntimePayload('s3', { phase: 'idle' })));
        }
      });
      ws.send(JSON.stringify(CONNECTED_S1));
    });
    await login(page, 'test-password');

    await openProjectsSidebar(page);
    await expect(page.getByText('Bug fix')).toBeVisible({ timeout: 3000 });

    // Active + streaming → green "Streaming" orb.
    await expect(
      page.getByRole('button', { name: /Bug fix/ }).getByText('Streaming', { exact: true })
    ).toHaveCount(1);

    // Clicking the row "switches" to it; the mock reports the run finished.
    await page.getByRole('button', { name: /Bug fix/ }).click();
    await expect(
      page.getByRole('button', { name: /Bug fix/ }).getByText('Streaming', { exact: true })
    ).toHaveCount(0);
  });

  test('renders a background tool-call indicator', async ({ page, login }) => {
    await page.routeWebSocket('/ws', (ws) => {
      let bgRunning = true;
      const bgTimer = setInterval(() => {
        if (bgRunning) {
          ws.send(
            JSON.stringify(
              sessionRuntimePayload('s3', { phase: 'running', activeToolName: 'example_tool' })
            )
          );
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
          bgRunning = false;
          clearInterval(bgTimer);
          ws.send(JSON.stringify({ ...sessionLoadedFor(msg.path), requestId: msg.requestId }));
        }
      });
      ws.send(JSON.stringify(CONNECTED_S1));
    });
    await login(page, 'test-password');

    await openProjectsSidebar(page);
    await expect(page.getByText('hello world')).toBeVisible({ timeout: 3000 });

    const backgroundRow = page.getByRole('button', { name: /hello world/ });
    await expect(
      backgroundRow.getByText('Running tool in background', { exact: true })
    ).toHaveCount(1);
    const projectB = page.getByRole('button', { name: /project-b/ });
    await expect(projectB.getByText('Background session running', { exact: true })).toHaveCount(1);
  });
});
