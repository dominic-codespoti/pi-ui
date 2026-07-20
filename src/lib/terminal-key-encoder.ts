/**
 * Encodes browser `KeyboardEvent`s into the raw terminal byte sequences that
 * `@earendil-works/pi-tui` components (`Input`, `Editor`, `SelectList`, …)
 * expect from real stdin — see `pi-tui/dist/keys.js` (`matchesKey`,
 * `LEGACY_KEY_SEQUENCES`, `LEGACY_SHIFT_SEQUENCES`, `LEGACY_CTRL_SEQUENCES`,
 * `rawCtrlChar`). This lets the browser act as a real terminal for pi-ui's
 * extension "custom UI" overlay instead of re-deriving pi-tui's keybinding
 * surface by hand — every current and future `tui.*` keybinding (word
 * jumps, kill-ring, undo, etc.) works automatically because the server
 * forwards the exact bytes a real terminal would send.
 *
 * pi-tui does not run with the Kitty keyboard protocol enabled server-side,
 * so this intentionally targets only the legacy/xterm sequences pi-tui
 * recognizes without it. A few modifier combinations that pi-tui can only
 * recognize via Kitty CSI-u (e.g. alt+Delete, alt+shift+letter) have no
 * legacy encoding and are dropped — their bindings still have a legacy
 * alternative (e.g. alt+d for delete-word-forward).
 */

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/** Keys that carry no payload on their own (modifier-only keydowns, IME candidate keys, etc.). */
const IGNORED_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Unidentified',
  'Dead',
  'ContextMenu',
]);

const NAMED_FUNCTION_KEYS: Record<string, string> = {
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
};

/**
 * Ctrl+key control byte, mirroring pi-tui's `rawCtrlChar()` exactly:
 * letters a-z → 1-26, `[ \ ] _ -` → 27, 28, 29, 31, 31 (`-` aliases `_`).
 */
function rawCtrlChar(key: string): string | null {
  const char = key.toLowerCase();
  const code = char.charCodeAt(0);
  if ((code >= 97 && code <= 122) || char === '[' || char === '\\' || char === ']' || char === '_') {
    return String.fromCharCode(code & 0x1f);
  }
  if (char === '-') return String.fromCharCode(31);
  return null;
}

/**
 * Encodes a single keydown as the terminal byte sequence pi-tui expects, or
 * `null` if the key carries no terminal payload (bare modifiers, unmapped
 * media/navigation keys, IME composition steps) — callers should leave the
 * browser's default behavior alone in that case rather than guess.
 */
export function encodeTerminalKey(e: KeyboardEvent): string | null {
  const { key, ctrlKey, altKey, metaKey, shiftKey } = e;

  // Cmd (Meta) combinations are OS/browser shortcuts (Cmd+C, Cmd+Tab, …),
  // not terminal input — leave them alone.
  if (metaKey) return null;
  if (IGNORED_KEYS.has(key)) return null;

  switch (key) {
    case 'Escape':
      return '\x1b';
    case 'Enter':
      return '\r';
    case 'Tab':
      return shiftKey ? '\x1b[Z' : '\t';
    case 'Backspace':
      return altKey ? '\x1b\x7f' : '\x7f';
    case 'Delete':
      return '\x1b[3~';
    case 'Insert':
      return '\x1b[2~';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';
    case 'ArrowUp':
      if (altKey) return '\x1bp';
      if (ctrlKey) return '\x1bOa';
      if (shiftKey) return '\x1b[a';
      return '\x1b[A';
    case 'ArrowDown':
      if (altKey) return '\x1bn';
      if (ctrlKey) return '\x1bOb';
      if (shiftKey) return '\x1b[b';
      return '\x1b[B';
    case 'ArrowRight':
      if (altKey) return '\x1bf';
      if (ctrlKey) return '\x1b[1;5C';
      if (shiftKey) return '\x1b[c';
      return '\x1b[C';
    case 'ArrowLeft':
      if (altKey) return '\x1bb';
      if (ctrlKey) return '\x1b[1;5D';
      if (shiftKey) return '\x1b[d';
      return '\x1b[D';
    default:
      break;
  }

  const fnSeq = NAMED_FUNCTION_KEYS[key];
  if (fnSeq) return fnSeq;

  // Printable characters: letters, digits, symbols, space. The browser
  // already applies Shift for us (e.g. Shift+1 → "!", Shift+a → "A"), so an
  // unmodified/shift-only key is sent through verbatim.
  if (key.length === 1) {
    if (ctrlKey && altKey && !shiftKey) {
      const ctrlChar = rawCtrlChar(key);
      return ctrlChar ? '\x1b' + ctrlChar : null;
    }
    if (ctrlKey && !altKey) {
      if (key === ' ') return '\x00';
      const ctrlChar = rawCtrlChar(key);
      return ctrlChar ?? null;
    }
    if (altKey && !ctrlKey) {
      return key === ' ' ? '\x1b ' : '\x1b' + key;
    }
    return key;
  }

  return null;
}

/** Wraps text in bracketed-paste markers so pi-tui's `Input`/`Editor` insert
 *  it literally (including newlines) instead of interpreting it as keystrokes. */
export function wrapBracketedPaste(text: string): string {
  return BRACKETED_PASTE_START + text + BRACKETED_PASTE_END;
}
