import { test, expect } from './fixtures';
import { CONNECTED_PAYLOAD } from './mocks/payloads';

const SID = CONNECTED_PAYLOAD.sessionId;

function compactionStartPayload(reason: string) {
  return { type: 'compaction_start', sessionId: SID, reason };
}

function compactionEndPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'compaction_end',
    sessionId: SID,
    reason: 'manual',
    aborted: false,
    willRetry: false,
    result: { tokensBefore: 240_000, estimatedTokensAfter: 18_000 },
    ...overrides,
  };
}

test.describe('Compaction UI', () => {
  test('shows a streaming notice on compaction_start and seals it with a token delta on compaction_end', async ({
    page,
    login,
  }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {
        /* ignore client messages */
      });
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => ws.send(JSON.stringify(compactionStartPayload('manual'))), 150);
      setTimeout(() => ws.send(JSON.stringify(compactionEndPayload())), 450);
    });
    await login(page, 'test-password');

    await expect(page.getByText('compacting context…')).toBeVisible({ timeout: 3000 });

    await expect(page.getByText('Context compaction')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 3000 });

    await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('93% freed', { exact: true })).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('context compacted · 240,000 → 18,000 tokens')).toBeVisible({
      timeout: 3000,
    });
  });

  test('seals the notice as failed when compaction_end reports an error (e.g. watchdog timeout)', async ({
    page,
    login,
  }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {
        /* ignore client messages */
      });
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => ws.send(JSON.stringify(compactionStartPayload('auto'))), 150);
      setTimeout(
        () =>
          ws.send(
            JSON.stringify(
              compactionEndPayload({
                reason: 'auto',
                aborted: true,
                willRetry: false,
                result: undefined,
                errorMessage: 'Compaction timed out after 5 min and was aborted.',
              })
            )
          ),
        450
      );
    });
    await login(page, 'test-password');

    await expect(page.getByText('auto-compacting context (auto)…')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Context compaction')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 3000 });

    await expect(page.getByText('Failed', { exact: true })).toBeVisible({ timeout: 3000 });
    await expect(
      page.getByText('compaction failed: Compaction timed out after 5 min and was aborted.')
    ).toBeVisible({ timeout: 3000 });
  });

  test('marks a non-aborted SDK compaction error as failed', async ({ page, login }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {
        /* ignore client messages */
      });
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => ws.send(JSON.stringify(compactionStartPayload('manual'))), 150);
      setTimeout(
        () =>
          ws.send(
            JSON.stringify(
              compactionEndPayload({
                aborted: false,
                willRetry: false,
                result: undefined,
                errorMessage: 'Nothing to compact (session too small)',
              })
            )
          ),
        450
      );
    });
    await login(page, 'test-password');

    await expect(page.getByText('Failed', { exact: true })).toBeVisible({ timeout: 3000 });
    await expect(
      page.getByText('compaction failed: Nothing to compact (session too small)')
    ).toBeVisible({ timeout: 3000 });
  });
});
