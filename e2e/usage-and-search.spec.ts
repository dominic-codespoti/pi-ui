import { test, expect } from './fixtures';

const USAGE_SUMMARY = {
  days: 30,
  since: '2026-10-07',
  until: '2026-11-05',
  totals: {
    cost: 12.34,
    tokens: 1_500_000,
    inputTokens: 1_400_000,
    outputTokens: 100_000,
    messages: 321,
  },
  byDay: Array.from({ length: 30 }, (_, i) => ({
    day: `2026-10-${String(7 + i).padStart(2, '0')}`,
    cost: i === 29 ? 2 : 0.3,
    tokens: 50_000,
    inputTokens: 45_000,
    outputTokens: 5_000,
    messages: 10,
  })),
  byModel: [
    {
      model: 'anthropic/claude-x',
      cost: 10,
      tokens: 1_000_000,
      inputTokens: 0,
      outputTokens: 0,
      messages: 200,
    },
    {
      model: 'openai/gpt-y',
      cost: 2.34,
      tokens: 500_000,
      inputTokens: 0,
      outputTokens: 0,
      messages: 121,
    },
  ],
  byProject: [
    {
      cwd: '/home/dom/Projects/code/pi-ui',
      cost: 12.34,
      tokens: 1_500_000,
      inputTokens: 0,
      outputTokens: 0,
      messages: 321,
    },
  ],
  sessionsWithUsage: 7,
};

test.describe('Usage summary', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('settings usage section requests and renders the summary', async ({ page, mockWs }) => {
    void mockWs;
    const requests: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        if (msg.type !== 'get_usage_summary') return;
        requests.push(msg);
        ws.send(
          JSON.stringify({
            type: 'usage_summary',
            requestId: msg.requestId,
            summary: { ...USAGE_SUMMARY, days: msg.days },
          })
        );
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
    await page.goto('/?ss=usage');
    await page.getByRole('button', { name: 'Open settings' }).click();
    const section = page.getByTestId('usage-section');
    await expect(section.getByTestId('usage-cost')).toHaveText('$12.34');
    await expect(section.getByTestId('usage-tokens')).toHaveText('1.5M');
    await expect(section.getByTestId('usage-by-model')).toContainText('anthropic/claude-x');
    expect(requests[0]).toMatchObject({ days: 30 });

    await section.getByRole('button', { name: '7 days' }).click();
    await expect.poll(() => requests.at(-1)?.days).toBe(7);
  });
});

test.describe('Session content search', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('searches message text and opens a hit', async ({ page, mockWs }) => {
    void mockWs;
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'get_projects')
          ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
        if (msg.type === 'get_all_sessions')
          ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
        if (msg.type === 'search_sessions') {
          ws.send(
            JSON.stringify({
              type: 'session_search_results',
              requestId: msg.requestId,
              query: msg.query,
              results: [
                {
                  path: '/s/hit.jsonl',
                  sessionId: 'hit',
                  cwd: '/home/dom/Projects/code/voynich-3',
                  name: 'Cipher notes',
                  firstMessage: 'first',
                  modified: 1,
                  matchCount: 4,
                  matches: [
                    {
                      role: 'assistant',
                      snippet: '…the Voynich folio…',
                      matchStart: 5,
                      matchLength: 7,
                    },
                  ],
                },
              ],
              scannedFiles: 60,
              totalFiles: 60,
              truncated: false,
              durationMs: 120,
            })
          );
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
    await page.goto('/?sp=1');
    const filter = page.locator('input[aria-label="Filter projects and sessions"]');
    await expect(filter).toBeVisible({ timeout: 15_000 });
    await filter.fill('voynich');
    await page.getByRole('button', { name: 'Search messages for “voynich”' }).click();
    await expect.poll(() => sent.find((m) => m.type === 'search_sessions')?.query).toBe('voynich');

    const hit = page.getByTestId('session-search-result');
    await expect(hit).toContainText('Cipher notes');
    await expect(hit.locator('mark')).toHaveText('Voynich');
    await hit.click();
    await expect
      .poll(() => sent.find((m) => m.type === 'switch_session')?.path)
      .toBe('/s/hit.jsonl');

    // Editing the filter drops stale results and offers a fresh search.
    await filter.fill('voynich manuscript');
    await expect(
      page.getByRole('button', { name: 'Search messages for “voynich manuscript”' })
    ).toBeVisible();
  });
});
