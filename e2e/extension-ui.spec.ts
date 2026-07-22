import { test, expect, submitPrompt } from './fixtures';
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
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
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
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await submitPrompt(page, 'Test confirm');

    await expect(page.getByText('Continue?')).toBeVisible({ timeout: 3000 });
    // Click the modal confirm action, not the echoed prompt text in chat.
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    // Check a response was sent
    const hasResponse = wsMessages.some((m) => {
      try { const p = JSON.parse(m); return p.type === 'extension_ui_response'; }
      catch { return false; }
    });
    expect(hasResponse).toBe(true);
  });

  test('replayed confirm dialog keeps confirm semantics', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        wsMessages.push(String(data));
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
      ws.send(JSON.stringify(extensionConfirmPayload('replay-c1', 'Reconnect confirm', 'Still continue?')));
      ws.send(JSON.stringify({ type: 'extension_ui_request_replay', id: 'replay-c1', method: 'confirm', title: 'Reconnect confirm', message: 'Still continue?' }));
    });

    await expect(page.getByText('Reconnect confirm')).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();

    const response = wsMessages
      .map((m) => {
        try { return JSON.parse(m); }
        catch { return null; }
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
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
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
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] }));
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await submitPrompt(page, 'Notify');

    await expect(page.getByText('Operation complete')).toBeVisible({ timeout: 3000 });
  });
});

// ── Extension component widget tests ────────────────────────────────────────
const BASE_WS_INIT = [
  { type: 'connected', sessionId: 's1', isStreaming: false, thinkingLevel: 'medium', model: null, availableModels: [], messages: [] },
  { type: 'projects_list', projects: [] },
  { type: 'all_sessions_list', sessions: [] },
];

function wsInit(ws: { send: (msg: string) => void }) {
  for (const msg of BASE_WS_INIT) ws.send(JSON.stringify(msg));
}

test.describe('Extension component widgets', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
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

  test('renders ANSI-styled text widget lines as colored HTML, matching the theme.fg() pattern extensions like pi-subagents use', async ({ page }) => {
    // "\x1b[38;2;79;204;146m...\x1b[0m" is exactly what stubTheme.fg('success', text)
    // produces server-side (server.ts converts it to widgetHtmlLines via ansiToHtml).
    const htmlLines = ['<span style="color:rgb(79,204,146)">&#x2713;</span> <span style="font-weight:bold">Fix login bug</span> completed'];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionSetWidgetTextPayload('agents', ['✓ Fix login bug completed'], htmlLines)));
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
});

test.describe('Interactive custom overlay (de-chromed)', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('renders the extension\'s own chrome without pi-ui\'s redundant header/footer', async ({ page }) => {
    const lines = ['╭──────────────────╮', '│ Subagent session │', '╰──────────────────╯'];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionInteractiveCustomPayload('t1', lines)));
      }, 500);
    });

    await expect(page.getByText('Subagent session', { exact: false })).toBeVisible({ timeout: 5000 });
    // No generic "EXTENSION UI" filler header — the extension's own drawn title is the only one shown.
    await expect(page.getByText('EXTENSION UI')).not.toBeVisible();
    // No redundant footer hint row duplicating the extension's own hints.
    await expect(page.getByText('Arrow keys & Enter sent to extension')).not.toBeVisible();
  });

  test('floating close button cancels the overlay', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => { wsMessages.push(String(data)); });
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionInteractiveCustomPayload('t2', ['some content'])));
      }, 500);
    });

    await expect(page.getByText('some content')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: /close extension overlay/i }).click();

    const parsed = wsMessages.map((m) => { try { return JSON.parse(m); } catch { return null; } });
    expect(parsed.some((p) => p?.type === 'extension_ui_response' && p.id === 't2' && p.cancelled === true)).toBe(true);
  });

  test('Escape key closes the overlay', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => { wsMessages.push(String(data)); });
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      setTimeout(() => {
        ws.send(JSON.stringify(extensionInteractiveCustomPayload('t3', ['some content'])));
      }, 500);
    });

    await expect(page.getByText('some content')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');

    await expect.poll(() => {
      const parsed = wsMessages.map((m) => { try { return JSON.parse(m); } catch { return null; } });
      return parsed.some((p) => p?.type === 'extension_ui_response' && p.id === 't3' && p.cancelled === true);
    }).toBe(true);
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

    const parsed = wsMessages.map((m) => { try { return JSON.parse(m); } catch { return null; } });
    expect(parsed.some((p) => p?.type === 'extension_custom_input' && p.id === 't4')).toBe(true);
    await expect(page.getByText('scrolled')).toBeVisible({ timeout: 3000 });
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

  test('clicking a button in a custom dialog sends extension_component_event, updates on extension_ui_update, and closes on extension_ui_dismiss', async ({ page }) => {
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
          ws.send(JSON.stringify({
            type: 'extension_ui_update',
            id: 'custom-4',
            parsed: {
              kind: 'text',
              label: '',
              content: 'Installing…',
              path: [],
            },
          }));
          ws.send(JSON.stringify({ type: 'extension_ui_dismiss', id: 'custom-4' }));
        }
      });
      wsInit(ws);
    });

    await submitPrompt(page, 'Install extension');

    await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: 'Install', exact: true }).click();

    await expect.poll(() => sentEvents.length).toBeGreaterThan(0);
    expect(sentEvents[0]).toMatchObject({ id: 'custom-4', path: [1], event: 'click', value: 'Install' });

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
          ws.send(JSON.stringify(extensionEventPayload('omp', 'quota_low', 'warning', 'Only 3 requests remaining')));
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
          ws.send(JSON.stringify(extensionEventPayload('omp', 'auth_failed', 'error', 'Invalid API key')));
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
