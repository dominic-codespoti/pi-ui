import type { TerminalInputHandler } from '@earendil-works/pi-coding-agent';
import type { AutocompleteProvider } from '@earendil-works/pi-tui';
import type { ExtensionUiStatePayload, ServerMessage, WidgetPayload } from '../../ws/protocol.ts';

import { WIDGET_REFRESH_MS, type ParsedComponent, type StubTui } from '../../tui-stubs.ts';

export type RuntimeTimer = number | Timer;

export interface PendingRequest {
  requestPayload: Record<string, unknown>;
  resolve: (response: Record<string, unknown>) => void;
  timeoutId?: RuntimeTimer;
}

type DisposableComponent = Record<string, unknown> & {
  dispose?: () => void;
};

export interface ActiveCustomDialog {
  root: DisposableComponent;
  nodeMap: Map<string, Record<string, unknown>>;
  lastParsedJson: string;
  pollId: RuntimeTimer;
}

export interface WidgetFactoryState {
  fn: (
    tui: unknown,
    theme: unknown
  ) => { render(width: number): unknown; dispose?(): void } | string[];
  intervalId?: RuntimeTimer;
  lastPayloadJson?: string;
  lastResult?: { dispose?(): void };
}

export interface WidgetStoreEntry {
  payload: WidgetPayload;
  factory?: WidgetFactoryState;
  failures: number;
}

export interface SessionUiState {
  statuses: Map<string, string>;
  workingMessage?: string;
  workingVisible: boolean;
  workingIndicatorFrames: string[];
  workingIndicatorMs: number;
  hiddenThinkingLabel: string;
  header: string;
  footer: string;
  editorComponent?: ParsedComponent;
  title: string;
  editorText: string;
  widgets: Map<string, WidgetStoreEntry>;
  pendingDialogs: Map<string, PendingRequest>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interactiveCustomComponents: Map<string, any>;
  interactiveRenderIntervals: Map<string, RuntimeTimer>;
  interactiveLastRender: Map<string, string>;
  activeCustomDialogs: Map<string, ActiveCustomDialog>;
}

export interface TerminalInputRegistryLike {
  register(owner: string | null, handler: TerminalInputHandler): () => void;
  unregister(owner: string | null, handler: TerminalInputHandler): void;
  has(owner: string | null): boolean;
  clear(owner: string | null): void;
}

export interface ExtensionRuntimeHooks {
  broadcast: (payload: ServerMessage) => void;
  scheduleSessionRuntimeBroadcast?: (sid: string) => void;
  activeSessionId?: () => string | null;
  sessionIdentity?: (sid: string) => unknown;
  terminalInput?: TerminalInputRegistryLike;
  log?: {
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  schemaVersion: number;
  dialogTimeoutMs?: number;
}

export interface InteractiveRenderSnapshot {
  cleanLines: string[];
  htmlLines: string[];
}

export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;

const DEFAULT_DIALOG_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ORPHAN_GRACE_MS = 30_000;

function createSessionUiState(): SessionUiState {
  return {
    statuses: new Map(),
    workingVisible: true,
    workingIndicatorFrames: [],
    workingIndicatorMs: 80,
    hiddenThinkingLabel: 'thinking',
    header: '',
    footer: '',
    title: 'pi UI',
    editorText: '',
    widgets: new Map(),
    pendingDialogs: new Map(),
    interactiveCustomComponents: new Map(),
    interactiveRenderIntervals: new Map(),
    interactiveLastRender: new Map(),
    activeCustomDialogs: new Map(),
  };
}

/**
 * Session-owned extension state and lifecycle resources. The class deliberately
 * contains no SDK runtime imports: server.ts supplies transport, logging,
 * session lookup, and terminal cleanup hooks.
 */
export class ExtensionRuntime {
  private readonly uiStateBuckets = new Map<string, SessionUiState>();
  private readonly ownerlessUiState = createSessionUiState();
  private readonly pendingRequestOwners = new Map<string, string | null>();
  private readonly autocompleteProviderWrappers = new Map<string, AutocompleteProviderFactory[]>();
  private readonly chainedAutocompleteProviders = new Map<string, AutocompleteProvider>();
  private readonly dialogTimeoutMs: number;
  private orphanCleanupTimer: RuntimeTimer | undefined;

  constructor(private readonly hooks: ExtensionRuntimeHooks) {
    this.dialogTimeoutMs = hooks.dialogTimeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS;
  }

  stampOwner(owner: string | null): Record<string, string> {
    return owner ? { sessionId: owner } : {};
  }

  uiStateFor(owner: string | null): SessionUiState {
    if (owner == null) return this.ownerlessUiState;
    let ui = this.uiStateBuckets.get(owner);
    if (!ui) {
      ui = createSessionUiState();
      this.uiStateBuckets.set(owner, ui);
    }
    return ui;
  }

  existingUiStateFor(owner: string | null): SessionUiState | undefined {
    return owner == null ? this.ownerlessUiState : this.uiStateBuckets.get(owner);
  }

  stateForSession(sid: string): SessionUiState | undefined {
    return this.uiStateBuckets.get(sid);
  }

  sessionStates(): IterableIterator<[string, SessionUiState]> {
    return this.uiStateBuckets.entries();
  }

  pendingRequestOwner(id: string): string | null {
    return this.pendingRequestOwners.get(id) ?? null;
  }

  pendingRequest(id: string): PendingRequest | undefined {
    const owner = this.pendingRequestOwners.get(id) ?? null;
    return this.existingUiStateFor(owner)?.pendingDialogs.get(id);
  }

  widgetOwnerFor(key: string): string | null | undefined {
    const active = this.hooks.activeSessionId?.() ?? null;
    if (active && this.uiStateBuckets.get(active)?.widgets.has(key)) return active;
    for (const [sid, ui] of this.uiStateBuckets) {
      if (ui.widgets.has(key)) return sid;
    }
    return this.ownerlessUiState.widgets.has(key) ? null : undefined;
  }

  /** Register and broadcast a request, resolving it through one cleanup path. */
  createDialogPromise<T>(
    id: string,
    requestPayload: Record<string, unknown>,
    parseResponse: (response: Record<string, unknown>) => T,
    owner: string | null = null
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const ui = this.uiStateFor(owner);
      const entry: PendingRequest = {
        requestPayload,
        resolve: (response) => {
          if (entry.timeoutId) clearTimeout(entry.timeoutId);
          ui.pendingDialogs.delete(id);
          if (owner) this.hooks.scheduleSessionRuntimeBroadcast?.(owner);
          this.finalizeExtensionResponse(id);
          this.pendingRequestOwners.delete(id);
          resolve(parseResponse(response));
        },
      };
      ui.pendingDialogs.set(id, entry);
      this.pendingRequestOwners.set(id, owner);
      if (owner) this.hooks.scheduleSessionRuntimeBroadcast?.(owner);
      this.hooks.broadcast({
        type: 'extension_ui_request',
        id,
        ...requestPayload,
        ...this.stampOwner(owner),
      });
      entry.timeoutId = setTimeout(() => {
        if (ui.pendingDialogs.get(id) === entry) entry.resolve({ cancelled: true });
      }, this.dialogTimeoutMs);
    });
  }

  resolvePending(id: string, response: Record<string, unknown>): boolean {
    const pending = this.pendingRequest(id);
    if (!pending) return false;
    pending.resolve(response);
    return true;
  }

  setPendingRequestOwner(id: string, owner: string | null): void {
    this.pendingRequestOwners.set(id, owner);
  }

  removePendingRequestOwner(id: string): void {
    this.pendingRequestOwners.delete(id);
  }

  cleanupCustomDialog(id: string): void {
    const owner = this.pendingRequestOwner(id);
    const ui = this.existingUiStateFor(owner);
    if (!ui) return;
    const dialog = ui.activeCustomDialogs.get(id);
    if (dialog) {
      clearInterval(dialog.pollId);
      try {
        dialog.root.dispose?.();
      } catch {
        // A disposed extension component must not abort session cleanup.
      }
      ui.activeCustomDialogs.delete(id);
    }
    ui.interactiveCustomComponents.get(id)?.dispose?.();
    ui.interactiveCustomComponents.delete(id);
    const pollId = ui.interactiveRenderIntervals.get(id);
    if (pollId) clearInterval(pollId);
    ui.interactiveRenderIntervals.delete(id);
    ui.interactiveLastRender.delete(id);
  }

  finalizeExtensionResponse(id: string): void {
    const owner = this.pendingRequestOwner(id);
    this.cleanupCustomDialog(id);
    this.hooks.broadcast({
      type: 'extension_ui_dismiss',
      id,
      ...this.stampOwner(owner),
    });
  }

  flushInteractiveRender(
    id: string,
    render: (component: StubTui) => InteractiveRenderSnapshot | null
  ): void {
    const owner = this.pendingRequestOwner(id);
    const ui = this.existingUiStateFor(owner);
    if (!ui) return;
    const component = ui.interactiveCustomComponents.get(id);
    if (!component) return;
    const rendered = render(component);
    if (!rendered) return;
    const json = JSON.stringify(rendered.cleanLines);
    if (json === ui.interactiveLastRender.get(id)) return;
    ui.interactiveLastRender.set(id, json);
    this.hooks.broadcast({
      type: 'custom_render',
      id,
      lines: rendered.cleanLines,
      htmlLines: rendered.htmlLines,
      ...this.stampOwner(owner),
    });
    const pending = ui.pendingDialogs.get(id);
    if (pending) {
      pending.requestPayload.lines = rendered.cleanLines;
      pending.requestPayload.htmlLines = rendered.htmlLines;
    }
  }

  setInteractiveRenderInterval(id: string, interval: RuntimeTimer, owner: string | null): void {
    this.uiStateFor(owner).interactiveRenderIntervals.set(id, interval);
  }
  registerInteractiveComponent(id: string, component: unknown, owner: string | null): void {
    const ui = this.uiStateFor(owner);
    ui.interactiveCustomComponents.set(id, component);
  }
  setInteractiveLastRender(id: string, json: string, owner: string | null): void {
    this.uiStateFor(owner).interactiveLastRender.set(id, json);
  }

  setActiveCustomDialog(id: string, dialog: ActiveCustomDialog, owner: string | null): void {
    this.uiStateFor(owner).activeCustomDialogs.set(id, dialog);
  }

  activeCustomDialog(id: string, owner: string | null): ActiveCustomDialog | undefined {
    return this.existingUiStateFor(owner)?.activeCustomDialogs.get(id);
  }

  registerTerminalInput(handler: TerminalInputHandler, owner: string | null): () => void {
    const registry = this.hooks.terminalInput;
    if (!registry) return () => undefined;
    const wasActive = registry.has(owner);
    const unregister = registry.register(owner, handler);
    if (!wasActive) {
      this.hooks.broadcast({
        type: 'extension_terminal_input_active',
        active: true,
        ...this.stampOwner(owner),
      });
    }
    return () => {
      const had = registry.has(owner);
      unregister();
      if (had && !registry.has(owner)) {
        this.hooks.broadcast({
          type: 'extension_terminal_input_active',
          active: false,
          ...this.stampOwner(owner),
        });
      }
    };
  }

  terminalInputActive(owner: string | null): boolean {
    return this.hooks.terminalInput?.has(owner) ?? false;
  }

  clearTerminalInput(owner: string | null): void {
    this.hooks.terminalInput?.clear(owner);
  }

  addAutocompleteProvider(factory: AutocompleteProviderFactory, owner: string | null): void {
    if (!factory || !owner) return;
    const providers = this.autocompleteProviderWrappers.get(owner) ?? [];
    providers.push(factory);
    this.autocompleteProviderWrappers.set(owner, providers);
    this.chainAutocompleteProviders(owner);
  }

  private chainAutocompleteProviders(sid: string): void {
    const fallback: AutocompleteProvider = {
      async getSuggestions() {
        return null;
      },
      applyCompletion(lines, cursorLine, cursorCol) {
        return { lines, cursorLine, cursorCol };
      },
    };
    let chained: AutocompleteProvider = fallback;
    for (const wrap of this.autocompleteProviderWrappers.get(sid) ?? []) {
      try {
        chained = wrap(chained);
      } catch (err) {
        this.hooks.log?.warn?.(`[pifrontier] autocomplete provider failed for ${sid}:`, err);
      }
    }
    this.chainedAutocompleteProviders.set(sid, chained);
  }

  autocompleteProviderFor(sid: string): AutocompleteProvider | null {
    return this.chainedAutocompleteProviders.get(sid) ?? null;
  }

  clearAutocompleteProviders(sid: string): void {
    this.autocompleteProviderWrappers.delete(sid);
    this.chainedAutocompleteProviders.delete(sid);
  }

  widgetsForSession(sid: string): WidgetPayload[] {
    const ui = this.uiStateBuckets.get(sid);
    return ui ? Array.from(ui.widgets.values(), (entry) => entry.payload) : [];
  }

  extensionUiStateForSession(sid: string): ExtensionUiStatePayload {
    const ui = this.uiStateBuckets.get(sid) ?? createSessionUiState();
    return {
      schemaVersion: this.hooks.schemaVersion,
      statuses: Object.fromEntries(ui.statuses),
      terminalInputActive: this.terminalInputActive(sid),
      ...(ui.workingMessage !== undefined ? { workingMessage: ui.workingMessage } : {}),
      workingVisible: ui.workingVisible,
      ...(ui.workingIndicatorFrames.length > 0 || ui.workingIndicatorMs !== 80
        ? {
            workingIndicator: {
              frames: ui.workingIndicatorFrames,
              intervalMs: ui.workingIndicatorMs,
            },
          }
        : {}),
      hiddenThinkingLabel: ui.hiddenThinkingLabel,
      ...(ui.header ? { header: ui.header } : {}),
      ...(ui.footer ? { footer: ui.footer } : {}),
      ...(ui.editorComponent ? { editorComponent: ui.editorComponent } : {}),
      ...(ui.title !== 'pi UI' ? { title: ui.title } : {}),
      widgets: this.widgetsForSession(sid),
      pendingDialogs: Array.from(ui.pendingDialogs, ([id, pending]) => ({
        id,
        ...pending.requestPayload,
      })),
    };
  }

  syncWidgetFactories(
    activeSid: string | null,
    tick: (key: string, owner: string | null) => void
  ): void {
    for (const [sid, ui] of this.uiStateBuckets) {
      for (const [key, entry] of ui.widgets) {
        const factory = entry.factory;
        if (!factory) continue;
        if (sid === activeSid) {
          if (!factory.intervalId) {
            tick(key, sid);
            const current = ui.widgets.get(key);
            if (current !== entry || current.factory !== factory) continue;
            factory.intervalId = setInterval(() => tick(key, sid), WIDGET_REFRESH_MS);
          }
        } else if (factory.intervalId) {
          clearInterval(factory.intervalId);
          factory.intervalId = undefined;
        }
      }
    }
  }

  disposeWidgetFactory(factory: WidgetFactoryState): void {
    clearInterval(factory.intervalId);
    factory.intervalId = undefined;
    try {
      factory.lastResult?.dispose?.();
    } catch {
      // Widget disposal is best effort during lifecycle teardown.
    }
    factory.lastResult = undefined;
  }

  teardownWidget(key: string, owner: string | null): void {
    const ui = this.existingUiStateFor(owner);
    const entry = ui?.widgets.get(key);
    if (entry?.factory) this.disposeWidgetFactory(entry.factory);
    ui?.widgets.delete(key);
    this.hooks.broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'setWidget',
      widgetKey: key,
      widgetType: 'text',
      widgetLines: [],
      ...this.stampOwner(owner),
    });
  }

  private disposeUiState(ui: SessionUiState): void {
    for (const entry of [...ui.pendingDialogs.values()]) entry.resolve({ cancelled: true });
    for (const component of ui.interactiveCustomComponents.values()) {
      try {
        component.dispose?.();
      } catch {
        // ignore disposal failures
      }
    }
    for (const interval of ui.interactiveRenderIntervals.values()) clearInterval(interval);
    for (const dialog of ui.activeCustomDialogs.values()) {
      clearInterval(dialog.pollId);
      try {
        dialog.root.dispose?.();
      } catch {
        // ignore disposal failures
      }
    }
    for (const entry of ui.widgets.values()) {
      if (entry.factory) this.disposeWidgetFactory(entry.factory);
    }
    ui.pendingDialogs.clear();
    ui.interactiveCustomComponents.clear();
    ui.interactiveRenderIntervals.clear();
    ui.interactiveLastRender.clear();
    ui.activeCustomDialogs.clear();
    ui.widgets.clear();
  }

  cancelOrphanCleanup(): void {
    clearTimeout(this.orphanCleanupTimer);
    this.orphanCleanupTimer = undefined;
  }
  disposeSession(sid: string): void {
    // Clear handlers first: onTerminalInput can exist without a UI bucket.
    this.clearTerminalInput(sid);
    this.clearAutocompleteProviders(sid);
    const ui = this.uiStateBuckets.get(sid);
    if (!ui) return;
    this.disposeUiState(ui);
    this.uiStateBuckets.delete(sid);
  }

  disposeAll(): void {
    clearTimeout(this.orphanCleanupTimer);
    this.orphanCleanupTimer = undefined;
    for (const sid of this.uiStateBuckets.keys()) this.disposeSession(sid);
    this.disposeUiState(this.ownerlessUiState);
    this.pendingRequestOwners.clear();
    this.autocompleteProviderWrappers.clear();
    this.chainedAutocompleteProviders.clear();
  }

  scheduleOrphanCleanup(delayMs = DEFAULT_ORPHAN_GRACE_MS): void {
    clearTimeout(this.orphanCleanupTimer);
    this.orphanCleanupTimer = setTimeout(() => {
      this.orphanCleanupTimer = undefined;
      this.disposeAll();
    }, delayMs);
  }
}

export { createSessionUiState };
