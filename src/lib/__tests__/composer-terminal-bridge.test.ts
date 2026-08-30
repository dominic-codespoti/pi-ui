import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalInputBridge, type ComposerElement } from '../composer-terminal-bridge';

/** Minimal structural textarea stand-in (unit env is plain Node — no DOM). */
function fakeComposer(initial = ''): ComposerElement & { events: string[] } {
  const el = {
    value: initial,
    selectionStart: initial.length as number | null,
    selectionEnd: initial.length as number | null,
    events: [] as string[],
    setRangeText(text: string, start: number, end: number) {
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + text.length;
    },
    setSelectionRange(start: number, end: number) {
      el.selectionStart = start;
      el.selectionEnd = end;
    },
    dispatchEvent(ev: Event) {
      el.events.push(ev.type);
      return true;
    },
  };
  return el;
}

// Node lacks InputEvent — the bridge only constructs it for dispatch bookkeeping.
class FakeInputEvent {
  constructor(
    public type: string,
    public init?: Record<string, unknown>
  ) {}
}
vi.stubGlobal('InputEvent', FakeInputEvent);

interface Harness {
  bridge: TerminalInputBridge;
  composer: ReturnType<typeof fakeComposer>;
  sent: Array<{ id: string; data: string; sessionId: string }>;
  composerKeyEvents: KeyboardEvent[];
  globalEvents: string[];
  /** Press a key and let the enqueue microtask register the pending entry. */
  press(e: KeyboardEvent): Promise<void>;
  /** Resolve the verdict the fake server produced for the Nth sent key. */
  respond(index: number, verdict: { consumed: boolean; data?: string }): void;
}

function makeHarness(): Harness {
  const composer = fakeComposer('');
  const sent: Array<{ id: string; data: string; sessionId: string }> = [];
  const composerKeyEvents: KeyboardEvent[] = [];
  const globalEvents: string[] = [];

  const bridge = new TerminalInputBridge({
    el: () => composer,
    getFallback: () => composer.value,
    setFallback: (v) => (composer.value = v),
    send: (msg) => void sent.push(msg),
    getSessionId: () => 's1',
    handleComposerKey: (e) => void composerKeyEvents.push(e),
    handleGlobalKeydown: (e) => void globalEvents.push(e.key),
    isMenuOpen: () => false,
    onEdit: () => {},
  });
  return {
    bridge,
    composer,
    sent,
    composerKeyEvents,
    globalEvents,
    async press(e) {
      bridge.handleKeydown(e, { handshakeComplete: true, terminalActive: true });
      // The enqueue chain registers the pending entry on a microtask.
      await Promise.resolve();
      await Promise.resolve();
    },
    respond(index, verdict) {
      bridge.resolveResult(sent[index].id, verdict);
    },
  };
}

function typeableKey(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('awaited (non-optimistic) keys', () => {
  it('holds printable keys until the verdict lands', async () => {
    const h = makeHarness();
    await h.press(typeableKey('a'));
    expect(h.composer.value).toBe('');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].sessionId).toBe('s1');
  });

  it('inserts the character when the verdict arrives unconsumed', async () => {
    const h = makeHarness();
    await h.press(typeableKey('a'));
    h.respond(0, { consumed: false });
    expect(h.composer.value).toBe('a');
    expect(h.composer.events.some((e) => e === 'input')).toBe(true);
  });

  it('applies nothing when consumed without a rewrite', async () => {
    const h = makeHarness();
    await h.press(typeableKey('x'));
    h.respond(0, { consumed: true });
    expect(h.composer.value).toBe('');
  });

  it('routes Enter through app handling when unconsumed', async () => {
    const h = makeHarness();
    await h.press(typeableKey('Enter'));
    h.respond(0, { consumed: false });
    expect(h.composerKeyEvents.length).toBeGreaterThan(0);
  });

  it('replays Escape through global handling when unconsumed', async () => {
    const h = makeHarness();
    await h.press(typeableKey('Escape'));
    h.respond(0, { consumed: false });
    expect(h.globalEvents).toContain('Escape');
  });

  it('applies rewritten data in place of the literal key', async () => {
    const h = makeHarness();
    await h.press(typeableKey('a'));
    h.respond(0, { consumed: false, data: 'REWRITTEN' });
    expect(h.composer.value).toBe('REWRITTEN');
  });

  it('times out after 2s and applies the key unconsumed', async () => {
    const h = makeHarness();
    await h.press(typeableKey('q'));
    await vi.advanceTimersByTimeAsync(2001);
    expect(h.composer.value).toBe('q');
  });
});

describe('flush and discard epochs', () => {
  it('flush applies queued keys unconsumed; discard drops them silently', async () => {
    const flushCase = makeHarness();
    await flushCase.press(typeableKey('k'));
    flushCase.bridge.flushPendingInputs();
    await vi.runAllTimersAsync();
    expect(flushCase.composer.value).toBe('k');

    const discardCase = makeHarness();
    await discardCase.press(typeableKey('k'));
    discardCase.bridge.discardPendingInputs();
    await vi.runAllTimersAsync();
    expect(discardCase.composer.value).toBe('');
  });

  it('a key queued before a session-switch discard stays dead across later flushes', async () => {
    const h = makeHarness();
    await h.press(typeableKey('old-session-key'));
    h.bridge.discardPendingInputs();
    // A later, unrelated flush must not resurrect the discarded entry.
    h.bridge.flushPendingInputs();
    await vi.runAllTimersAsync();
    expect(h.composer.value).toBe('');
  });
});

describe('optimistic keys and revert guards', () => {
  it('reverts a consumed caret key to its snapshot when no foreign edit intervened', async () => {
    const h = makeHarness();
    h.composer.value = 'hello';
    h.composer.setSelectionRange(3, 3);
    await h.press(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    // Simulate the native default action having moved the caret.
    h.composer.setSelectionRange(2, 2);
    h.respond(0, { consumed: true });
    expect(h.composer.selectionStart).toBe(3); // restored to snapshot
  });

  it('does NOT revert when unrelated edits happened while in flight', async () => {
    const h = makeHarness();
    h.composer.value = 'hello';
    h.composer.setSelectionRange(3, 3);
    await h.press(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    h.composer.setSelectionRange(2, 2);
    // Foreign edit (paste/IME) between native action and verdict.
    h.bridge.handleComposerInput();
    h.respond(0, { consumed: true });
    expect(h.composer.selectionStart).toBe(2); // untouched
  });

  it('defers Backspace while earlier keys are pending, preserving terminal order', async () => {
    const h = makeHarness();
    await h.press(typeableKey('a')); // awaited key — now pending
    const prevented: string[] = [];
    const backspace = new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true });
    vi.spyOn(backspace, 'preventDefault').mockImplementation(() => void prevented.push('pd'));

    await h.press(backspace);
    expect(prevented).toContain('pd'); // delete was deferred, not applied natively

    // "a" verdict lands first → inserts "a"; the serialized chain only then
    // sends the deferred backspace, whose verdict deletes it.
    h.respond(0, { consumed: false });
    expect(h.composer.value).toBe('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toHaveLength(2);
    h.respond(1, { consumed: false });
    expect(h.composer.value).toBe(''); // deferred delete applied against live text
  });
});
