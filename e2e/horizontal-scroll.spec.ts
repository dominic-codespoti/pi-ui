import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * Wide content inside a chat bubble must pan horizontally within its own box.
 * The chat scroller is overflow-x:hidden (no page-level sideways pan), so every
 * wide producer — code blocks, markdown tables — must be its own scroll
 * container. Regression guard for clipped tables/code that could not be slid.
 */

const WIDE_TABLE_MD = [
  '| Column One | Column Two | Column Three | Column Four | Column Five | Column Six | Column Seven | Column Eight |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| aaaaaaaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbbbbb | cccccccccccccccccccc | dddddddddddddddddddd | eeeeeeeeeeeeeeeeeeee | ffffffffffffffffffff | gggggggggggggggggggg | hhhhhhhhhhhhhhhhhhhh |',
].join('\n');

const LONG_CODE =
  'const veryLongIdentifierName = someFunction(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive, argumentSix, argumentSeven);';

function connectedWithAssistant(markdown: string): string {
  return JSON.stringify({
    type: 'connected',
    sessionId: 's1',
    isStreaming: false,
    thinkingLevel: 'medium',
    model: { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', reasoning: false },
    availableModels: [],
    messages: [
      { role: 'user', content: 'show me wide content', timestamp: Date.now() - 60000 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: markdown }],
        usage: { input: 5, output: 10, totalTokens: 15 },
        stopReason: 'endTurn',
        timestamp: Date.now() - 55000,
      },
    ],
  });
}

test('markdown tables pan horizontally instead of being clipped', async ({ page }) => {
  await page.routeWebSocket('/ws', (ws) => {
    ws.send(connectedWithAssistant(`Data:\n\n${WIDE_TABLE_MD}`));
  });
  await loginAndOpen(page);

  const table = page.locator('.prose table');
  await expect(table).toBeVisible({ timeout: 5000 });

  // The table is its own horizontal scroll container.
  await expect(table).toHaveCSS('overflow-x', 'auto');
  const pannable = await table.evaluate((el: HTMLElement) => ({
    overflowing: el.scrollWidth > el.clientWidth,
    panned: ((el.scrollLeft = 80), el.scrollLeft > 0),
    constrained: el.clientWidth <= el.parentElement!.clientWidth + 1,
  }));
  expect(pannable.overflowing).toBe(true);
  expect(pannable.panned).toBe(true);
  expect(pannable.constrained).toBe(true);
});

test('code blocks keep their horizontal scroll', async ({ page }) => {
  await page.routeWebSocket('/ws', (ws) => {
    ws.send(connectedWithAssistant(`Code:\n\n\`\`\`js\n${LONG_CODE}\n\`\`\``));
  });
  await loginAndOpen(page);

  const pre = page.locator('.code-block-pre');
  await expect(pre).toBeVisible({ timeout: 5000 });
  await expect(pre).toHaveCSS('overflow-x', 'auto');
  const pannable = await pre.evaluate((el: HTMLElement) => ({
    overflowing: el.scrollWidth > el.clientWidth,
    panned: ((el.scrollLeft = 60), el.scrollLeft > 0),
  }));
  expect(pannable.panned).toBe(true);
});

test('the chat scroller clips page-level sideways pan', async ({ page }) => {
  await page.routeWebSocket('/ws', (ws) => {
    ws.send(connectedWithAssistant(`Data:\n\n${WIDE_TABLE_MD}`));
  });
  await loginAndOpen(page);

  await expect(page.locator('.prose table')).toBeVisible({ timeout: 5000 });
  // The vertical chat column must not become a second horizontal scroller.
  const scroller = page.locator('.scroll-container-mobile').first();
  await expect(scroller).toHaveCSS('overflow-x', 'hidden');
});

async function loginAndOpen(page: Page): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="password"]', 'test-password');
  await page.click('button[type="submit"]');
  await page.waitForURL('/');
}
