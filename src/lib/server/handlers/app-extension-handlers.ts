import type {
  AppExtensionCallContext,
  AppExtensionExecutionContext,
  AppExtensionOperationDeclaration,
  AppExtensionScope,
  AppExtensionSummary,
} from '../../app-extensions/types.ts';
import type { ClientMessage, ProjectInfo } from '../../ws/protocol.ts';
import type { SessionFileInfo } from '../session-scan.ts';

export interface AppExtensionHandlerSocket {
  send(data: string): unknown;
}

const MAX_APP_EXTENSION_CALLS_PER_SOCKET = 32;
/** Sliding-window call budget per socket (abuse/loop guard, generous by design). */
const MAX_APP_EXTENSION_CALLS_PER_MINUTE_PER_SOCKET = 120;
const APP_EXTENSION_CALL_BUDGET_WINDOW_MS = 60_000;
const appExtensionCallBudgets = new WeakMap<object, { windowStart: number; count: number }>();
const MAX_APP_EXTENSION_SUBSCRIPTIONS_PER_SOCKET = 128;
const appExtensionCallsBySocket = new WeakMap<object, Map<string, AbortController>>();
const appExtensionSubscriptionsBySocket = new WeakMap<object, Map<string, AppExtensionEventSubscription>>();
const appExtensionSubscriptionSocketRefs = new Set<WeakRef<AppExtensionHandlerSocket>>();
const appExtensionSubscriptionRefsBySocket = new WeakMap<object, WeakRef<AppExtensionHandlerSocket>>();

type AppExtensionEventSubscription = {
  extensionId: string;
  eventName: string;
  scope: AppExtensionScope;
};

function removeAppExtensionSubscriptionsForSocket(socket: AppExtensionHandlerSocket): void {
  appExtensionSubscriptionsBySocket.delete(socket);
  const socketRef = appExtensionSubscriptionRefsBySocket.get(socket);
  if (socketRef) appExtensionSubscriptionSocketRefs.delete(socketRef);
  appExtensionSubscriptionRefsBySocket.delete(socket);
}

function* liveAppExtensionSubscriptions(): Generator<
  [AppExtensionHandlerSocket, Map<string, AppExtensionEventSubscription>]
> {
  for (const socketRef of appExtensionSubscriptionSocketRefs) {
    const socket = socketRef.deref();
    if (!socket) {
      appExtensionSubscriptionSocketRefs.delete(socketRef);
      continue;
    }
    const subscriptions = appExtensionSubscriptionsBySocket.get(socket);
    if (!subscriptions?.size) {
      removeAppExtensionSubscriptionsForSocket(socket);
      continue;
    }
    yield [socket, subscriptions];
  }
}

function purgeAppExtensionSubscriptionsForExtension(extensionId: string): void {
  for (const [socket, subscriptions] of liveAppExtensionSubscriptions()) {
    for (const [subscriptionId, subscription] of subscriptions) {
      if (subscription.extensionId === extensionId) subscriptions.delete(subscriptionId);
    }
    if (!subscriptions.size) removeAppExtensionSubscriptionsForSocket(socket);
  }
}

function pruneAppExtensionSubscriptions(
  dependencies: AppExtensionHandlerDependencies
): AppExtensionSummary[] | undefined {
  if (appExtensionSubscriptionSocketRefs.size === 0) return undefined;
  let summaries: AppExtensionSummary[];
  try {
    summaries = dependencies.runtime.list();
  } catch {
    return undefined;
  }
  const extensions = new Map(summaries.map((summary) => [summary.id, summary]));
  const declaredEvents = new Map<string, Set<string>>();

  for (const [socket, subscriptions] of liveAppExtensionSubscriptions()) {
    for (const [subscriptionId, subscription] of subscriptions) {
      const extension = extensions.get(subscription.extensionId);
      if (!extension?.enabled) {
        subscriptions.delete(subscriptionId);
        continue;
      }
      if (!dependencies.eventNames) continue;
      let names = declaredEvents.get(subscription.extensionId);
      if (!names) {
        try {
          names = new Set(dependencies.eventNames(subscription.extensionId));
        } catch {
          names = new Set();
        }
        declaredEvents.set(subscription.extensionId, names);
      }
      if (!names.has(subscription.eventName)) subscriptions.delete(subscriptionId);
    }
    if (!subscriptions.size) removeAppExtensionSubscriptionsForSocket(socket);
  }
  return summaries;
}

function appExtensionCallsFor(socket: AppExtensionHandlerSocket): Map<string, AbortController> {
  let calls = appExtensionCallsBySocket.get(socket);
  if (!calls) {
    calls = new Map();
    appExtensionCallsBySocket.set(socket, calls);
  }
  return calls;
}

/** Abort app operations owned by a socket when it disconnects. */
export function cancelAppExtensionCallsForSocket(socket: AppExtensionHandlerSocket): void {
  const calls = appExtensionCallsBySocket.get(socket);
  if (calls) {
    for (const controller of calls.values()) controller.abort(new Error('WebSocket closed.'));
    calls.clear();
    appExtensionCallsBySocket.delete(socket);
  }
  removeAppExtensionSubscriptionsForSocket(socket);
}

/** Return only sockets with an active subscription matching this event scope. */
export function appExtensionEventRecipients(
  extensionId: string,
  eventName: string,
  scope: AppExtensionScope
): AppExtensionHandlerSocket[] {
  const recipients: AppExtensionHandlerSocket[] = [];
  for (const [socket, subscriptions] of liveAppExtensionSubscriptions()) {
    if (
      [...subscriptions.values()].some(
        (subscription) =>
          subscription.extensionId === extensionId &&
          subscription.eventName === eventName &&
          subscription.scope.projectId === scope.projectId &&
          subscription.scope.sessionId === scope.sessionId
      )
    ) {
      recipients.push(socket);
    }
  }
  return recipients;
}

/** Narrow structural view of the app-extension runtime used by WS dispatch. */
export interface AppExtensionHandlerRuntime {
  list(): AppExtensionSummary[];
  operations(extensionId: string): AppExtensionOperationDeclaration[];
  read(
    extensionId: string,
    operationId: string,
    input: Record<string, unknown>,
    ctx: AppExtensionCallContext
  ): Promise<unknown>;
  invoke(
    extensionId: string,
    operationId: string,
    input: Record<string, unknown>,
    ctx: AppExtensionCallContext
  ): Promise<unknown>;
}

/** Narrow structural view of the project catalog (reads only). */
export interface AppExtensionHandlerProjectCatalog {
  list(): Promise<ProjectInfo[]>;
}

/** Narrow structural view of the session catalog (reads only). */
export interface AppExtensionHandlerSessionCatalog {
  list(): Promise<SessionFileInfo[]>;
}

export interface AppExtensionHandlerDependencies {
  runtime: AppExtensionHandlerRuntime;
  projectCatalog: AppExtensionHandlerProjectCatalog;
  sessionCatalog: AppExtensionHandlerSessionCatalog;
  /** Declared event names for an enabled extension. */
  eventNames?: (extensionId: string) => string[];
  /** Rescan installed candidates (package host). Runs before catalog reads when present. */
  refresh?: () => void | Promise<void>;
  /** Enable/disable via the package host (dynamic import on enable). Wired by the server. */
  setEnabled?: (extensionId: string, enabled: boolean) => void | Promise<void>;
  /** Re-import an enabled extension's server entry in place. Wired by the server. */
  reload?: (extensionId: string) => void | Promise<void>;
  /** Same-origin client bundle URL for an enabled extension, if available. */
  clientUrl?: (extensionId: string) => string | undefined;
  createExecutionContext?: (options: {
    extensionId: string;
    operationId: string;
    scope: AppExtensionScope;
    caller: AppExtensionCallContext['caller'];
    signal?: AbortSignal;
  }) => Promise<AppExtensionExecutionContext> | AppExtensionExecutionContext;
  logError?: (...args: unknown[]) => void;
}

/** Wire budget for a single operation result (JSON-encoded bytes). */
/** Wire budget for a single operation input (JSON-encoded bytes). */
export const APP_EXTENSION_INPUT_LIMIT_BYTES = 64 * 1024;
export const APP_EXTENSION_RESULT_LIMIT_BYTES = 128 * 1024;
/** Upper bound for error strings returned to the requester. */
export const APP_EXTENSION_ERROR_LIMIT_CHARS = 2000;

const TRUNCATION_MARKER = '…(truncated)';

function boundText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

function toErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message || String(err) : String(err);
  return boundText(raw, APP_EXTENSION_ERROR_LIMIT_CHARS);
}

function byteLength(json: string): number {
  return new TextEncoder().encode(json).length;
}

function hasId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface ResolvedScope {
  scope: AppExtensionScope;
  caller: AppExtensionCallContext['caller'];
}

async function resolveAppExtensionEventScope(
  scope: AppExtensionScope,
  dependencies: AppExtensionHandlerDependencies
): Promise<AppExtensionScope> {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('app-extension event subscription requires an explicit scope object');
  }
  if (scope.projectId !== undefined && !hasId(scope.projectId)) {
    throw new Error('invalid projectId in app-extension event scope');
  }
  if (scope.sessionId !== undefined && !hasId(scope.sessionId)) {
    throw new Error('invalid sessionId in app-extension event scope');
  }
  const projectId = hasId(scope.projectId) ? scope.projectId : undefined;
  const sessionId = hasId(scope.sessionId) ? scope.sessionId : undefined;
  if (projectId === undefined && sessionId === undefined) return {};

  const [projects, sessions] = await Promise.all([
    projectId === undefined ? Promise.resolve([]) : dependencies.projectCatalog.list(),
    sessionId === undefined ? Promise.resolve([]) : dependencies.sessionCatalog.list(),
  ]);
  const project = projectId === undefined ? undefined : projects.find((item) => item.cwd === projectId);
  if (projectId !== undefined && !project) throw new Error(`unknown project "${projectId}"`);

  if (sessionId !== undefined) {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error(`unknown session "${sessionId}"`);
    if (project && project.cwd !== session.cwd) {
      throw new Error(`session "${sessionId}" does not belong to project "${project.cwd}"`);
    }
    return { projectId: session.cwd, sessionId: session.id };
  }
  return project ? { projectId: project.cwd } : {};
}

function toCatalogExtensions(
  dependencies: AppExtensionHandlerDependencies,
  summaries = dependencies.runtime.list()
): AppExtensionSummary[] {
  return summaries.map((summary) => {
    if (!summary.enabled) return { ...summary };
    const url = dependencies.clientUrl?.(summary.id);
    return hasId(url) ? { ...summary, clientUrl: url } : { ...summary };
  });
}

/**
 * Enforce the operation's declared scope using catalog data only. Scope IDs
 * come exclusively from the frame — there is deliberately no focused/selected
 * session fallback here (unlike session-scoped messages elsewhere).
 */
export async function resolveAppExtensionScope(
  declared: AppExtensionOperationDeclaration,
  scope: AppExtensionScope,
  dependencies: AppExtensionHandlerDependencies,
  caller: AppExtensionCallContext['caller'] = { kind: 'ui' }
): Promise<ResolvedScope> {
  const mode = declared.scope ?? 'app';
  const projectId = hasId(scope.projectId) ? scope.projectId : undefined;
  const sessionId = hasId(scope.sessionId) ? scope.sessionId : undefined;

  if (mode === 'app') {
    // App-scoped operations receive no workspace/session scope. The UI sends its
    // ambient selection with every call; discard it rather than turning that
    // incidental selection into an app-operation failure or capability.
    return {
      scope: {},
      caller: caller.sessionId ? { kind: caller.kind, sessionId: caller.sessionId } : { kind: caller.kind },
    };
  }

  if (mode === 'project') {
    if (projectId === undefined) {
      throw new Error(`operation "${declared.id}" requires an explicit projectId`);
    }
    // Canonical cwd match only — arbitrary frame-supplied paths are rejected.
    const project = (await dependencies.projectCatalog.list()).find((p) => p.cwd === projectId);
    if (!project) {
      throw new Error(`unknown project "${projectId}"`);
    }
    if (sessionId === undefined) {
      return {
        scope: { projectId: project.cwd },
        caller: caller.sessionId
          ? { kind: caller.kind, sessionId: caller.sessionId }
          : { kind: caller.kind },
      };
    }
    const session = (await dependencies.sessionCatalog.list()).find((s) => s.id === sessionId);
    if (!session) {
      throw new Error(`unknown session "${sessionId}"`);
    }
    if (session.cwd !== project.cwd) {
      throw new Error(`session "${sessionId}" does not belong to project "${project.cwd}"`);
    }
    return {
      scope: { projectId: project.cwd, sessionId: session.id },
      caller: { kind: caller.kind, sessionId: session.id },
    };
  }

  // mode === 'session'
  if (sessionId === undefined) {
    throw new Error(`operation "${declared.id}" requires an explicit sessionId`);
  }
  const session = (await dependencies.sessionCatalog.list()).find((s) => s.id === sessionId);
  if (!session) {
    throw new Error(`unknown session "${sessionId}"`);
  }
  if (projectId !== undefined && projectId !== session.cwd) {
    throw new Error(`project "${projectId}" does not match session "${sessionId}"`);
  }
  return {
    scope: { projectId: session.cwd, sessionId: session.id },
    caller: { kind: caller.kind, sessionId: session.id },
  };
}

/**
 * Dispatch app-extension transport messages. Unknown messages return false so
 * the composition root can continue with its remaining protocol handlers.
 * All replies go to the requesting socket only — never broadcast.
 */
export async function dispatchAppExtensionMessage(
  message: ClientMessage,
  socket: AppExtensionHandlerSocket,
  dependencies: AppExtensionHandlerDependencies
): Promise<boolean> {
  switch (message.type) {
    case 'get_app_extensions': {
      try {
        await dependencies.refresh?.();
        const summaries = pruneAppExtensionSubscriptions(dependencies);
        const extensions = toCatalogExtensions(dependencies, summaries);
        socket.send(JSON.stringify({ type: 'app_extensions_list', extensions }));
      } catch (err) {
        dependencies.logError?.('[pifrontier] get_app_extensions error:', err);
        socket.send(JSON.stringify({ type: 'app_extensions_list', extensions: [] }));
      }
      return true;
    }

    case 'set_app_extension_enabled': {
      const { extensionId, enabled } = message;
      try {
        if (!dependencies.setEnabled) {
          throw new Error('app-extension enable/disable is not configured');
        }
        await dependencies.setEnabled(extensionId, enabled);
        if (!enabled) purgeAppExtensionSubscriptionsForExtension(extensionId);
        const summaries = pruneAppExtensionSubscriptions(dependencies);
        const extensions = toCatalogExtensions(dependencies, summaries);
        socket.send(JSON.stringify({ type: 'app_extensions_list', extensions }));
        socket.send(
          JSON.stringify({ type: 'app_extension_toggle_result', extensionId, enabled, ok: true })
        );
      } catch (err) {
        dependencies.logError?.('[pifrontier] set_app_extension_enabled error:', err);
        socket.send(
          JSON.stringify({
            type: 'app_extension_toggle_result',
            extensionId,
            enabled,
            ok: false,
            error: toErrorMessage(err),
          })
        );
      }
      return true;
    }

    case 'reload_app_extension': {
      const { extensionId } = message;
      try {
        if (!dependencies.reload) {
          throw new Error('app-extension reload is not configured');
        }
        // Re-scan first so a manifest edited on disk since the last catalog read is picked up.
        await dependencies.refresh?.();
        await dependencies.reload(extensionId);
        const summaries = pruneAppExtensionSubscriptions(dependencies);
        const extensions = toCatalogExtensions(dependencies, summaries);
        socket.send(JSON.stringify({ type: 'app_extensions_list', extensions }));
        socket.send(
          JSON.stringify({ type: 'app_extension_reload_result', extensionId, ok: true })
        );
      } catch (err) {
        dependencies.logError?.('[pifrontier] reload_app_extension error:', err);
        socket.send(
          JSON.stringify({
            type: 'app_extension_reload_result',
            extensionId,
            ok: false,
            error: toErrorMessage(err),
          })
        );
      }
      return true;
    }

    case 'app_extension_subscribe': {
      try {
        if (!hasId(message.subscriptionId) || message.subscriptionId.length > 128) {
          throw new Error('invalid app-extension subscriptionId');
        }
        if (!hasId(message.extensionId) || !hasId(message.eventName)) {
          throw new Error('app-extension subscription requires an extensionId and eventName');
        }
        const declaredEvents = dependencies.eventNames?.(message.extensionId) ?? [];
        if (!declaredEvents.includes(message.eventName)) {
          throw new Error(`unknown event "${message.eventName}" for extension "${message.extensionId}"`);
        }
        const existingSubscriptions = appExtensionSubscriptionsBySocket.get(socket);
        const subscriptions = existingSubscriptions ?? new Map();
        if (
          !subscriptions.has(message.subscriptionId) &&
          subscriptions.size >= MAX_APP_EXTENSION_SUBSCRIPTIONS_PER_SOCKET
        ) {
          throw new Error(`too many app-extension subscriptions (limit ${MAX_APP_EXTENSION_SUBSCRIPTIONS_PER_SOCKET})`);
        }
        const scope = await resolveAppExtensionEventScope(message.scope, dependencies);
        subscriptions.set(message.subscriptionId, {
          extensionId: message.extensionId,
          eventName: message.eventName,
          scope,
        });
        if (!existingSubscriptions) {
          const socketRef = new WeakRef(socket);
          appExtensionSubscriptionSocketRefs.add(socketRef);
          appExtensionSubscriptionRefsBySocket.set(socket, socketRef);
        }
        appExtensionSubscriptionsBySocket.set(socket, subscriptions);
        socket.send(
          JSON.stringify({
            type: 'app_extension_subscription_result',
            subscriptionId: message.subscriptionId,
            extensionId: message.extensionId,
            ok: true,
          })
        );
      } catch (err) {
        dependencies.logError?.('[pifrontier] app_extension_subscribe rejected:', err);
        socket.send(
          JSON.stringify({
            type: 'app_extension_subscription_result',
            subscriptionId: message.subscriptionId,
            extensionId: message.extensionId,
            ok: false,
            error: toErrorMessage(err),
          })
        );
      }
      return true;
    }

    case 'app_extension_unsubscribe': {
      const subscriptions = appExtensionSubscriptionsBySocket.get(socket);
      subscriptions?.delete(message.subscriptionId);
      if (subscriptions?.size === 0) removeAppExtensionSubscriptionsForSocket(socket);
      return true;
    }

    case 'app_extension_cancel': {
      appExtensionCallsBySocket.get(socket)?.get(message.callId)?.abort(
        new Error('App extension call cancelled by requester.')
      );
      return true;
    }

    case 'app_extension_call': {
      const { callId, extensionId, operationId } = message;
      const fail = (error: string): void => {
        socket.send(
          JSON.stringify({ type: 'app_extension_result', callId, extensionId, ok: false, error })
        );
      };
      const calls = appExtensionCallsFor(socket);
      if (calls.has(callId)) return true;
      if (calls.size >= MAX_APP_EXTENSION_CALLS_PER_SOCKET) {
        fail(`too many concurrent app-extension operations (limit ${MAX_APP_EXTENSION_CALLS_PER_SOCKET})`);
        return true;
      }
      const now = Date.now();
      let budget = appExtensionCallBudgets.get(socket);
      if (!budget || now - budget.windowStart >= APP_EXTENSION_CALL_BUDGET_WINDOW_MS) {
        budget = { windowStart: now, count: 0 };
        appExtensionCallBudgets.set(socket, budget);
      }
      budget.count += 1;
      if (budget.count > MAX_APP_EXTENSION_CALLS_PER_MINUTE_PER_SOCKET) {
        fail(
          `app-extension call rate exceeded (limit ${MAX_APP_EXTENSION_CALLS_PER_MINUTE_PER_SOCKET}/min per connection); slow down and retry.`
        );
        return true;
      }
      const controller = new AbortController();
      calls.set(callId, controller);
      try {
        const declared = dependencies.runtime
          .operations(extensionId)
          .find((op) => op.id === operationId);
        if (!declared) {
          fail(toErrorMessage(`extension "${extensionId}": unknown operation "${operationId}"`));
          return true;
        }
        if (message.kind !== declared.kind) {
          fail(
            toErrorMessage(
              `extension "${extensionId}": operation "${operationId}" is ` +
                `${declared.kind === 'read' ? 'a read' : 'an action'}, ` +
                `use ${declared.kind === 'read' ? 'read()' : 'invoke()'}`
            )
          );
          return true;
        }
        const resolved = await resolveAppExtensionScope(declared, message.scope ?? {}, dependencies);
        const ctx: AppExtensionCallContext = dependencies.createExecutionContext
          ? await dependencies.createExecutionContext({
              extensionId,
              operationId,
              scope: resolved.scope,
              caller: resolved.caller,
              signal: controller.signal,
            })
          : { scope: resolved.scope, caller: resolved.caller, signal: controller.signal };
        const rawInput = message.input ?? {};
        let inputBytes = 0;
        try {
          inputBytes = byteLength(JSON.stringify(rawInput) ?? 'null');
        } catch (err) {
          fail(
            toErrorMessage(
              `input is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`
            )
          );
          return true;
        }
        if (inputBytes > APP_EXTENSION_INPUT_LIMIT_BYTES) {
          fail(
            toErrorMessage(
              `input exceeds 64 KiB limit (${inputBytes} bytes JSON-encoded); narrow the operation input`
            )
          );
          return true;
        }
        const input = rawInput;
        const result =
          declared.kind === 'read'
            ? await dependencies.runtime.read(extensionId, operationId, input, ctx)
            : await dependencies.runtime.invoke(extensionId, operationId, input, ctx);
        let encoded: string;
        try {
          encoded = JSON.stringify(result) ?? 'null';
        } catch (err) {
          fail(
            toErrorMessage(
              `result is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`
            )
          );
          return true;
        }
        const bytes = byteLength(encoded);
        if (bytes > APP_EXTENSION_RESULT_LIMIT_BYTES) {
          fail(
            toErrorMessage(
              `result exceeds 128 KiB limit (${bytes} bytes JSON-encoded); narrow the operation input`
            )
          );
          return true;
        }
        socket.send(
          JSON.stringify({ type: 'app_extension_result', callId, extensionId, ok: true, result })
        );
      } catch (err) {
        dependencies.logError?.('[pifrontier] app_extension_call error:', err);
        fail(toErrorMessage(err));
      } finally {
        if (calls.get(callId) === controller) calls.delete(callId);
        if (calls.size === 0) appExtensionCallsBySocket.delete(socket);
      }
      return true;
    }

    default:
      return false;
  }
}
