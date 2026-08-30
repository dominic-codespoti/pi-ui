import { test, expect } from './fixtures';
import {
  CONNECTED_PAYLOAD,
  PROJECTS_LIST_PAYLOAD,
  ALL_SESSIONS_LIST_PAYLOAD,
} from './mocks/payloads';

const UNCONFIGURED_PROVIDERS = {
  type: 'providers_list',
  providers: [
    { id: 'openai', name: 'OpenAI', configured: true, source: 'environment', modelCount: 1 },
    { id: 'anthropic', name: 'Anthropic', configured: false, modelCount: 1 },
  ],
};

const CONFIGURED_PROVIDERS = {
  type: 'providers_list',
  providers: [
    { id: 'anthropic', name: 'Anthropic', configured: true, source: 'stored', modelCount: 1 },
    { id: 'openai', name: 'OpenAI', configured: true, source: 'environment', modelCount: 1 },
  ],
};

test.describe('Provider credentials', () => {
  test('updates provider status and model availability after saving a key', async ({
    page,
    login,
  }) => {
    let savedKey: string | undefined;

    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'get_providers') {
          ws.send(JSON.stringify(savedKey ? CONFIGURED_PROVIDERS : UNCONFIGURED_PROVIDERS));
        } else if (msg.type === 'set_provider_key') {
          savedKey = msg.key;
          ws.send(JSON.stringify(CONFIGURED_PROVIDERS));
          ws.send(
            JSON.stringify({
              type: 'available_models_changed',
              availableModels: [
                ...CONNECTED_PAYLOAD.availableModels,
                {
                  provider: 'anthropic',
                  id: 'claude-sonnet',
                  name: 'Claude Sonnet',
                  reasoning: true,
                  contextWindow: 200_000,
                },
              ],
            })
          );
        }
      });
      ws.send(JSON.stringify(CONNECTED_PAYLOAD));
      ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
      ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
    });

    await login(page, 'test-password');
    await page.getByRole('button', { name: 'Open model and provider panel' }).click();
    await page.getByRole('tab', { name: /providers/ }).click();

    const keyInput = page.getByLabel('API key for Anthropic');
    await expect(keyInput).toBeVisible();
    await keyInput.fill('sk-test');
    await page.getByRole('button', { name: 'save', exact: true }).click();

    await expect(page.getByRole('button', { name: 'remove key', exact: true })).toBeVisible();
    expect(savedKey).toBe('sk-test');
    await page.locator('button[data-value="models"]').click();
    await expect(page.getByText('Claude Sonnet', { exact: true })).toBeVisible();
  });

  test('derives thinking rungs from the selected model capabilities', async ({ page, login }) => {
    const modelA = {
      provider: 'openai',
      id: 'reasoning-a',
      name: 'Reasoning A',
      reasoning: true,
      contextWindow: 128_000,
      thinkingLevelMap: {
        off: 'off',
        minimal: null,
        medium: 'medium',
        high: 'high',
        max: null,
      },
    };
    const modelB = {
      provider: 'openai',
      id: 'reasoning-b',
      name: 'Reasoning B',
      reasoning: true,
      contextWindow: 128_000,
      thinkingLevelMap: {
        off: 'off',
        minimal: 'minimal',
        low: 'low',
        medium: null,
        high: null,
        xhigh: 'xhigh',
      },
    };
    let sendWs: { send: (message: string) => void } | undefined;
    const sent: Record<string, unknown>[] = [];

    await page.routeWebSocket('/ws', (ws) => {
      sendWs = ws;
      ws.onMessage((data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        sent.push(message);
      });
      ws.send(
        JSON.stringify({
          ...CONNECTED_PAYLOAD,
          model: modelA,
          availableModels: [modelA, modelB],
          thinkingLevel: 'unknown',
        })
      );
      ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
      ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
    });

    await login(page, 'test-password');
    await page.getByRole('button', { name: 'Open model and provider panel' }).click();

    await expect(page.getByRole('button', { name: 'off', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'low', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'medium', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'high', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'minimal', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'high', exact: true })).toHaveClass(
      /border-primary\/60/
    );
    await expect(page.getByRole('button', { name: 'max', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'xhigh', exact: true })).toHaveCount(0);

    if (!sendWs) throw new Error('WebSocket did not open');
    sendWs.send(JSON.stringify({ type: 'model_changed', model: modelB, thinkingLevel: 'xhigh' }));

    await expect(page.getByRole('button', { name: 'minimal', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'xhigh', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'xhigh', exact: true })).toHaveClass(
      /border-primary\/60/
    );
    await expect(page.getByRole('button', { name: 'medium', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'high', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'max', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'low', exact: true }).click();
    expect(sent.find((message) => message.type === 'set_thinking_level')).toMatchObject({
      level: 'low',
    });
  });

  test('applies available_models_changed pushes without a reload', async ({ page, login }) => {
    const modelA = {
      provider: 'openai',
      id: 'gpt-4o',
      name: 'GPT-4o',
      reasoning: false,
      contextWindow: 128_000,
    };
    const modelB = {
      provider: 'anthropic',
      id: 'claude-sonnet-4',
      name: 'Claude Sonnet 4',
      reasoning: true,
      contextWindow: 200_000,
    };
    let sendWs: { send: (message: string) => void } | undefined;

    await page.routeWebSocket('/ws', (ws) => {
      sendWs = ws;
      ws.onMessage((data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        if (message.type === 'get_projects') ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
        if (message.type === 'get_all_sessions') ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
      });
      ws.send(JSON.stringify({ ...CONNECTED_PAYLOAD, availableModels: [modelA] }));
      ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
      ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
    });

    await login(page);
    await page.getByRole('button', { name: 'Open model and provider panel' }).click();
    const gptRow = page.getByRole('button', { name: /^GPT-4o \d/ });
    const claudeRow = page.getByRole('button', { name: /^Claude Sonnet 4 \d/ });
    await expect(gptRow).toBeVisible();
    await expect(claudeRow).toHaveCount(0);

    if (!sendWs) throw new Error('WebSocket did not open');
    sendWs.send(
      JSON.stringify({ type: 'available_models_changed', availableModels: [modelA, modelB] })
    );

    // The async push from the snapshot-first handshake updates the picker live.
    await expect(claudeRow).toBeVisible();
    await expect(gptRow).toBeVisible();
  });
});
