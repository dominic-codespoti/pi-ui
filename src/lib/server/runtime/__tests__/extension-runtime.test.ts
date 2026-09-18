import { describe, expect, it } from 'vitest';
import { ExtensionRuntime, type TerminalInputRegistryLike } from '../extension-runtime';

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
