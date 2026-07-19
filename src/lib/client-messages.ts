export type MsgUsage = {
  input: number;
  output: number;
  totalTokens: number;
  cost: { total: number };
};

export type UIMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notice' | 'diagnostic';
  content: string;
  images?: string[];
  toolInput?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  streaming: boolean;
  aborted?: boolean;
  expanded?: boolean;
  diff?: string;
  lineCount?: number;
  usage?: MsgUsage;
  thinking?: string;
  thinkingExpanded?: boolean;
  startMs?: number;
  endMs?: number;
  thinkingStartMs?: number;
  detailExpanded?: boolean;
  noticeKind?: 'compaction' | 'retry' | 'custom' | 'abort';
  customType?: string;
  renderedContent?: string;
  renderedThinking?: string;
  level?: 'info' | 'warning' | 'error' | 'success';
  source?: string;
  details?: string;
  createdAt: number;
};

export function uid(): string {
  return crypto.randomUUID();
}

export function extractTextContent(blocks: { type: string; text?: string }[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

export function formatToolInput(toolName: string, details?: Record<string, unknown>): string | undefined {
  if (!details) return undefined;
  const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
  const num = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined;

  if (toolName === 'bash' || toolName === 'execute_bash') {
    const cmd = str(details.command);
    if (cmd) return `$ ${cmd.split('\n')[0].trim()}`;
  }
  if (toolName === 'read' || toolName === 'read_file') {
    const p = str(details.path ?? details.file_path ?? details.file);
    if (!p) return undefined;
    const basename = p.split('/').pop() ?? p;
    const offset = num(details.offset);
    const limit = num(details.limit);
    if (offset !== undefined) {
      const end = limit !== undefined ? offset + limit - 1 : '';
      return `${basename}:${offset}${end ? `–${end}` : '+'}`;
    }
    return basename;
  }
  if (toolName === 'write' || toolName === 'write_file') {
    const p = str(details.path ?? details.file_path ?? details.file);
    return p ? p.split('/').pop() ?? p : undefined;
  }
  if (toolName === 'edit') {
    const p = str(details.path ?? details.file_path ?? details.file);
    const basename = p ? p.split('/').pop() ?? p : undefined;
    const edits = Array.isArray(details.edits) ? details.edits.length : undefined;
    if (basename && edits !== undefined && edits > 1) return `${basename} (${edits} edits)`;
    return basename;
  }
  if (toolName === 'grep') {
    const pattern = str(details.pattern);
    const path = str(details.path);
    const glob = str(details.glob);
    if (!pattern) return undefined;
    const loc = (path ?? glob ?? '').split('/').pop() ?? '';
    return loc ? `/${pattern}/ ${loc}` : `/${pattern}/`;
  }
  if (toolName === 'find') {
    const pattern = str(details.pattern);
    const path = str(details.path);
    if (!pattern) return undefined;
    const loc = (path ?? '').split('/').pop() ?? '';
    return loc ? `${pattern} ${loc}` : pattern;
  }
  if (toolName === 'ls') {
    return str(details.path) ?? '.';
  }
  for (const v of Object.values(details)) {
    if (typeof v === 'string' && v.length < 80) return v;
  }
  return undefined;
}

function msgTimestamp(msg: Record<string, unknown>): number {
  return typeof msg.timestamp === 'number' ? (msg.timestamp as number) : Date.now();
}

export function agentMsgToUI(
  m: unknown,
  toolInputMap?: Map<string, { name: string; input: Record<string, unknown> }>,
  index?: number
): UIMessage[] {
  const msg = m as Record<string, unknown>;
  if (!msg || typeof msg.role !== 'string') return [];

/**
 * Derive a stable message ID from the raw SDK message.
 * Uses the SDK's own `id` field if present, otherwise hashes
 * role + timestamp + content prefix. This ensures re-parsed
 * messages keep the same ID across reconnects, preserving
 * Svelte keyed-DOM stability and UI state (expanded tools, etc.).
 */
function stableMsgId(msg: Record<string, unknown>, index?: number): string {
  const rawId = msg.id as string | undefined;
  if (rawId && typeof rawId === 'string' && rawId.length > 8) return rawId;
  const role = (msg.role as string) ?? 'unknown';
  const ts = msgTimestamp(msg);
  // Use first 64 chars of content/command as content fingerprint
  const content = (msg.content ?? msg.command ?? '') as string;
  const prefix = typeof content === 'string' ? content.slice(0, 64) : JSON.stringify(content).slice(0, 64);
  // The SDK's sessionEntryToContextMessages returns the inner `message` object
  // which carries NO `id` field — so rawId is always undefined for incoming
  // history payloads. The array index is the only reliably unique differentiator.
  const dedup = index !== undefined ? `:${index}` : '';
  // Simple stable hash — good enough for dedup, not cryptographic
  let hash = 0;
  const key = `${role}:${ts}:${prefix}${dedup}`;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0; // convert to 32bit int
  }
  return `msg-${ts}-${Math.abs(hash).toString(36)}`;
}

  const ts = msgTimestamp(msg);
  const role = msg.role.toLowerCase();
  switch (role) {
    case 'user':
    case 'human': {
      let text: string;
      let images: string[] | undefined;
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const blocks = msg.content as { type: string; text?: string; data?: string; mimeType?: string }[];
        text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        const imgBlocks = blocks.filter((b) => b.type === 'image' && b.data && b.mimeType);
        if (imgBlocks.length > 0) {
          images = imgBlocks.map((b) => `data:${b.mimeType};base64,${b.data}`);
        }
        if (!text && imgBlocks.length === 0) text = JSON.stringify(msg.content);
      } else {
        text = JSON.stringify(msg.content);
      }
      return [{ id: stableMsgId(msg, index), role: 'user' as const, content: text, images, streaming: false, createdAt: ts }];
    }
    case 'assistant':
    case 'ai': {
      let text = '';
      let thinkingText = '';
      let images: string[] | undefined;

      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const blocks = msg.content as {
          type: string;
          text?: string;
          thinking?: string;
          data?: string;
          mimeType?: string;
        }[];
        text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        thinkingText = blocks
          .filter((b) => b.type === 'thinking')
          .map((b) => b.thinking ?? '')
          .join('');
        const imgBlocks = blocks.filter((b): b is { type: 'image'; data: string; mimeType: string } => b.type === 'image' && !!b.data && !!b.mimeType);
        if (imgBlocks.length > 0) {
          images = imgBlocks.map((b) => `data:${b.mimeType};base64,${b.data}`);
        }
      }

      const rawUsage = msg.usage as { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } | undefined;
      const usage: MsgUsage | undefined = rawUsage?.totalTokens
        ? { input: rawUsage.input ?? 0, output: rawUsage.output ?? 0, totalTokens: rawUsage.totalTokens, cost: { total: rawUsage.cost?.total ?? 0 } }
        : undefined;

      return text || thinkingText || images
        ? [{ id: stableMsgId(msg, index), role: 'assistant' as const, content: text, images, thinking: thinkingText || undefined, thinkingExpanded: false, streaming: false, usage, createdAt: ts }]
        : [];
    }
    case 'bashexecution':
    case 'bash_execution':
    case 'bash': {
      const cmd = (msg.command as string | undefined) ?? (msg.content as string | undefined);
      const output = (msg.output as string | undefined) ?? (typeof msg.content === 'string' ? '' : '');
      return [
        {
          id: stableMsgId(msg, index),
          role: 'tool' as const,
          toolName: 'bash',
          toolInput: cmd ? `$ ${cmd.split('\n')[0].trim()}` : undefined,
          toolArgs: cmd ? { command: cmd } : undefined,
          content: output || '',
          isError: typeof msg.exitCode === 'number' && (msg.exitCode as number) !== 0,
          streaming: false,
          createdAt: ts,
        },
      ];
    }
    case 'toolresult':
    case 'tool_result': {
      const toolCallId = (msg.toolCallId as string | undefined) ?? (msg.id as string | undefined);
      let toolInfo = toolCallId ? toolInputMap?.get(toolCallId) : undefined;
      if (!toolInfo && toolCallId && toolInputMap && toolInputMap.size > 0) {
        for (const [id, info] of toolInputMap) {
          if (id.endsWith(toolCallId) || toolCallId.endsWith(id)) {
            toolInfo = info;
            break;
          }
        }
      }
      const toolName = (msg.toolName as string | undefined) ?? toolInfo?.name ?? 'tool';
      const toolInput = toolInfo ? formatToolInput(toolName, toolInfo.input) : undefined;

      let content = '';
      let images: string[] | undefined;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const blocks = msg.content as { type: string; text?: string; data?: string; mimeType?: string }[];
        content = extractTextContent(blocks);
        const imgBlocks = blocks.filter((b): b is { type: 'image'; data: string; mimeType: string } => b.type === 'image' && !!b.data && !!b.mimeType);
        if (imgBlocks.length > 0) images = imgBlocks.map((b) => `data:${b.mimeType};base64,${b.data}`);
      }

      return [
        {
          id: stableMsgId(msg, index),
          role: 'tool' as const,
          toolName,
          toolCallId,
          toolInput,
          toolArgs: toolInfo?.input,
          content,
          images,
          isError: (msg.isError as boolean | undefined) ?? false,
          streaming: false,
          createdAt: ts,
        },
      ];
    }
    default: {
      const customType = msg.customType as string | undefined;
      if (customType === 'pi-ui:diagnostic') {
        const details = msg.details as { level?: string; details?: string; source?: string } | undefined;
        const content = typeof msg.content === 'string' ? msg.content : (msg.display as string | undefined) ?? '[diagnostic]';
        return [{
          id: stableMsgId(msg, index),
          role: 'diagnostic' as const,
          content,
          level: (details?.level as 'info' | 'warning' | 'error' | 'success') ?? 'info',
          details: details?.details as string | undefined,
          source: details?.source as string | undefined,
          streaming: false,
          createdAt: ts,
        }];
      }
      if (customType) {
        const details = msg.details as Record<string, unknown> | undefined;
        const display = (msg.display as string | undefined) ?? '';
        let content = display || `[${customType}]`;
        if (details) {
          content += '\n\n' + JSON.stringify(details, null, 2);
        }
        return [{
          id: stableMsgId(msg, index),
          role: 'notice' as const,
          content,
          noticeKind: 'custom' as const,
          customType,
          streaming: false,
          createdAt: ts,
        }];
      }
      return [];
    }
  }
}

export function reconnectDelay(attempt: number): number {
  const base = Math.min(1000 * Math.pow(2, attempt), 30000);
  const jitter = Math.round(Math.random() * 1000 - 500);
  return Math.max(500, base + jitter);
}

export function rawMessagesToUI(rawMessages: unknown[]): UIMessage[] {
  if (rawMessages.length === 0) return [];
  // Single pass: collect tool-call info for matching and convert each message.
  const toolInputMap = new Map<string, { name: string; input: Record<string, unknown> }>();
  const result = new Array<UIMessage>(rawMessages.length);
  let writeIdx = 0;
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i] as Record<string, unknown>;
    if (!m || typeof m.role !== 'string') continue;
    // Collect tool call info from assistant messages (needed for later toolResult matching)
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const blk of m.content as { type: string; id?: string; name?: string; input?: Record<string, unknown>; arguments?: Record<string, unknown> }[]) {
        const isToolCall = (blk.type === 'toolCall' || blk.type === 'tool_use') && blk.id && blk.name;
        if (isToolCall) {
          toolInputMap.set(blk.id!, { name: blk.name!, input: blk.arguments ?? blk.input ?? {} });
        }
      }
    }
    // Convert and write — agentMsgToUI returns an array, spread into result.
    const ui = agentMsgToUI(m, toolInputMap, i);
    for (let j = 0; j < ui.length; j++) {
      result[writeIdx++] = ui[j];
    }
  }
  result.length = writeIdx;
  return result;
}
