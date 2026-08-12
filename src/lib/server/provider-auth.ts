import type { AgentSession } from '@earendil-works/pi-coding-agent';

type ProviderRuntime = Pick<AgentSession['modelRuntime'], 'login'>;

/**
 * Store a user-supplied provider API key through the SDK's persistent login
 * flow. Runtime overrides are intentionally ephemeral and disappear when the
 * server/session runtime is recreated.
 */
export async function persistProviderApiKey(
  runtime: ProviderRuntime,
  providerId: string,
  apiKey: string
): Promise<void> {
  await runtime.login(providerId, 'api_key', {
    prompt: async (prompt) => {
      if (prompt.type !== 'secret') {
        throw new Error(
          `Provider "${providerId}" requires an interactive login flow. Use /login ${providerId}.`
        );
      }
      return apiKey;
    },
    notify: () => {},
  });
}
