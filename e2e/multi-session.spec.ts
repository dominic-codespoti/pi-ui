import { test, expect, type MockWsHarness } from './fixtures';
import {
  ALL_SESSIONS_LIST_PAYLOAD,
  assistantMessageEndPayload,
  assistantMessageStartPayload,
  sessionRuntimePayload,
  textDeltaPayload,
} from './mocks/payloads';
import type { Page } from '@playwright/test';

const S1_PATH = '/home/user/project-a/s1.jsonl';
const S2_PATH = '/home/user/project-a/s2.jsonl';
const BACKGROUND_TEXT = 'Background-only response';

const SESSIONS = {
  ...ALL_SESSIONS_LIST_PAYLOAD,
  sessions: ALL_SESSIONS_LIST_PAYLOAD.sessions.filter(
    (session) => session.path === S1_PATH || session.path === S2_PATH
  ),
};

async function openProjectsSidebar(page: Page) {
  const search = page.locator('input[aria-label="Filter projects and sessions"]');
  const toggle = page.locator('[aria-label="Toggle session panel"]');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(search).toBeVisible({ timeout: 3000 });
}

function sessionLoaded(
  sessionId: string,
  sessionPath: string,
  requestId?: string,
  messages: unknown[] = []
) {
  return {
    type: 'session_loaded',
    sessionId,
    sessionPath,
    requestId,
    isStreaming: false,
    thinkingLevel: 'medium',
    model: null,
    availableModels: [],
    messages,
    cwd: '/home/user/project-a',
    sessionMode: 'persisted',
    contextUsage: null,
  };
}

function assistantHistoryMessage(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    stopReason: 'endTurn',
  };
}

async function setupMockSession(
  page: Page,
  mockWs: (page: Page, opts?: { autoInit?: boolean; strict?: boolean }) => Promise<MockWsHarness>
) {
  const harness = await mockWs(page, { autoInit: true });
  return { harness };
}

test.describe('Multi-session runtime and view routing', () => {
  test('keeps background status and streamed output scoped to its session', async ({
    page,
    login,
    mockWs,
  }) => {
    const { harness } = await setupMockSession(page, mockWs);
    await login(page, 'test-password');
    await openProjectsSidebar(page);

    await expect(page.getByText('Bug fix')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Add tests')).toBeVisible({ timeout: 3000 });

    // The visible s1 remains idle while a runtime delta marks non-visible s2 running.
    harness.send(sessionRuntimePayload('s2', { phase: 'running' }));
    const s1Row = page.getByRole('button', { name: /Bug fix/ });
    const s2Row = page.getByRole('button', { name: /Add tests/ });
    await expect(s2Row.getByText('Running in background', { exact: true })).toHaveCount(1);
    await expect(s1Row.getByText('Streaming', { exact: true })).toHaveCount(0);

    // Tool activity takes precedence over the running orb, then disappears on a delta
    // that omits activeToolName.
    harness.send(sessionRuntimePayload('s2', { phase: 'running', activeToolName: 'example_tool' }));
    await expect(s2Row.getByText('Running tool in background', { exact: true })).toHaveCount(1);
    harness.send(sessionRuntimePayload('s2', { phase: 'running' }));
    await expect(s2Row.getByText('Running tool in background', { exact: true })).toHaveCount(0);
    await expect(s2Row.getByText('Running in background', { exact: true })).toHaveCount(1);

    // Awaiting input exposes the attention affordance, while a later idle delta
    // records an unread result for the still-background session.
    harness.send(sessionRuntimePayload('s2', { phase: 'awaiting-input', needsAttention: true }));
    await expect(s2Row.getByText('Session needs attention', { exact: true })).toHaveCount(1);
    harness.send(sessionRuntimePayload('s2', { phase: 'idle', unread: true }));
    await expect(s2Row.getByText('Unchecked result', { exact: true })).toHaveCount(1);

    // Streaming events stamped for s2 must not leak into the visible s1 view.
    harness.send({ ...assistantMessageStartPayload(), sessionId: 's2' });
    harness.send({ ...textDeltaPayload(BACKGROUND_TEXT), sessionId: 's2' });
    harness.send({ ...assistantMessageEndPayload(), sessionId: 's2' });
    harness.send({ type: 'agent_end', sessionId: 's2', willRetry: false });
    await expect(page.getByText(BACKGROUND_TEXT)).toHaveCount(0);

    // Switching answers with s2's snapshot, clears its unread marker, and must
    // announce the newly focused session on the wire.
    await s2Row.click();
    const switchMessage = await harness.waitForMessage(
      'switch_session',
      (message) => message.path === S2_PATH
    );
    harness.send(
      sessionLoaded('s2', S2_PATH, String(switchMessage.requestId), [
        assistantHistoryMessage(BACKGROUND_TEXT),
      ])
    );
    harness.send(sessionRuntimePayload('s2', { phase: 'idle' }));
    await expect(page.getByText(BACKGROUND_TEXT)).toBeVisible({ timeout: 3000 });
    await expect(s2Row.getByText('Unchecked result', { exact: true })).toHaveCount(0);
    await harness.waitForMessage('session_focus', (message) => message.sessionId === 's2');
  });

  test('keeps runtime status live while applying meaningful session summary changes', async ({
    page,
    login,
    mockWs,
  }) => {
    const { harness } = await setupMockSession(page, mockWs);
    await login(page, 'test-password');
    await openProjectsSidebar(page);

    const s2Row = page.getByRole('button', { name: /Add tests/ });
    await expect(s2Row).toBeVisible({ timeout: 3000 });

    harness.send(sessionRuntimePayload('s2', { phase: 'running' }));
    await expect(s2Row.getByText('Running in background', { exact: true })).toHaveCount(1);

    const s2 = SESSIONS.sessions.find((session) => session.id === 's2');
    if (!s2) throw new Error('Missing s2 test session');
    harness.send({
      type: 'session_updated',
      session: {
        ...s2,
        name: 'Renamed background task',
        modified: Date.now(),
        messageCount: s2.messageCount + 1,
      },
    });
    await expect(page.getByText('Renamed background task')).toBeVisible();
    await expect(page.getByRole('button', { name: /Renamed background task/ })).toHaveCount(1);
  });
  test('ignores a stale foreign snapshot after a correlated switch', async ({
    page,
    login,
    mockWs,
  }) => {
    const { harness } = await setupMockSession(page, mockWs);
    await login(page, 'test-password');
    await openProjectsSidebar(page);

    const s2Row = page.getByRole('button', { name: /Add tests/ });
    await expect(s2Row).toBeVisible({ timeout: 3000 });
    await s2Row.click();
    const switchMessage = await harness.waitForMessage(
      'switch_session',
      (message) => message.path === S2_PATH
    );
    const requestId = String(switchMessage.requestId);
    harness.send(
      sessionLoaded('s2', S2_PATH, requestId, [assistantHistoryMessage('Active transcript')])
    );
    await expect(page.getByText('Active transcript')).toBeVisible({ timeout: 3000 });
    await expect(page).toHaveURL(/session=%2Fhome%2Fuser%2Fproject-a%2Fs2\.jsonl/);

    harness.send(
      sessionLoaded('s1', S1_PATH, 'stale-foreign-request', [
        assistantHistoryMessage('Stale foreign transcript'),
      ])
    );
    await expect(page).toHaveURL(/session=%2Fhome%2Fuser%2Fproject-a%2Fs2\.jsonl/);
    await expect(page.getByText('Active transcript')).toBeVisible();
    await expect(page.getByText('Stale foreign transcript')).toHaveCount(0);
  });
});
