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
export const MIN_WIRE_BLOCK_CHARS = 512;

export interface WireBudgetOptions {
  blockCap?: number; // default MAX_WIRE_BLOCK_CHARS (80_000); per text/thinking block
  messageCap?: number; // default 128_000; max combined content chars per message
  totalBudget?: number; // default 512_000; global char budget across all messages
}

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

function countCapabbleBlocks(content: unknown[]): number {
  let count = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (
      ('text' in block && typeof block.text === 'string') ||
      ('thinking' in block && typeof block.thinking === 'string')
    ) {
      count++;
    }
  }
  return count;
}

function getBlockContentChars(block: unknown): number {
  if (!block || typeof block !== 'object') return 0;
  let len = 0;
  if ('text' in block && typeof block.text === 'string') {
    len += block.text.length;
  }
  if ('thinking' in block && typeof block.thinking === 'string') {
    len += block.thinking.length;
  }
  return len;
}

/**
 * Bound message payloads to fit within wire character budgets.
 *
 * Semantics:
 * - Returned array has EXACTLY the input's length and order.
 * - Newest-first allocation: iterate from END spending budget.
 * - Only 'text'/'thinking' block fields and plain-string content are capped.
 * - Truncation suffix reuses the existing truncated() wording verbatim.
 * - Copy-on-write: messages already under all caps keep their ORIGINAL object reference.
 * - Non-object entries pass through.
 * - Per-message: effectiveBlockCap = min(blockCap, floor(remainingMsgCap / capabbleBlockCount))
 *   walking that message's blocks; a message consumes min(its post-cap content chars, remainingTotal)
 *   from totalBudget; once remaining <= 0 later (older) messages use blockCap = MIN_WIRE_BLOCK_CHARS.
 */
export function boundMessagesForWire(messages: unknown[], options?: WireBudgetOptions): unknown[] {
  const defaultBlockCap = options?.blockCap ?? MAX_WIRE_BLOCK_CHARS;
  const messageCap = options?.messageCap ?? 128_000;
  let remainingTotalBudget = options?.totalBudget ?? 512_000;

  let arrayChanged = false;
  const result = new Array(messages.length);

  // Iterate newest-first (from end to start)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object' || !('content' in msg)) {
      result[i] = msg;
      continue;
    }

    const currentBlockCap = remainingTotalBudget <= 0 ? MIN_WIRE_BLOCK_CHARS : defaultBlockCap;

    const content = msg.content;

    if (typeof content === 'string') {
      const effectiveCap = Math.min(currentBlockCap, messageCap);
      if (content.length <= effectiveCap) {
        result[i] = msg;
        const consumed = Math.min(content.length, Math.max(0, remainingTotalBudget));
        remainingTotalBudget -= consumed;
      } else {
        arrayChanged = true;
        const truncatedContent = truncated(content, effectiveCap);
        result[i] = { ...msg, content: truncatedContent };
        const consumed = Math.min(effectiveCap, Math.max(0, remainingTotalBudget));
        remainingTotalBudget -= consumed;
      }
      continue;
    }

    if (!Array.isArray(content)) {
      result[i] = msg;
      continue;
    }

    let remainingMsgCap = messageCap;
    let capabbleCount = countCapabbleBlocks(content);
    let blocksChanged = false;
    let postCapChars = 0;

    const newBlocks = content.map((block) => {
      if (!block || typeof block !== 'object') return block;
      const isCapabble =
        ('text' in block && typeof block.text === 'string') ||
        ('thinking' in block && typeof block.thinking === 'string');

      if (!isCapabble) return block;

      const effectiveBlockCap = Math.min(
        currentBlockCap,
        capabbleCount > 0 ? Math.floor(remainingMsgCap / capabbleCount) : remainingMsgCap
      );

      const nextBlock = trimBlock(block, effectiveBlockCap);
      if (nextBlock !== block) {
        blocksChanged = true;
      }

      const chars = getBlockContentChars(nextBlock);
      postCapChars += chars;
      remainingMsgCap -= Math.min(getBlockContentChars(block), effectiveBlockCap);
      capabbleCount--;

      return nextBlock;
    });

    const consumed = Math.min(postCapChars, Math.max(0, remainingTotalBudget));
    remainingTotalBudget -= consumed;

    if (!blocksChanged) {
      result[i] = msg;
    } else {
      arrayChanged = true;
      result[i] = { ...msg, content: newBlocks };
    }
  }

  return arrayChanged ? result : messages;
}
