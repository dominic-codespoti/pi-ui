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

import {
  MAX_WIRE_BLOCK_CHARS,
  MIN_WIRE_BLOCK_CHARS,
  MAX_WIRE_AUX_CHARS,
  MAX_WIRE_AUX_TOTAL_CHARS,
  MAX_WIRE_IMAGE_CHARS,
  MAX_WIRE_TOOL_OUTPUT_CHARS,
} from '../wire-limits.ts';

export {
  MAX_WIRE_BLOCK_CHARS,
  MIN_WIRE_BLOCK_CHARS,
  MAX_WIRE_AUX_CHARS,
  MAX_WIRE_AUX_TOTAL_CHARS,
  MAX_WIRE_IMAGE_CHARS,
  MAX_WIRE_TOOL_OUTPUT_CHARS,
} from '../wire-limits.ts';

export interface WireBudgetOptions {
  blockCap?: number; // default MAX_WIRE_BLOCK_CHARS (80_000); per text/thinking block
  messageCap?: number; // default 128_000; max combined content chars per message
  totalBudget?: number; // default 512_000; global char budget across all messages
  elideToolOutput?: boolean; // default true; fetch oversized output when its row is expanded
}

function truncated(text: string, maxChars: number): string {
  const dropped = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n… [pi-ui: ${dropped.toLocaleString('en-US')} characters truncated for transfer — full text is preserved in the session file]`;
}

function countStringChars(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object' || seen.has(value)) return 0;

  seen.add(value);
  let chars = 0;
  if (Array.isArray(value)) {
    for (const item of value) chars += countStringChars(item, seen);
  } else {
    for (const item of Object.values(value)) chars += countStringChars(item, seen);
  }
  return chars;
}

function toolOutputChars(message: Record<string, unknown>): number {
  const content = message.content;
  const contentChars =
    typeof content === 'string'
      ? content.length
      : Array.isArray(content)
        ? content.reduce((total, block) => total + getBlockContentChars(block), 0)
        : 0;
  return contentChars + countStringChars(message.details);
}

function isToolResult(message: object): boolean {
  const role = (message as Record<string, unknown>).role;
  return typeof role === 'string' && role.toLowerCase().replace('_', '') === 'toolresult';
}

function elideToolOutputs(messages: unknown[]): unknown[] {
  let result = messages;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || typeof message !== 'object' || !isToolResult(message)) continue;

    const outputBytes = toolOutputChars(message as Record<string, unknown>);
    if (outputBytes <= MAX_WIRE_TOOL_OUTPUT_CHARS) continue;

    if (result === messages) result = messages.slice();
    const next = { ...(message as Record<string, unknown>) };
    delete next.content;
    delete next.details;
    delete next.diff;
    delete next.renderedResultHtml;
    next.outputElided = true;
    next.outputBytes = outputBytes;
    result[i] = next;
  }
  return result;
}

/** Trim a content block copy-on-write; returns the original when under cap. */
function trimBlock(
  block: unknown,
  maxChars: number,
  maxImageChars = MAX_WIRE_IMAGE_CHARS
): unknown {
  if (!block || typeof block !== 'object') return block;
  let out: object = block;
  if ('text' in out && typeof out.text === 'string' && out.text.length > maxChars) {
    out = { ...out, text: truncated(out.text, maxChars) };
  }
  if ('thinking' in out && typeof out.thinking === 'string' && out.thinking.length > maxChars) {
    out = { ...out, thinking: truncated(out.thinking, maxChars) };
  }
  if ('data' in out && typeof out.data === 'string' && out.data.length > maxImageChars) {
    const next = { ...out } as Record<string, unknown>;
    delete next.data;
    if (!('text' in next)) next.text = '[image omitted: too large for transfer]';
    out = next;
  }
  return out;
}

function countBudgetableBlocks(content: unknown[]): number {
  let count = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (
      ('text' in block && typeof block.text === 'string') ||
      ('thinking' in block && typeof block.thinking === 'string') ||
      ('data' in block && typeof block.data === 'string')
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
  if ('data' in block && typeof block.data === 'string') {
    len += block.data.length;
  }
  return len;
}
const RENDERED_HTML_FIELDS = [
  'renderedCallHtml',
  'renderedResultHtml',
  'renderedNoticeHtml',
] as const;

function trimRenderedLines(value: unknown, maxChars: number): { value: unknown; consumed: number } {
  if (!Array.isArray(value)) return { value, consumed: 0 };
  let remaining = Math.max(0, maxChars);
  let changed = false;
  const lines: unknown[] = [];
  for (const line of value) {
    if (typeof line !== 'string') {
      lines.push(line);
      continue;
    }
    if (remaining <= 0) {
      changed = true;
      continue;
    }
    if (line.length <= remaining) {
      lines.push(line);
      remaining -= line.length;
      continue;
    }
    lines.push(truncated(line, remaining));
    remaining = 0;
    changed = true;
  }
  return {
    value: changed ? lines : value,
    consumed: Math.max(0, maxChars) - remaining,
  };
}

function boundRenderedFields(
  message: object,
  maxChars: number
): { message: object; consumed: number } {
  let next = message;
  let remaining = Math.max(0, maxChars);
  let consumed = 0;
  for (const field of RENDERED_HTML_FIELDS) {
    const value = (next as Record<string, unknown>)[field];
    const trimmed = trimRenderedLines(value, Math.min(MAX_WIRE_AUX_CHARS, remaining));
    if (trimmed.value !== value) {
      next = { ...(next as Record<string, unknown>), [field]: trimmed.value };
    }
    consumed += trimmed.consumed;
    remaining -= trimmed.consumed;
  }
  return { message: next, consumed };
}

/**
 * Bound message payloads to fit within wire character budgets.
 *
 * Semantics:
 * - Returned array has EXACTLY the input's length and order.
 * - Newest-first allocation: iterate from END spending content budget.
 * - Text/thinking blocks, image data, and rendered extension HTML are bounded.
 * - Truncation suffix reuses the existing truncated() wording verbatim.
 * - Tool-result output over MAX_WIRE_TOOL_OUTPUT_CHARS is elided by default; the
 *   full content is fetched when its collapsed row is expanded.
 * - Copy-on-write: messages already under all caps keep their ORIGINAL object reference.
 * - Non-object entries pass through.
 * - Per-message: effectiveBlockCap = min(blockCap, floor(remainingMsgCap / budgetableCount))
 *   walking that message's blocks; a message consumes min(its post-cap content chars, remainingTotal)
 *   from totalBudget. totalBudget is a hard ceiling covering both message content and rendered aux
 *   fields; MAX_WIRE_AUX_TOTAL_CHARS is a sub-cap within that total. Once remaining <= 0 later
 *   (older) messages use blockCap = MIN_WIRE_BLOCK_CHARS.
 */
export function boundMessagesForWire(messages: unknown[], options?: WireBudgetOptions): unknown[] {
  const wireMessages = options?.elideToolOutput === false ? messages : elideToolOutputs(messages);
  const defaultBlockCap = options?.blockCap ?? MAX_WIRE_BLOCK_CHARS;
  const messageCap = options?.messageCap ?? 128_000;
  let remainingTotalBudget = options?.totalBudget ?? 512_000;

  let arrayChanged = false;
  const result = new Array(messages.length);

  // Iterate newest-first (from end to start)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = wireMessages[i];
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
    let budgetableCount = countBudgetableBlocks(content);
    let blocksChanged = false;
    let postCapChars = 0;

    const newBlocks = content.map((block) => {
      if (!block || typeof block !== 'object') return block;
      const isBudgetable =
        ('text' in block && typeof block.text === 'string') ||
        ('thinking' in block && typeof block.thinking === 'string') ||
        ('data' in block && typeof block.data === 'string');
      if (!isBudgetable) return block;

      const effectiveBlockCap = Math.min(
        currentBlockCap,
        budgetableCount > 0 ? Math.floor(remainingMsgCap / budgetableCount) : remainingMsgCap
      );

      const nextBlock = trimBlock(block, effectiveBlockCap, MAX_WIRE_IMAGE_CHARS);
      if (nextBlock !== block) {
        blocksChanged = true;
      }

      const chars = getBlockContentChars(nextBlock);
      postCapChars += chars;
      remainingMsgCap -= Math.min(chars, Math.max(0, effectiveBlockCap));
      budgetableCount--;

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

  let remainingAuxBudget = Math.min(Math.max(0, remainingTotalBudget), MAX_WIRE_AUX_TOTAL_CHARS);
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (!msg || typeof msg !== 'object') continue;
    const bounded = boundRenderedFields(msg, remainingAuxBudget);
    remainingAuxBudget = Math.max(0, remainingAuxBudget - bounded.consumed);
    remainingTotalBudget = Math.max(0, remainingTotalBudget - bounded.consumed);
    if (bounded.message !== msg) {
      arrayChanged = true;
      result[i] = bounded.message;
    }
  }

  return arrayChanged ? result : wireMessages;
}
