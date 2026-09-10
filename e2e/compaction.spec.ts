import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
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

type FrameSender = () => void;

/** Install a socket whose compaction frames are sent by the test around its assertions. */
async function installCompactionSocket(
  page: Page,
  startReason = 'manual',
  endOverrides: Record<string, unknown> = {}
): Promise<{ ready: Promise<void>; sendStart: FrameSender; sendEnd: FrameSender }> {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let sendStart: FrameSender | undefined;
  let sendEnd: FrameSender | undefined;

  await page.routeWebSocket('/ws', (ws) => {
    ws.onMessage(() => {
      /* ignore client messages */
    });
    sendStart = () => ws.send(JSON.stringify(compactionStartPayload(startReason)));
    sendEnd = () => ws.send(JSON.stringify(compactionEndPayload(endOverrides)));
    ws.send(JSON.stringify(CONNECTED_PAYLOAD));
    resolveReady();
  });

  return {
    ready,
    sendStart: () => {
      if (!sendStart) throw new Error('Compaction socket did not open');
      sendStart();
    },
    sendEnd: () => {
      if (!sendEnd) throw new Error('Compaction socket did not open');
      sendEnd();
    },
  };
}

test.describe('Compaction UI', () => {
  test('shows a streaming notice on compaction_start and seals it with a token delta on compaction_end', async ({
    page,
    login,
  }) => {
    const frames = await installCompactionSocket(page);
    await login(page, 'test-password');
    await frames.ready;
    frames.sendStart();

    await expect(page.getByText('compacting context…')).toBeVisible({ timeout: 3000 });

    await expect(page.getByText('Context compaction')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 3000 });

    frames.sendEnd();
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
    const frames = await installCompactionSocket(page, 'auto', {
      reason: 'auto',
      aborted: true,
      result: undefined,
      errorMessage: 'Compaction timed out after 5 min and was aborted.',
    });
    await login(page, 'test-password');
    await frames.ready;
    frames.sendStart();

    await expect(page.getByText('auto-compacting context (auto)…')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Context compaction')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 3000 });

    frames.sendEnd();
    await expect(page.getByText('Failed', { exact: true })).toBeVisible({ timeout: 3000 });
    await expect(
      page.getByText('compaction failed: Compaction timed out after 5 min and was aborted.')
    ).toBeVisible({ timeout: 3000 });
  });

  test('marks a non-aborted SDK compaction error as failed', async ({ page, login }) => {
    const frames = await installCompactionSocket(page, 'manual', {
      aborted: false,
      result: undefined,
      errorMessage: 'Nothing to compact (session too small)',
    });
    await login(page, 'test-password');
    await frames.ready;
    frames.sendStart();
    await page.getByText('compacting context…').waitFor({ state: 'visible' });
    frames.sendEnd();

    await expect(page.getByText('Failed', { exact: true })).toBeVisible({ timeout: 3000 });
    await expect(
      page.getByText('compaction failed: Nothing to compact (session too small)')
    ).toBeVisible({ timeout: 3000 });
  });
});
