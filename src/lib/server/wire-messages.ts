/**
 * Size-bounding for message payloads sent over the WebSocket.
 *
 * A single runaway reasoning/text block (hundreds of KB to MB) inside the
 * initial `connected` / `session_loaded` / `older_messages` payloads can
 * stall JSON.stringify on the server, blow up JSON.parse + markdown render
 * on the client (especially mobile), and wedge reconnect loops. History
 * blocks beyond the cap are truncated for transfer only — the session file
 * on disk keeps the full text.
 */

/** Per-block character cap for history payloads (~20k tokens). */
export const MAX_WIRE_BLOCK_CHARS = 80_000;

function truncated(text: string, maxChars: number): string {
  const dropped = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n… [pi-ui: ${dropped.toLocaleString('en-US')} characters truncated for transfer — full text is preserved in the session file]`;
}

/** Trim a content block copy-on-write; returns the original when under cap. */
function trimBlock(block: unknown, maxChars: number): unknown {
  if (!block || typeof block !== 'object') return block;
  let out: object = block;
  if ('text' in out && typeof out.text === 'string' && out.text.length > maxChars) {
    out = { ...out, text: truncated(out.text, maxChars) };
  }
  if ('thinking' in out && typeof out.thinking === 'string' && out.thinking.length > maxChars) {
    out = { ...out, thinking: truncated(out.thinking, maxChars) };
  }
  return out;
}

/**
 * Bound every text/thinking block (and string content) in a message array to
 * `maxChars` characters. Copy-on-write: untouched messages/blocks keep their
 * identity, and the input array is never mutated (it is the live in-memory
 * session history).
 */
export function trimMessagesForWire(
  messages: unknown[],
  maxChars: number = MAX_WIRE_BLOCK_CHARS
): unknown[] {
  let changed = false;
  const out = messages.map((msg) => {
    if (!msg || typeof msg !== 'object' || !('content' in msg)) return msg;
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.length <= maxChars) return msg;
      changed = true;
      return { ...msg, content: truncated(content, maxChars) };
    }
    if (!Array.isArray(content)) return msg;
    let blocksChanged = false;
    const blocks = content.map((block) => {
      const next = trimBlock(block, maxChars);
      if (next !== block) blocksChanged = true;
      return next;
    });
    if (!blocksChanged) return msg;
    changed = true;
    return { ...msg, content: blocks };
  });
  return changed ? out : messages;
}
