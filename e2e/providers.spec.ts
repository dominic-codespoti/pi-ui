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
  });
});
