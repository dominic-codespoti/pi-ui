import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Provider,
} from '@earendil-works/pi-ai';
import { loginProvider, type ProviderLoginOptions } from './provider-login.ts';

type Runtime = ProviderLoginOptions['runtime'];
type PromptPayload = Omit<AuthPrompt, 'signal'>;
type Send = (message: Record<string, unknown>) => void;
type PendingPrompt = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

export interface StartProviderLoginOptions {
  socketSend: Send;
  socketOwner?: object;
  runtime: Runtime;
  provider?: string;
  authType?: AuthType;
  sessionId?: string;
  onlyUnconfigured?: boolean;
  isConfigured?: (providerId: string) => boolean;
  selectProvider?: ProviderLoginOptions['selectProvider'];
  selectAuthType?: ProviderLoginOptions['selectAuthType'];
  mutate: ProviderLoginOptions['mutate'];
  providerName?: string;
  onTerminal?: (
    status: 'succeeded' | 'failed' | 'cancelled',
    providerId?: string
  ) => void | Promise<void>;
}

interface LoginRecord {
  loginId: string;
  providerKey: string;
  controller: AbortController;
  prompts: Map<string, PendingPrompt>;
  socketOwner?: object;
}

const MAX_CONCURRENT_LOGINS = 4;
const activeLogins = new Map<string, LoginRecord>();
const activeProviders = new Map<string, string>();

export function cancelProviderLoginsForSocket(socketOwner: object): void {
  for (const record of activeLogins.values()) {
    if (record.socketOwner === socketOwner) record.controller.abort();
  }
}

export function respondToProviderLoginPrompt(
  loginId: string,
  promptId: string,
  value?: string,
  cancelled?: boolean
): boolean {
  const record = activeLogins.get(loginId);
  const pending = record?.prompts.get(promptId);
  if (!record || !pending) return false;
  record.prompts.delete(promptId);
  pending.cleanup();
  if (cancelled || value === undefined) pending.reject(new Error('Login cancelled'));
  else pending.resolve(value);
  return true;
}

export function cancelProviderLogin(loginId: string): boolean {
  const record = activeLogins.get(loginId);
  if (!record) return false;
  record.controller.abort();
  return true;
}

export function startProviderLogin(options: StartProviderLoginOptions): {
  loginId: string;
  started: boolean;
  error?: string;
} {
  const loginId = crypto.randomUUID();
  const providerRef = options.provider?.trim();
  const resolvedProvider = providerRef
    ? options.runtime
        .getProviders()
        .find(
          (provider) =>
            provider.id.toLowerCase() === providerRef.toLowerCase() ||
            provider.name.toLowerCase() === providerRef.toLowerCase()
        )
    : undefined;
  const providerKey = resolvedProvider?.id.toLowerCase() ?? providerRef?.toLowerCase() ?? '*';
  if (activeLogins.size >= MAX_CONCURRENT_LOGINS) {
    const error = 'Too many provider logins are already in progress.';
    options.socketSend({
      type: 'provider_login_state',
      loginId,
      provider: options.provider ?? '',
      providerName: options.providerName ?? options.provider ?? '',
      authType: options.authType ?? 'oauth',
      status: 'failed',
      error,
    });
    return { loginId, started: false, error };
  }
  if (providerRef && activeProviders.has(providerKey)) {
    const error = `A login for ${options.provider} is already in progress.`;
    options.socketSend({
      type: 'provider_login_state',
      loginId,
      provider: resolvedProvider?.id ?? providerRef,
      providerName: resolvedProvider?.name ?? options.providerName ?? providerRef,
      authType: options.authType ?? 'oauth',
      status: 'failed',
      error,
    });
    return { loginId, started: false, error };
  }

  const record: LoginRecord = {
    loginId,
    providerKey,
    controller: new AbortController(),
    prompts: new Map(),
    socketOwner: options.socketOwner,
  };
  activeLogins.set(loginId, record);
  if (providerRef) activeProviders.set(providerKey, loginId);
  let currentProvider = resolvedProvider?.id ?? options.provider;
  let currentProviderName =
    options.providerName ?? resolvedProvider?.name ?? options.provider ?? '';
  let currentAuthType = options.authType ?? (resolvedProvider?.auth.oauth ? 'oauth' : 'api_key');
  const sendState = (status: 'started' | 'succeeded' | 'failed' | 'cancelled', error?: string) => {
    options.socketSend({
      type: 'provider_login_state',
      loginId,
      provider: currentProvider ?? '',
      providerName: currentProviderName,
      authType: currentAuthType,
      status,
      ...(error ? { error } : {}),
    });
  };
  const interaction: AuthInteraction = {
    signal: record.controller.signal,
    prompt: (prompt) =>
      new Promise<string>((resolve, reject) => {
        if (record.controller.signal.aborted || prompt.signal?.aborted) {
          reject(new Error('Login cancelled'));
          return;
        }
        const promptId = crypto.randomUUID();
        let settled = false;
        const settleReject = (error: Error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        };
        const cleanup = () => {
          prompt.signal?.removeEventListener('abort', onAbort);
          record.controller.signal.removeEventListener('abort', onAbort);
        };
        const pending: PendingPrompt = {
          resolve: (value) => {
            if (!settled) {
              settled = true;
              resolve(value);
            }
          },
          reject: settleReject,
          cleanup,
        };
        const onAbort = () => {
          record.prompts.delete(promptId);
          pending.cleanup();
          options.socketSend({ type: 'provider_login_prompt_cancel', loginId, promptId });
          settleReject(new Error('Login cancelled'));
        };
        record.prompts.set(promptId, pending);
        prompt.signal?.addEventListener('abort', onAbort, { once: true });
        record.controller.signal.addEventListener('abort', onAbort, { once: true });
        let promptPayload: PromptPayload;
        if (prompt.type === 'select') {
          promptPayload = {
            type: prompt.type,
            message: prompt.message,
            options: prompt.options,
          } as PromptPayload;
        } else {
          promptPayload = {
            type: prompt.type,
            message: prompt.message,
            ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
          } as PromptPayload;
        }
        options.socketSend({
          type: 'provider_login_prompt',
          loginId,
          promptId,
          prompt: promptPayload,
        });
      }),
    notify: (event: AuthEvent) =>
      options.socketSend({ type: 'provider_login_event', loginId, event }),
  };
  const selectProvider =
    options.selectProvider ??
    (async (providers: readonly Provider[]) => {
      const choices = providers.map((candidate) => ({
        id: candidate.id,
        label: `${candidate.name} (${candidate.id})`,
      }));
      const selected = await interaction.prompt({
        type: 'select',
        message: 'Select a provider to log in',
        options: choices,
      });
      const candidate = providers.find((provider) => provider.id === selected);
      if (candidate) {
        const candidateKey = candidate.id.toLowerCase();
        const active = activeProviders.get(candidateKey);
        if (active && active !== loginId)
          throw new Error(`A login for ${candidate.id} is already in progress.`);
        activeProviders.set(candidateKey, loginId);
        currentProvider = candidate.id;
        currentProviderName = candidate.name;
        if (!options.authType) currentAuthType = candidate.auth.oauth ? 'oauth' : 'api_key';
        sendState('started');
      }
      return candidate;
    });
  const selectAuthType =
    options.selectAuthType ??
    (async (provider: Provider, choices: readonly { type: AuthType; label: string }[]) => {
      const selected = await interaction.prompt({
        type: 'select',
        message: `Select authentication method for ${provider.name}`,
        options: choices.map((choice) => ({ id: choice.type, label: choice.label })),
      });
      const choice = choices.find((candidate) => candidate.type === selected);
      if (choice) {
        currentAuthType = choice.type;
        sendState('started');
      }
      return choice?.type;
    });

  sendState('started');
  void (async () => {
    let status: 'succeeded' | 'failed' | 'cancelled' = 'failed';
    try {
      const provider = await loginProvider({
        ...options,
        selectProvider,
        selectAuthType,
        interaction,
      });
      currentProvider = provider.id;
      currentProviderName = provider.name;
      if (record.controller.signal.aborted) throw new Error('Login cancelled');
      status = 'succeeded';
      sendState(status);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      status =
        record.controller.signal.aborted || error === 'Login cancelled' ? 'cancelled' : 'failed';
      sendState(status, status === 'failed' ? error : undefined);
    } finally {
      for (const [promptId, pending] of record.prompts) {
        pending.cleanup();
        pending.reject(new Error('Login cancelled'));
        options.socketSend({ type: 'provider_login_prompt_cancel', loginId, promptId });
      }
      record.prompts.clear();
      activeLogins.delete(loginId);
      if (activeProviders.get(providerKey) === loginId) activeProviders.delete(providerKey);
      if (currentProvider && activeProviders.get(currentProvider.toLowerCase()) === loginId)
        activeProviders.delete(currentProvider.toLowerCase());
      await options.onTerminal?.(status, currentProvider);
    }
  })();
  return { loginId, started: true };
}
