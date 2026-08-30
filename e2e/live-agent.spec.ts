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
});
