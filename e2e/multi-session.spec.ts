import { test, expect } from './fixtures';
import {
  ALL_SESSIONS_LIST_PAYLOAD,
  CONNECTED_PAYLOAD,
  PROJECTS_LIST_PAYLOAD,
  assistantMessageEndPayload,
  assistantMessageStartPayload,
  sessionRuntimePayload,
  textDeltaPayload,
} from './mocks/payloads';
import type { Page } from '@playwright/test';

const S1_PATH = '/home/user/project-a/s1.jsonl';
const S2_PATH = '/home/user/project-a/s2.jsonl';
const BACKGROUND_TEXT = 'Background-only response';

const PROJECTS = {
  ...PROJECTS_LIST_PAYLOAD,
  projects: PROJECTS_LIST_PAYLOAD.projects.filter(
    (project) => project.cwd === '/home/user/project-a'
  ),
};
const SESSIONS = {
  ...ALL_SESSIONS_LIST_PAYLOAD,
  sessions: ALL_SESSIONS_LIST_PAYLOAD.sessions.filter(
    (session) => session.path === S1_PATH || session.path === S2_PATH
  ),
};

async function openProjectsSidebar(page: Page) {
  const search = page.locator('input[aria-label="Filter projects and sessions"]');
  const isOpen = async () => {
    try {
      await search.waitFor({ state: 'attached', timeout: 300 });
    } catch {
      return false;
    }
    const box = await search.boundingBox();
    return !!box && box.width > 0 && box.x >= -1;
  };
  if (await isOpen()) return;
  const toggle = page.locator('[aria-label="Toggle session panel"]');
  for (let i = 0; i < 5; i++) {
    if (await isOpen()) break;
    await toggle.click();
    await page.waitForTimeout(250);
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
  mockWs: (page: Page, opts?: { autoInit?: boolean }) => Promise<void>
) {
  await mockWs(page, { autoInit: false });
  const outbound: Record<string, unknown>[] = [];
  let emit: (payload: unknown) => void = () => {
    throw new Error('WebSocket is not connected');
  };

  await page.routeWebSocket('/ws', (ws) => {
    emit = (payload) => ws.send(JSON.stringify(payload));
    ws.onMessage((data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      outbound.push(message);
      if (message.type === 'get_projects') {
        emit(PROJECTS);
      } else if (message.type === 'get_all_sessions') {
        emit(SESSIONS);
      } else if (message.type === 'switch_session') {
        const path = String(message.path);
        const sessionId = path === S2_PATH ? 's2' : 's1';
        const messages = sessionId === 's2' ? [assistantHistoryMessage(BACKGROUND_TEXT)] : [];
        emit(sessionLoaded(sessionId, path, String(message.requestId), messages));
        emit(sessionRuntimePayload(sessionId, { phase: 'idle' }));
      }
    });
    emit({ ...CONNECTED_PAYLOAD, sessionId: 's1', sessionPath: S1_PATH, messages: [] });
  });

  return {
    outbound,
    emit: (payload: unknown) => emit(payload),
  };
}

test.describe('Multi-session runtime and view routing', () => {
  test('keeps background status and streamed output scoped to its session', async ({
    page,
    login,
    mockWs,
  }) => {
    const { outbound, emit } = await setupMockSession(page, mockWs);
    await login(page, 'test-password');
    await openProjectsSidebar(page);

    await expect(page.getByText('Bug fix')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Add tests')).toBeVisible({ timeout: 3000 });

    // The visible s1 remains idle while a runtime delta marks non-visible s2 running.
    emit(sessionRuntimePayload('s2', { phase: 'running' }));
    const s1Row = page.getByRole('button', { name: /Bug fix/ });
    const s2Row = page.getByRole('button', { name: /Add tests/ });
    await expect(s2Row.getByLabel('Running in background')).toBeVisible();
    await expect(s1Row.getByLabel('Streaming')).toHaveCount(0);

    // Tool activity takes precedence over the running orb, then disappears on a delta
    // that omits activeToolName.
    emit(sessionRuntimePayload('s2', { phase: 'running', activeToolName: 'example_tool' }));
    await expect(s2Row.getByLabel('Running tool in background')).toBeVisible();
    emit(sessionRuntimePayload('s2', { phase: 'running' }));
    await expect(s2Row.getByLabel('Running tool in background')).toHaveCount(0);
    await expect(s2Row.getByLabel('Running in background')).toBeVisible();

    // Awaiting input exposes the attention affordance, while a later idle delta
    // records an unread result for the still-background session.
    emit(sessionRuntimePayload('s2', { phase: 'awaiting-input', needsAttention: true }));
    await expect(s2Row.getByLabel('Session needs attention')).toBeVisible();
    emit(sessionRuntimePayload('s2', { phase: 'idle', unread: true }));
    await expect(s2Row.getByLabel('Unchecked result')).toBeVisible();

    // Streaming events stamped for s2 must not leak into the visible s1 view.
    emit({ ...assistantMessageStartPayload(), sessionId: 's2' });
    emit({ ...textDeltaPayload(BACKGROUND_TEXT), sessionId: 's2' });
    emit({ ...assistantMessageEndPayload(), sessionId: 's2' });
    emit({ type: 'agent_end', sessionId: 's2', willRetry: false });
    await expect(page.getByText(BACKGROUND_TEXT)).toHaveCount(0);

    // Switching answers with s2's snapshot, clears its unread marker, and must
    // announce the newly focused session on the wire.
    await s2Row.click();
    await expect(page.getByText(BACKGROUND_TEXT)).toBeVisible({ timeout: 3000 });
    await expect(s2Row.getByLabel('Unchecked result')).toHaveCount(0);
    await expect
      .poll(() =>
        outbound.some((message) => message.type === 'session_focus' && message.sessionId === 's2')
      )
      .toBe(true);
  });
});
