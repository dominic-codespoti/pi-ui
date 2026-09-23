import { test, expect, type MockWsHarness } from './fixtures';
import type { Page } from '@playwright/test';
import {
  providerLoginEventPayload,
  providerLoginPromptCancelPayload,
  providerLoginPromptPayload,
  providerLoginStatePayload,
} from './mocks/payloads';

const PROVIDERS = {
  type: 'providers_list',
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      configured: false,
      oauthLogin: true,
      oauthLoginLabel: 'Sign in with Claude',
      modelCount: 1,
    },
  ],
};

async function openProviderLogin(page: Page, ws: MockWsHarness) {
  await page.getByRole('button', { name: 'Open model and provider panel' }).click();
  await ws.waitForMessage('get_providers');
  ws.send(PROVIDERS);
  await page.getByRole('tab', { name: /providers/ }).click();
  await page.getByRole('button', { name: /Sign in/ }).click();
  return ws.waitForMessage('provider_login');
}

async function initializeProviders(
  page: Page,
  login: (page: Page, password?: string) => Promise<void>,
  wsHarness: (page: Page) => Promise<MockWsHarness>
) {
  const ws = await wsHarness(page);
  await login(page, 'test-password');
  return ws;
}

test.describe('Provider login dialog', () => {
  test('supports OAuth URL, redirect paste prompt, callback cancellation and success', async ({
    page,
    login,
    mockWs,
  }) => {
    const ws = await initializeProviders(page, login, mockWs);
    const loginRequest = await openProviderLogin(page, ws);
    const loginId = `mock-${String(loginRequest.provider)}`;
    ws.send(providerLoginStatePayload(loginId, 'started'));
    const url = 'https://accounts.example.test/oauth?state=abc';
    ws.send(
      providerLoginEventPayload(loginId, {
        type: 'auth_url',
        url,
        instructions: 'Authorize in your browser.',
      })
    );
    ws.send(
      providerLoginEventPayload(loginId, {
        type: 'progress',
        message: 'Waiting for browser authorization.',
      })
    );
    const promptId = 'manual-code-1';
    ws.send(
      providerLoginPromptPayload(loginId, promptId, {
        type: 'manual_code',
        message: 'Authorization code or redirect URL',
        placeholder: 'Paste the redirect URL',
      })
    );

    await expect(page.getByText(url)).toHaveAttribute('title', url);
    await expect(page.getByRole('button', { name: 'Open sign-in page' })).toBeVisible();
    const codeInput = page.getByPlaceholder('Paste the redirect URL');
    await codeInput.fill('http://localhost:53692/callback?code=returned');
    await page.getByRole('button', { name: 'Submit' }).click();
    const response = await ws.waitForMessage('provider_login_response');
    expect(response).toMatchObject({
      loginId,
      promptId,
      value: 'http://localhost:53692/callback?code=returned',
    });

    ws.send(providerLoginPromptCancelPayload(loginId, promptId));
    await expect(codeInput).toHaveCount(0);
    await expect(page.getByText('Received sign-in from browser…')).toBeVisible();
    ws.send(providerLoginStatePayload(loginId, 'succeeded'));
    await expect(page.getByText('Signed in to Anthropic')).toBeVisible();
  });

  test('Cancel sends provider_login_cancel', async ({ page, login, mockWs }) => {
    const ws = await initializeProviders(page, login, mockWs);
    const loginRequest = await openProviderLogin(page, ws);
    const loginId = `mock-${String(loginRequest.provider)}`;
    ws.send(providerLoginStatePayload(loginId, 'started'));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const cancellation = await ws.waitForMessage('provider_login_cancel');
    expect(cancellation).toMatchObject({ loginId });
  });
});
