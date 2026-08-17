import { test, expect } from './fixtures';
import {
  PROJECTS_LIST_PAYLOAD,
  ALL_SESSIONS_LIST_PAYLOAD,
  SESSION_LOADED_PAYLOAD,
} from './mocks/payloads';
import type { Page } from '@playwright/test';

async function openProjectsSidebar(page: Page) {
  const search = page.locator('input[aria-label="Filter projects and sessions"]');
  // The panel is a fixed off-canvas drawer on mobile: it keeps a non-empty
  // bounding box (translateX(-100%)) even when closed, so `:visible` cannot
  // detect openness. The sidebar content is ALSO lazily mounted (module loads
  // on first open), so a never-opened drawer has no element at all — never
  // wait for it, judge existence + actual position instead.
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
  // The toggle's listener may not be attached yet during initial hydration —
  // verify the drawer actually opened and retry if the click no-opped.
  for (let i = 0; i < 5; i++) {
    if (await isOpen()) break;
    await toggle.click();
    await page.waitForTimeout(250); // drawer slide-in transition (220ms)
  }
  await expect(search).toBeVisible({ timeout: 3000 });
}
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
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's1',
          isStreaming: false,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          messages: [],
        })
      );
    });

    await openProjectsSidebar(page);

    await expect(page.getByText('project-a')).toBeVisible({ timeout: 3000 });
  });

  test('session switch updates URL without reloading', async ({ page }) => {
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
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's1',
          isStreaming: false,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          messages: [],
        })
      );
    });

    // Reload marker — a real navigation would lose it.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__piNoReload = true;
    });

    await openProjectsSidebar(page);
    await page.getByRole('button', { name: /Bug fix/ }).click();

    // The shallow goto must persist the session path to the URL bar…
    await expect(page).toHaveURL(/session=%2Fhome%2Fuser%2Fproject-a%2Fs1\.jsonl/);
    // …without navigating: the page was never reloaded.
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__piNoReload)
    ).toBe(true);
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
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's1',
          isStreaming: false,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          messages: [],
        })
      );
    });

    await openProjectsSidebar(page);
    await page
      .locator('input[aria-label="Filter projects and sessions"]:visible')
      .fill('nonexistent');
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
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's1',
          isStreaming: false,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          messages: [],
        })
      );
      // Send a runtime update for a background session
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: 'session_runtime',
            sessionId: 's3',
            isRunning: true,
            unseen: false,
            lastActivity: Date.now(),
          })
        );
      }, 100);
    });

    await openProjectsSidebar(page);

    // Wait for session to appear
    await expect(page.getByText('hello world')).toBeVisible({ timeout: 3000 });
  });

  test('shows loading state and blocks duplicate new sessions', async ({ page }) => {
    let newSessionCount = 0;
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_projects') ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        if (msg.type === 'get_all_sessions') ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
        if (msg.type === 'new_session') {
          newSessionCount += 1;
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                ...SESSION_LOADED_PAYLOAD,
                sessionId: 'new-session',
                messages: [],
                sessionName: undefined,
              })
            );
          }, 250);
        }
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's1',
          isStreaming: false,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          messages: [],
        })
      );
    });

    await openProjectsSidebar(page);
    await page.getByRole('button', { name: 'project-a 2' }).hover();
    const newSessionButton = page.getByRole('button', { name: 'New session in project-a' });
    await newSessionButton.click();

    await expect(newSessionButton).toBeDisabled();
    await expect(page.getByPlaceholder('Opening session…')).toBeVisible();
    expect(newSessionCount).toBe(1);
  });
  test('collapses the active project and previews three sessions', async ({ page }) => {
    const sessions = [
      ...ALL_SESSIONS_LIST_PAYLOAD.sessions,
      {
        id: 's4',
        path: '/home/user/project-a/s4.jsonl',
        cwd: '/home/user/project-a',
        name: 'Third session',
        created: Date.now() - 3 * 86400000,
        modified: Date.now() - 3 * 3600000,
        messageCount: 4,
        firstMessage: 'Third session prompt',
      },
      {
        id: 's5',
        path: '/home/user/project-a/s5.jsonl',
        cwd: '/home/user/project-a',
        name: 'Overflow session',
        created: Date.now() - 4 * 86400000,
        modified: Date.now() - 4 * 3600000,
        messageCount: 2,
        firstMessage: 'Overflow session prompt',
      },
    ];

    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_projects') ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        if (msg.type === 'get_all_sessions') {
          ws.send(JSON.stringify({ ...ALL_SESSIONS_LIST_PAYLOAD, sessions }));
        }
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's1',
          cwd: '/home/user/project-a',
          isStreaming: false,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          messages: [],
        })
      );
    });

    await openProjectsSidebar(page);

    const projectHeader = page.locator('button[aria-expanded][title="/home/user/project-a"]');
    await expect(projectHeader).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: /^Third session/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Overflow session/ })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show 1 more sessions' })).toBeVisible();

    await projectHeader.click();
    await expect(projectHeader).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', { name: /^Bug fix/ })).toBeHidden();
  });
});
