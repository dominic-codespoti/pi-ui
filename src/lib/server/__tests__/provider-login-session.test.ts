import { describe, expect, it, vi } from 'vitest';
import type { AuthInteraction, AuthType, Provider } from '@earendil-works/pi-ai';
import {
  cancelProviderLogin,
  respondToProviderLoginPrompt,
  startProviderLogin,
} from '../provider-login-session.js';

type MockRuntime = {
  getProviders: () => readonly Provider[];
  login: (providerId: string, authType: AuthType, interaction: AuthInteraction) => Promise<unknown>;
};
const provider = {
  id: 'test',
  name: 'Test Provider',
  auth: { oauth: { loginLabel: 'Sign in' } },
} as Provider;
function makeRuntime(login: (interaction: AuthInteraction) => Promise<unknown>): MockRuntime {
  return {
    getProviders: () => [provider],
    login: (_providerId, _authType, interaction) => login(interaction),
  };
}
function options(runtime: MockRuntime, socketSend = vi.fn()) {
  return {
    runtime,
    socketSend,
    provider: 'test',
    authType: 'oauth' as const,
    mutate: async (_providerId: string, operation: () => Promise<void>) => operation(),
  };
}

describe('provider login session bridge', () => {
  it('cancels a prompt when the SDK prompt signal aborts', async () => {
    let sdkSignal!: AbortController;
    const runtime = makeRuntime(async (interaction) => {
      const promptController = new AbortController();
      sdkSignal = promptController;
      return interaction.prompt({
        type: 'manual_code',
        message: 'Code',
        signal: promptController.signal,
      });
    });
    const socketSend = vi.fn();
    const { loginId } = startProviderLogin(options(runtime, socketSend));
    await vi.waitFor(() =>
      expect(socketSend).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'provider_login_prompt' })
      )
    );
    const promptId = socketSend.mock.calls.find(
      ([message]) => message.type === 'provider_login_prompt'
    )![0].promptId;
    sdkSignal.abort();
    await vi.waitFor(() =>
      expect(socketSend).toHaveBeenCalledWith({
        type: 'provider_login_prompt_cancel',
        loginId,
        promptId,
      })
    );
    await vi.waitFor(() =>
      expect(socketSend).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'provider_login_state', status: 'cancelled' })
      )
    );
    expect(respondToProviderLoginPrompt(loginId, promptId, 'late')).toBe(false);
  });

  it('aborts the interaction signal on provider login cancellation', async () => {
    let seenSignal!: AbortSignal;
    const runtime = makeRuntime(async (interaction) => {
      seenSignal = interaction.signal!;
      await new Promise<void>((resolve) =>
        seenSignal.addEventListener('abort', () => resolve(), { once: true })
      );
    });
    const { loginId } = startProviderLogin(options(runtime));
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    expect(cancelProviderLogin(loginId)).toBe(true);
    await vi.waitFor(() => expect(seenSignal.aborted).toBe(true));
  });

  it('refuses a second concurrent login for the same provider', async () => {
    const runtime = makeRuntime(async () => new Promise<never>(() => {}));
    const first = startProviderLogin(options(runtime));
    const secondSend = vi.fn();
    const second = startProviderLogin(options(runtime, secondSend));
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(secondSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'provider_login_state',
        status: 'failed',
        error: expect.stringContaining('already in progress'),
      })
    );
    cancelProviderLogin(first.loginId);
  });
});
