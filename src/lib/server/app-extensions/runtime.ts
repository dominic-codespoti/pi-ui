/**
 * In-memory runtime for trusted app-level extensions.
 *
 * SERVER-ONLY: pure TypeScript with no filesystem, Bun server, or Pi SDK
 * dependencies so it stays trivially unit-testable. Persistence (install
 * records), code loading, and transport (WS handlers, agent tools) live in
 * sibling/adapter layers — this module only owns the registry, dispatch,
 * and scoped events.
 *
 * Bounding note: results and error messages pass through unchanged. Size
 * caps/truncation belong at the transport edge (WS adapter), which knows the
 * wire budget — truncating here could corrupt structured handler results.
 */

import {
  APP_EXTENSION_API_VERSION,
  APP_EXTENSION_CAPABILITIES,
  APP_EXTENSION_SLOTS,
  type AppExtensionCallContext,
  type AppExtensionEvent,
  type AppExtensionManifest,
  type AppExtensionOperationDeclaration,
  type AppExtensionScope,
  type AppExtensionSummary,
} from '../../app-extensions/types.ts';

export type AppExtensionErrorCode =
  | 'invalid-manifest'
  | 'duplicate'
  | 'not-registered'
  | 'disabled'
  | 'unknown-operation'
  | 'wrong-kind';

export class AppExtensionError extends Error {
  readonly code: AppExtensionErrorCode;
  constructor(code: AppExtensionErrorCode, message: string) {
    super(message);
    this.name = 'AppExtensionError';
    this.code = code;
  }
}

/** Read handlers must be side-effect free; action handlers may mutate. */
export type AppExtensionReadHandler = (
  input: Record<string, unknown>,
  ctx: AppExtensionCallContext,
) => unknown | Promise<unknown>;

export type AppExtensionActionHandler = (
  input: Record<string, unknown>,
  ctx: AppExtensionCallContext,
) => unknown | Promise<unknown>;

export interface AppExtensionHandlerMaps {
  reads?: Record<string, AppExtensionReadHandler>;
  actions?: Record<string, AppExtensionActionHandler>;
}

export interface AppExtensionRegisterOptions {
  /** Registration implies enabled unless explicitly set false. */
  enabled?: boolean;
}

export type AppExtensionEventListener = (event: AppExtensionEvent) => void;

const DEFAULT_CALL_CONTEXT: AppExtensionCallContext = {
  scope: {},
  caller: { kind: 'ui' },
};

interface Registration {
  manifest: AppExtensionManifest;
  reads: Map<string, AppExtensionReadHandler>;
  actions: Map<string, AppExtensionActionHandler>;
  declarations: Map<string, AppExtensionOperationDeclaration>;
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Throw on any malformed manifest so bad packages fail fast at install. */
export function validateAppExtensionManifest(manifest: AppExtensionManifest): void {
  if (!isRecord(manifest)) {
    throw new AppExtensionError('invalid-manifest', 'extension manifest must be an object');
  }
  if (manifest.schemaVersion !== 1) {
    throw new AppExtensionError(
      'invalid-manifest',
      `unsupported manifest schemaVersion (expected 1, got ${String(manifest.schemaVersion)})`,
    );
  }
  if (manifest.apiVersion !== APP_EXTENSION_API_VERSION) {
    throw new AppExtensionError(
      'invalid-manifest',
      `unsupported manifest apiVersion (expected ${APP_EXTENSION_API_VERSION}, got ${String(manifest.apiVersion)})`,
    );
  }
  if (!nonEmpty(manifest.id) || !nonEmpty(manifest.name) || !nonEmpty(manifest.version)) {
    throw new AppExtensionError(
      'invalid-manifest',
      'extension manifest requires non-empty id, name, and version',
    );
  }
  if (!nonEmpty(manifest.clientEntry) || !nonEmpty(manifest.serverEntry)) {
    throw new AppExtensionError(
      'invalid-manifest',
      `extension "${manifest.id}": clientEntry and serverEntry must be non-empty paths`,
    );
  }
  if (!Array.isArray(manifest.views) || !Array.isArray(manifest.operations)) {
    throw new AppExtensionError(
      'invalid-manifest',
      `extension "${manifest.id}": views and operations must be arrays`,
    );
  }
  const seenViews = new Set<string>();
  for (const view of manifest.views) {
    if (
      !isRecord(view) ||
      !nonEmpty(view.id) ||
      !nonEmpty(view.title) ||
      !(APP_EXTENSION_SLOTS as readonly unknown[]).includes(view.slot)
    ) {
      throw new AppExtensionError(
        'invalid-manifest',
        `extension "${manifest.id}": view "${String((view as unknown as Record<string, unknown>)?.id ?? '?')}" needs an id, title, and valid slot`,
      );
    }
    if (seenViews.has(view.id)) {
      throw new AppExtensionError(
        'invalid-manifest',
        `extension "${manifest.id}": duplicate view id "${view.id}"`,
      );
    }
    seenViews.add(view.id);
  }
  const seenOps = new Set<string>();
  for (const op of manifest.operations) {
    if (
      !isRecord(op) ||
      !nonEmpty(op.id) ||
      (op.kind !== 'read' && op.kind !== 'action') ||
      (op.scope !== undefined && !['app', 'project', 'session'].includes(op.scope)) ||
      !nonEmpty(op.description)
    ) {
      throw new AppExtensionError(
        'invalid-manifest',
        `extension "${manifest.id}": each operation needs an id, kind ('read' | 'action'), and description`,
      );
    }
    if (seenOps.has(op.id)) {
      throw new AppExtensionError(
        'invalid-manifest',
        `extension "${manifest.id}": duplicate operation id "${op.id}"`,
      );
    }
    seenOps.add(op.id);
  }
  if (manifest.capabilities !== undefined) {
    if (
      !Array.isArray(manifest.capabilities) ||
      manifest.capabilities.some(
        (capability) =>
          !(APP_EXTENSION_CAPABILITIES as readonly unknown[]).includes(capability)
      ) ||
      new Set(manifest.capabilities).size !== manifest.capabilities.length
    ) {
      throw new AppExtensionError(
        'invalid-manifest',
        `extension "${manifest.id}": capabilities must be unique known values (${APP_EXTENSION_CAPABILITIES.join(', ')})`
      );
    }
  }
}

/**
 * Verify handler maps against the manifest: every declared operation needs a
 * handler of the matching kind, and undeclared/duplicate handlers are
 * rejected rather than silently ignored.
 */
function bindHandlers(
  manifest: AppExtensionManifest,
  handlers: AppExtensionHandlerMaps | undefined,
): Pick<Registration, 'reads' | 'actions' | 'declarations'> {
  const declarations = new Map<string, AppExtensionOperationDeclaration>();
  for (const op of manifest.operations) declarations.set(op.id, op);

  const reads = new Map<string, AppExtensionReadHandler>();
  const actions = new Map<string, AppExtensionActionHandler>();
  const readHandlers = handlers?.reads ?? {};
  const actionHandlers = handlers?.actions ?? {};
  if (!isRecord(readHandlers) || !isRecord(actionHandlers)) {
    throw new AppExtensionError(
      'invalid-manifest',
      `extension "${manifest.id}": reads/actions handler maps must be objects`,
    );
  }

  for (const [id, fn] of Object.entries(readHandlers)) {
    const decl = declarations.get(id);
    if (!decl) {
      throw new AppExtensionError(
        'invalid-manifest',
        `extension "${manifest.id}": read handler "${id}" has no matching manifest operation`,
      );
    }
    if (decl.kind !== 'read') {
      throw new AppExtensionError(
        'invalid-manifest',
        `extension "${manifest.id}": handler "${id}" registered as read but manifest declares kind "${decl.kind}"`,
      );
    }
    if (typeof fn !== 'function') {
      throw new AppExtensionError(
        'invalid-manifest',
        `extension "${manifest.id}": read handler "${id}" is not a function`,
      );
    }
    reads.set(id, fn);
  }

  for (const [id, fn] of Object.entries(actionHandlers)) {
    const decl = declarations.get(id);
    if (!decl) {
      throw new AppExtensionError(
        'invalid-manifest',
        `extension "${manifest.id}": action handler "${id}" has no matching manifest operation`,
      );
    }
    if (decl.kind !== 'action') {
      throw new AppExtensionError(
        'invalid-manifest',
        `extension "${manifest.id}": handler "${id}" registered as action but manifest declares kind "${decl.kind}"`,
      );
    }
    if (typeof fn !== 'function') {
      throw new AppExtensionError(
        'invalid-manifest',
        `extension "${manifest.id}": action handler "${id}" is not a function`,
      );
    }
    actions.set(id, fn);
  }

  const missing = manifest.operations
    .filter((op) => (op.kind === 'read' ? !reads.has(op.id) : !actions.has(op.id)))
    .map((op) => `${op.kind}:${op.id}`);
  if (missing.length > 0) {
    throw new AppExtensionError(
      'invalid-manifest',
      `extension "${manifest.id}": missing handlers for ${missing.join(', ')}`,
    );
  }

  return { reads, actions, declarations };
}

export class AppExtensionRuntime {
  private readonly extensions = new Map<string, Registration>();
  private readonly listeners = new Map<string, Map<string, Set<AppExtensionEventListener>>>();

  /** Register a validated manifest with its handlers. Throws on duplicates. */
  register(
    manifest: AppExtensionManifest,
    handlers?: AppExtensionHandlerMaps,
    opts?: AppExtensionRegisterOptions,
  ): AppExtensionSummary {
    validateAppExtensionManifest(manifest);
    if (this.extensions.has(manifest.id)) {
      throw new AppExtensionError(
        'duplicate',
        `extension "${manifest.id}" is already registered`,
      );
    }
    const bound = bindHandlers(manifest, handlers);
    this.extensions.set(manifest.id, {
      manifest: structuredClone(manifest),
      ...bound,
      enabled: opts?.enabled ?? true,
    });
    return this.summaryOf(manifest.id);
  }

  /** Remove an extension and drop its event listeners. Returns false when unknown. */
  unregister(extensionId: string): boolean {
    this.listeners.delete(extensionId);
    return this.extensions.delete(extensionId);
  }

  enable(extensionId: string): void {
    this.requireRegistration(extensionId).enabled = true;
  }

  disable(extensionId: string): void {
    this.requireRegistration(extensionId).enabled = false;
  }

  /** Summaries for the extension list UI (enabled flag included). */
  list(): AppExtensionSummary[] {
    return [...this.extensions.keys()].map((id) => this.summaryOf(id));
  }

  get(extensionId: string): AppExtensionSummary | undefined {
    if (!this.extensions.has(extensionId)) return undefined;
    return this.summaryOf(extensionId);
  }

  /** Declared operations (copies) — used by adapters registering agent tools. */
  operations(extensionId: string): AppExtensionOperationDeclaration[] {
    const reg = this.requireRegistration(extensionId);
    return [...reg.declarations.values()].map((op) => ({ ...op }));
  }

  /**
   * Dispatch a side-effect-free read. Rejects unknown/disabled extensions,
   * unknown operations, and action-kind operations.
   */
  async read(
    extensionId: string,
    operationId: string,
    input?: Record<string, unknown>,
    ctx?: AppExtensionCallContext,
  ): Promise<unknown> {
    const reg = this.requireEnabled(extensionId);
    const decl = reg.declarations.get(operationId);
    if (!decl) {
      throw new AppExtensionError(
        'unknown-operation',
        `extension "${extensionId}": unknown operation "${operationId}"`,
      );
    }
    if (decl.kind !== 'read') {
      throw new AppExtensionError(
        'wrong-kind',
        `extension "${extensionId}": operation "${operationId}" is an action, use invoke()`,
      );
    }
    // Context passes through unchanged — this layer never invents
    // cwd/session focus; adapters supply scope and caller.
    return await reg.reads.get(operationId)?.(input ?? {}, ctx ?? DEFAULT_CALL_CONTEXT);
  }

  /**
   * Single entry point for actions, shared by every adapter (UI bridge,
   * WS handler, agent tools): caller kind travels inside ctx, never as a
   * separate dispatch path.
   */
  async invoke(
    extensionId: string,
    operationId: string,
    input?: Record<string, unknown>,
    ctx?: AppExtensionCallContext,
  ): Promise<unknown> {
    const reg = this.requireEnabled(extensionId);
    const decl = reg.declarations.get(operationId);
    if (!decl) {
      throw new AppExtensionError(
        'unknown-operation',
        `extension "${extensionId}": unknown operation "${operationId}"`,
      );
    }
    if (decl.kind !== 'action') {
      throw new AppExtensionError(
        'wrong-kind',
        `extension "${extensionId}": operation "${operationId}" is a read, use read()`,
      );
    }
    return await reg.actions.get(operationId)?.(input ?? {}, ctx ?? DEFAULT_CALL_CONTEXT);
  }

  /**
   * Emit a scoped event to subscribers of this extension. Scope travels with
   * the event so adapters can filter by project/session.
   */
  emit(extensionId: string, eventName: string, data?: unknown, scope?: AppExtensionScope): void {
    this.requireRegistration(extensionId);
    const byEvent = this.listeners.get(extensionId);
    const targets = byEvent?.get(eventName);
    if (!targets || targets.size === 0) return;
    const event: AppExtensionEvent = { extensionId, eventName, data, scope };
    let firstError: unknown;
    for (const listener of [...targets]) {
      try {
        listener(event);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  /** Subscribe to one extension's event; the returned fn unsubscribes. */
  subscribe(
    extensionId: string,
    eventName: string,
    listener: AppExtensionEventListener,
  ): () => void {
    this.requireRegistration(extensionId);
    let byEvent = this.listeners.get(extensionId);
    if (!byEvent) {
      byEvent = new Map();
      this.listeners.set(extensionId, byEvent);
    }
    let targets = byEvent.get(eventName);
    if (!targets) {
      targets = new Set();
      byEvent.set(eventName, targets);
    }
    targets.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      targets.delete(listener);
      if (targets.size === 0) byEvent.delete(eventName);
      if (byEvent.size === 0) this.listeners.delete(extensionId);
    };
  }

  /** Test/owner escape hatch: drop every registration and listener. */
  clear(): void {
    this.extensions.clear();
    this.listeners.clear();
  }

  private requireRegistration(extensionId: string): Registration {
    const reg = this.extensions.get(extensionId);
    if (!reg) {
      throw new AppExtensionError(
        'not-registered',
        `extension "${extensionId}" is not registered`,
      );
    }
    return reg;
  }

  private requireEnabled(extensionId: string): Registration {
    const reg = this.requireRegistration(extensionId);
    if (!reg.enabled) {
      throw new AppExtensionError('disabled', `extension "${extensionId}" is disabled`);
    }
    return reg;
  }

  private summaryOf(extensionId: string): AppExtensionSummary {
    const reg = this.requireRegistration(extensionId);
    const { id, name, version, description, views, capabilities } = reg.manifest;
    return {
      id,
      name,
      version,
      description,
      enabled: reg.enabled,
      views: views.map((v) => ({ ...v })),
      capabilities: [...(capabilities ?? [])],
    };
  }
}
