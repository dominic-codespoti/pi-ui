import { test, expect, submitPrompt } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * Live end-to-end specs — NO routeWebSocket here.
 *
 * These run against the real Bun server with a real pi SDK session: the agent
 * dir points at the per-run scratch dir built by e2e/global-setup.ts
 * (PI_CODING_AGENT_DIR in playwright.config.ts) whose models.json defines a
 * single provider backed by the local fake LLM (e2e/fake-llm.ts). This is the
 * only layer that exercises the server-side WS handler, event forwarder, and
 * SDK bridge that the mocked specs skip.
 */

const REPLY_TIMEOUT = 60_000;

/** Wait for the real WS to be connected: the composer becomes usable. */
async function waitForReady(page: Page): Promise<void> {
  await expect(page.locator('textarea')).toBeEditable({ timeout: 120_000 });
}

/**
 * Start a fresh session via the /new slash command so each test is decoupled
 * from whatever session a previous run left active on the server (the server
 * resumes the last-active session on connect).
 */
async function startNewSession(page: Page): Promise<void> {
  await page.fill('textarea', '/new');
  await page.click('button[aria-label="Send message"]');
  await waitForReady(page);
}

test.describe('Live agent', () => {
  // First connect lazy-loads the pi SDK (~136 MB import) and creates the
  // session; the Playwright default of 30s is too tight for a cold server.
  test.setTimeout(180_000);

  test.beforeEach(async ({ page, login }) => {
    await login(page);
    await waitForReady(page);
    await startNewSession(page);
  });

  test('prompt round-trip through real server, SDK session, and fake LLM', async ({ page }) => {
    const prompt = `live e2e round-trip ${Date.now()}`;
    await submitPrompt(page, prompt);

    // The fake LLM echoes the prompt back prefixed; seeing it rendered means:
    // client → server WS → SDK prompt → provider stream → message_end
    // forwarder → broadcast → client render all worked.
    await expect(page.getByText(`FAKE-LLM REPLY: ${prompt}`)).toBeVisible({
      timeout: REPLY_TIMEOUT,
    });
  });

  test('assistant reply persists across reload (session written to disk)', async ({ page }) => {
    const prompt = `live e2e persist ${Date.now()}`;
    await submitPrompt(page, prompt);
    await expect(page.getByText(`FAKE-LLM REPLY: ${prompt}`)).toBeVisible({
      timeout: REPLY_TIMEOUT,
    });

    await page.reload();
    await waitForReady(page);
    // History comes back from the persisted session file through connected.
    await expect(page.getByText(`FAKE-LLM REPLY: ${prompt}`)).toBeVisible({
      timeout: 30_000,
    });
  });

  test('switching away from and back to a streaming first turn keeps abort targeted correctly', async ({
    page,
  }) => {
    // Regression test for a bug where switch_session checked the session
    // .jsonl's existence on disk before checking in-memory residency. The
    // SDK does not persist a session's file until its first turn completes,
    // so navigating back to a session while its first reply was still
    // streaming was rejected with "Session not found" — leaving this
    // socket's server-side focus stuck on whatever was focused before the
    // failed switch. Abort/steer omit an explicit sessionId and rely on
    // that focus, so they landed on the wrong session.
    const panel = page.locator('[role="complementary"][aria-label^="projects"]');
    // Sidebar content is lazily mounted and the panel is a fixed off-canvas
    // drawer — use its state attribute, not its transitioning geometry, to
    // decide whether it is open (matches session-orbs.spec.ts).
    const waitForPanelTransition = async () => {
      await panel.evaluate(async (element) => {
        const animations = element.getAnimations();
        if (animations.length === 0) return;
        await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
      });
    };
    const isSidebarOpen = async () => {
      try {
        await panel.waitFor({ state: 'attached', timeout: 300 });
      } catch {
        return false;
      }
      await waitForPanelTransition();
      return (await panel.getAttribute('aria-hidden')) === 'false';
    };
    const toggle = page.locator('[aria-label="Toggle session panel"]');
    const openSidebar = async () => {
      if (await isSidebarOpen()) return;
      for (let i = 0; i < 5; i++) {
        if (await isSidebarOpen()) break;
        await toggle.click();
        await page.waitForTimeout(250);
      }
    };

    const prompt = `SLOW_STREAM: nav-abort ${Date.now()}`;
    await submitPrompt(page, prompt);
    await expect(page.getByRole('button', { name: 'Abort generation' })).toBeVisible({
      timeout: 10_000,
    });

    // Navigate away to a brand-new session while the first one still streams.
    await openSidebar();
    await page.getByRole('button', { name: 'pi-ui-e2e-workspace', exact: false }).first().hover();
    await page.getByRole('button', { name: 'New session in pi-ui-e2e-workspace' }).click();
    await expect(page.locator('textarea')).toBeEditable({ timeout: 10_000 });

    // Navigate back to the still-streaming session — this must succeed, not
    // dead-end on "Session not found". A freshly-created session has no
    // name/title yet, so its sidebar row shows no preview text; find it by
    // its background-activity orb instead of message content.
    await openSidebar();
    const backgroundRow = page
      .locator('button')
      .filter({ has: page.getByText('Running in background', { exact: true }) });
    await expect(backgroundRow).toHaveCount(1);
    await backgroundRow.click();
    await expect(page.getByText('Session not found', { exact: false })).toHaveCount(0);
    const abortButton = page.getByRole('button', { name: 'Abort generation' });
    await expect(abortButton).toBeVisible({ timeout: 10_000 });

    // Abort must stop THIS session, not silently no-op against whatever was
    // previously focused — the composer drops out of "Abort generation"
    // back to idle once the turn is actually cancelled (Send stays disabled
    // on empty input; that is independent of the abort itself).
    await abortButton.click();
    await expect(abortButton).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('textarea')).toBeEditable({ timeout: 5_000 });
  });
});
