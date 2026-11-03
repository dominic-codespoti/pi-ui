import { describe, expect, it } from 'vitest';
import {
  ExtensionRuntime,
  normalizeCustomBlocked,
  pendingRequestBlocksForInput,
  type TerminalInputRegistryLike,
} from '../extension-runtime';

type Handler = (data: string) => unknown;

function terminalRegistry(): TerminalInputRegistryLike & { owners: Set<string | null> } {
  const owners = new Set<string | null>();
  const handlers = new Map<string | null, Set<Handler>>();
  return {
    owners,
    register(owner, handler) {
      let set = handlers.get(owner);
      if (!set) {
        set = new Set();
        handlers.set(owner, set);
      }
      set.add(handler as Handler);
      owners.add(owner);
      return () => {
        set?.delete(handler as Handler);
        if (!set?.size) {
          handlers.delete(owner);
          owners.delete(owner);
        }
      };
    },
    unregister(owner, handler) {
      handlers.get(owner)?.delete(handler as Handler);
      if (!handlers.get(owner)?.size) {
        handlers.delete(owner);
        owners.delete(owner);
      }
    },
    has(owner) {
      return owners.has(owner);
    },
    clear(owner) {
      handlers.delete(owner);
      owners.delete(owner);
    },
  };
}

describe('ExtensionRuntime', () => {
  it('keeps ownerless and session UI buckets isolated', () => {
    const runtime = new ExtensionRuntime({
      broadcast: () => undefined,
      schemaVersion: 1,
      terminalInput: terminalRegistry(),
    });

    runtime.uiStateFor('one').statuses.set('mode', 'one');
    runtime.uiStateFor('two').statuses.set('mode', 'two');
    runtime.uiStateFor(null).statuses.set('mode', 'server');

    expect(runtime.uiStateFor('one').statuses.get('mode')).toBe('one');
    expect(runtime.uiStateFor('two').statuses.get('mode')).toBe('two');
    expect(runtime.uiStateFor(null).statuses.get('mode')).toBe('server');
    expect(runtime.extensionUiStateForSession('one').statuses).toEqual({ mode: 'one' });
    expect(runtime.extensionUiStateForSession('two').statuses).toEqual({ mode: 'two' });
  });

  it('disposes pending requests and resources in one session without touching another', async () => {
    const events: string[] = [];
    const terminal = terminalRegistry();
    const runtime = new ExtensionRuntime({
      broadcast: (payload) => {
        if (payload.type === 'extension_ui_dismiss') events.push(`dismiss:${payload.id}`);
      },
      schemaVersion: 1,
      terminalInput: terminal,
    });

    const ownerOnePromise = runtime.createDialogPromise(
      'dialog-one',
      { method: 'confirm' },
      (response) => Boolean(response.confirmed),
      'one'
    );
    const ownerTwoPromise = runtime.createDialogPromise(
      'dialog-two',
      { method: 'confirm' },
      (response) => Boolean(response.confirmed),
      'two'
    );
    const handler = () => ({ consume: true });
    runtime.registerTerminalInput(handler, 'one');
    const widget = runtime.uiStateFor('one').widgets;
    widget.set('w', {
      payload: { widgetKey: 'w', widgetType: 'text', widgetLines: [] },
      failures: 0,
      factory: { fn: () => [] },
    });

    runtime.disposeSession('one');

    await expect(ownerOnePromise).resolves.toBe(false);
    expect(runtime.pendingRequest('dialog-one')).toBeUndefined();
    expect(runtime.stateForSession('one')).toBeUndefined();
    expect(runtime.stateForSession('two')).toBeDefined();
    expect(runtime.pendingRequest('dialog-two')).toBeDefined();
    expect(terminal.has('one')).toBe(false);
    expect(events).toEqual(['dismiss:dialog-one']);

    runtime.disposeSession('two');
    await expect(ownerTwoPromise).resolves.toBe(false);
  });

  it('chains autocomplete providers per session and clears the chain on disposal', () => {
    const runtime = new ExtensionRuntime({ broadcast: () => undefined, schemaVersion: 1 });
    const base = {
      async getSuggestions() {
        return null;
      },
      applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
        return { lines, cursorLine, cursorCol };
      },
    };
    const wrapped = { ...base, marker: 'one' };
    runtime.addAutocompleteProvider(() => wrapped, 'one');

    expect(runtime.autocompleteProviderFor('one')).toBe(wrapped);
    expect(runtime.autocompleteProviderFor('two')).toBeNull();
    runtime.disposeSession('one');
    expect(runtime.autocompleteProviderFor('one')).toBeNull();
  });
});

describe('pendingRequestBlocksForInput', () => {
  it('treats built-in dialogs as waiting on the user', () => {
    for (const method of ['select', 'confirm', 'input', 'editor']) {
      expect(pendingRequestBlocksForInput({ method })).toBe(true);
    }
  });

  it('treats a passive custom() loader as non-blocking (SDK 1.5 semantics)', () => {
    expect(
      pendingRequestBlocksForInput({
        method: 'custom',
        parsed: { kind: 'loader', label: 'Working…' },
      })
    ).toBe(false);
    expect(
      pendingRequestBlocksForInput({
        method: 'custom',
        parsed: { kind: 'progress', label: 'Indexing', progress: 0.4 },
      })
    ).toBe(false);
  });

  it('honours the explicit blocked option', () => {
    expect(
      pendingRequestBlocksForInput({
        method: 'custom',
        parsed: { kind: 'loader', label: 'Waiting for approval' },
        blocked: { kind: 'permission', message: 'Approve deploy?' },
      })
    ).toBe(true);
  });

  it('keeps pre-1.5 interactive or actionable custom() dialogs blocking', () => {
    expect(pendingRequestBlocksForInput({ method: 'custom', interactive: true })).toBe(true);
    // Unparseable component: the browser falls back to a free-text reply box.
    expect(pendingRequestBlocksForInput({ method: 'custom' })).toBe(true);
    expect(
      pendingRequestBlocksForInput({ method: 'custom', parsed: { kind: 'input', label: 'Name' } })
    ).toBe(true);
    expect(
      pendingRequestBlocksForInput({
        method: 'custom',
        parsed: { kind: 'button', label: 'Approve' },
      })
    ).toBe(true);
  });
});

describe('normalizeCustomBlocked', () => {
  it('accepts known kinds and bounds the message', () => {
    expect(normalizeCustomBlocked({ kind: 'question', message: 'Pick a color' })).toEqual({
      kind: 'question',
      message: 'Pick a color',
    });
    expect(
      normalizeCustomBlocked({ kind: 'auth', message: 'x'.repeat(2000) })?.message
    ).toHaveLength(500);
  });

  it('rejects malformed values', () => {
    expect(normalizeCustomBlocked(undefined)).toBeUndefined();
    expect(normalizeCustomBlocked(true)).toBeUndefined();
    expect(normalizeCustomBlocked({ kind: 'busy', message: 'no' })).toBeUndefined();
    expect(normalizeCustomBlocked({ kind: 'question', message: 42 })).toEqual({
      kind: 'question',
      message: '',
    });
  });
});
