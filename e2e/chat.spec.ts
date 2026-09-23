import { test, expect, submitPrompt } from './fixtures';
import {
  CONNECTED_PAYLOAD,
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

  test('shows provider failures when the assistant returns an error message', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          const failure = {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
            stopReason: 'error',
            errorMessage: '503 upstream overloaded',
            timestamp: Date.now(),
          };
          ws.send(JSON.stringify(agentStartPayload()));
          ws.send(JSON.stringify(assistantMessageStartPayload()));
          ws.send(JSON.stringify({ type: 'message_end', message: failure }));
          ws.send(JSON.stringify({ type: 'agent_end', messages: [failure], willRetry: false }));
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
    await page.goto('/');

    await submitPrompt(page, 'Trigger provider failure');

    await expect(
      page.getByRole('status').filter({ hasText: '503 upstream overloaded' })
    ).toBeVisible({
      timeout: 3000,
    });
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

  test('shows active tool execution indicator', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 's1',
          isStreaming: false,
          activeToolName: 'example_tool',
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
    await expect(page.getByLabel('Running tool example_tool')).toBeVisible({ timeout: 3000 });
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
          ...CONNECTED_PAYLOAD,
          sessionId: 's1',
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

  test('shows extension subcommands with spaces and typed prefixes', async ({ page }) => {
    const longDescription =
      'Agent commands with a deliberately long description that should wrap instead of being clipped';
    const commandPrefixes: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_command_completions' && msg.command === 'ag') {
          commandPrefixes.push(msg.prefix);
          ws.send(
            JSON.stringify({
              type: 'command_completions',
              sessionId: msg.sessionId,
              requestId: msg.requestId,
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
          commands: [{ name: 'ag', description: longDescription, source: 'test' }],
        })
      );
      ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
      ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
    });

    await page.goto('/');
    await page.fill('textarea', '/ag');
    const description = page.getByText(longDescription, { exact: true });
    await expect(description).toBeVisible();
    await expect(description).toHaveCSS('white-space', 'normal');

    await page.fill('textarea', '/ag   ');
    await expect(page.getByText('/ag subcommands')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Show agent status')).toBeVisible();
    await expect.poll(() => commandPrefixes).toContain('');

    await page.fill('textarea', '/ag sta');
    await expect(page.getByText('Show agent status')).toBeVisible({ timeout: 3000 });
    await expect.poll(() => commandPrefixes).toContain('sta');
    await page.getByRole('option', { name: /status Show agent status/ }).click();
    await expect(page.locator('textarea')).toHaveValue('/ag status ');
  });
  test('preserves parent arguments for nested command completions', async ({ page }) => {
    const commandPrefixes: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type !== 'get_command_completions') return;
        commandPrefixes.push(msg.prefix);
        ws.send(
          JSON.stringify({
            type: 'command_completions',
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            command: msg.command,
            prefix: msg.prefix,
            items: [
              { value: 'child grand', label: 'grand', description: 'Grandchild command' },
              { value: 'child graph', label: 'graph', description: 'Graph command' },
            ],
          })
        );
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 'nested-session',
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
          commands: [{ name: 'parent', description: 'Parent command', source: 'test' }],
        })
      );
    });

    await page.goto('/');
    await page.fill('textarea', '/parent child gr');
    await expect(page.getByRole('option', { name: /grand Grandchild command/ })).toBeVisible({
      timeout: 3000,
    });
    await expect.poll(() => commandPrefixes).toContain('child gr');
    const option = page.getByRole('option', { name: /grand Grandchild command/ });
    await option.focus();
    await expect(option).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('textarea')).toHaveValue('/parent child grand ');
  });

  test('resolves mixed-case extension command invocations canonically', async ({ page }) => {
    const completions: { command: string; prefix: string }[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_command_completions') {
          completions.push({ command: msg.command, prefix: msg.prefix });
        }
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 'mixed-case-session',
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
          commands: [{ name: 'Deploy', description: 'Deploy command', source: 'test' }],
        })
      );
    });

    await page.goto('/');
    await page.fill('textarea', '/deploy ');
    await expect.poll(() => completions).toContainEqual({ command: 'Deploy', prefix: '' });
    await page.fill('textarea', '/Deploy st');
    await expect.poll(() => completions).toContainEqual({ command: 'Deploy', prefix: 'st' });
    expect(completions.every(({ command }) => command !== 'deploy')).toBe(true);
  });

  test('keeps fuzzy extension argument results returned by the server', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type !== 'get_command_completions') return;
        ws.send(
          JSON.stringify({
            type: 'command_completions',
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            command: msg.command,
            prefix: msg.prefix,
            items: [{ value: 'status', label: 'status' }],
          })
        );
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 'fuzzy-session',
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
          commands: [{ name: 'ag', description: 'Agent command', source: 'test' }],
        })
      );
    });

    await page.goto('/');
    await page.fill('textarea', '/ag sts');
    await expect(page.getByRole('option', { name: /status/ })).toBeVisible({ timeout: 3000 });
  });

  test('does not request argument completions for commands that do not provide them', async ({
    page,
  }) => {
    const requests: unknown[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_command_completions') requests.push(msg);
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 'no-args-session',
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
          commands: [
            {
              name: 'cmd',
              description: 'No completable arguments',
              source: 'test',
              hasArgumentCompletions: false,
            },
          ],
        })
      );
    });

    await page.goto('/');
    await page.fill('textarea', '/cmd ');
    await expect(page.getByRole('listbox', { name: 'Composer shortcuts' })).toHaveCount(0);
    await expect.poll(() => requests.length, { timeout: 400 }).toBe(0);
  });

  test('matches skills by their full slash invocation', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_resources') {
          ws.send(
            JSON.stringify({
              type: 'resources_list',
              skills: [
                {
                  name: 'frontend',
                  description: 'Frontend workflows',
                  scope: 'project',
                  isBuiltin: false,
                  source: 'test',
                },
              ],
              prompts: [],
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 'skill-session',
          isStreaming: false,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          messages: [],
        })
      );
    });

    await page.goto('/');
    await page.fill('textarea', '/skill:');
    await expect(page.getByRole('option', { name: /\/skill:frontend/ })).toBeVisible({
      timeout: 3000,
    });
  });

  test('Escape dismisses the slash menu until the composer input changes', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.send(
        JSON.stringify({
          ...CONNECTED_PAYLOAD,
          sessionId: 'escape-session',
        })
      );
    });
    await page.goto('/');
    await page.fill('textarea', '/ho');
    const menu = page.getByRole('listbox', { name: 'Composer shortcuts' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await page.waitForTimeout(150);
    await expect(menu).toHaveCount(0);
    await page.fill('textarea', '/hot');
    await expect(menu).toBeVisible();
  });

  test('shows slash completions while the agent is streaming', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.send(
        JSON.stringify({
          ...CONNECTED_PAYLOAD,
          sessionId: 'streaming-menu-session',
          isStreaming: true,
        })
      );
    });
    await page.goto('/');
    await page.fill('textarea', '/ho');
    await expect(page.getByRole('listbox', { name: 'Composer shortcuts' })).toBeVisible();
  });

  test('handles duplicate slash labels without breaking input updates', async ({ page }) => {
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_resources') {
          ws.send(
            JSON.stringify({
              type: 'resources_list',
              skills: [],
              prompts: [
                {
                  name: 'review',
                  description: 'Review prompt',
                  scope: 'project',
                  isBuiltin: false,
                  source: 'test',
                },
              ],
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 'duplicate-label-session',
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
          commands: [{ name: 'review', description: 'Review extension command', source: 'test' }],
        })
      );
    });

    await page.goto('/');
    await page.fill('textarea', '/review');
    const reviewOptions = page.getByRole('option', { name: /\/review/ });
    await expect(reviewOptions.first()).toBeVisible();
    await expect(reviewOptions).toHaveCount(1);
    await page.fill('textarea', '/rev');
    await expect(page.locator('textarea')).toHaveValue('/rev');
    await expect(reviewOptions.first()).toBeVisible();
  });

  test('ignores out-of-order same-query completion responses', async ({ page }) => {
    const requests: Array<{ sessionId: string; requestId: string; query: string }> = [];
    let socket: { send(data: string): void } | null = null;
    await page.routeWebSocket('/ws', (ws) => {
      socket = ws;
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_extension_autocomplete' && msg.trigger === '@') {
          requests.push(msg);
        }
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 'completion-session',
          isStreaming: false,
          thinkingLevel: 'medium',
          model: null,
          availableModels: [],
          messages: [],
        })
      );
    });

    await page.goto('/');
    await page.fill('textarea', '@foo');
    await expect.poll(() => requests.length, { timeout: 3000 }).toBe(1);
    await page.fill('textarea', '@bar');
    await expect.poll(() => requests.length, { timeout: 3000 }).toBe(2);
    await page.fill('textarea', '@foo');
    await expect.poll(() => requests.length, { timeout: 3000 }).toBe(3);

    const latest = requests[2];
    const stale = requests[0];
    socket!.send(
      JSON.stringify({
        type: 'extension_completions',
        sessionId: latest.sessionId,
        requestId: latest.requestId,
        trigger: '@',
        query: 'foo',
        items: [{ value: 'fresh', label: 'fresh', description: 'latest' }],
      })
    );
    await expect(page.getByRole('option', { name: /@fresh latest/ })).toBeVisible({
      timeout: 3000,
    });
    socket!.send(
      JSON.stringify({
        type: 'extension_completions',
        sessionId: stale.sessionId,
        requestId: stale.requestId,
        trigger: '@',
        query: 'foo',
        items: [{ value: 'stale', label: 'stale', description: 'old' }],
      })
    );
    await expect(page.getByRole('option', { name: /@fresh latest/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /@stale old/ })).not.toBeVisible();
  });

  test('debounces file, extension, and command completion channels', async ({ page }) => {
    const requests = {
      file: [] as Array<{ query: string }>,
      extension: [] as Array<{ query: string }>,
      command: [] as Array<{ prefix: string }>,
    };
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'file_complete') requests.file.push(msg);
        if (msg.type === 'get_extension_autocomplete' && msg.trigger === '@')
          requests.extension.push(msg);
        if (msg.type === 'get_command_completions') requests.command.push(msg);
      });
      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: 'completion-debounce-session',
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
          commands: [{ name: 'parent', description: 'Parent command', source: 'test' }],
        })
      );
    });

    await page.goto('/');
    await page.fill('textarea', '@a');
    await page.fill('textarea', '@ab');
    await page.fill('textarea', '@abc');
    await expect.poll(() => requests.file.length, { timeout: 3000 }).toBe(1);
    await expect.poll(() => requests.extension.length, { timeout: 3000 }).toBe(1);
    expect(requests.file[0].query).toBe('abc');
    expect(requests.extension[0].query).toBe('abc');

    await page.fill('textarea', '/parent a');
    await page.fill('textarea', '/parent ab');
    await page.fill('textarea', '/parent abc');
    await expect.poll(() => requests.command.length, { timeout: 3000 }).toBe(1);
    expect(requests.command[0].prefix).toBe('abc');
  });

  test('clears completion and context state when switching sessions', async ({ page }) => {
    let firstRequest: { sessionId: string; requestId: string } | null = null;
    let secondRequest: { sessionId: string; requestId: string } | null = null;
    let socket: { send(data: string): void } | null = null;
    await page.routeWebSocket('/ws', (ws) => {
      socket = ws;
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_extension_autocomplete' && msg.trigger === '@') {
          if (!firstRequest) firstRequest = msg;
          else secondRequest = msg;
        }
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_PAYLOAD,
          type: 'connected',
          sessionId: 'session-one',
          messages: [],
          contextUsage: { tokens: 90, contextWindow: 100, percent: 90 },
        })
      );
    });

    await page.goto('/');
    await page.fill('textarea', '@foo');
    await expect.poll(() => firstRequest !== null, { timeout: 3000 }).toBe(true);
    socket!.send(
      JSON.stringify({
        type: 'extension_completions',
        sessionId: firstRequest!.sessionId,
        requestId: firstRequest!.requestId,
        trigger: '@',
        query: 'foo',
        items: [{ value: 'old', label: 'old', description: 'old session' }],
      })
    );
    await expect(page.getByRole('option', { name: /@old old session/ })).toBeVisible({
      timeout: 3000,
    });

    socket!.send(
      JSON.stringify({
        ...CONNECTED_PAYLOAD,
        type: 'session_loaded',
        sessionId: 'session-two',
        messages: [],
        contextUsage: { tokens: 0, contextWindow: 100, percent: 0 },
      })
    );
    await expect.poll(() => secondRequest !== null, { timeout: 3000 }).toBe(true);
    await expect(page.locator('body')).not.toContainText('90');
    socket!.send(
      JSON.stringify({
        type: 'extension_completions',
        sessionId: firstRequest!.sessionId,
        requestId: firstRequest!.requestId,
        trigger: '@',
        query: 'foo',
        items: [{ value: 'stale', label: 'stale', description: 'prior session' }],
      })
    );
    await expect(page.getByRole('option', { name: /@stale prior session/ })).not.toBeVisible();
  });
  test('stages an image pasted from clipboard', async ({ page }) => {
    const wsMessages: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => wsMessages.push(String(data)));
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

    await page.goto('/');
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await page.locator('textarea').evaluate((textarea, base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
      textarea.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        })
      );
    }, pngBase64);

    await expect(page.locator('img[alt="clipboard.png"]')).toBeVisible({ timeout: 3000 });
    await page.getByLabel('Send message').click();
    await expect
      .poll(
        () =>
          wsMessages.some((raw) => {
            try {
              const message = JSON.parse(raw);
              return (
                message.type === 'prompt' &&
                Array.isArray(message.images) &&
                message.images.length === 1 &&
                message.images[0]?.mimeType === 'image/png'
              );
            } catch {
              return false;
            }
          }),
        { timeout: 3000 }
      )
      .toBe(true);
  });
});

test.describe('Keyboard navigation regressions', () => {
  test.beforeEach(async ({ page, login, mockWs }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('skip link focuses the conversation landmark', async ({ page }) => {
    const skipLink = page.getByRole('link', { name: 'Skip to content' });
    const main = page.locator('main#main-content');

    await skipLink.focus();
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(main).toBeFocused();
  });

  test('closed session panel is excluded from keyboard navigation and reopens focusably', async ({
    page,
    isMobile,
  }) => {
    const toggle = page.getByLabel('Toggle session panel');
    const filter = page.getByLabel('Filter projects and sessions');

    await toggle.click();
    await expect(filter).toBeVisible();
    await filter.focus();
    await expect(filter).toBeFocused();

    if (isMobile) {
      await page.getByLabel('Close projects panel').click();
    } else {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(filter).not.toBeFocused();
    await expect
      .poll(() =>
        filter.evaluate((element) => ({
          hidden: element.closest('[aria-hidden="true"]') !== null,
          inert: element.closest('[inert]') !== null,
        }))
      )
      .toEqual({ hidden: true, inert: true });

    await page.keyboard.press('Tab');
    await expect(filter).not.toBeFocused();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(filter).toBeVisible();
    await expect
      .poll(() =>
        filter.evaluate((element) => ({
          hidden: element.closest('[aria-hidden="true"]') !== null,
          inert: element.closest('[inert]') !== null,
        }))
      )
      .toEqual({ hidden: false, inert: false });
    await filter.focus();

    await expect(filter).toBeFocused();
  });
});
test.describe('Message accessibility regressions', () => {
  test('editing a user message focuses the editor and restores the edit trigger on cancel', async ({
    page,
    login,
    mockWs,
  }) => {
    const harness = await mockWs(page);
    await login(page, 'test-password');
    await harness.waitForMessage('get_all_sessions');
    harness.send({
      ...CONNECTED_PAYLOAD,
      messages: [{ role: 'user', content: 'Draft to edit', timestamp: Date.now() }],
    });

    const editTrigger = page.getByRole('button', { name: 'Edit message' });
    await expect(editTrigger).toBeVisible();
    await editTrigger.focus();
    await editTrigger.press('Enter');
    const editor = page.getByRole('textbox', { name: 'Edit your message' });
    await expect(editor).toBeFocused();
    const cancel = page.getByRole('button', { name: 'cancel', exact: true });
    await cancel.focus();
    await cancel.press('Enter');
    await expect(editor).toHaveCount(0);
    await expect(editTrigger).toBeFocused();
  });

  test('thinking and tool output disclosures expose and update their controlled regions', async ({
    page,
    login,
    mockWs,
  }) => {
    const harness = await mockWs(page);
    await login(page, 'test-password');
    await harness.waitForMessage('get_all_sessions');
    harness.send({
      ...CONNECTED_PAYLOAD,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'First reason carefully.' },
            { type: 'text', text: 'Final answer.' },
          ],
          timestamp: Date.now(),
        },
        {
          role: 'bash',
          command: 'printf output',
          output: 'Tool output text',
          timestamp: Date.now() + 1,
        },
      ],
    });

    const thinkingToggle = page.getByRole('button', { name: 'Toggle thinking block 1' });
    const thinkingToggleId = await thinkingToggle.getAttribute('id');
    const thinkingControls = await thinkingToggle.getAttribute('aria-controls');
    if (!thinkingToggleId || !thinkingControls)
      throw new Error('thinking disclosure relationships are missing');
    const stableThinkingToggle = page.locator(`#${thinkingToggleId}`);
    const thinkingRegion = page.locator(`#${thinkingControls}`);
    await expect(stableThinkingToggle).toHaveAttribute('aria-expanded', 'false');
    await expect
      .poll(() => thinkingRegion.evaluate((element) => (element as HTMLElement).hidden))
      .toBe(true);
    await thinkingToggle.focus();
    await thinkingToggle.press('Enter');
    await expect(stableThinkingToggle).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(() => thinkingRegion.evaluate((element) => (element as HTMLElement).hidden))
      .toBe(false);
    await expect(thinkingRegion).toContainText('First reason carefully.');
    await expect(page.getByText('Final answer.')).toBeVisible();

    const toolToggle = page.getByRole('button', { name: 'Expand Shell output' });
    const toolToggleId = await toolToggle.getAttribute('id');
    const toolControls = await toolToggle.getAttribute('aria-controls');
    if (!toolToggleId || !toolControls)
      throw new Error('tool disclosure relationships are missing');
    const stableToolToggle = page.locator(`#${toolToggleId}`);
    const toolRegion = page.locator(`#${toolControls}`);
    await expect(stableToolToggle).toHaveAttribute('aria-expanded', 'false');
    await expect
      .poll(() => toolRegion.evaluate((element) => (element as HTMLElement).hidden))
      .toBe(true);
    await toolToggle.focus();
    await toolToggle.press('Enter');
    await expect(stableToolToggle).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(() => toolRegion.evaluate((element) => (element as HTMLElement).hidden))
      .toBe(false);
    await expect(toolRegion).toContainText('Tool output text');
  });

  test('image download action appears when focused from the keyboard', async ({
    page,
    login,
    mockWs,
  }) => {
    const harness = await mockWs(page);
    await login(page, 'test-password');
    await harness.waitForMessage('get_all_sessions');
    harness.send({
      ...CONNECTED_PAYLOAD,
      messages: [
        {
          role: 'tool_result',
          toolCallId: 'image-result',
          toolName: 'screenshot',
          content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
          timestamp: Date.now(),
        },
      ],
    });

    const imageToggle = page.getByRole('button', { name: 'Expand Screenshot output' });
    const imageToggleId = await imageToggle.getAttribute('id');
    const outputControls = await imageToggle.getAttribute('aria-controls');
    if (!imageToggleId || !outputControls) {
      throw new Error('image tool disclosure relationships are missing');
    }
    const stableImageToggle = page.locator(`#${imageToggleId}`);
    const imageRegion = page.locator(`#${outputControls}`);
    await expect(stableImageToggle).toHaveAttribute('aria-expanded', 'false');
    await expect
      .poll(() => imageRegion.evaluate((element) => (element as HTMLElement).hidden))
      .toBe(true);
    await imageToggle.focus();
    await imageToggle.press('Enter');
    await expect(stableImageToggle).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(() => imageRegion.evaluate((element) => (element as HTMLElement).hidden))
      .toBe(false);
    await expect(imageRegion.locator('img')).toHaveCount(1);
    const download = page.getByRole('button', { name: 'Download image' });
    await expect(download).toHaveCount(1);
    await expect.poll(() => download.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await download.focus();
    await expect(download).toBeFocused();
    await expect.poll(() => download.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  });

  test('mobile message actions meet the compact touch target', async ({
    page,
    login,
    mockWs,
    isMobile,
  }) => {
    test.skip(!isMobile, 'compact message actions are mobile-only');
    const harness = await mockWs(page);
    await login(page, 'test-password');
    await harness.waitForMessage('get_all_sessions');
    harness.send({
      ...CONNECTED_PAYLOAD,
      messages: [
        { role: 'user', content: 'Mobile message', timestamp: Date.now() },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Mobile answer' }],
          timestamp: Date.now() + 1,
        },
      ],
    });

    const actions = page.getByRole('button', { name: /^(Copy message|Edit message)$/ });
    await expect(actions).toHaveCount(3);
    for (let index = 0; index < (await actions.count()); index++) {
      const box = await actions.nth(index).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
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

  test('long-pressing message text leaves native selection available', async ({
    page,
    login,
    isMobile,
  }) => {
    test.skip(!isMobile, 'native text selection is a touch behavior');
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

    const text = page.locator('.msg-row-longpress').nth(1).locator('.trace-body.select-text');
    await expect(text).toBeVisible();
    await expect(text).toHaveCSS('user-select', 'text');
    await text.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 120,
      clientY: 200,
      bubbles: true,
    });
    await page.waitForTimeout(650);
    await text.dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 120,
      clientY: 200,
      bubbles: true,
    });

    await expect(page.getByRole('dialog')).not.toBeVisible();
  });
});
