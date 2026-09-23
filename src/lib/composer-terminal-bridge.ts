import { encodeTerminalKey } from '#lib/terminal-key-encoder.js';

/**
 * Composer terminal-input bridge — extracted from +page.svelte.
 *
 * When a session extension registers `onTerminalInput`, the server sets
 * `terminalInputActive` and every composer keystroke is ALSO forwarded as
 * pi-tui key bytes for an extension verdict (consumed / rewritten /
 * unconsumed). The overlay's hidden input (interactive custom components)
 * always needs this; the composer only needs it while an interactive overlay
 * is open. Outside that window the composer is a plain textarea: no sends,
 * no snapshots, no revert bookkeeping.
 *
 * Why a class: the bridge owns ~10 pieces of coupled mutable state (seq
 * counters, pending verdict map, native-edit expectation) that must stay
 * consistent across keydown → input → verdict → flush/discard. A closure
 * keeps it out of the page component without prop-drilling.
 */

export type TerminalVerdict = { consumed: boolean; data?: string };

const TERMINAL_VERDICT_TIMEOUT_MS = 2000;

type ComposerSnapshot = {
  value: string;
  start: number;
  end: number;
  seq: number;
  /** composerForeignEditSeq at snapshot time — any bump before the verdict
   *  arrives means something OTHER than this key's own expected native
   *  action changed the text (paste, IME, programmatic, another verdict). */
  foreignSeq: number;
  /** composerEditSeq whose native default action last painted at snapshot
   *  time — lets the verdict tell whether this key's own native action
   *  painted (lastNativeEditSeq advanced past it) or not (synthetic event,
   *  prevented default). Only meaningful with expectsNativeInsert. */
  nativeSeq: number;
  /** True for plain unmodified printable keys — the only keys whose native
   *  default action inserts text and whose verdict may apply a fallback. */
  expectsNativeInsert: boolean;
  menuOpen: boolean;
  /** Native delete was prevented (keys were pending) — replayed at verdict time. */
  deferredDelete?: 'backward' | 'forward';
  /** Composer value length when a delete was deferred — the verdict only
   *  replays when the unconsumed verdicts of earlier keys landed since,
   *  which is exactly when the live length grew past this base. */
  deferredBaseLength?: number;
};

export interface ComposerBridgeHost {
  /** Live textarea element (undefined when unmounted). */
  get inputEl(): HTMLTextAreaElement | undefined;
  /** Current Svelte `input` state (fallback when inputEl is missing). */
  getInput(): string;
  setInput(value: string): void;
  /** Whether the slash menu is currently open (snapshot field). */
  isMenuOpen(): boolean;
  /** App-level key handling: slash nav, Enter submit. Returns true if handled. */
  handleKey(e: KeyboardEvent): boolean;
  /** Global Escape handling (panels, modals). */
  handleGlobalKey(e: KeyboardEvent): void;
  /** Resize the textarea after a programmatic edit. */
  resize(): void;
  /** Send a terminal-input key to the server. */
  sendTerminalInput(id: string, data: string, sessionId: string): void;
  /** Current session id for stamping sends. */
  getSessionId(): string | null;
}
/**
 * Keys applied immediately (never gated on the server verdict).
 * Plain printable characters paint via the textarea's native default
 * action and are reverted best-effort if the verdict says consumed; the
 * verdict still reaches extensions in the background. Only Enter and
 * Escape await the verdict, so a consumed verdict can veto submit/close.
 */
export function isOptimisticTerminalKey(e: KeyboardEvent): boolean {
  // Ctrl/Alt-modified keys are optimistic EXCEPT Enter — a consumed
  // Ctrl+Enter/Alt+Enter verdict must be able to veto the submit.
  if (e.ctrlKey || e.altKey) return e.key !== 'Enter';
  // Plain printable characters (no modifiers): native paint, revert on consumed.
  if (!e.metaKey && e.key.length === 1) return true;
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

export class ComposerTerminalBridge {
  private pending = new Map<
    string,
    {
      event: KeyboardEvent;
      optimistic: boolean;
      snapshot: ComposerSnapshot;
      deadline: number;
      applied: boolean;
    }
  >();
  /** In-flight keys whose paint awaits the server verdict (Enter/Escape). */
  private pendingAwaitedCount = 0;
  private composerEditSeq = 0;
  private composerForeignEditSeq = 0;
  private lastNativeEditSeq = -1;
  private expectingNativeEdit = false;
  private expectedNativeSeq = -1;
  /** True while insertText/deleteText/restore mutate the textarea. Their
   *  dispatched input events re-enter noteInput via the page handler and must
   *  not consume a real key's pending native expectation. */
  private applyingOwnEdit = false;
  private nextId = 0;
  private deadlineTimer: Timer | undefined;
  private deadlineAt = 0;

  constructor(private readonly host: ComposerBridgeHost) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Call from the textarea's oninput. The input event carries which kind of
   *  edit just painted, so classify directly instead of racing the browser's
   *  native default action with an expiry timer (a microtask drains before the
   *  native input event, misclassifying every real keystroke as foreign and
   *  double-inserting on the unconsumed verdict). */
  noteInput(event?: InputEvent): void {
    if (this.applyingOwnEdit) return;
    if (this.expectingNativeEdit && this.expectedNativeSeq === this.composerEditSeq) {
      if (this.isNativeKeyPaint(event)) {
        this.expectingNativeEdit = false;
        this.lastNativeEditSeq = this.composerEditSeq;
        return;
      }
    }
    this.composerForeignEditSeq++;
  }

  /** Whether an input event is the pending key's own native default action.
   *  Accepted types are exactly what natively follows an optimistic keydown:
   *  a single-char insert or a backward/forward delete. Paste, drop, IME,
   *  and multi-char replacements are foreign even mid-expectation. An absent
   *  event (direct caller) keeps the historical native classification. */
  private isNativeKeyPaint(event?: InputEvent): boolean {
    const type = event?.inputType ?? '';
    if (type === '') return true;
    if (type === 'deleteContentBackward' || type === 'deleteContentForward') return true;
    if (type !== 'insertText') return false;
    const data = event?.data;
    return data == null || data.length <= 1;
  }

  /**
   * Keydown entry — returns true when the bridge consumed the event
   * (async verdict path armed). Returns false when the caller should run
   * plain local handling (bridge inactive or key unencodable).
   */
  handleKeydown(e: KeyboardEvent, bridgeActive: boolean): boolean {
    if (!bridgeActive || e.isComposing) return false;
    const data = encodeTerminalKey(e);
    if (!data) return false;
    const optimistic = isOptimisticTerminalKey(e);
    const expectsNativeInsert =
      optimistic && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1;
    const inputEl = this.host.inputEl;
    const input = this.host.getInput();
    const snapshot: ComposerSnapshot = {
      value: inputEl?.value ?? input,
      start: inputEl?.selectionStart ?? input.length,
      end: inputEl?.selectionEnd ?? input.length,
      seq: ++this.composerEditSeq,
      foreignSeq: this.composerForeignEditSeq,
      nativeSeq: this.lastNativeEditSeq,
      expectsNativeInsert,
      menuOpen: this.host.isMenuOpen(),
    };
    if (optimistic) {
      // Native default action applies the key; app-level handling runs now.
      // With ANY earlier key's verdict still in flight, a native
      // Backspace/Delete would delete against pre-verdict text (terminal
      // order breaks: "a" then ⌫ must delete the "a"). Defer those until
      // the pending verdicts land; everything else paints in order natively.
      if ((e.key === 'Backspace' || e.key === 'Delete') && this.pending.size > 0) {
        e.preventDefault();
        e.stopPropagation();
        snapshot.deferredDelete = e.key === 'Backspace' ? 'backward' : 'forward';
        snapshot.deferredBaseLength = (inputEl?.value ?? input).length;
      } else {
        // Arm the native-paint expectation only for keys whose default action
        // mutates the value (printable insert, non-deferred delete).
        // Non-mutating optimistic keys (arrows, Home/End, …) paint nothing:
        // arming for them would misclassify a later foreign insert as their
        // native paint and let a consumed verdict erase it. Synthetic
        // keydowns produce no native input, so their verdict falls back to
        // programmatic insert (see verdict path). The pending expectation
        // must NOT expire on a timer: a microtask drains before the browser
        // dispatches the native input event, so expiry misclassifies real
        // keystrokes as foreign and the unconsumed verdict double-inserts.
        // A later keydown overwrites the seq stamp, so stale expectations
        // self-invalidate without a timer.
        if (expectsNativeInsert || e.key === 'Backspace' || e.key === 'Delete') {
          this.expectingNativeEdit = true;
          this.expectedNativeSeq = snapshot.seq;
        }
        this.host.handleKey(e);
      }
    } else {
      e.preventDefault();
      e.stopPropagation();
    }
    this.enqueue(e, data, optimistic, snapshot);
    return true;
  }

  /** Settle an incoming server verdict by id. Returns false when unknown. */
  settleVerdict(id: string, verdict: TerminalVerdict): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.settleEntry(id, entry, verdict);
    return true;
  }

  /** Socket close/reconnect: queued verdicts never arrive — settle as unconsumed. */
  flush(): void {
    this.clearDeadlineTimer();
    for (const [id, entry] of this.pending) this.settleEntry(id, entry, { consumed: false });
    this.pending.clear();
    this.pendingAwaitedCount = 0;
    this.clearDeadlineTimer();
  }

  /** Session switch — keys for the previous session must never apply. */
  discard(): void {
    this.clearDeadlineTimer();
    for (const entry of this.pending.values()) entry.applied = true;
    this.pending.clear();
    this.pendingAwaitedCount = 0;
  }

  private enqueue(
    e: KeyboardEvent,
    data: string,
    optimistic: boolean,
    snapshot: ComposerSnapshot
  ): void {
    const id = `k${(++this.nextId).toString(36)}`;
    // Fire-and-forget: typing must never wait on an earlier key's verdict.
    const entry = {
      event: e,
      optimistic,
      snapshot,
      deadline: Date.now() + TERMINAL_VERDICT_TIMEOUT_MS,
      applied: false,
    };
    this.pending.set(id, entry);
    this.scheduleDeadline(entry.deadline);
    if (!optimistic) this.pendingAwaitedCount++;
    this.host.sendTerminalInput(id, data, this.host.getSessionId() ?? '');
  }

  private settleEntry(
    id: string,
    entry: {
      event: KeyboardEvent;
      optimistic: boolean;
      snapshot: ComposerSnapshot;
      deadline: number;
      applied: boolean;
    },
    verdict: TerminalVerdict
  ): void {
    if (entry.applied) return;
    entry.applied = true;
    this.pending.delete(id);
    if (!entry.optimistic) this.pendingAwaitedCount = Math.max(0, this.pendingAwaitedCount - 1);
    this.applyResult(entry.event, verdict, entry.snapshot, entry.optimistic);
  }

  private scheduleDeadline(deadline: number): void {
    if (this.deadlineTimer !== undefined && this.deadlineAt <= deadline) return;
    if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer);
    this.deadlineAt = deadline;
    this.deadlineTimer = setTimeout(() => this.expirePending(), Math.max(0, deadline - Date.now()));
  }

  private expirePending(): void {
    this.deadlineTimer = undefined;
    this.deadlineAt = 0;
    const now = Date.now();
    let nextDeadline = Infinity;
    for (const [id, entry] of this.pending) {
      if (entry.deadline <= now) this.settleEntry(id, entry, { consumed: false });
      else if (entry.deadline < nextDeadline) nextDeadline = entry.deadline;
    }
    if (nextDeadline !== Infinity) this.scheduleDeadline(nextDeadline);
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimer === undefined) return;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    this.deadlineAt = 0;
  }

  private applyResult(
    e: KeyboardEvent,
    verdict: TerminalVerdict,
    snapshot: ComposerSnapshot,
    optimistic: boolean
  ): void {
    if (verdict.consumed) {
      // Best-effort revert: only when no later keydown intervened AND the
      // text wasn't changed by a non-keydown edit (paste/IME/programmatic)
      // while the verdict was in flight. A consumed Backspace/Delete whose
      // native effect was simulated (E2E) or deferred paints exactly one
      // native edit for its own seq — that is still its own edit, so revert
      // it even though composerEditSeq advanced past the snapshot.
      const ownNativeEdit =
        (e.key === 'Backspace' || e.key === 'Delete') &&
        this.lastNativeEditSeq === snapshot.seq + 1 &&
        snapshot.foreignSeq === this.composerForeignEditSeq;
      if (
        (snapshot.seq === this.composerEditSeq &&
          snapshot.foreignSeq === this.composerForeignEditSeq) ||
        ownNativeEdit
      ) {
        this.restore(snapshot);
      }
      return;
    }
    if (verdict.data !== undefined) {
      // pi-tui replaces the key with the rewritten data. For optimistic keys
      // the native default action already ran, so undo it first (guarded).
      if (
        optimistic &&
        snapshot.seq === this.composerEditSeq &&
        snapshot.foreignSeq === this.composerForeignEditSeq
      )
        this.restore(snapshot);
      this.applyRewrittenData(verdict.data, e);
      return;
    }
    if (optimistic) {
      // Plain printable key whose native default action never painted
      // (synthetic keydown in tests, default prevented elsewhere): its
      // verdict arriving unconsumed is the only paint signal, so insert now.
      // No seq/foreign guard here — later keydowns are normal fast typing and
      // verdicts arrive in send order, so inserting at the live caret keeps
      // terminal order. The painted check alone prevents double-insert.
      if (snapshot.expectsNativeInsert && this.lastNativeEditSeq < snapshot.seq) {
        this.insertText(e.key);
        return;
      }
      if (snapshot.deferredDelete) {
        // Replay only when an earlier key's unconsumed verdict painted since
        // the deferral (live length grew past the deferred base) — otherwise
        // the delete's own synthetic native effect already ran and replaying
        // would double-delete.
        const liveLength = (this.host.inputEl?.value ?? this.host.getInput()).length;
        if (liveLength > (snapshot.deferredBaseLength ?? -1))
          this.deleteText(snapshot.deferredDelete === 'backward');
      } else if (!snapshot.menuOpen && this.host.isMenuOpen()) {
        // The key's app-level handling may have run before an earlier awaited
        // key's verdict opened the slash menu (fast typing: "/" then ArrowDown).
        // Replay the menu interaction now that the menu exists.
        this.host.handleKey(e);
      }
      return;
    }
    if (this.host.handleKey(e)) return;

    if (e.key === 'Enter') this.insertText('\n');
    else if (e.key.length === 1) this.insertText(e.key);
    // Shift+Enter newline
    else if (e.key === 'Escape') {
      // The awaited tier preventDefault+stopPropagation'd this key, so the
      // window handler (close panels, dismiss modal) never saw it — replay it.
      this.host.handleGlobalKey(e);
    }
    // Other unmapped keys: nothing to apply.
  }

  /**
   * Applies handler-rewritten data. In pi-tui the rewritten bytes are
   * processed as a key, not inserted literally — map the single-byte
   * sequences with real composer actions; anything else is inserted as text
   * (the only current consumer never rewrites).
   */
  private applyRewrittenData(data: string, sourceEvent: KeyboardEvent): void {
    if (data === '\r') {
      // Rewritten to Enter — replay the composer's Enter handling with the
      // original event's modifiers (shift state decides submit vs newline).
      // A real KeyboardEvent is required: handleKey calls
      // preventDefault(), which throws Illegal invocation on event fakes.
      this.host.handleKey(
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
      // with the key transformed, since handleGlobalKey reads e.key.
      this.host.handleGlobalKey(
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

  private insertText(text: string): void {
    const inputEl = this.host.inputEl;
    if (!inputEl) {
      this.host.setInput(this.host.getInput() + text);
      return;
    }
    const input = this.host.getInput();
    const start = inputEl.selectionStart ?? input.length;
    const end = inputEl.selectionEnd ?? input.length;
    this.applyingOwnEdit = true;
    try {
      inputEl.setRangeText(text, start, end, 'end');
      inputEl.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
      );
    } finally {
      this.applyingOwnEdit = false;
    }
    this.host.resize();
  }

  /** Native-equivalent Backspace/Delete against the live composer text. */
  private deleteText(backward: boolean): void {
    const inputEl = this.host.inputEl;
    const input = this.host.getInput();
    if (!inputEl) {
      this.host.setInput(backward ? input.slice(0, Math.max(0, input.length - 1)) : input.slice(1));
      return;
    }
    const start = inputEl.selectionStart ?? input.length;
    const end = inputEl.selectionEnd ?? input.length;
    const delStart = backward ? Math.max(0, start - (start === end ? 1 : 0)) : start;
    const delEnd = backward ? end : Math.min(inputEl.value.length, end + (start === end ? 1 : 0));
    this.applyingOwnEdit = true;
    try {
      inputEl.setRangeText('', delStart, delEnd, 'end');
      inputEl.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: backward ? 'deleteContentBackward' : 'deleteContentForward',
        })
      );
    } finally {
      this.applyingOwnEdit = false;
    }
    this.host.resize();
  }

  private restore(s: ComposerSnapshot): void {
    const inputEl = this.host.inputEl;
    if (!inputEl) {
      this.host.setInput(s.value);
      return;
    }
    this.applyingOwnEdit = true;
    try {
      inputEl.value = s.value;
      inputEl.setSelectionRange(s.start, s.end);
      inputEl.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop' })
      );
    } finally {
      this.applyingOwnEdit = false;
    }
    this.host.resize();
  }
}
