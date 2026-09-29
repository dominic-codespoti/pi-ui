/**
 * Browser-side loader for trusted app-extension client modules.
 *
 * Each extension serves a versioned runtime ESM bundle (its `clientEntry`);
 * the view host loads it with a dynamic `import()` and mounts it into a
 * container element. This module stays dependency-free and server-import-free
 * so both the Svelte host and unit tests can use it.
 */
import type {
  AppExtensionClientApi,
  AppExtensionClientModule,
  AppExtensionScope,
} from './types.js';

/** Host-provided transport for operation calls, scoped to the active view. */
export type AppExtensionHostCall = (
  kind: 'read' | 'action',
  operationId: string,
  input: Record<string, unknown> | undefined,
  scope: AppExtensionScope,
  signal?: AbortSignal
) => Promise<unknown>;

/** Host-provided event subscription, scoped to the active view. */
export type AppExtensionHostSubscribe = (
  eventName: string,
  listener: (data: unknown) => void,
  scope: AppExtensionScope
) => () => void;

/** Host-provided chat prompt submission, scoped to the active view. */
export type AppExtensionHostPrompt = (
  text: string,
  scope: AppExtensionScope
) => Promise<void> | void;

/** Host-provided composer draft replacement, scoped to the active view. */
export type AppExtensionHostDraft = (
  text: string,
  scope: AppExtensionScope
) => Promise<void> | void;

/** Host-provided confirmation dialog. Resolves true on confirm, false on cancel/dismiss. */
export type AppExtensionHostConfirm = (
  options: { title?: string; message: string; confirmLabel?: string },
  scope: AppExtensionScope
) => Promise<boolean> | boolean;

/** Host-provided project file viewer for a project-relative path. */
export type AppExtensionHostOpenFile = (
  path: string,
  scope: AppExtensionScope
) => Promise<void> | void;

/** Host-provided chat session switch by session ID. */
export type AppExtensionHostSwitchSession = (
  sessionId: string,
  scope: AppExtensionScope
) => Promise<void> | void;

/** Host-provided toast/notice sink. */
export type AppExtensionHostNotify = (
  message: string,
  kind?: 'info' | 'success' | 'warning' | 'error'
) => void;

export interface BuildAppExtensionClientApiOptions {
  extensionId: string;
  scope: AppExtensionScope;
  call: AppExtensionHostCall;
  subscribe: AppExtensionHostSubscribe;
  notify?: AppExtensionHostNotify;
  prompt?: AppExtensionHostPrompt;
  draft?: AppExtensionHostDraft;
  confirm?: AppExtensionHostConfirm;
  openFile?: AppExtensionHostOpenFile;
  switchSession?: AppExtensionHostSwitchSession;
}

/** Own event subscriptions for one mounted extension view. */
export function trackAppExtensionSubscriptions(
  subscribe: AppExtensionHostSubscribe
): { subscribe: AppExtensionHostSubscribe; cleanup(): void } {
  const cleanups = new Set<() => void>();
  return {
    subscribe(eventName, listener, scope) {
      const unsubscribe = subscribe(eventName, listener, scope);
      let active = true;
      const cleanup = () => {
        if (!active) return;
        active = false;
        cleanups.delete(cleanup);
        unsubscribe();
      };
      cleanups.add(cleanup);
      return cleanup;
    },
    cleanup() {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // A failed extension cleanup must not block the remaining subscriptions.
        }
      }
      cleanups.clear();
    },
  };
}

/**
 * Pure shape check for a loaded client module. Accepts any value and reports
 * whether it exposes a callable `mount(root, api)` entry point.
 */
export function isAppExtensionClientModule(value: unknown): value is AppExtensionClientModule {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object' && typeof value !== 'function') return false;
  return typeof (value as { mount?: unknown }).mount === 'function';
}

/**
 * Load and validate a versioned runtime client module from its URL.
 * Throws a contained Error (import failure or missing `mount`) for the view
 * host to render instead of crashing the shell.
 */
export async function loadAppExtensionClientModule(
  clientUrl: string
): Promise<AppExtensionClientModule> {
  if (!clientUrl || clientUrl.trim().length === 0) {
    throw new Error('Extension client is unavailable (missing client URL).');
  }
  let loaded: unknown;
  try {
    loaded = await import(/* @vite-ignore */ clientUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load extension client from ${clientUrl}: ${detail}`, {
      cause: error,
    });
  }
  // Bundles may export mount directly or as the default export's mount.
  const fallback = (loaded as { default?: unknown } | null)?.default;
  const candidate = isAppExtensionClientModule(loaded) ? loaded : fallback;
  if (!isAppExtensionClientModule(candidate)) {
    throw new Error(
      `Extension client at ${clientUrl} does not export a mount(root, api) function.`
    );
  }
  return candidate;
}

/**
 * Validate a project-relative path: non-empty, forward-slash, no null bytes,
 * no absolute paths, and no `..`/empty/`.` segments.
 */
function assertProjectRelativePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty project-relative path.`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain null bytes.`);
  }
  if (value.includes('\\')) {
    throw new Error(`${label} must use forward slashes (backslashes are ambiguous).`);
  }
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    throw new Error(`${label} must be project-relative (got ${JSON.stringify(value)}).`);
  }
  for (const segment of value.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new Error(`${label} must not contain ".", "..", or empty segments.`);
    }
  }
}

/**
 * Build the client-facing bridge from host callbacks. `read` always issues a
 * `read`-kind call and `invoke` always issues an `action`-kind call, so an
 * extension cannot escalate a read into a side-effecting action.
 */
export function buildAppExtensionClientApi(
  options: BuildAppExtensionClientApiOptions
): AppExtensionClientApi {
  const { extensionId, scope, call, subscribe, notify, prompt, draft, confirm, openFile, switchSession } =
    options;
  const snapshot: AppExtensionScope = { ...scope };
  return {
    extensionId,
    scope: snapshot,
    read(
      operationId: string,
      input?: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ): Promise<unknown> {
      return options?.signal
        ? call('read', operationId, input, snapshot, options.signal)
        : call('read', operationId, input, snapshot);
    },
    invoke(
      operationId: string,
      input?: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ): Promise<unknown> {
      return options?.signal
        ? call('action', operationId, input, snapshot, options.signal)
        : call('action', operationId, input, snapshot);
    },
    subscribe(
      eventName: string,
      listener: (data: unknown) => void,
      subscriptionScope: AppExtensionScope = snapshot
    ): () => void {
      return subscribe(eventName, listener, subscriptionScope);
    },
    notify(message: string, kind?: 'info' | 'success' | 'warning' | 'error'): void {
      notify?.(message, kind);
    },
    async setComposerDraft(text: string): Promise<void> {
      if (typeof text !== 'string') {
        throw new Error('Composer draft must be a string.');
      }
      if (!draft) {
        throw new Error('Composer drafts are unavailable for this view.');
      }
      await draft(text, snapshot);
    },
    async confirm(options: { title?: string; message: string; confirmLabel?: string }): Promise<boolean> {
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error('Confirm options must be an object with a message.');
      }
      const { title, message, confirmLabel } = options;
      if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('Confirm message must be a non-empty string.');
      }
      if (title !== undefined && typeof title !== 'string') {
        throw new Error('Confirm title must be a string.');
      }
      if (confirmLabel !== undefined && typeof confirmLabel !== 'string') {
        throw new Error('Confirm label must be a string.');
      }
      if (!confirm) {
        throw new Error('Confirmation dialogs are unavailable for this view.');
      }
      return Boolean(
        await confirm(
          {
            ...(title !== undefined ? { title } : {}),
            message,
            ...(confirmLabel !== undefined ? { confirmLabel } : {}),
          },
          snapshot
        )
      );
    },
    async openFile(path: string): Promise<void> {
      assertProjectRelativePath(path, 'File path');
      if (!openFile) {
        throw new Error('File viewing is unavailable for this view.');
      }
      await openFile(path, snapshot);
    },
    async switchSession(sessionId: string): Promise<void> {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('Session ID must be a non-empty string.');
      }
      if (!switchSession) {
        throw new Error('Session switching is unavailable for this view.');
      }
      await switchSession(sessionId, snapshot);
    },
    async prompt(text: string): Promise<void> {
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('Prompt text must be a non-empty string.');
      }
      if (!prompt) {
        throw new Error('Chat prompts are unavailable for this view.');
      }
      await prompt(text, snapshot);
    },
  };
}

/** Result of `AppExtensionClientModule.mount` — plain cleanup, unmount object, or nothing. */
export type AppExtensionClientCleanup = void | (() => void) | { unmount(): void };

/**
 * Invoke a mount cleanup (returned function or `{ unmount }`), swallowing
 * teardown errors so prop changes / destroy never crash the shell.
 */
export function teardownAppExtensionClient(cleanup: unknown): void {
  try {
    if (typeof cleanup === 'function') {
      (cleanup as () => void)();
    } else if (
      cleanup !== null &&
      cleanup !== undefined &&
      typeof (cleanup as { unmount?: unknown }).unmount === 'function'
    ) {
      (cleanup as { unmount(): void }).unmount();
    }
  } catch {
    /* teardown is best-effort — the host container is discarded regardless */
  }
}
