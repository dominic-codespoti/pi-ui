export type MsgUsage = {
  input: number;
  output: number;
  totalTokens: number;
  cost: { total: number };
};

export type CompactionNoticeDetails = {
  reason?: string;
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'retrying';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  errorMessage?: string;
  willRetry?: boolean;
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
  noticeKind?: 'compaction' | 'retry' | 'custom' | 'abort' | 'toast';
  compaction?: CompactionNoticeDetails;
  customType?: string;
  renderedContent?: string;
  renderedThinking?: string;
  renderedCallHtml?: string[];
  renderedResultHtml?: string[];
  // Full tool output was withheld from the wire.
  outputElided?: boolean;
  // Original tool output character count before elision.
  outputBytes?: number;
  // True while the client fetches withheld tool output.
  outputLoading?: boolean;
  renderedNoticeHtml?: string[];
  level?: 'info' | 'warning' | 'error' | 'success';
  source?: string;
  details?: string;
  createdAt: number;
};

export function uid(): string {
  return crypto.randomUUID();
}

export function extractTextContent(blocks: unknown[]): string {
  return blocks
    .filter(
      (block): block is { type: string; text?: unknown } =>
        !!block &&
        typeof block === 'object' &&
        typeof (block as Record<string, unknown>).type === 'string'
    )
    .filter((block) => block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function messageFingerprint(msg: Record<string, unknown>): string {
  const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : 'unknown';
  const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : '';
  return `${role}:${timestamp}:${stableSerialize(msg)}`;
}
type ToolInputInfo = { name: string; input: Record<string, unknown> };
type ToolInputLookup = Map<string, ToolInputInfo>;

function toolIdAliases(id: string): string[] {
  const aliases: string[] = [];
  for (let i = 0; i < id.length; i++) {
    if (id[i] === '-' || id[i] === '_' || id[i] === ':' || id[i] === '/') {
      const alias = id.slice(i + 1);
      if (alias) aliases.push(alias);
    }
  }
  return aliases;
}

function lookupToolInput(toolInputMap: ToolInputLookup | undefined, toolCallId: string) {
  if (!toolInputMap) return undefined;
  const exact = toolInputMap.get(toolCallId);
  if (exact) return exact;
  for (const alias of toolIdAliases(toolCallId)) {
    const info = toolInputMap.get(alias);
    if (info) return info;
  }
  return undefined;
}

export function formatToolInput(
  toolName: string,
  details?: Record<string, unknown>
): string | undefined {
  if (!details) return undefined;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

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
    return p ? (p.split('/').pop() ?? p) : undefined;
  }
  if (toolName === 'edit') {
    const p = str(details.path ?? details.file_path ?? details.file);
    const basename = p ? (p.split('/').pop() ?? p) : undefined;
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
  return typeof msg.timestamp === 'number' ? msg.timestamp : 0;
}

export function agentMsgToUI(
  m: unknown,
  toolInputMap?: ToolInputLookup,
  index?: number
): UIMessage[] {
  if (!isRecord(m) || typeof m.role !== 'string') return [];
  const msg = m;

  /**
   * Derive a stable message ID from the raw SDK message.
   * Uses the SDK's own `id` field if present, otherwise hashes the complete
   * stable raw message. The optional absolute index is only a deterministic
   * tie-breaker for duplicate messages and keeps IDs distinct across pages.
   */
  function stableMsgId(msg: Record<string, unknown>, index?: number): string {
    const rawId = msg.id;
    if (typeof rawId === 'string' && rawId.length > 8) return rawId;
    const key = messageFingerprint(msg);
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash << 5) - hash + key.charCodeAt(i);
      hash |= 0;
    }
    const base = `msg-${Math.abs(hash).toString(36)}`;
    return index === undefined ? base : `${base}-${index}`;
  }
  const ts = msgTimestamp(msg);
  const rawRole = msg.role;
  if (typeof rawRole !== 'string') return [];
  const role = rawRole.toLowerCase();
  switch (role) {
    case 'user':
    case 'human': {
      let text: string;
      let images: string[] | undefined;
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const blocks = contentBlocks(msg.content);
        text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => (typeof b.text === 'string' ? b.text : ''))
          .join('');
        const imgBlocks = blocks.filter(
          (b) => b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string'
        );
        if (imgBlocks.length > 0) {
          images = imgBlocks.map((b) => `data:${b.mimeType as string};base64,${b.data as string}`);
        }
        if (!text && imgBlocks.length === 0) text = stableSerialize(msg.content);
      } else {
        text = stableSerialize(msg.content);
      }
      return [
        {
          id: stableMsgId(msg, index),
          role: 'user' as const,
          content: text,
          images,
          streaming: false,
          createdAt: ts,
        },
      ];
    }
    case 'assistant':
    case 'ai': {
      let text = '';
      let thinkingText = '';
      let images: string[] | undefined;

      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const blocks = contentBlocks(msg.content);
        text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => (typeof b.text === 'string' ? b.text : ''))
          .join('');
        thinkingText = blocks
          .filter((b) => b.type === 'thinking')
          .map((b) => (typeof b.thinking === 'string' ? b.thinking : ''))
          .join('');
        const imgBlocks = blocks.filter(
          (b) => b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string'
        );
        if (imgBlocks.length > 0) {
          images = imgBlocks.map((b) => `data:${b.mimeType as string};base64,${b.data as string}`);
        }
      }

      const rawUsage = msg.usage as
        | { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } }
        | undefined;
      const usage: MsgUsage | undefined = rawUsage?.totalTokens
        ? {
            input: rawUsage.input ?? 0,
            output: rawUsage.output ?? 0,
            totalTokens: rawUsage.totalTokens,
            cost: { total: rawUsage.cost?.total ?? 0 },
          }
        : undefined;

      return text || thinkingText || images
        ? [
            {
              id: stableMsgId(msg, index),
              role: 'assistant' as const,
              content: text,
              images,
              thinking: thinkingText || undefined,
              thinkingExpanded: false,
              streaming: false,
              usage,
              createdAt: ts,
            },
          ]
        : [];
    }
    case 'bashexecution':
    case 'bash_execution':
    case 'bash': {
      const cmd = (msg.command as string | undefined) ?? (msg.content as string | undefined);
      const output =
        (msg.output as string | undefined) ?? (typeof msg.content === 'string' ? '' : '');
      return [
        {
          id: stableMsgId(msg, index),
          role: 'tool' as const,
          toolName: 'bash',
          toolInput: cmd ? `$ ${cmd.split('\n')[0].trim()}` : undefined,
          content: output || '',
          isError: typeof msg.exitCode === 'number' && (msg.exitCode as number) !== 0,
          streaming: false,
          createdAt: ts,
        },
      ];
    }
    case 'toolresult':
    case 'tool_result': {
      const toolCallId =
        (typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined) ??
        (typeof msg.id === 'string' ? msg.id : undefined);
      const toolInfo = toolCallId ? lookupToolInput(toolInputMap, toolCallId) : undefined;
      const toolName =
        (typeof msg.toolName === 'string' ? msg.toolName : undefined) ?? toolInfo?.name ?? 'tool';
      const toolInput = toolInfo ? formatToolInput(toolName, toolInfo.input) : undefined;

      let content = '';
      let images: string[] | undefined;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const blocks = contentBlocks(msg.content);
        content = extractTextContent(blocks);
        const imgBlocks = blocks.filter(
          (b) => b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string'
        );
        if (imgBlocks.length > 0)
          images = imgBlocks.map((b) => `data:${b.mimeType as string};base64,${b.data as string}`);
      }

      const result: UIMessage = {
        id: stableMsgId(msg, index),
        role: 'tool' as const,
        toolName,
        toolCallId,
        toolInput,
        content,
        images,
        isError: (msg.isError as boolean | undefined) ?? false,
        streaming: false,
        createdAt: ts,
      };
      if (typeof msg.startMs === 'number') result.startMs = msg.startMs;
      if (typeof msg.endMs === 'number') result.endMs = msg.endMs;
      const rawUsage = msg.usage as
        | { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } }
        | undefined;
      if (rawUsage?.totalTokens !== undefined) {
        result.usage = {
          input: rawUsage.input ?? 0,
          output: rawUsage.output ?? 0,
          totalTokens: rawUsage.totalTokens,
          cost: { total: rawUsage.cost?.total ?? 0 },
        };
      }
      if (typeof msg.outputElided === 'boolean') result.outputElided = msg.outputElided;
      if (typeof msg.outputBytes === 'number') result.outputBytes = msg.outputBytes;
      return [result];
    }
    default: {
      const customType = msg.customType as string | undefined;
      if (customType === 'pi-ui:diagnostic') {
        const details = msg.details as
          { level?: string; details?: string; source?: string } | undefined;
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : typeof msg.display === 'string'
              ? msg.display
              : '[diagnostic]';
        return [
          {
            id: stableMsgId(msg, index),
            role: 'diagnostic' as const,
            content,
            level: (details?.level as 'info' | 'warning' | 'error' | 'success') ?? 'info',
            details: details?.details as string | undefined,
            source: details?.source as string | undefined,
            streaming: false,
            createdAt: ts,
          },
        ];
      }
      if (customType) {
        // display: false means LLM-context only — skip UI rendering.
        if (msg.display === false) return [];
        const details = msg.details as Record<string, unknown> | undefined;
        const rawContent = msg.content;
        let content =
          typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? extractTextContent(rawContent as { type: string; text?: string }[])
              : typeof msg.display === 'string'
                ? msg.display
                : '';
        if (!content) content = `[${customType}]`;
        if (details) {
          content += '\n\n' + JSON.stringify(details, null, 2);
        }
        return [
          {
            id: stableMsgId(msg, index),
            role: 'notice' as const,
            content,
            noticeKind: 'custom' as const,
            customType,
            renderedNoticeHtml: msg.renderedNoticeHtml as string[] | undefined,
            streaming: false,
            createdAt: ts,
          },
        ];
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

export function rawMessagesToUI(rawMessages: unknown[], absoluteOffset = 0): UIMessage[] {
  if (rawMessages.length === 0) return [];
  // Collect tool-call info before conversion so later tool results can resolve
  // exact IDs and known aliases without scanning the whole map per result.
  const fingerprints = new Map<string, number>();
  for (const raw of rawMessages) {
    if (isRecord(raw) && typeof raw.role === 'string') {
      const fingerprint = messageFingerprint(raw);
      fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
    }
  }
  const toolInputMap: ToolInputLookup = new Map();
  for (const raw of rawMessages) {
    if (!isRecord(raw) || typeof raw.role !== 'string') continue;
    const role = raw.role.toLowerCase();
    if ((role !== 'assistant' && role !== 'ai') || !Array.isArray(raw.content)) continue;
    for (const block of raw.content) {
      if (!isRecord(block)) continue;
      const id = typeof block.id === 'string' ? block.id : undefined;
      const name = typeof block.name === 'string' ? block.name : undefined;
      if (!id || !name || (block.type !== 'toolCall' && block.type !== 'tool_use')) continue;
      const rawInput = block.arguments ?? block.input;
      const input = isRecord(rawInput) ? rawInput : {};
      const info = { name, input };
      if (!toolInputMap.has(id)) toolInputMap.set(id, info);
      for (const alias of toolIdAliases(id)) {
        if (!toolInputMap.has(alias)) toolInputMap.set(alias, info);
      }
    }
  }

  const result = new Array<UIMessage>(rawMessages.length);
  let writeIdx = 0;
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i];
    if (!isRecord(m) || typeof m.role !== 'string') continue;
    const fingerprint = messageFingerprint(m);
    const duplicate = (fingerprints.get(fingerprint) ?? 0) > 1;
    const ui = agentMsgToUI(m, toolInputMap, duplicate ? absoluteOffset + i : undefined);
    for (let j = 0; j < ui.length; j++) result[writeIdx++] = ui[j];
  }
  result.length = writeIdx;
  return result;
}
