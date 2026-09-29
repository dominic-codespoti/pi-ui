import {
  isAppExtensionServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '#lib/ws/protocol.js';
import type { AppExtensionScope, AppExtensionSummary } from './types.js';

export type AppExtensionCallKind = 'read' | 'action';
export type AppExtensionCall = (
  kind: AppExtensionCallKind,
  extensionId: string,
  operationId: string,
  input: Record<string, unknown> | undefined,
  scope: AppExtensionScope,
  signal?: AbortSignal
) => Promise<unknown>;

export type AppExtensionSender = (message: ClientMessage) => boolean | void;
export type AppExtensionEventListener = (data: unknown) => void;
export type AppExtensionToggleResult = {
  extensionId: string;
  enabled: boolean;
  ok: boolean;
  error?: string;
};
export type AppExtensionReloadResult = {
  extensionId: string;
  ok: boolean;
  error?: string;
};

type PendingCall = {
  extensionId: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

type EventSubscription = {
  subscriptionId: string;
  extensionId: string;
  eventName: string;
  scope: AppExtensionScope;
  listener: AppExtensionEventListener;
};

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Request/response and event adapter for app-extension WebSocket messages.
 * Scope is always supplied by the caller; this class never consults session
 * focus or selection state.
 */
export class AppExtensionTransport {
  private readonly pending = new Map<string, PendingCall>();
  private readonly extensionListeners = new Set<(extensions: AppExtensionSummary[]) => void>();
  private readonly toggleListeners = new Set<(result: AppExtensionToggleResult) => void>();
  private readonly reloadListeners = new Set<(result: AppExtensionReloadResult) => void>();
  private readonly eventSubscriptions = new Set<EventSubscription>();
  private nextId = 0;

  constructor(
    private readonly sendMessage: AppExtensionSender,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  requestExtensions(): boolean {
    const sent = this.sendMessage({ type: 'get_app_extensions' }) !== false;
    if (sent) {
      // Subscriptions are socket-scoped on the server and must be restored after reconnect.
      for (const subscription of this.eventSubscriptions) {
        this.sendMessage({
          type: 'app_extension_subscribe',
          subscriptionId: subscription.subscriptionId,
          extensionId: subscription.extensionId,
          eventName: subscription.eventName,
          scope: subscription.scope,
        });
      }
    }
    return sent;
  }

  setEnabled(extensionId: string, enabled: boolean): boolean {
    return this.sendMessage({ type: 'set_app_extension_enabled', extensionId, enabled }) !== false;
  }

  /**
   * Ask the host to re-import this extension's server entry in place. Kept separate from
   * setEnabled because re-running a server entry only makes sense for code the user already
   * chose to trust.
   */
  reload(extensionId: string): boolean {
    return this.sendMessage({ type: 'reload_app_extension', extensionId }) !== false;
  }

  onExtensions(listener: (extensions: AppExtensionSummary[]) => void): () => void {
    this.extensionListeners.add(listener);
    return () => this.extensionListeners.delete(listener);
  }

  onToggleResult(listener: (result: AppExtensionToggleResult) => void): () => void {
    this.toggleListeners.add(listener);
    return () => this.toggleListeners.delete(listener);
  }

  onReloadResult(listener: (result: AppExtensionReloadResult) => void): () => void {
    this.reloadListeners.add(listener);
    return () => this.reloadListeners.delete(listener);
  }

  call: AppExtensionCall = (kind, extensionId, operationId, input, scope, signal) => {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
      return Promise.reject(new Error('An explicit app-extension scope is required.'));
    }
    const callId = `app-${Date.now().toString(36)}-${(++this.nextId).toString(36)}`;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const timer = setTimeout(() => {
        const pending = this.pending.get(callId);
        if (!pending) return;
        this.sendMessage({ type: 'app_extension_cancel', callId });
        this.finishPending(callId);
        pending.reject(new Error('App extension call timed out.'));
      }, this.timeoutMs);
      this.pending.set(callId, {
        extensionId,
        resolve,
        reject,
        timer,
        ...(signal ? { signal } : {}),
      });
      const sent = this.sendMessage({
        type: 'app_extension_call',
        callId,
        extensionId,
        operationId,
        kind,
        ...(input === undefined ? {} : { input }),
        scope,
      });
      if (sent === false) {
        this.finishPending(callId);
        reject(new Error('App extension call could not be sent.'));
        return;
      }
      if (signal) {
        const pending = this.pending.get(callId);
        if (!pending) return;
        const onAbort = () => {
          if (!this.pending.has(callId)) return;
          this.sendMessage({ type: 'app_extension_cancel', callId });
          this.finishPending(callId);
          pending.reject(abortError(signal));
        };
        pending.abortHandler = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
        // Cover aborts between the initial check and listener registration.
        if (signal.aborted) onAbort();
      }
    });
  };

  subscribe(
    extensionId: string,
    eventName: string,
    listener: AppExtensionEventListener,
    scope: AppExtensionScope = {}
  ): () => void {
    const subscriptionId = `app-sub-${Date.now().toString(36)}-${(++this.nextId).toString(36)}`;
    const subscription = { subscriptionId, extensionId, eventName, listener, scope: { ...scope } };
    this.eventSubscriptions.add(subscription);
    this.sendMessage({
      type: 'app_extension_subscribe',
      subscriptionId,
      extensionId,
      eventName,
      scope: subscription.scope,
    });
    return () => {
      if (!this.eventSubscriptions.delete(subscription)) return;
      this.sendMessage({ type: 'app_extension_unsubscribe', subscriptionId });
    };
  }

  /** Consume app-level server frames; return false for all other message types. */
  handle(message: ServerMessage): boolean {
    if (!isAppExtensionServerMessage(message)) return false;
    switch (message.type) {
      case 'app_extensions_list':
        for (const listener of [...this.extensionListeners]) {
          try {
            listener(message.extensions);
          } catch (error) {
            console.error('[pi-ui] app extension catalog listener failed:', error);
          }
        }
        return true;
      case 'app_extension_result': {
        const pending = this.pending.get(message.callId);
        if (!pending || pending.extensionId !== message.extensionId) return true;
        this.finishPending(message.callId);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error || 'App extension call failed.'));
        return true;
      }
      case 'app_extension_subscription_result': {
        if (message.ok) return true;
        const subscription = [...this.eventSubscriptions].find(
          (item) =>
            item.subscriptionId === message.subscriptionId && item.extensionId === message.extensionId
        );
        if (subscription) this.eventSubscriptions.delete(subscription);
        console.error(
          `[pi-ui] app extension subscription rejected (${message.extensionId}): ${message.error ?? 'unknown error'}`
        );
        return true;
      }
      case 'app_extension_toggle_result':
        for (const listener of [...this.toggleListeners]) {
          try {
            listener({
              extensionId: message.extensionId,
              enabled: message.enabled,
              ok: message.ok,
              ...(message.error === undefined ? {} : { error: message.error }),
            });
          } catch (error) {
            console.error('[pi-ui] app extension toggle listener failed:', error);
          }
        }
        return true;
      case 'app_extension_reload_result':
        for (const listener of [...this.reloadListeners]) {
          try {
            listener({
              extensionId: message.extensionId,
              ok: message.ok,
              ...(message.error === undefined ? {} : { error: message.error }),
            });
          } catch (error) {
            console.error('[pi-ui] app extension reload listener failed:', error);
          }
        }
        return true;
      case 'app_extension_event':
        for (const subscription of [...this.eventSubscriptions]) {
          if (
            subscription.extensionId === message.extensionId &&
            subscription.eventName === message.eventName &&
            scopeMatches(subscription.scope, message.scope)
          ) {
            try {
              subscription.listener(message.data);
            } catch (error) {
              console.error('[pi-ui] app extension event listener failed:', error);
            }
          }
        }
        return true;
      default:
        return false;
    }
  }

  failPending(reason = 'Connection closed.') {
    for (const [callId, pending] of this.pending) {
      this.finishPending(callId);
      pending.reject(new Error(reason));
    }
  }

  dispose(reason = 'Connection closed.') {
    this.failPending(reason);
    for (const subscription of this.eventSubscriptions) {
      this.sendMessage({ type: 'app_extension_unsubscribe', subscriptionId: subscription.subscriptionId });
    }
    this.eventSubscriptions.clear();
    this.extensionListeners.clear();
    this.toggleListeners.clear();
    this.reloadListeners.clear();
  }

  private finishPending(callId: string): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
    }
    this.pending.delete(callId);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('App extension call was aborted.');
}

function isValidScopeValue(scope: unknown): scope is AppExtensionScope {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return false;
  const value = scope as Record<string, unknown>;
  return (
    (value.projectId === undefined || (typeof value.projectId === 'string' && value.projectId.length > 0)) &&
    (value.sessionId === undefined || (typeof value.sessionId === 'string' && value.sessionId.length > 0))
  );
}

function scopeMatches(
  subscription: AppExtensionScope,
  event: AppExtensionScope | undefined
): boolean {
  const rawEventScope: unknown = event;
  if (
    rawEventScope !== undefined &&
    (rawEventScope === null || typeof rawEventScope !== 'object' || Array.isArray(rawEventScope))
  ) {
    return false;
  }
  const eventScope = (rawEventScope ?? {}) as AppExtensionScope;
  if (
    !isValidScopeValue(subscription) ||
    !isValidScopeValue(eventScope)
  ) {
    return false;
  }
  // Global listeners only receive global events. A session-only subscription
  // matches that exact session after the server adds its canonical project cwd.
  if (subscription.projectId === undefined && subscription.sessionId === undefined) {
    return eventScope.projectId === undefined && eventScope.sessionId === undefined;
  }
  if (subscription.projectId === undefined && subscription.sessionId !== undefined) {
    return subscription.sessionId === eventScope.sessionId;
  }
  return (
    subscription.projectId === eventScope.projectId &&
    subscription.sessionId === eventScope.sessionId
  );
}
