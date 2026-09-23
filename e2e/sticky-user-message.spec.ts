import { test, expect } from './fixtures';
import { CONNECTED_PAYLOAD } from './mocks/payloads';

const longAssistantReply = (label: string): string =>
  Array.from(
    { length: 30 },
    (_, index) =>
      `${label} paragraph ${index + 1}. This response is intentionally long enough to fill several screens while scrolling through the conversation.`
  ).join('\n\n');

test('only the current turn user message sticks at the top of the transcript', async ({
  page,
  login,
}) => {
  const firstUserText = 'FIRST LONG USER MESSAGE: '.concat(
    'This is deliberately lengthy user content that wraps across multiple lines and remains clamped in the transcript. '.repeat(
      8
    )
  );
  const secondUserText = 'SECOND SHORT USER MESSAGE';

  await page.routeWebSocket('/ws', (ws) => {
    ws.send(
      JSON.stringify({
        ...CONNECTED_PAYLOAD,
        sessionId: 'sticky-turns',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: firstUserText }],
            timestamp: 1_700_000_000_000,
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: longAssistantReply('FIRST REPLY') }],
            timestamp: 1_700_000_001_000,
          },
          {
            role: 'user',
            content: [{ type: 'text', text: secondUserText }],
            timestamp: 1_700_000_002_000,
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: longAssistantReply('SECOND REPLY') }],
            timestamp: 1_700_000_003_000,
          },
        ],
      })
    );
  });

  await login(page);

  const scrollContainer = page.locator('#main-content');
  const userRows = page.locator('[role="group"][id^="message-user-"]');
  await expect(userRows).toHaveCount(2);
  await expect(page.getByText('FIRST REPLY paragraph 1.')).toBeVisible();
  await expect(page.getByText(secondUserText)).toBeVisible();

  const [firstUserId, secondUserId] = await userRows.evaluateAll((rows) =>
    rows.map((row) => row.id)
  );
  const assistantRows = page.locator('[role="group"][id^="message-assistant-"]');
  await expect(assistantRows).toHaveCount(2);
  const firstAssistantId = await assistantRows.first().getAttribute('id');
  expect(firstAssistantId).not.toBeNull();

  const scrollRowToTop = async (id: string): Promise<void> => {
    await scrollContainer.evaluate((container, targetId) => {
      const target = document.getElementById(targetId);
      if (!target) throw new Error(`Missing transcript row ${targetId}`);
      container.scrollTop +=
        target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    }, id);
  };

  const pinnedUserRows = async (): Promise<{ id: string; text: string }[]> =>
    page.evaluate(() => {
      const container = document.querySelector<HTMLElement>('#main-content');
      if (!container) throw new Error('Missing transcript scroll container');
      const viewport = container.getBoundingClientRect();
      return Array.from(
        document.querySelectorAll<HTMLElement>('[role="group"][id^="message-user-"]')
      )
        .filter((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.bottom > viewport.top && bounds.top < viewport.top + 40;
        })
        .map((row) => ({ id: row.id, text: row.innerText }));
    });

  await scrollRowToTop(firstAssistantId!);
  const firstPinned = await pinnedUserRows();
  expect(firstPinned).toHaveLength(1);
  expect(firstPinned[0].id).toBe(firstUserId);

  await scrollRowToTop(secondUserId!);
  const secondPinned = await pinnedUserRows();
  expect(secondPinned).toHaveLength(1);
  expect(secondPinned[0].id).toBe(secondUserId);
  expect(secondPinned[0].text).toContain(secondUserText);
});
