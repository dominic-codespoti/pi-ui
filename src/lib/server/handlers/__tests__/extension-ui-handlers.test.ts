import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '../../../ws/protocol.ts';
import type { SessionUiState } from '../../runtime/extension-runtime.ts';
import {
  dispatchExtensionUiMessage,
  type ExtensionUiHandlerDependencies,
  type ExtensionUiHandlerTarget,
} from '../extension-ui-handlers';

function uiState(): SessionUiState {
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

function setup() {
  const state = uiState();
  const send = vi.fn();
  const targetEntry = vi.fn(
    (socketData: unknown, message: ClientMessage): ExtensionUiHandlerTarget => {
      const socketTarget =
        typeof socketData === 'object' &&
        socketData !== null &&
        'targetSession' in socketData &&
        typeof socketData.targetSession === 'string'
          ? socketData.targetSession
          : undefined;
      const sessionId =
        socketTarget ??
        ('sessionId' in message && typeof message.sessionId === 'string'
          ? message.sessionId
          : 'focused');
      return { session: { sessionId } };
    }
  );
  const stampOwner = (owner: string | null): Record<string, string> =>
    owner ? { sessionId: owner } : {};
  const dependencies: ExtensionUiHandlerDependencies = {
    targetEntry,
    uiStateFor: () => state,
    existingUiStateFor: (owner) => (owner === 'owner-a' ? state : undefined),
    pendingRequestOwner: () => 'owner-a',
    widgetOwnerFor: () => undefined,
    teardownWidget: vi.fn(),
    flushInteractiveRender: vi.fn(),
    terminalInputDispatch: vi.fn(() => ({ consumed: true, data: 'handled' })),
    broadcast: vi.fn(),
    stampOwner,
    parseComponentTree: vi.fn(),
    boundParsedComponentTree: vi.fn(),
    logError: vi.fn(),
  };
  return { state, send, targetEntry, dependencies };
}

describe('dispatchExtensionUiMessage', () => {
  it('returns false without effects for unrelated messages', async () => {
    const { send, dependencies } = setup();

    expect(
      await dispatchExtensionUiMessage({ type: 'ping' }, { data: {}, send }, dependencies)
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a response routed to a different session than its pending owner', async () => {
    const { state, send, targetEntry, dependencies } = setup();
    const resolve = vi.fn();
    state.pendingDialogs.set('dialog-1', {
      requestPayload: { method: 'confirm' },
      resolve,
    });

    expect(
      await dispatchExtensionUiMessage(
        { type: 'extension_ui_response', id: 'dialog-1', sessionId: 'owner-b', confirmed: true },
        { data: { targetSession: 'owner-b' }, send },
        dependencies
      )
    ).toBe(true);
    expect(targetEntry).toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('dispatches terminal input to the target and replies only to the requester with ownership', async () => {
    const { send, dependencies } = setup();

    expect(
      await dispatchExtensionUiMessage(
        { type: 'extension_terminal_input', id: 'input-1', sessionId: 'owner-a', data: '\u0003' },
        { data: { targetSession: 'owner-a' }, send },
        dependencies
      )
    ).toBe(true);
    expect(dependencies.terminalInputDispatch).toHaveBeenCalledWith('owner-a', '\u0003');
    expect(send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'extension_terminal_input_result',
        id: 'input-1',
        consumed: true,
        data: 'handled',
        sessionId: 'owner-a',
      })
    );
  });
});
