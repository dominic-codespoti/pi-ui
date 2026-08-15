import { test, expect, submitPrompt } from './fixtures';
import {
  agentStartPayload,
  assistantMessageStartPayload,
  textDeltaPayload,
  assistantMessageEndPayload,
  agentEndPayload,
  thinkingDeltaPayload,
} from './mocks/payloads';

test.describe('Chat / prompt streaming', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('shows composer after connect', async ({ page }) => {
    await expect(page.locator('textarea')).toBeVisible();
  });

  test('sends prompt message over WebSocket', async ({ page }) => {
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
    });

    await page.goto('/');

    await page.fill('textarea', 'Hello pi');
    await page.getByLabel('Send message').click();

    const hasPrompt = wsMessages.some((m) => {
      try {
        const p = JSON.parse(m);
        return p.type === 'prompt' && p.message === 'Hello pi';
      } catch {
        return false;
      }
    });
    expect(hasPrompt).toBe(true);
  });

  test('renders streaming text deltas', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      let streaming = false;
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt' && !streaming) {
          streaming = true;
          ws.send(JSON.stringify(agentStartPayload()));
          ws.send(JSON.stringify(assistantMessageStartPayload()));
          setTimeout(() => ws.send(JSON.stringify(textDeltaPayload('Hello'))), 50);
          setTimeout(() => ws.send(JSON.stringify(textDeltaPayload(' world'))), 100);
          setTimeout(() => {
            ws.send(JSON.stringify(assistantMessageEndPayload()));
            ws.send(JSON.stringify(agentEndPayload()));
          }, 150);
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
    await page.goto('/');

    await page.fill('textarea', 'Say hi');
    await page.getByLabel('Send message').click();

    await expect(page.getByText('Hello world')).toBeVisible({ timeout: 5000 });
  });

  test('renders existing messages from connected payload', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's1',
          isStreaming: false,
          thinkingLevel: 'medium',
          model: { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', reasoning: false },
          availableModels: [],
          messages: [
            { role: 'user', content: 'Hello', timestamp: Date.now() - 60000 },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Hi there!' }],
              usage: { input: 5, output: 10, totalTokens: 15 },
              stopReason: 'endTurn',
              timestamp: Date.now() - 55000,
            },
          ],
        })
      );
    });

    await page.goto('/');

    await expect(page.getByText('Hi there!')).toBeVisible({ timeout: 3000 });
  });

  test('dispatches a slash command instead of steering while the agent is streaming', async ({
    page,
  }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        wsMessages.push(String(data));
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's1',
          isStreaming: true,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          messages: [],
        })
      );
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.goto('/');

    // Composer is in the streaming state (send button becomes steer). Typing
    // a slash command must still dispatch as a command, not get steered into
    // the agent's turn as literal text.
    await page.fill('textarea', '/tree');
    await page.getByLabel('Steer pi').click();

    const parsed = wsMessages.map((m) => {
      try {
        return JSON.parse(m);
      } catch {
        return null;
      }
    });
    expect(parsed.some((p) => p?.type === 'get_session_tree')).toBe(true);
    expect(parsed.some((p) => p?.type === 'steer')).toBe(false);
  });

  test('blocks a session-mutating slash command while streaming instead of steering or dispatching', async ({
    page,
  }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        wsMessages.push(String(data));
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's1',
          isStreaming: true,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          messages: [],
        })
      );
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.goto('/');

    await page.fill('textarea', '/reload');
    await page.getByLabel('Steer pi').click();

    await expect(
      page.getByText('Wait for the agent to finish before running this command.')
    ).toBeVisible({ timeout: 3000 });

    const parsed = wsMessages.map((m) => {
      try {
        return JSON.parse(m);
      } catch {
        return null;
      }
    });
    expect(parsed.some((p) => p?.type === 'steer')).toBe(false);
    expect(parsed.some((p) => p?.type === 'run_builtin')).toBe(false);
  });

  test('resumes an in-progress response after switching sessions', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
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
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: 'session_loaded',
            sessionId: 's2',
            isStreaming: true,
            thinkingLevel: 'medium',
            model: null,
            availableModels: [],
            messages: [{ role: 'user', content: 'Continue', timestamp: Date.now() }],
            streamingMessage: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Partial' }],
              timestamp: Date.now(),
            },
          })
        );
        ws.send(
          JSON.stringify({
            type: 'message_update',
            sessionId: 's2',
            message: { role: 'assistant' },
            assistantMessageEvent: { type: 'text_delta', delta: ' response' },
          })
        );
      }, 50);
    });

    await page.goto('/');

    await expect(page.getByText('Partial response')).toBeVisible({ timeout: 3000 });
  });

  test('shows thinking deltas', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      let streaming = false;
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt' && !streaming) {
          streaming = true;
          ws.send(JSON.stringify(agentStartPayload()));
          ws.send(JSON.stringify(assistantMessageStartPayload()));
          setTimeout(
            () => ws.send(JSON.stringify(thinkingDeltaPayload('Hmm, let me think...'))),
            50
          );
          setTimeout(() => ws.send(JSON.stringify(textDeltaPayload('Here is my answer.'))), 100);
          setTimeout(() => {
            ws.send(JSON.stringify(assistantMessageEndPayload()));
            ws.send(JSON.stringify(agentEndPayload()));
          }, 150);
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
    await page.goto('/');

    await page.fill('textarea', 'Think');
    await page.getByLabel('Send message').click();

    await expect(page.getByText('Here is my answer.')).toBeVisible({ timeout: 5000 });
  });

  test('shows extension subcommands after slash command space', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_command_completions' && msg.command === 'ag') {
          ws.send(
            JSON.stringify({
              type: 'command_completions',
              command: 'ag',
              prefix: msg.prefix,
              items: [
                { value: 'start', label: 'start', description: 'Start an agent' },
                { value: 'status', label: 'status', description: 'Show agent status' },
              ],
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
      ws.send(
        JSON.stringify({
          type: 'commands_list',
          commands: [{ name: 'ag', description: 'Agent commands', source: 'test' }],
        })
      );
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.goto('/');
    await page.fill('textarea', '/ag ');

    await expect(page.getByText('/ag subcommands')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Start an agent')).toBeVisible();
    await page.getByRole('option', { name: /start Start an agent/ }).click();
    await expect(page.locator('textarea')).toHaveValue('/ag start ');
  });
});

test.describe('Mobile native feel', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('composer disables keyboard autocorrection', async ({ page }) => {
    const composer = page.locator('textarea');
    await expect(composer).toHaveAttribute('autocapitalize', 'off');
    await expect(composer).toHaveAttribute('autocorrect', 'off');
    await expect(composer).toHaveAttribute('spellcheck', 'false');
  });

  test('mobile header controls meet touch target size', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'desktop keeps compact density');
    const box = await page.getByLabel('Toggle session panel').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(40);
    expect(box!.height).toBeGreaterThanOrEqual(40);
  });

  test('tapping the conversation dismisses the composer keyboard', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'keyboard dismiss is a touch behavior');
    await submitPrompt(page, 'hello');
    await page.locator('textarea').focus();
    await expect(page.locator('textarea')).toBeFocused();
    await page.locator('#main-content').click({ position: { x: 8, y: 200 } });
    await expect(page.locator('textarea')).not.toBeFocused();
  });

  test('drawer drag-to-close and edge-swipe gestures', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'touch gestures are mobile-only');
    const toggle = page.getByLabel('Toggle session panel');
    const swipe = (fromX: number, toX: number, y = 300) =>
      page.evaluate(
        ([from, to, yPos]) => {
          const root = document.querySelector('[role="presentation"]')!;
          const mk = (x: number) =>
            new Touch({ identifier: 1, target: root, clientX: x, clientY: yPos });
          root.dispatchEvent(
            new TouchEvent('touchstart', {
              touches: [mk(from)],
              changedTouches: [mk(from)],
              bubbles: true,
            })
          );
          root.dispatchEvent(
            new TouchEvent('touchend', {
              touches: [],
              changedTouches: [mk(to)],
              bubbles: true,
            })
          );
        },
        [fromX, toX, y] as const
      );

    // Swipe left on the open drawer closes it
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await swipe(150, 60);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Swipe right from the left edge re-opens it
    await swipe(10, 100);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Close again via drag — the toggle sits behind the open drawer
    await swipe(150, 60);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('Android back closes an open drawer', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'history back integration is mobile-only');
    const toggle = page.getByLabel('Toggle session panel');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.evaluate(() => history.back());
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('long-press opens the message action sheet', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'long-press menu is a touch behavior');
    await submitPrompt(page, 'hello');
    const row = page.locator('.msg-row-longpress').first();
    await row.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 120,
      clientY: 200,
      bubbles: true,
    });
    await page.waitForTimeout(650);
    await row.dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 120,
      clientY: 200,
      bubbles: true,
    });

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Copy message')).toBeVisible();
    await expect(sheet.getByText('Edit & resend')).toBeVisible();
    // Native sheet: panel docked to the bottom edge
    const panel = page.locator('[data-sheet-panel]');
    const box = await panel.boundingBox();
    const vh = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(vh / 2);
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(vh - 8);

    // Edit & resend jumps straight into inline editing
    await sheet.getByText('Edit & resend').click();
    await expect(sheet).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'resend' })).toBeVisible();
  });

  test('project picker docks to the bottom on mobile', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'desktop keeps the centered dropdown');
    await page.getByRole('button', { name: /working in project/ }).click();
    const picker = page.locator('[data-project-picker]');
    await expect(picker).toBeVisible();
    const box = await picker.boundingBox();
    const vh = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(vh / 2);
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(vh - 8);
  });
});

test.describe('Mobile native feel — custom payloads', () => {
  test('long-press on an assistant message offers copy turn', async ({ page, login, isMobile }) => {
    test.skip(!isMobile, 'long-press menu is a touch behavior');
    await page.routeWebSocket('/ws', (ws) => {
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's1',
          isStreaming: false,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          messages: [
            { id: 'u1', role: 'user', content: 'hello', streaming: false, createdAt: Date.now() },
            {
              id: 'a1',
              role: 'assistant',
              content: 'hi there',
              streaming: false,
              createdAt: Date.now(),
            },
          ],
          cwd: '/home/user/project',
          sessionName: 's',
          isCompacting: false,
        })
      );
    });
    await login(page, 'test-password');

    const row = page.locator('.msg-row-longpress').nth(1);
    await row.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 120,
      clientY: 200,
      bubbles: true,
    });
    await page.waitForTimeout(650);
    await row.dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 120,
      clientY: 200,
      bubbles: true,
    });

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Copy message')).toBeVisible();
    await expect(sheet.getByText('Copy entire turn')).toBeVisible();
    // No edit action for assistant messages
    await expect(sheet.getByText('Edit & resend')).not.toBeVisible();
  });
});
