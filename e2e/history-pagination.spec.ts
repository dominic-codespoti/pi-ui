import { test, expect } from './fixtures';
import {
  CONNECTED_PAYLOAD,
  PROJECTS_LIST_PAYLOAD,
  ALL_SESSIONS_LIST_PAYLOAD,
} from './mocks/payloads';

/** Deterministic raw SDK-style message with index-identifiable content. */
function rawMsg(i: number): Record<string, unknown> {
  return i % 2 === 0
    ? { role: 'user', content: `older user ${i}`, timestamp: 1_700_000_000_000 + i * 1_000 }
    : {
        role: 'assistant',
        content: [{ type: 'text', text: `older assistant ${i}` }],
        timestamp: 1_700_000_000_000 + i * 1_000,
      };
}

const TOTAL = 150;
const TAIL_COUNT = 100;

test.describe('Chat history pagination', () => {
  test('requests older pages on demand and disables when fully loaded', async ({ page, login }) => {
    const clientMessages: Array<Record<string, unknown>> = [];
    let olderPagesSent = 0;

    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        clientMessages.push(msg);

        if (msg.type === 'get_projects') ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        if (msg.type === 'get_all_sessions') ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
        if (msg.type === 'load_messages') {
          olderPagesSent += 1;
          const alreadyHasCount = Number(msg.alreadyHasCount ?? 0);
          const count = Number(msg.count ?? 50);
          const end = Math.max(0, TOTAL - alreadyHasCount);
          const start = Math.max(0, end - count);
          const older = Array.from({ length: end - start }, (_, k) => rawMsg(start + k));
          ws.send(
            JSON.stringify({
              type: 'older_messages',
              messages: older,
              totalMessageCount: TOTAL,
              messagesTruncated: start > 0,
            })
          );
        }
      });

      ws.send(
        JSON.stringify({
          ...CONNECTED_PAYLOAD,
          messages: Array.from({ length: TAIL_COUNT }, (_, k) => rawMsg(k + TOTAL - TAIL_COUNT)),
          totalMessageCount: TOTAL,
          messagesTruncated: true,
        })
      );
    });

    await login(page);

    // Tail of the initial window is visible; nothing has been requested yet.
    await expect(page.getByText('older assistant 149')).toBeVisible();
    expect(clientMessages.filter((m) => m.type === 'load_messages')).toHaveLength(0);

    // The header pill offers exactly one remaining page.
    const loadButton = page.getByRole('button', { name: /Load 50 older \(50 remaining\)/ });
    await expect(loadButton).toBeEnabled();

    await loadButton.click();

    // Exactly one page request with correct pager ledger; prepends render.
    await expect
      .poll(() => clientMessages.filter((m) => m.type === 'load_messages'))
      .toHaveLength(1);
    expect(clientMessages.find((m) => m.type === 'load_messages')).toMatchObject({
      count: 50,
      alreadyHasCount: TAIL_COUNT,
    });
    await expect(page.getByText('older user 50')).toBeVisible();
    // Fully loaded flips messagesTruncated=false — the pager pill unmounts.
    await expect(page.getByText('All messages loaded')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Load \d+ older/ })).toHaveCount(0);
    expect(olderPagesSent).toBe(1);
  });
});
