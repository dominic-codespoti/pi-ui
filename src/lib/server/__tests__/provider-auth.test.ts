import { describe, expect, it, vi } from 'vitest';
import { persistProviderApiKey } from '../provider-auth';

describe('persistProviderApiKey', () => {
  it('uses the SDK login flow so the key is stored persistently', async () => {
    let storedKey: string | undefined;
    const login = vi.fn(async (_providerId, _type, interaction) => {
      storedKey = await interaction.prompt({ type: 'secret', message: 'API key' });
      return { type: 'api_key' as const, key: storedKey };
    });

    await persistProviderApiKey({ login }, 'openai', 'sk-test');

    expect(login).toHaveBeenCalledWith(
      'openai',
      'api_key',
      expect.objectContaining({
        prompt: expect.any(Function),
        notify: expect.any(Function),
      })
    );
    expect(storedKey).toBe('sk-test');
  });

  it('does not feed an API key into multi-step provider prompts', async () => {
    const login = vi.fn(async (_providerId, _type, interaction) => {
      await interaction.prompt({ type: 'text', message: 'Account ID' });
      return { type: 'api_key' as const };
    });

    await expect(persistProviderApiKey({ login }, 'cloudflare', 'sk-test')).rejects.toThrow(
      'interactive login flow'
    );
  });
});
