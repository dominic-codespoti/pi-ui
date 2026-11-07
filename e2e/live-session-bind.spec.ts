import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, submitPrompt } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Live regression spec — NO routeWebSocket.
 *
 * Sessions created from the UI (`new_session`, the sidebar "New session"
 * button) must get their RPC host bound: extensions receive `session_start`
 * with a real UI context (`ctx.hasUI === true`). The 0.21.1 refactor dropped
 * the background bind from setActiveSession, so such sessions silently never
 * fired `session_start` and every ctx.ui call was a no-op until an extension
 * command happened to bind them.
 *
 * The probe extension renders a widget from `session_start` carrying the
 * session id, so the spec can tell the new session's probe from any other.
 */

const AGENT_DIR = '/tmp/pi-ui-e2e-agent';
const TIMEOUT = 120_000;

const PROBE_SOURCE = `
interface CtxLike {
  hasUI: boolean;
  sessionManager: { getSessionId(): string };
  ui: { setWidget(key: string, content: string[], options?: { placement?: string }): void };
}
interface PiLike {
  on(event: 'session_start', handler: (event: unknown, ctx: CtxLike) => void): void;
}
export default function bindProbe(pi: PiLike): void {
  pi.on('session_start', (_event, ctx) => {
    const line = 'bind-probe hasUI=' + String(ctx.hasUI) + ' id=' + ctx.sessionManager.getSessionId();
    ctx.ui.setWidget('bind-probe', [line], { placement: 'aboveEditor' });
  });
}
`;

async function waitForReady(page: Page): Promise<void> {
  await expect(page.locator('textarea')).toBeEditable({ timeout: TIMEOUT });
}

/** Open the off-canvas projects sidebar (same approach as live-agent.spec.ts). */
async function openSidebar(page: Page): Promise<void> {
  const panel = page.locator('[role="complementary"][aria-label^="projects"]');
  const isOpen = async () => {
    try {
      await panel.waitFor({ state: 'attached', timeout: 300 });
    } catch {
      return false;
    }
    await panel.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((a) => a.finished.catch(() => undefined)));
    });
    return (await panel.getAttribute('aria-hidden')) === 'false';
  };
  const toggle = page.locator('[aria-label="Toggle session panel"]');
  for (let i = 0; i < 5 && !(await isOpen()); i++) {
    await toggle.click();
    await page.waitForTimeout(250);
  }
}

async function probeIds(page: Page): Promise<string[]> {
  const texts = await page.getByText(/bind-probe hasUI=/).allInnerTexts();
  return texts.map((t) => /id=(\S+)/.exec(t)?.[1] ?? '').filter(Boolean);
}

test.describe('Live session binding', () => {
  test.setTimeout(240_000);

  test.beforeEach(() => {
    // New SDK sessions load global extensions from AGENT_DIR/extensions.
    mkdirSync(`${AGENT_DIR}/extensions`, { recursive: true });
    writeFileSync(`${AGENT_DIR}/extensions/pi-ui-bind-probe.ts`, PROBE_SOURCE);
  });

  test('a session created from the UI fires session_start with a bound UI', async ({
    page,
    login,
  }) => {
    await login(page);
    await waitForReady(page);
    // A persisted turn registers the workspace project in the sidebar.
    const prompt = `bind probe warmup ${Date.now()}`;
    await submitPrompt(page, prompt);
    await expect(page.getByText(`FAKE-LLM REPLY: ${prompt}`)).toBeVisible({ timeout: 60_000 });
    const before = new Set(await probeIds(page));
    const previousSession = new URL(page.url()).searchParams.get('session');

    await openSidebar(page);
    await page.getByRole('button', { name: 'pi-ui-e2e-workspace', exact: false }).first().hover();
    await page.getByRole('button', { name: 'New session in pi-ui-e2e-workspace' }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('session'), { timeout: TIMEOUT })
      .not.toBe(previousSession);
    await waitForReady(page);

    // The new session's own probe appears, and its UI context was bound.
    await expect
      .poll(async () => (await probeIds(page)).filter((id) => !before.has(id)).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await expect(page.getByText(/bind-probe hasUI=true id=/).first()).toBeVisible();
    await expect(page.getByText(/bind-probe hasUI=false/)).toHaveCount(0);
  });
});
