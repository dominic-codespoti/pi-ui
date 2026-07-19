import { test as base, type Page } from '@playwright/test';
import { CONNECTED_PAYLOAD, PROJECTS_LIST_PAYLOAD, ALL_SESSIONS_LIST_PAYLOAD } from './mocks/payloads';

export type MockWsOptions = {
  /** If true, the mock WS auto-replies to common init messages (get_projects, get_all_sessions). */
  autoInit?: boolean;
};

/**
 * Extended test fixture that provides helpers for mocking the /ws endpoint.
 */
export const test = base.extend<{
  mockWs: (page: Page, opts?: MockWsOptions) => Promise<void>;
  login: (page: Page, password?: string) => Promise<void>;
}>({
  mockWs: async ({}, use) => {
    await use(async (page: Page, opts?: MockWsOptions) => {
      const { autoInit = true } = opts ?? {};

      await page.routeWebSocket('/ws', (ws) => {
        ws.onMessage((message) => {
          const msg = JSON.parse(String(message));

          if (autoInit) {
            if (msg.type === 'get_projects') {
              ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
            } else if (msg.type === 'get_all_sessions') {
              ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
            }
          }
        });

        // Send connected payload immediately on open
        ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      });
    });
  },

  login: async ({}, use) => {
    await use(async (page: Page, password?: string) => {
      await page.goto('/login');
      await page.fill('input[name="password"]', password ?? 'test-password');
      await page.click('button[type="submit"]');
      await page.waitForURL('/');
    });
  },
});

/**
 * Fill the composer and submit via the send button.
 * Works on both desktop and mobile projects — on mobile, plain Enter inserts
 * a newline by design, so keyboard submission is not portable.
 */
export async function submitPrompt(page: Page, text: string): Promise<void> {
  await page.fill('textarea', text);
  await page.click('button[aria-label="Send message"]');
}

export { expect } from '@playwright/test';
