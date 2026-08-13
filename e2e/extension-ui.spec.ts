import { test, expect, submitPrompt } from './fixtures';
import type { Page } from '@playwright/test';
import {
  extensionConfirmPayload,
  extensionInputPayload,
  extensionSelectPayload,
  extensionNotifyPayload,
  extensionSetWidgetPayload,
  extensionSetWidgetTextPayload,
  extensionCustomPayload,
  extensionInteractiveCustomPayload,
  extensionEventPayload,
  ALL_SESSIONS_LIST_PAYLOAD,
  PROJECTS_LIST_PAYLOAD,
} from './mocks/payloads';
import { CONNECTED_PAYLOAD } from './mocks/payloads';

test.describe('Extension UI modals', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('shows confirm dialog', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionConfirmPayload('c1', 'Continue?', 'Are you sure?')));
        }
        if (msg.type === 'extension_ui_response' && msg.id === 'c1') {
          ws.send(JSON.stringify(extensionConfirmPayload('c2', 'Done', 'Confirmed!')));
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
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await submitPrompt(page, 'Confirm action');

    await expect(page.getByText('Continue?')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Are you sure?')).toBeVisible();
  });

  test('confirm dialog sends response on button click', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        wsMessages.push(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionConfirmPayload('c1', 'Continue?', 'Are you sure?')));
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
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await submitPrompt(page, 'Test confirm');

    await expect(page.getByText('Continue?')).toBeVisible({ timeout: 3000 });
    // Click the modal confirm action, not the echoed prompt text in chat.
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    // Check a response was sent
    const hasResponse = wsMessages.some((m) => {
      try {
        const p = JSON.parse(m);
        return p.type === 'extension_ui_response';
      } catch {
        return false;
      }
    });
    expect(hasResponse).toBe(true);
  });

  test('replayed confirm dialog keeps confirm semantics', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        wsMessages.push(String(data));
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
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
      ws.send(
        JSON.stringify(extensionConfirmPayload('replay-c1', 'Reconnect confirm', 'Still continue?'))
      );
      ws.send(
        JSON.stringify({
          type: 'extension_ui_request_replay',
          id: 'replay-c1',
          method: 'confirm',
          title: 'Reconnect confirm',
          message: 'Still continue?',
        })
      );
    });

    await expect(page.getByText('Reconnect confirm')).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();

    const response = wsMessages
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .find((m) => m?.type === 'extension_ui_response' && m.id === 'replay-c1');
    expect(response).toMatchObject({ confirmed: true });
  });

  test('shows input dialog', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionInputPayload('i1', 'Enter name', 'Your name...')));
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
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await submitPrompt(page, 'Input test');

    await expect(page.getByText('Enter name')).toBeVisible({ timeout: 3000 });
    await expect(page.getByPlaceholder('Your name...')).toBeVisible();
  });

  test('shows notify() message inline in chat', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionNotifyPayload('Operation complete', 'success')));
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
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await submitPrompt(page, 'Notify');

    await expect(page.getByText('Operation complete')).toBeVisible({ timeout: 3000 });
  });
});

// ── Extension component widget tests ────────────────────────────────────────
const BASE_WS_INIT = [
  {
    type: 'connected',
    sessionId: 's1',
    isStreaming: false,
    thinkingLevel: 'medium',
    model: null,
    availableModels: [],
    messages: [],
  },
  { type: 'projects_list', projects: [] },
  { type: 'all_sessions_list', sessions: [] },
];

function wsInit(ws: { send: (msg: string) => void }) {
  for (const msg of BASE_WS_INIT) ws.send(JSON.stringify(msg));
}

async function openProjectsSidebar(page: Page) {
  const search = page.locator('input[aria-label="Filter projects and sessions"]');
  // Sidebar content is lazily mounted (module loads on first open) and the
  // panel is a fixed off-canvas drawer on mobile — never wait for the element,
  // judge existence + actual position instead.
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

const CONNECTED_S1 = {
  type: 'connected',
  sessionId: 's1',
  isStreaming: false,
  thinkingLevel: 'medium',
  model: null,
  availableModels: [],
  messages: [],
  cwd: '/home/user/project-a',
  sessionMode: 'persisted',
};

function sessionLoadedFor(path: string, widgets: unknown[] = []) {
  const isProjectB = path.includes('project-b');
  return {
    type: 'session_loaded',
    sessionId: isProjectB ? 's3' : 's1',
    isStreaming: false,
    thinkingLevel: 'medium',
    model: null,
    availableModels: [],
    messages: [],
    cwd: isProjectB ? '/home/user/project-b' : '/home/user/project-a',
    sessionName: isProjectB ? undefined : 'Bug fix',
    sessionPath: path,
    sessionMode: 'persisted',
    contextUsage: null,
    widgets,
  };
}

test.describe('Extension component widgets', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });
  test('shows search provider status and footer alongside unrelated status', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_S1));
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: 'extension_ui_request',
            id: 'search-status',
            method: 'setStatus',
            statusKey: 'search',
            statusText: 'DuckDuckGo / Jina',
            sessionId: 's1',
          })
        );
        ws.send(
          JSON.stringify({
            type: 'extension_ui_request',
            id: 'other-status',
            method: 'setStatus',
            statusKey: 'other',
            statusText: 'Ready',
            sessionId: 's1',
          })
        );
        ws.send(
          JSON.stringify({
            type: 'extension_ui_request',
            id: 'search-footer',
            method: 'set_footer',
            content: 'DuckDuckGo / Jina',
            sessionId: 's1',
          })
        );
      }, 300);
    });

    await expect(page.getByText(/Ready/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/DuckDuckGo \/ Jina/)).toHaveCount(2);

    if ((page.viewportSize()?.width ?? 0) >= 768) {
      const statusTrigger = page.getByLabel('Extension statuses');
      await expect(statusTrigger).toBeVisible();
      await statusTrigger.hover();
      await expect(page.getByText('Extension status', { exact: true })).toBeVisible();
      await expect(page.getByText('search', { exact: true })).toBeVisible();
    }
  });

  test('renders a ProgressBar widget', async ({ page }) => {
    const progressBar = {
      kind: 'progress',
      label: 'Building…',
      progress: 0.6,
    };
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      // Push widget after a short delay so the page has time to connect
      setTimeout(() => {
        ws.send(JSON.stringify(extensionSetWidgetPayload('test-progress', progressBar)));
      }, 500);
    });

    // Wait for the widget to appear
    await expect(page.getByText('Building…')).toBeVisible({ timeout: 5000 });
    // Progress bar should be rendered
    await expect(page.locator('progress')).toBeVisible();
  });

  test('renders a Loader widget', async ({ page }) => {
    const loader = { kind: 'loader', label: 'Loading resources…' };
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionSetWidgetPayload('test-loader', loader)));
      }, 500);
    });

    await expect(page.getByText('Loading resources…')).toBeVisible({ timeout: 5000 });
  });

  test('renders a container widget with children', async ({ page }) => {
    const containerWidget = {
      kind: 'container',
      direction: 'vertical',
      children: [
        { kind: 'text', label: '', content: 'Status: OK' },
        { kind: 'button', label: 'Refresh', variant: 'primary' },
      ],
    };
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionSetWidgetPayload('test-container', containerWidget)));
      }, 500);
    });

    await expect(page.getByText('Status: OK')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Refresh')).toBeVisible();
  });

  test('widget dismiss button removes the widget', async ({ page }) => {
    const textWidget = { kind: 'text', label: '', content: 'Widget to dismiss' };
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionSetWidgetPayload('dismiss-me', textWidget)));
      }, 500);
    });

    await expect(page.getByText('Widget to dismiss')).toBeVisible({ timeout: 5000 });
    // Find and click the dismiss button (aria-label="Dismiss widget")
    const dismissBtn = page.getByRole('button', { name: /dismiss widget/i }).first();
    await dismissBtn.click();
    await expect(page.getByText('Widget to dismiss')).not.toBeVisible({ timeout: 3000 });
  });

  test('renders ANSI-styled text widget lines as colored HTML, matching the theme.fg() pattern extensions like pi-subagents use', async ({
    page,
  }) => {
    // "\x1b[38;2;79;204;146m...\x1b[0m" is exactly what stubTheme.fg('success', text)
    // produces server-side (server.ts converts it to widgetHtmlLines via ansiToHtml).
    const htmlLines = [
      '<span style="color:rgb(79,204,146)">&#x2713;</span> <span style="font-weight:bold">Fix login bug</span> completed',
    ];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(
          JSON.stringify(
            extensionSetWidgetTextPayload('agents', ['✓ Fix login bug completed'], htmlLines)
          )
        );
      }, 500);
    });

    const widgetText = page.getByText('Fix login bug', { exact: false });
    await expect(widgetText).toBeVisible({ timeout: 5000 });
    // The bold span must actually be present in the DOM, not just the plain text —
    // proves the client rendered widgetHtmlLines via {@html} rather than falling
    // back to the plain widgetLines join.
    const boldSpan = page.locator('span[style*="font-weight:bold"]', { hasText: 'Fix login bug' });
    await expect(boldSpan).toBeVisible();
  });

  test('does not render the legacy agents panel alongside the fleet panel', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_S1));
      setTimeout(() => {
        ws.send(
          JSON.stringify(
            extensionSetWidgetTextPayload('agents', ['Legacy agents'], undefined, 's1')
          )
        );
        ws.send(
          JSON.stringify(
            extensionSetWidgetTextPayload('subagents', ['Legacy subagents'], undefined, 's1')
          )
        );
        ws.send(
          JSON.stringify(
            extensionSetWidgetPayload(
              'fleet',
              { kind: 'text', label: '', content: 'Fleet agents' },
              'belowEditor',
              's1'
            )
          )
        );
      }, 500);
    });

    await expect(page.getByText('Fleet agents')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Legacy agents')).toHaveCount(0);
    await expect(page.getByText('Legacy subagents')).toHaveCount(0);
  });

  test('scopes widgets to the active session when switching', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_projects') ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        if (msg.type === 'get_all_sessions') ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
        if (msg.type === 'switch_session') {
          ws.send(JSON.stringify(sessionLoadedFor(msg.path)));
        }
      });
      ws.send(JSON.stringify(CONNECTED_S1));
      setTimeout(() => {
        ws.send(
          JSON.stringify(
            extensionSetWidgetPayload(
              'subagents',
              { kind: 'text', label: '', content: 'Active subagents: 2' },
              undefined,
              's1'
            )
          )
        );
      }, 500);
    });

    await openProjectsSidebar(page);
    await expect(page.getByText('Active subagents: 2')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: /hello world/ }).click();
    await expect(page.getByText('Active subagents: 2')).toHaveCount(0, { timeout: 3000 });
  });

  test('replays widgets from session state after loading a session', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_S1));
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            ...sessionLoadedFor('/home/user/project-a/mock-session-002.jsonl'),
            sessionId: 'mock-session-002',
            widgets: [
              {
                widgetKey: 'subagents',
                widgetType: 'component',
                widgetComponent: {
                  kind: 'text',
                  label: '',
                  content: 'Active subagents: 1',
                },
                widgetPlacement: 'belowEditor',
              },
            ],
          })
        );
      }, 500);
    });

    await expect(page.getByText('Active subagents: 1')).toBeVisible({ timeout: 5000 });
  });

  test('drops widget broadcasts stamped for another session', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_S1));
      setTimeout(() => {
        ws.send(
          JSON.stringify(
            extensionSetWidgetPayload(
              'stale',
              { kind: 'text', label: '', content: 'Stale widget' },
              undefined,
              'other-session'
            )
          )
        );
      }, 500);
    });

    await page.waitForTimeout(1000);
    await expect(page.getByText('Stale widget')).toHaveCount(0);
  });

  test('dismisses a widget durably through the server', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => wsMessages.push(String(data)));
      ws.send(JSON.stringify(CONNECTED_S1));
      setTimeout(() => {
        ws.send(
          JSON.stringify(
            extensionSetWidgetPayload(
              'dismiss-durable',
              { kind: 'text', label: '', content: 'Dismiss durably' },
              undefined,
              's1'
            )
          )
        );
      }, 500);
    });

    await expect(page.getByText('Dismiss durably')).toBeVisible({ timeout: 5000 });
    await page
      .getByRole('button', { name: /dismiss widget/i })
      .first()
      .click();
    await expect(page.getByText('Dismiss durably')).toHaveCount(0, { timeout: 3000 });
    await expect
      .poll(() => {
        return wsMessages.some((raw) => {
          try {
            const msg = JSON.parse(raw);
            return msg.type === 'dismiss_widget' && msg.key === 'dismiss-durable';
          } catch {
            return false;
          }
        });
      })
      .toBe(true);
  });
});

test.describe('Interactive custom overlay', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('keeps extension-rendered content distinct from host chrome', async ({ page }) => {
    const lines = ['╭──────────────────╮', '│ Subagent session │', '╰──────────────────╯'];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionInteractiveCustomPayload('t1', lines)));
      }, 500);
    });

    await expect(page.getByText('Subagent session', { exact: false })).toBeVisible({
      timeout: 5000,
    });
    // The compact terminal frame must not add generic modal filler.
    await expect(page.getByText('EXTENSION UI')).not.toBeVisible();
    // Avoid a redundant footer hint row duplicating extension hints.
    await expect(page.getByText('Arrow keys & Enter sent to extension')).not.toBeVisible();
  });

  test('close button cancels the overlay', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        wsMessages.push(String(data));
      });
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionInteractiveCustomPayload('t2', ['some content'])));
      }, 500);
    });

    await expect(page.getByText('some content')).toBeVisible({ timeout: 5000 });
    const closeButton = page.getByRole('button', { name: /close extension overlay/i });
    const closeBounds = await closeButton.boundingBox();
    expect(closeBounds?.width).toBeGreaterThanOrEqual(40);
    expect(closeBounds?.height).toBeGreaterThanOrEqual(40);
    await closeButton.click();

    const parsed = wsMessages.map((m) => {
      try {
        return JSON.parse(m);
      } catch {
        return null;
      }
    });
    expect(
      parsed.some(
        (p) => p?.type === 'extension_ui_response' && p.id === 't2' && p.cancelled === true
      )
    ).toBe(true);
  });

  test('Escape key closes the overlay', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        wsMessages.push(String(data));
      });
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionInteractiveCustomPayload('t3', ['some content'])));
      }, 500);
    });

    await expect(page.getByText('some content')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');

    await expect
      .poll(() => {
        const parsed = wsMessages.map((m) => {
          try {
            return JSON.parse(m);
          } catch {
            return null;
          }
        });
        return parsed.some(
          (p) => p?.type === 'extension_ui_response' && p.id === 't3' && p.cancelled === true
        );
      })
      .toBe(true);
  });

  test('arrow key forwards a terminal-encoded keystroke to the extension', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        wsMessages.push(String(data));
        if (msg.type === 'extension_custom_input' && msg.id === 't4') {
          ws.send(JSON.stringify({ type: 'custom_render', id: 't4', lines: ['scrolled'] }));
        }
      });
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionInteractiveCustomPayload('t4', ['some content'])));
      }, 500);
    });

    await expect(page.getByText('some content')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('ArrowDown');

    const parsed = wsMessages.map((m) => {
      try {
        return JSON.parse(m);
      } catch {
        return null;
      }
    });
    expect(parsed.some((p) => p?.type === 'extension_custom_input' && p.id === 't4')).toBe(true);
    await expect(page.getByText('scrolled')).toBeVisible({ timeout: 3000 });
  });
  test('reports a stable live viewport and applies a custom render update', async ({ page }) => {
    const resizeMessages: Array<{ columns: number; rows: number }> = [];
    let sendWs: { send: (msg: string) => void } | undefined;
    await page.routeWebSocket('/ws', (ws) => {
      sendWs = ws;
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as {
          type?: string;
          id?: string;
          columns?: number;
          rows?: number;
        };
        if (
          msg.type === 'extension_custom_resize' &&
          msg.id === 't5' &&
          typeof msg.columns === 'number' &&
          typeof msg.rows === 'number'
        ) {
          resizeMessages.push({ columns: msg.columns, rows: msg.rows });
        }
      });
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionInteractiveCustomPayload('t5', ['line one'])));
      }, 500);
    });

    await expect(page.getByText('line one')).toBeVisible({ timeout: 5000 });
    const dialog = page.getByRole('dialog', { name: 'Extension terminal' });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByRole('textbox', { name: 'Extension terminal input' })).toBeFocused();

    await expect.poll(() => resizeMessages.length, { timeout: 5000 }).toBe(1);
    const initialResize = resizeMessages[0];
    expect(initialResize.columns).toBeGreaterThanOrEqual(20);
    expect(initialResize.columns).toBeLessThanOrEqual(200);
    expect(initialResize.rows).toBeGreaterThanOrEqual(20);
    expect(initialResize.rows).toBeLessThanOrEqual(80);
    expect(
      await dialog
        .locator(':scope > div')
        .evaluate((element) => element.getBoundingClientRect().height)
    ).toBe(480);

    if (!sendWs) throw new Error('WebSocket did not open');
    sendWs.send(JSON.stringify({ type: 'custom_render', id: 't5', lines: ['wrapped line'] }));
    await expect(page.getByText('wrapped line')).toBeVisible({ timeout: 3000 });
    await page.waitForTimeout(300);
    expect(resizeMessages).toHaveLength(1);

    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.setViewportSize({
      width: Math.min(700, Math.max(320, viewport.width - 80)),
      height: 360,
    });
    await expect.poll(() => resizeMessages.length, { timeout: 5000 }).toBe(2);
    const resized = resizeMessages[1];
    expect(resized.columns).toBeLessThan(initialResize.columns);
    expect(resized.rows).toBeLessThan(initialResize.rows);
    await page.waitForTimeout(300);
    expect(resizeMessages).toHaveLength(2);
  });
});

test.describe('Extension custom modal with parsed components', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('shows a custom modal with select options', async ({ page }) => {
    const parsed = {
      kind: 'select',
      label: 'Pick a model:',
      options: [
        { value: 'gpt-4', label: 'GPT-4' },
        { value: 'claude', label: 'Claude' },
      ],
    };
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionCustomPayload('custom-1', 'Model Picker', parsed)));
        }
      });
      wsInit(ws);
    });

    await submitPrompt(page, 'Pick model');

    await expect(page.getByText('Pick a model:')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('GPT-4')).toBeVisible();
    await expect(page.getByText('Claude')).toBeVisible();
  });

  test('shows a custom modal with container of text and button', async ({ page }) => {
    const parsed = {
      kind: 'container',
      direction: 'vertical',
      children: [
        { kind: 'text', label: '', content: 'Extension info: v2.1' },
        { kind: 'button', label: 'Install', variant: 'primary' },
      ],
    };
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionCustomPayload('custom-2', 'Extension Info', parsed)));
        }
      });
      wsInit(ws);
    });

    await submitPrompt(page, 'Extension info');

    await expect(page.getByText('Extension info: v2.1')).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Install' })).toBeVisible();
  });

  test('clicking a button in a custom dialog sends extension_component_event, updates on extension_ui_update, and closes on extension_ui_dismiss', async ({
    page,
  }) => {
    const parsed = {
      kind: 'container',
      direction: 'vertical',
      path: [],
      children: [
        { kind: 'text', label: '', content: 'Confirm install?', path: [0] },
        { kind: 'button', label: 'Install', variant: 'primary', path: [1] },
      ],
    };
    const sentEvents: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionCustomPayload('custom-4', 'Installer', parsed)));
        } else if (msg.type === 'extension_component_event') {
          sentEvents.push(msg);
          // Simulate the server invoking the extension's real onClick: it
          // updates the tree once, then resolves the dialog.
          ws.send(
            JSON.stringify({
              type: 'extension_ui_update',
              id: 'custom-4',
              parsed: {
                kind: 'text',
                label: '',
                content: 'Installing…',
                path: [],
              },
            })
          );
          ws.send(JSON.stringify({ type: 'extension_ui_dismiss', id: 'custom-4' }));
        }
      });
      wsInit(ws);
    });

    await submitPrompt(page, 'Install extension');

    await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible({
      timeout: 3000,
    });
    await page.getByRole('button', { name: 'Install', exact: true }).click();

    await expect.poll(() => sentEvents.length).toBeGreaterThan(0);
    expect(sentEvents[0]).toMatchObject({
      id: 'custom-4',
      path: [1],
      event: 'click',
      value: 'Install',
    });

    // Dialog closes once extension_ui_dismiss arrives — the intermediate
    // extension_ui_update never sticks around as a stuck/zombie modal.
    await expect(page.getByText('Installer')).not.toBeVisible({ timeout: 3000 });
  });

  test('shows a custom modal with progress bar', async ({ page }) => {
    const parsed = {
      kind: 'progress',
      label: 'Downloading…',
      progress: 0.45,
    };
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionCustomPayload('custom-3', 'Download', parsed)));
        }
      });
      wsInit(ws);
    });

    await submitPrompt(page, 'Download');

    await expect(page.getByText('Downloading…')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('progress')).toBeVisible();
  });
});

test.describe('Extension event visibility', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('shows a chat notice for warning extension_event', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(
            JSON.stringify(
              extensionEventPayload('omp', 'quota_low', 'warning', 'Only 3 requests remaining')
            )
          );
        }
      });
      wsInit(ws);
    });

    await submitPrompt(page, 'Trigger event');

    await expect(page.getByText('[ext] omp: quota_low')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Only 3 requests remaining')).toBeVisible();
  });

  test('shows a chat notice for error extension_event', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(
            JSON.stringify(extensionEventPayload('omp', 'auth_failed', 'error', 'Invalid API key'))
          );
        }
      });
      wsInit(ws);
    });

    await submitPrompt(page, 'Trigger error');

    await expect(page.getByText('[ext] omp: auth_failed')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Invalid API key')).toBeVisible();
  });

  test('does NOT show a chat notice for info extension_event', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify(extensionEventPayload('omp', 'heartbeat', 'info')));
        }
      });
      wsInit(ws);
    });

    await submitPrompt(page, 'Trigger info');

    // Wait a bit and confirm no chat notice appears
    await page.waitForTimeout(2000);
    await expect(page.getByText('[ext] omp: heartbeat')).not.toBeVisible();
  });
});

test.describe('Extension terminal input', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  async function pressKey(page: Page, key: string) {
    await page.locator('textarea').focus();
    await page.evaluate((k) => {
      document
        .querySelector('textarea')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    }, key);
  }

  test('consumed letter is not inserted', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: true,
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await pressKey(page, 'a');

    await expect(page.locator('textarea')).toHaveValue('');
  });

  test('not-consumed letter is inserted', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: false,
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await pressKey(page, 'b');

    await expect(page.locator('textarea')).toHaveValue('b');
  });

  test('inactive composer does not round-trip terminal input', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => sent.push(JSON.parse(String(data)) as Record<string, unknown>));
      ws.send(JSON.stringify(CONNECTED_S1));
    });

    await page.locator('textarea').fill('z');
    await page.keyboard.type('y');

    expect(sent.some((msg) => msg.type === 'extension_terminal_input')).toBe(false);
    await expect(page.locator('textarea')).toHaveValue('zy');
  });

  test('live activation broadcast enables routing', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: true,
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(JSON.stringify(CONNECTED_S1));
      ws.send(
        JSON.stringify({
          type: 'extension_terminal_input_active',
          active: true,
          sessionId: 's1',
        })
      );
    });

    await pressKey(page, 'q');

    expect(sent.some((msg) => msg.type === 'extension_terminal_input')).toBe(true);
    await expect(page.locator('textarea')).toHaveValue('');
  });

  test('consumed Enter does not submit', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: true,
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await page.locator('textarea').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);

    expect(sent.some((msg) => msg.type === 'prompt')).toBe(false);
  });

  test('editor text changes stay synchronized with terminal input', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: false,
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await pressKey(page, 'h');
    await pressKey(page, 'i');

    await expect
      .poll(() =>
        sent.some(
          (msg) =>
            msg.type === 'extension_editor_text_change' &&
            msg.text === 'hi' &&
            msg.sessionId === 's1'
        )
      )
      .toBe(true);
  });

  test('rewritten data replaces the key', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: false,
              data: 'X',
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await pressKey(page, 'a');

    await expect(page.locator('textarea')).toHaveValue('X');
  });

  test('slash menu still works while terminal input is routed', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: false,
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await pressKey(page, '/');
    await expect(page.locator('textarea')).toHaveValue('/');
    await pressKey(page, 'ArrowDown');
    await pressKey(page, 'Enter');

    await expect(page.locator('textarea')).toHaveValue('/reload ');
  });

  test('set_editor_text programmatic changes sync to the editor mirror', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: 'extension_ui_request',
            id: 'set-1',
            method: 'set_editor_text',
            text: 'hello from extension',
          })
        );
      }, 300);
    });

    await expect
      .poll(() =>
        sent.some(
          (msg) =>
            msg.type === 'extension_editor_text_change' &&
            msg.text === 'hello from extension' &&
            msg.sessionId === 's1'
        )
      )
      .toBe(true);
  });

  test('consumed Escape inserts nothing and does not submit', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: true,
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await pressKey(page, 'Escape');
    await page.waitForTimeout(100);

    await expect(page.locator('textarea')).toHaveValue('');
    expect(sent.some((msg) => msg.type === 'extension_terminal_input')).toBe(true);
    expect(sent.some((msg) => msg.type === 'prompt')).toBe(false);
  });

  test('unconsumed Escape still closes an open panel', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: false,
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    // aria-expanded is the portable open/closed signal — the mobile drawer
    // keeps the panel's search input "visible" in both states.
    const toggle = page.locator('[aria-label="Toggle session panel"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await pressKey(page, 'Escape');

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('consumed Ctrl+Enter does not submit', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: true,
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await page.locator('textarea').focus();
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(100);

    expect(sent.some((msg) => msg.type === 'prompt')).toBe(false);
    await expect(page.locator('textarea')).toHaveValue('');
  });

  test('rapid slash then arrow still navigates the menu', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: false,
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    // No waits between keys: ArrowDown fires while '/' is still awaiting its
    // verdict, so its menu interaction must be replayed when the menu opens.
    await pressKey(page, '/');
    await pressKey(page, 'ArrowDown');
    await pressKey(page, 'Enter');

    await expect(page.locator('textarea')).toHaveValue('/reload ');
  });

  test('optimistic rewritten data replaces the key instead of stacking on it', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: false,
              data: 'X',
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await page.locator('textarea').fill('abc');
    await page.evaluate(() => {
      const el = document.querySelector('textarea')!;
      el.focus();
      el.setSelectionRange(3, 3);
    });

    await pressKey(page, 'Backspace');

    // Native backspace deleted 'c', then the verdict rewrote the key to 'X':
    // the native effect is undone and 'X' replaces it at the snapshot caret.
    await expect(page.locator('textarea')).toHaveValue('abcX');
  });

  test('queued keys apply locally when the socket closes mid-flight', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    let closed = false;
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input' && !closed) {
          const count = sent.filter((m) => m.type === 'extension_terminal_input').length;
          if (count === 1) {
            // The first key's verdict never arrives — the socket dies while
            // the second key is still queued behind it.
            setTimeout(() => {
              closed = true;
              try {
                ws.close();
              } catch {
                /* already closed */
              }
            }, 100);
          }
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await pressKey(page, 'a');
    await pressKey(page, 'b');

    // Neither keystroke may vanish: on close, the pending key applies as
    // unconsumed and the queued key must do the same.
    await expect(page.locator('textarea')).toHaveValue('ab');
  });

  test('keys are not routed during the reconnect handshake', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: false,
              sessionId: 's1',
            })
          );
        }
      });
      // Hold the connected payload so keystrokes land in the handshake
      // window (socket open, session identity not yet established).
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            ...CONNECTED_S1,
            extensionUiState: { terminalInputActive: true },
          })
        );
      }, 300);
    });

    await pressKey(page, 'a');
    await page.waitForTimeout(100);

    // Pre-handshake: no routing, no insertion (untrusted keydown has no
    // native effect — the assertion that matters is the absence of the
    // terminal-input message with the stale session identity).
    expect(sent.some((msg) => msg.type === 'extension_terminal_input')).toBe(false);

    // Post-handshake: routing resumes normally.
    await page.waitForTimeout(300);
    await pressKey(page, 'b');
    await expect(page.locator('textarea')).toHaveValue('b');
  });

  test('fast backspace after a pending key keeps terminal order', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    let firstInput = true;
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          const reply = () =>
            ws.send(
              JSON.stringify({
                type: 'extension_terminal_input_result',
                id: msg.id,
                consumed: false,
                sessionId: 's1',
              })
            );
          if (firstInput) {
            // Hold the "a" verdict so the Backspace keydown lands while "a"
            // is still in flight — that is the deferral window this test
            // exercises (untrusted test keydowns have no native delete, so
            // the deferred manual delete is the only deletion path).
            firstInput = false;
            setTimeout(reply, 200);
          } else {
            reply();
          }
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    // Composer has "x", caret at end. Type "a" (awaited verdict), then
    // Backspace while "a" is still in flight. The deferred delete must run
    // after "a" lands, leaving "x" — not "xa" (what an immediate delete of
    // the pre-"a" text followed by the late "a" insert would yield).
    await page.locator('textarea').fill('x');
    await page.evaluate(() => {
      const el = document.querySelector('textarea')!;
      el.focus();
      el.setSelectionRange(1, 1);
    });
    await pressKey(page, 'a');
    await pressKey(page, 'Backspace');

    await expect(page.locator('textarea')).toHaveValue('x');
  });

  test('pending input from a previous session is discarded on session switch', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(msg);
        if (msg.type === 'extension_terminal_input') {
          // Switch sessions while the key is awaiting its verdict, then let
          // the (now-stale) verdict arrive late.
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: 'session_loaded',
                sessionId: 's2',
                isStreaming: false,
                thinkingLevel: 'medium',
                model: null,
                availableModels: [],
                messages: [],
              })
            );
          }, 150);
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: 'extension_terminal_input_result',
                id: msg.id,
                consumed: false,
                sessionId: 's1',
              })
            );
          }, 400);
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await pressKey(page, 'a');
    await page.waitForTimeout(700);

    // The key was sent for s1 and must never be inserted into s2's composer.
    await expect(page.locator('textarea')).toHaveValue('');
    expect(sent.some((msg) => msg.type === 'prompt')).toBe(false);
  });

  test('consumed backspace undoes its own edit on a non-empty composer', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        if (msg.type === 'extension_terminal_input') {
          ws.send(
            JSON.stringify({
              type: 'extension_terminal_input_result',
              id: msg.id,
              consumed: true,
              sessionId: 's1',
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await page.locator('textarea').fill('abc');
    await page.evaluate(() => {
      const el = document.querySelector('textarea')!;
      el.focus();
      el.setSelectionRange(3, 3);
    });

    // Untrusted keydowns never trigger the browser's native text deletion,
    // so simulate exactly what a real Backspace keypress does immediately
    // after the keydown — value change + its resulting input event — which
    // exercises the bridge's own native-edit bookkeeping (not a fake DOM
    // state) rather than relying on CDP-dispatched trusted-event behavior.
    await page.evaluate(() => {
      const el = document.querySelector('textarea') as HTMLTextAreaElement;
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
      );
      el.value = 'ab';
      el.setSelectionRange(2, 2);
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })
      );
    });

    // The consumed verdict must undo the deletion it caused — not just leave
    // an empty composer untouched (the fleet's only real-world case).
    await expect(page.locator('textarea')).toHaveValue('abc');
  });

  test('a foreign edit while a consumed verdict is pending is not erased', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        if (msg.type === 'extension_terminal_input') {
          // Delay the verdict so a foreign edit can land while it's pending.
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: 'extension_terminal_input_result',
                id: msg.id,
                consumed: true,
                sessionId: 's1',
              })
            );
          }, 300);
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
    });

    await page.locator('textarea').fill('x');
    await page.evaluate(() => {
      const el = document.querySelector('textarea')!;
      el.focus();
      el.setSelectionRange(1, 1);
    });

    // Optimistic ArrowLeft: no native value change, verdict pending 300ms.
    await pressKey(page, 'ArrowLeft');

    // A foreign edit (IME commit, paste, programmatic replace) lands while
    // the verdict is still in flight — it must survive the later revert.
    await page.evaluate(() => {
      const el = document.querySelector('textarea') as HTMLTextAreaElement;
      el.value = 'xy';
      el.setSelectionRange(2, 2);
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'y' })
      );
    });

    await page.waitForTimeout(500);

    await expect(page.locator('textarea')).toHaveValue('xy');
  });

  test('editor mirror resyncs after a same-session reconnect', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    let connectionCount = 0;
    await page.routeWebSocket('/ws', (ws) => {
      connectionCount++;
      const isFirst = connectionCount === 1;
      ws.onMessage((data) => {
        sent.push(JSON.parse(String(data)) as Record<string, unknown>);
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_S1,
          extensionUiState: { terminalInputActive: true },
        })
      );
      if (isFirst) {
        // Force a reconnect to the SAME session shortly after connecting.
        setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        }, 300);
      }
    });

    await page.locator('textarea').fill('draft text');
    const mirrorHits = () =>
      sent.filter((m) => m.type === 'extension_editor_text_change' && m.text === 'draft text')
        .length;
    await expect.poll(mirrorHits).toBeGreaterThanOrEqual(1);

    // Wait past the forced close and the client's reconnect + handshake.
    await expect.poll(() => connectionCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

    // Neither `sessionId` nor `input` changed across the reconnect, so the
    // mirror $effect alone would never refire — the explicit resync must.
    await expect.poll(mirrorHits, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  });
});
