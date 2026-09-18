import type { ClientMessage, ServerMessage } from '../../ws/protocol.ts';
import type { SessionUiState } from '../runtime/extension-runtime.ts';
import type { ParsedComponent } from '../../tui-stubs.ts';

export interface ExtensionUiHandlerSocket {
  readonly data: unknown;
  send(data: string): unknown;
}

export interface ExtensionUiHandlerTarget {
  readonly session: {
    readonly sessionId: string;
  };
}

export interface ExtensionUiHandlerDependencies {
  targetEntry: (
    socketData: unknown,
    message: ClientMessage,
    send: (data: string) => unknown
  ) => ExtensionUiHandlerTarget | undefined;
  uiStateFor: (owner: string | null) => SessionUiState;
  existingUiStateFor: (owner: string | null) => SessionUiState | undefined;
  pendingRequestOwner: (id: string) => string | null;
  widgetOwnerFor: (key: string) => string | null | undefined;
  teardownWidget: (key: string, owner: string | null) => void;
  flushInteractiveRender: (id: string) => void;
  terminalInputDispatch: (owner: string, data: string) => { consumed: boolean; data?: string };
  broadcast: (payload: ServerMessage) => void;
  stampOwner: (owner: string | null) => Record<string, string>;
  parseComponentTree: (
    component: Record<string, unknown>,
    width: number,
    path: number[],
    nodeMap: Map<string, Record<string, unknown>>
  ) => ParsedComponent;
  boundParsedComponentTree: (parsed: ParsedComponent) => ParsedComponent;
  logError?: (...args: unknown[]) => void;
}

/**
 * Dispatch extension UI transport messages. Unknown messages return false so
 * the composition root can continue with its remaining protocol handlers.
 */
export async function dispatchExtensionUiMessage(
  message: ClientMessage,
  socket: ExtensionUiHandlerSocket,
  dependencies: ExtensionUiHandlerDependencies
): Promise<boolean> {
  switch (message.type) {
    case 'extension_ui_response': {
      const owner = dependencies.pendingRequestOwner(message.id);
      const target = dependencies.targetEntry(
        socket.data,
        owner ? { ...message, sessionId: owner } : message,
        socket.send
      );
      if (!target) return true;
      if (owner && owner !== target.session.sessionId) return true;
      const pending = dependencies.existingUiStateFor(owner)?.pendingDialogs.get(message.id);
      if (pending) pending.resolve(message as unknown as Record<string, unknown>);
      return true;
    }

    case 'dismiss_widget': {
      const key = message.key as string | undefined;
      if (!key) return true;
      const target = dependencies.targetEntry(socket.data, message, socket.send);
      if (!target) return true;
      const owner = dependencies.widgetOwnerFor(key);
      if (owner === undefined || (owner && owner !== target.session.sessionId)) return true;
      dependencies.teardownWidget(key, owner);
      return true;
    }

    case 'extension_custom_input': {
      const customId = message.id as string | undefined;
      const data = message.data as string | undefined;
      if (!customId || data === undefined) return true;
      const owner = dependencies.pendingRequestOwner(customId);
      const target = dependencies.targetEntry(
        socket.data,
        owner ? { ...message, sessionId: owner } : message,
        socket.send
      );
      if (!target) return true;
      const resolvedOwner = owner ?? target.session.sessionId;
      const ui = dependencies.existingUiStateFor(resolvedOwner);
      const component = ui?.interactiveCustomComponents.get(customId);
      if (!component) return true;
      try {
        // `data` is the raw terminal byte sequence the browser encoded for
        // this keystroke/paste — pass it straight through, exactly as real
        // stdin would deliver it.
        if (typeof component.handleInput === 'function') component.handleInput(data);
      } catch (err) {
        dependencies.logError?.('[pifrontier] extension_custom_input error:', err);
      } finally {
        dependencies.flushInteractiveRender(customId);
      }
      return true;
    }

    case 'extension_custom_resize': {
      const resizeId = message.id as string | undefined;
      if (!resizeId) return true;
      const owner = dependencies.pendingRequestOwner(resizeId);
      const target = dependencies.targetEntry(
        socket.data,
        owner ? { ...message, sessionId: owner } : message,
        socket.send
      );
      if (!target) return true;
      const resolvedOwner = owner ?? target.session.sessionId;
      const tui = dependencies
        .existingUiStateFor(resolvedOwner)
        ?.interactiveCustomComponents.get(resizeId);
      if (!tui?.terminal?.setSize) return true;
      const columns = typeof message.columns === 'number' ? message.columns : 80;
      const rows = typeof message.rows === 'number' ? message.rows : 24;
      tui.terminal.setSize(columns, rows);
      return true;
    }

    case 'extension_terminal_input': {
      const inputId = message.id as string | undefined;
      const data = message.data as string | undefined;
      if (!inputId || typeof data !== 'string') return true;
      const target = dependencies.targetEntry(socket.data, message, socket.send);
      if (!target) return true;
      const owner = target.session.sessionId;
      const verdict = dependencies.terminalInputDispatch(owner, data);
      // Requester-only reply — a broadcast fans every keystroke's verdict to
      // all tabs and queues it behind streaming deltas.
      socket.send(
        JSON.stringify({
          type: 'extension_terminal_input_result',
          id: inputId,
          consumed: verdict.consumed,
          ...(verdict.data !== undefined ? { data: verdict.data } : {}),
          ...dependencies.stampOwner(owner),
        })
      );
      return true;
    }

    case 'extension_editor_text_change': {
      const text = message.text as string | undefined;
      if (typeof text !== 'string') return true;
      const target = dependencies.targetEntry(socket.data, message, socket.send);
      if (!target) return true;
      const ui = dependencies.uiStateFor(target.session.sessionId);
      ui.editorText = text;
      return true;
    }

    case 'extension_component_event': {
      const dialogId = message.id as string | undefined;
      if (!dialogId) return true;
      const owner = dependencies.pendingRequestOwner(dialogId);
      const target = dependencies.targetEntry(
        socket.data,
        owner ? { ...message, sessionId: owner } : message,
        socket.send
      );
      if (!target) return true;
      const resolvedOwner = owner ?? target.session.sessionId;
      const path = (message.path as number[] | undefined) ?? [];
      const event = message.event as string;
      const value = message.value as string | undefined;
      const dlg = dependencies.existingUiStateFor(resolvedOwner)?.activeCustomDialogs.get(dialogId);
      const node = dlg?.nodeMap.get(path.join('.'));
      let handled = false;
      try {
        if (node) {
          if (
            event === 'select' &&
            Array.isArray(node.items) &&
            typeof node.onSelect === 'function'
          ) {
            const item = (node.items as Array<{ value: string }>).find((i) => i.value === value);
            if (item) {
              (node.onSelect as (i: unknown) => void)(item);
              handled = true;
            }
          } else if (event === 'click' && typeof node.onClick === 'function') {
            (node.onClick as () => void)();
            handled = true;
          } else if (event === 'toggle' && typeof node.onToggle === 'function') {
            (node.onToggle as (v: boolean) => void)(!node.checked);
            handled = true;
          } else if (event === 'submit') {
            if (typeof node.setValue === 'function')
              (node.setValue as (v: string) => void)(value ?? '');
            if (typeof node.onSubmit === 'function') {
              (node.onSubmit as (v: string) => void)(value ?? '');
              handled = true;
            }
          } else if (event === 'setting' && typeof node.updateValue === 'function') {
            const sepIdx = (value ?? '').indexOf('::');
            if (sepIdx !== -1) {
              (node.updateValue as (settingId: string, v: string) => void)(
                (value as string).slice(0, sepIdx),
                (value as string).slice(sepIdx + 2)
              );
              handled = true;
            }
          }
        }
        if (handled && dlg) {
          // Re-parse and only broadcast if the tree actually changed — avoids
          // redundant traffic when the callback is a pure no-op.
          const reparsed = dependencies.boundParsedComponentTree(
            dependencies.parseComponentTree(dlg.root, 80, [], dlg.nodeMap)
          );
          const json = JSON.stringify(reparsed);
          if (json !== dlg.lastParsedJson) {
            dlg.lastParsedJson = json;
            dependencies.broadcast({
              type: 'extension_ui_update',
              id: dialogId,
              parsed: reparsed,
              ...dependencies.stampOwner(owner),
            });
            const ui = dependencies.existingUiStateFor(dependencies.pendingRequestOwner(dialogId));
            const pending = ui?.pendingDialogs.get(dialogId);
            if (pending) pending.requestPayload.parsed = reparsed;
          }
        } else if (!handled) {
          // No live callback on this node (static tree, or a component the
          // extension built without wiring a callback) — fall back to resolving
          // the dialog directly with the raw value.
          const ui = dependencies.existingUiStateFor(dependencies.pendingRequestOwner(dialogId));
          const pending = ui?.pendingDialogs.get(dialogId);
          if (pending) pending.resolve({ value });
        }
      } catch (err) {
        dependencies.logError?.('[pifrontier] extension_component_event error:', err);
        // A throwing callback must still resolve the dialog; otherwise the
        // extension's await ui.confirm()/select() call hangs forever.
        const ui = dependencies.existingUiStateFor(dependencies.pendingRequestOwner(dialogId));
        const pending = ui?.pendingDialogs.get(dialogId);
        if (pending) pending.resolve({ value });
      }
      return true;
    }

    default:
      return false;
  }
}
