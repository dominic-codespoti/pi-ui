/**
 * Terminal-input bridge: routes composer keystrokes through pi-tui
 * extensions' onTerminalInput handlers while preserving native-feeling
 * typing.
 *
 * Two application tiers per keydown when a terminal-input handler is active:
 *
 * - **Optimistic** keys (caret movement, Backspace/Delete, Tab, …) run their
 *   app/native behavior immediately; the verdict arrives in the background
 *   and a consumed verdict reverts best-effort.
 * - **Awaited** keys (printable chars, Enter, Escape) hold the key until the
 *   verdict lands, then apply it (or its handler-provided rewrite).
 *
 * Correctness rests on three monotonic counters owned here:
 * - `generation` — bumped by every flush/discard; queued executors and late
 *   verdicts compare their capture-time generation before acting.
 * - `discardEpoch` — bumped ONLY by session-switch discards, so a stale entry
 *   from session A never resurrects into session B even if unrelated flushes
 *   also invalidate its generation.
 * - edit sequence numbers — distinguish "this key's own expected native
 *   change" from "something else edited the text" (paste, IME, programmatic).
 */
import { encodeTerminalKey } from '#lib/terminal-key-encoder.js';

/** Structural subset of HTMLTextAreaElement the bridge touches. */
export interface ComposerElement {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setRangeText(text: string, start: number, end: number, mode?: 'end' | 'start' | 'preserve'): void;
  setSelectionRange(start: number, end: number): void;
  dispatchEvent(ev: Event): boolean;
}

export interface ComposerSnapshot {
  value: string;
  start: number;
  end: number;
  seq: number;
  /** foreign-edit counter at snapshot time — any bump before the verdict
   *  arrives means something OTHER than this key's own expected native
   *  action changed the text (paste, IME, programmatic, another verdict). */
  foreignSeq: number;
  menuOpen: boolean;
  /** Native delete was prevented (keys were pending) — replayed at verdict time. */
  deferredDelete?: 'backward' | 'forward';
}

export interface TerminalVerdict {
  consumed: boolean;
  data?: string;
}

export interface TerminalBridgeDeps {
  /** Live composer element (null → operate on the fallback string). */
  el: () => ComposerElement | null;
  /** Composer text when no element is mounted. */
  getFallback: () => string;
  setFallback: (v: string) => void;
  send: (msg: {
    type: 'extension_terminal_input';
    id: string;
    data: string;
    sessionId: string;
  }) => void;
  getSessionId: () => string;
  /** App-level composer key handling (menus, submit); returns truthy when handled. */
  handleComposerKey: (e: KeyboardEvent) => unknown;
  /** Global shortcut handling — replayed for awaited Escapes. */
  handleGlobalKeydown: (e: KeyboardEvent) => void;
  isMenuOpen: () => boolean;
  /** Called after any composer mutation (resize, mirror flush…). */
  onEdit: () => void;
}

export class TerminalInputBridge {
  private readonly deps: TerminalBridgeDeps;

  private chain: Promise<void> = Promise.resolve();
  /** Bumped when pending inputs are flushed/discarded — stale queued executors
   *  and late verdicts check it before sending/applying anything. */
  private generation = 0;
  /** See class doc — epoch semantics make each entry's capture point authoritative. */
  private discardEpoch = 0;

  private pending = new Map<string, (verdict: TerminalVerdict, discard?: boolean) => void>();
  private editSeq = 0;
  /** Bumped by any composer input event NOT attributable to the immediately
   *  preceding optimistic keydown's own native action. */
  private foreignEditSeq = 0;
  /** True for the one input event expected to follow an optimistic keydown's
   *  own native default action (if it produces one at all — arrows/Home/End
   *  don't). Cleared on a microtask so a key with NO native input event (e.g.
   *  a bare arrow) never misattributes a LATER, unrelated edit to itself. */
  private expectingNativeEdit = false;

  constructor(deps: TerminalBridgeDeps) {
    this.deps = deps;
  }

  /** Composer `input` event: attribute the edit to the pending optimistic key or mark it foreign. */
  handleComposerInput(): void {
    if (this.expectingNativeEdit) {
      this.expectingNativeEdit = false;
    } else {
      this.foreignEditSeq++;
    }
    this.deps.onEdit();
  }

  /**
   * Entry point from the composer's keydown handler. Returns true when the
   * key was routed through the terminal bridge; false when the caller should
   * run plain composer handling instead.
   */
  handleKeydown(
    e: KeyboardEvent,
    opts: { handshakeComplete: boolean; terminalActive: boolean }
  ): boolean {
    // During the reconnect handshake (socket open, connected not yet arrived)
    // sessionId/terminalInputActive still describe the previous session —
    // routing a key now would dispatch it to the wrong session's handlers.
    if (!opts.handshakeComplete || !opts.terminalActive || e.isComposing) return false;
    const data = encodeTerminalKey(e);
    if (!data) return false;

    const optimistic = isOptimisticTerminalKey(e);
    const el = this.deps.el();
    const fallbackLen = this.deps.getFallback().length;
    const snapshot: ComposerSnapshot = {
      value: el?.value ?? this.deps.getFallback(),
      start: el?.selectionStart ?? fallbackLen,
      end: el?.selectionEnd ?? fallbackLen,
      seq: ++this.editSeq,
      foreignSeq: this.foreignEditSeq,
      menuOpen: this.deps.isMenuOpen(),
    };
    if (optimistic) {
      // Native default action applies the key; app-level handling runs now.
      // Backspace/Delete with earlier keys still in flight would delete
      // against pre-verdict text (terminal order breaks: "a" then ⌫ must
      // delete the "a"). Defer those until the pending verdicts land.
      if ((e.key === 'Backspace' || e.key === 'Delete') && this.pending.size > 0) {
        e.preventDefault();
        e.stopPropagation();
        snapshot.deferredDelete = e.key === 'Backspace' ? 'backward' : 'forward';
      } else {
        this.expectingNativeEdit = true;
        this.deps.handleComposerKey(e);
        queueMicrotask(() => {
          this.expectingNativeEdit = false;
        });
      }
    } else {
      e.preventDefault();
      e.stopPropagation();
    }
    this.enqueue(e, data, optimistic, snapshot);
    return true;
  }

  /** Verdict for a previously sent `extension_terminal_input`. */
  resolveResult(id: string, verdict: TerminalVerdict): void {
    const settle = this.pending.get(id);
    if (settle) settle(verdict);
  }

  /** Socket close / reconnect: queued keys still belong to this session —
   *  apply them unconsumed; no epoch bump. */
  flushPendingInputs(): void {
    this.generation++;
    for (const settle of [...this.pending.values()]) settle({ consumed: false });
    this.pending.clear();
    this.chain = Promise.resolve();
  }

  /** Session switch — keys sent for the previous session must neither be
   *  applied to the new session's composer nor routed to it. */
  discardPendingInputs(): void {
    this.discardEpoch++;
    this.generation++;
    for (const settle of [...this.pending.values()]) settle({ consumed: false }, true);
    this.pending.clear();
    this.chain = Promise.resolve();
  }

  private enqueue(e: KeyboardEvent, data: string, optimistic: boolean, snapshot: ComposerSnapshot) {
    const id = crypto.randomUUID();
    const gen = this.generation;
    const capturedDiscardEpoch = this.discardEpoch;
    this.chain = this.chain
      .then(
        () =>
          new Promise<void>((resolve) => {
            // Flushed/discarded (socket close, session switch) while queued —
            // this key must neither be sent nor applied.
            if (gen !== this.generation) {
              if (capturedDiscardEpoch === this.discardEpoch) {
                // Only flush(es) — never a discard — happened since capture,
                // so this key still belongs to the current session and must
                // not vanish.
                this.applyResult(e, { consumed: false }, snapshot, optimistic);
              }
              resolve();
              return;
            }
            const entry = {
              applied: false,
              timeout: setTimeout(() => settle({ consumed: false }), 2000),
            };
            const settle = (verdict: TerminalVerdict, discard = false) => {
              if (entry.applied) return;
              entry.applied = true;
              clearTimeout(entry.timeout);
              this.pending.delete(id);
              resolve();
              if (!discard) this.applyResult(e, verdict, snapshot, optimistic);
            };
            this.pending.set(id, settle);
            this.deps.send({
              type: 'extension_terminal_input',
              id,
              data,
              sessionId: this.deps.getSessionId(),
            });
          })
      )
      .catch(() => {
        this.pending.delete(id);
        if (gen === this.generation || capturedDiscardEpoch === this.discardEpoch) {
          this.applyResult(e, { consumed: false }, snapshot, optimistic);
        }
      });
  }

  private applyResult(
    e: KeyboardEvent,
    verdict: TerminalVerdict,
    snapshot: ComposerSnapshot,
    optimistic: boolean
  ) {
    if (verdict.consumed) {
      // Best-effort revert: only when no later keydown intervened AND the
      // text wasn't changed by a non-keydown edit (paste/IME/programmatic)
      // while the verdict was in flight.
      if (snapshot.seq === this.editSeq && snapshot.foreignSeq === this.foreignEditSeq) {
        this.restoreComposer(snapshot);
      }
      return;
    }
    if (verdict.data !== undefined) {
      // pi-tui replaces the key with the rewritten data. For optimistic keys
      // the native default action already ran, so undo it first (guarded).
      if (
        optimistic &&
        snapshot.seq === this.editSeq &&
        snapshot.foreignSeq === this.foreignEditSeq
      )
        this.restoreComposer(snapshot);
      this.applyRewrittenData(verdict.data, e);
      return;
    }
    if (optimistic) {
      if (snapshot.deferredDelete) {
        // Earlier verdicts have landed by now (chain order) — delete against
        // the live text so terminal order is preserved.
        this.deleteComposerText(snapshot.deferredDelete === 'backward');
      } else if (!snapshot.menuOpen && this.deps.isMenuOpen()) {
        // The key's app-level handling may have run before an earlier awaited
        // key's verdict opened the slash menu (fast typing: "/" then ArrowDown).
        // Replay the menu interaction now that the menu exists.
        this.deps.handleComposerKey(e);
      }
      return;
    }
    if (this.deps.handleComposerKey(e)) return;

    if (e.key === 'Enter') this.insertText('\n');
    // Shift+Enter newline
    else if (e.key.length === 1) this.insertText(e.key);
    else if (e.key === 'Escape') {
      // The awaited tier preventDefault+stopPropagation'd this key, so the
      // window handler (close panels, dismiss modal) never saw it — replay it.
      this.deps.handleGlobalKeydown(e);
    }
    // Other unmapped keys: nothing to apply.
  }

  /**
   * Applies handler-rewritten data. In pi-tui the rewritten bytes are
   * processed as a key, not inserted literally — map the single-byte
   * sequences with real composer actions; anything else is inserted as text
   * (the only current consumer never rewrites).
   */
  private applyRewrittenData(data: string, sourceEvent: KeyboardEvent) {
    if (data === '\r') {
      // Rewritten to Enter — replay the composer's Enter handling with the
      // original event's modifiers (shift state decides submit vs newline).
      // A real KeyboardEvent is required: handleComposerKey calls
      // preventDefault(), which throws Illegal invocation on event fakes.
      this.deps.handleComposerKey(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          shiftKey: sourceEvent.shiftKey,
        })
      );
      return;
    }
    if (data === '\x1b') {
      // Rewritten to Escape — replay global Escape handling (close panels)
      // with the key transformed, since handleGlobalKeydown reads e.key.
      this.deps.handleGlobalKeydown(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
          ctrlKey: sourceEvent.ctrlKey,
          metaKey: sourceEvent.metaKey,
          shiftKey: sourceEvent.shiftKey,
          altKey: sourceEvent.altKey,
        })
      );
      return;
    }
    this.insertText(data);
  }

  insertText(text: string): void {
    const el = this.deps.el();
    if (!el) {
      this.deps.setFallback(this.deps.getFallback() + text);
      return;
    }
    const start = el.selectionStart ?? this.deps.getFallback().length;
    const end = el.selectionEnd ?? this.deps.getFallback().length;
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
    );
    this.deps.onEdit();
  }

  /** Native-equivalent Backspace/Delete against the live composer text. */
  private deleteComposerText(backward: boolean): void {
    const el = this.deps.el();
    if (!el) {
      const cur = this.deps.getFallback();
      this.deps.setFallback(backward ? cur.slice(0, Math.max(0, cur.length - 1)) : cur.slice(1));
      return;
    }
    const start = el.selectionStart ?? this.deps.getFallback().length;
    const end = el.selectionEnd ?? this.deps.getFallback().length;
    const delStart = backward ? Math.max(0, start - (start === end ? 1 : 0)) : start;
    const delEnd = backward ? end : Math.min(el.value.length, end + (start === end ? 1 : 0));
    el.setRangeText('', delStart, delEnd, 'end');
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: backward ? 'deleteContentBackward' : 'deleteContentForward',
      })
    );
    this.deps.onEdit();
  }

  private restoreComposer(s: ComposerSnapshot): void {
    const el = this.deps.el();
    if (!el) {
      this.deps.setFallback(s.value);
      return;
    }
    el.value = s.value;
    el.setSelectionRange(s.start, s.end);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop' }));
    this.deps.onEdit();
  }
}

/**
 * Keys whose native textarea behavior is complex (caret/selection/line
 * movement, clipboard, focus) are applied natively and the verdict arrives
 * in the background; consumed keys are reverted best-effort. All other keys
 * (printable chars, Enter, Escape) await the verdict before applying.
 */
function isOptimisticTerminalKey(e: KeyboardEvent): boolean {
  // Ctrl/Alt-modified keys are optimistic EXCEPT Enter — a consumed
  // Ctrl+Enter/Alt+Enter verdict must be able to veto the submit.
  if (e.ctrlKey || e.altKey) return e.key !== 'Enter';
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'Home':
    case 'End':
    case 'PageUp':
    case 'PageDown':
    case 'Backspace':
    case 'Delete':
    case 'Tab':
    case 'Insert':
      return true;
    default:
      return false;
  }
}
