import type { AuthInteraction, AuthType, Provider } from '@earendil-works/pi-ai';

type Runtime = {
  getProviders(): readonly Provider[];
  login(providerId: string, authType: AuthType, interaction: AuthInteraction): Promise<unknown>;
};

export interface ProviderLoginOptions {
  runtime: Runtime;
  provider?: string;
  authType?: AuthType;
  onlyUnconfigured?: boolean;
  isConfigured?: (providerId: string) => boolean;
  selectProvider?: (providers: readonly Provider[]) => Promise<Provider | undefined>;
  selectAuthType?: (
    provider: Provider,
    choices: readonly { type: AuthType; label: string }[]
  ) => Promise<AuthType | undefined>;
  interaction: AuthInteraction;
  mutate: (providerId: string, operation: () => Promise<void>) => Promise<void>;
}

/** Resolve a provider and run its SDK-owned login flow using the caller's UI interaction. */
export async function loginProvider(options: ProviderLoginOptions): Promise<Provider> {
  const { runtime, interaction } = options;
  const providerRef = options.provider?.trim().toLowerCase();
  const loginCandidates = runtime.getProviders().filter((candidate) => {
    if (!candidate.auth.oauth && !candidate.auth.apiKey) return false;
    if (options.onlyUnconfigured && options.isConfigured?.(candidate.id)) return false;
    return (
      !providerRef ||
      candidate.id.toLowerCase() === providerRef ||
      candidate.name.toLowerCase() === providerRef
    );
  });
  if (loginCandidates.length === 0) {
    throw new Error(
      providerRef
        ? `Unknown provider or no login method: ${options.provider}`
        : 'All providers are already configured.'
    );
  }

  let provider = loginCandidates[0];
  if (!providerRef) {
    const selected = await options.selectProvider?.(loginCandidates);
    if (!selected) throw new Error('Login cancelled');
    provider = selected;
  }

  const authChoices: Array<{ type: AuthType; label: string }> = [];
  if (provider.auth.oauth) {
    authChoices.push({
      type: 'oauth',
      label: provider.auth.oauth.loginLabel ?? 'Sign in with account',
    });
  }
  if (provider.auth.apiKey) authChoices.push({ type: 'api_key', label: 'Sign in with API key' });
  const authType =
    options.authType ??
    (authChoices.length === 1
      ? authChoices[0].type
      : await options.selectAuthType?.(provider, authChoices));
  if (!authType || !authChoices.some((choice) => choice.type === authType)) {
    throw new Error('Login cancelled');
  }
  if (authType === 'api_key' && !provider.auth.apiKey?.login) {
    throw new Error(`${provider.name} is configured outside pi.`);
  }

  try {
    await runtime.login(provider.id, authType, interaction);
  } finally {
    // Interactive login may take minutes; queue only the post-login snapshot.
    await options.mutate(provider.id, async () => {});
  }
  return provider;
}
