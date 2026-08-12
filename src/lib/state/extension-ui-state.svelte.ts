import type { ParsedComponent } from '$lib/tui-stubs';
import {
  EXTENSION_UI_SCHEMA_VERSION,
  type ClientMessage,
  type ExtensionUiStatePayload,
  type WidgetContent,
} from '$lib/ws/protocol';

/** A modal dialog queued for the active session (queue head renders). */
export type ModalState =
  | { method: 'confirm'; id: string; title: string; message: string }
  | { method: 'input'; id: string; title: string; placeholder?: string; secret?: boolean }
  | { method: 'select'; id: string; title: string; options: string[] }
  | { method: 'editor'; id: string; title: string; prefill?: string }
  | {
      method: 'custom';
      id: string;
      title: string;
      parsed?: ParsedComponent;
      lines?: string[];
      htmlLines?: string[];
      interactive?: true;
    };

/**
 * All extension UI state for the ACTIVE session. The server is the source of
 * truth: full snapshots arrive on `connected`/`session_loaded` (Phase 2 wire —
 * `applySnapshot`), live updates arrive as stamped `extension_ui_request`
 * deltas (`applyDelta` branches in the host component), and `reset()`/session
 * changes must never leave the previous session's panels behind.
 *
 * Runes-based class singleton — same convention as `projects-state.svelte.ts`.
 */
export class ExtensionUiState {
  /** Keyed status texts from extension setStatus() calls. */
  statuses = $state<Record<string, string>>({});
  /** Keyed widget panels from extension setWidget() calls. */
  widgets = $state<Record<string, WidgetContent>>({});
  /** Widget placement mapping (aboveEditor / belowEditor). */
  widgetPlacement = $state<Record<string, string>>({});
  /** Custom working message from extension setWorkingMessage() calls. */
  workingMessage = $state<string | undefined>(undefined);
  /** Whether the streaming working indicator is visible (setWorkingVisible). */
  workingVisible = $state(true);
  /** Frames for the working indicator animation (setWorkingIndicator). */
  workingIndicatorFrames = $state<string[]>([]);
  /** Interval in ms between frame ticks (setWorkingIndicator). */
  workingIndicatorMs = $state(80);
  /** Label shown for collapsed thinking blocks (setHiddenThinkingLabel). */
  hiddenThinkingLabel = $state('thinking');
  /** Extension-injected header content (setHeader). */
  header = $state('');
  /** Extension-injected footer content (setFooter). */
  footer = $state('');
  /** Extension-injected editor component panel (setEditorComponent). */
  editorComponentPanel = $state<ParsedComponent | null>(null);
  /** Document title set by the active session's extension (setTitle). */
  title = $state('pi UI');
  /** Whether the active session has onTerminalInput handlers. */
  terminalInputActive = $state(false);
  /** Queued modal dialogs for the active session (queue head renders). */
  modalQueue = $state<ModalState[]>([]);

  /** WS sender injected by the host component (same pattern as projectsState.send). */
  send: (msg: ClientMessage) => boolean = () => false;

  // ── Live delta application (extension_ui_request branches) ─────────────────

  /** Apply a setWidget delta — the wire body of a setWidget broadcast. */
  applyWidget(msg: Record<string, unknown>): void {
    const key = msg.widgetKey as string | undefined;
    if (!key) return;
    const widgetType = (msg.widgetType as string | undefined) ?? 'text';
    const widgetLines = msg.widgetLines as string[] | undefined;
    const widgetHtmlLines = msg.widgetHtmlLines as string[] | undefined;
    const widgetPlacement = msg.widgetPlacement as string | undefined;
    const widgetData = msg.widgetData as Record<string, unknown> | undefined;
    const widgetComponent = msg.widgetComponent as ParsedComponent | undefined;
    if (widgetType === 'text' && (!widgetLines || widgetLines.length === 0)) {
      delete this.widgets[key];
    } else if (widgetType === 'component' && widgetComponent) {
      this.widgets[key] = { type: 'component', component: widgetComponent };
    } else if (widgetType === 'table') {
      const headers = (widgetData?.headers as string[]) ?? [];
      const rows = (widgetData?.rows as string[][]) ?? [];
      this.widgets[key] = { type: 'table', headers, rows };
    } else if (widgetType === 'badge') {
      const text = (widgetData?.text as string) ?? '';
      const variant =
        (widgetData?.variant as 'info' | 'warning' | 'error' | 'success' | undefined) ?? 'info';
      this.widgets[key] = { type: 'badge', text, variant };
    } else {
      this.widgets[key] = {
        type: 'text',
        lines: widgetLines ?? [],
        ...(widgetHtmlLines?.length ? { htmlLines: widgetHtmlLines } : {}),
      };
    }
    if (widgetPlacement) {
      this.widgetPlacement[key] = widgetPlacement;
    } else {
      delete this.widgetPlacement[key];
    }
  }

  setStatus(key: string | undefined, text: string | undefined): void {
    if (!key) return;
    if (text == null) {
      delete this.statuses[key];
    } else {
      this.statuses[key] = text;
    }
  }

  setWorkingMessage(message: string | undefined): void {
    this.workingMessage = message;
  }

  setWorkingVisible(visible: boolean): void {
    this.workingVisible = visible;
  }

  setWorkingIndicator(frames: string[] | undefined, intervalMs: number | undefined): void {
    this.workingIndicatorFrames = frames ?? [];
    this.workingIndicatorMs = intervalMs ?? 80;
  }

  setHiddenThinkingLabel(label: string | undefined): void {
    this.hiddenThinkingLabel = label ?? 'thinking';
  }

  setHeader(content: string | undefined): void {
    this.header = content ?? '';
  }

  setFooter(content: string | undefined): void {
    this.footer = content ?? '';
  }

  setEditorComponent(parsed: ParsedComponent | null): void {
    this.editorComponentPanel = parsed;
  }

  setTitle(title: string | undefined): void {
    this.title = title ?? 'pi UI';
    document.title = this.title;
  }
  setTerminalInputActive(active: boolean): void {
    this.terminalInputActive = active;
  }

  /** Build a ModalState from an extension_ui_request payload (null for non-modal methods). */
  modalFromRequest(msg: Record<string, unknown>): ModalState | null {
    const id = msg.id as string;
    const method = msg.method as string;
    switch (method) {
      case 'confirm':
        return {
          method: 'confirm',
          id,
          title: (msg.title as string | undefined) ?? 'Confirm',
          message: (msg.message as string | undefined) ?? '',
        };
      case 'input':
        return {
          method: 'input',
          id,
          title: (msg.title as string | undefined) ?? 'Input',
          placeholder: msg.placeholder as string | undefined,
          ...(msg.secret === true ? { secret: true } : {}),
        };
      case 'select':
        return {
          method: 'select',
          id,
          title: (msg.title as string | undefined) ?? 'Select',
          options: (msg.options as string[] | undefined) ?? [],
        };
      case 'editor':
        return {
          method: 'editor',
          id,
          title: (msg.title as string | undefined) ?? 'Editor',
          prefill: msg.prefill as string | undefined,
        };
      case 'custom': {
        const parsed = msg.parsed as ParsedComponent | undefined;
        const lines = msg.lines as string[] | undefined;
        const htmlLines = msg.htmlLines as string[] | undefined;
        const interactive = msg.interactive as boolean | undefined;
        return {
          method: 'custom',
          id,
          title: (msg.title as string | undefined) ?? 'Extension Request',
          parsed,
          ...(lines ? { lines } : {}),
          ...(htmlLines ? { htmlLines } : {}),
          ...(interactive ? { interactive: true as const } : {}),
        };
      }
      default:
        return null;
    }
  }

  /** Queue a live extension_ui_request as a modal (no-op for non-modal methods). */
  queueModalFromRequest(msg: Record<string, unknown>): void {
    const state = this.modalFromRequest(msg);
    if (!state) return;
    this.modalQueue = [...this.modalQueue, state];
  }

  /** Queue a replayed extension_ui_request (deduped by id) — reconnect + snapshot replay. */
  replayModalFromRequest(msg: Record<string, unknown>): void {
    const state = this.modalFromRequest(msg);
    if (!state) return;
    if (this.modalQueue.some((m) => m.id === state.id)) return;
    this.modalQueue = [...this.modalQueue, state];
  }

  /** Update the active interactive custom overlay's rendered lines. */
  updateCustomRender(
    id: string | undefined,
    lines: string[] | undefined,
    htmlLines: string[] | undefined
  ): void {
    const active = this.modalQueue[0];
    if (
      !id ||
      !lines ||
      this.modalQueue.length === 0 ||
      !active ||
      active.method !== 'custom' ||
      active.id !== id ||
      !active.interactive
    ) {
      return;
    }
    this.modalQueue = [
      {
        ...active,
        lines,
        ...(htmlLines ? { htmlLines } : {}),
      } as ModalState,
      ...this.modalQueue.slice(1),
    ];
  }

  /** Update a parsed custom dialog tree (extension_ui_update). */
  updateCustomParsed(id: string | undefined, parsed: ParsedComponent | undefined): void {
    if (!id || !parsed) return;
    this.modalQueue = this.modalQueue.map((m) =>
      m.method === 'custom' && m.id === id ? { ...m, parsed } : m
    );
  }

  /** Remove a dismissed dialog (extension_ui_dismiss); true when it was active. */
  dismissModal(id: string | undefined): boolean {
    if (!id) return false;
    const wasActive = this.modalQueue[0]?.id === id;
    this.modalQueue = this.modalQueue.filter((m) => m.id !== id);
    return wasActive;
  }

  // ── Modal answers — send the response, then pop only on a live socket ──────

  answerConfirm(confirmed: boolean): boolean {
    const modal = this.modalQueue[0];
    if (!modal) return false;
    if (this.send({ type: 'extension_ui_response', id: modal.id, confirmed })) {
      this.modalQueue = this.modalQueue.slice(1);
      return true;
    }
    return false;
  }

  answerSubmitValue(value: string): boolean {
    const modal = this.modalQueue[0];
    if (!modal) return false;
    if (this.send({ type: 'extension_ui_response', id: modal.id, value })) {
      this.modalQueue = this.modalQueue.slice(1);
      return true;
    }
    return false;
  }

  answerSelect(value: string): boolean {
    const modal = this.modalQueue[0];
    if (!modal) return false;
    if (this.send({ type: 'extension_ui_response', id: modal.id, value })) {
      this.modalQueue = this.modalQueue.slice(1);
      return true;
    }
    return false;
  }

  /** Returns true when the cancel was sent (caller resets modalInput). */
  answerCancel(): boolean {
    const modal = this.modalQueue[0];
    if (!modal) return false;
    if (this.send({ type: 'extension_ui_response', id: modal.id, cancelled: true })) {
      this.modalQueue = this.modalQueue.slice(1);
      return true;
    }
    return false;
  }

  /** Dismiss a widget locally and durably through the server. */
  dismissWidget(key: string): void {
    delete this.widgets[key];
    delete this.widgetPlacement[key];
    this.send({ type: 'dismiss_widget', key });
  }

  // ── Session scoping ─────────────────────────────────────────────────────────

  /** Clear all widgets + placements (session switch without a widgets payload). */
  clearWidgets(): void {
    this.widgets = {};
    this.widgetPlacement = {};
  }

  /**
   * Full replace of the active session's extension UI from a server snapshot
   * (`extension_ui_state`, sent after connected/session_loaded). Clears every
   * channel first so nothing from the previous session survives.
   */
  applySnapshot(ui: ExtensionUiStatePayload): void {
    if (ui.schemaVersion !== undefined && ui.schemaVersion !== EXTENSION_UI_SCHEMA_VERSION) {
      console.warn(
        `[pi-ui] Dropping extension UI snapshot: schema v${ui.schemaVersion} != v${EXTENSION_UI_SCHEMA_VERSION}`
      );
      return;
    }
    this.statuses = ui.statuses ?? {};
    this.clearWidgets();
    for (const w of ui.widgets ?? []) {
      this.applyWidget(w as unknown as Record<string, unknown>);
    }
    this.workingMessage = ui.workingMessage;
    this.workingVisible = ui.workingVisible ?? true;
    this.workingIndicatorFrames = ui.workingIndicator?.frames ?? [];
    this.workingIndicatorMs = ui.workingIndicator?.intervalMs ?? 80;
    this.hiddenThinkingLabel = ui.hiddenThinkingLabel ?? 'thinking';
    this.header = ui.header ?? '';
    this.footer = ui.footer ?? '';
    this.editorComponentPanel = ui.editorComponent ?? null;
    this.setTitle(ui.title ?? 'pi UI');
    this.terminalInputActive = ui.terminalInputActive ?? false;
    this.modalQueue = [];
    for (const dlg of ui.pendingDialogs ?? []) {
      this.replayModalFromRequest(dlg);
    }
  }

  /** Clear every channel (defensive: session change without a snapshot). */
  reset(): void {
    this.statuses = {};
    this.clearWidgets();
    this.workingMessage = undefined;
    this.workingVisible = true;
    this.workingIndicatorFrames = [];
    this.workingIndicatorMs = 80;
    this.hiddenThinkingLabel = 'thinking';
    this.header = '';
    this.footer = '';
    this.editorComponentPanel = null;
    this.setTitle('pi UI');
    this.terminalInputActive = false;
    this.modalQueue = [];
  }
}

/** Singleton shared by the chat page. */
export const extensionUiState = new ExtensionUiState();
