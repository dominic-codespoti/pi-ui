import {
  extractTextContent,
  formatToolInput,
  rawMessagesToUI,
  uid,
  type CompactionNoticeDetails,
  type UIMessage,
} from '#lib/client-messages.js';
import type { ContextUsage, ModelInfo, ServerMessage } from '#lib/ws/protocol.js';

export type SessionReducerState = {
  sessionId: string | null;
  isStreaming: boolean;
  activeToolName: string | undefined;
  model: ModelInfo | null;
  thinkingLevel: string;
  availableModels: ModelInfo[];
  cwd: string;
  sessionPath: string | undefined;
  sessionName: string | undefined;
  messages: UIMessage[];
  activeStreamMsg: UIMessage | null;
  toolsById: Map<string, UIMessage>;
  contextUsage: ContextUsage | null;
  queuedSteering: string[];
  queuedFollowUp: string[];
  isCompacting: boolean;
  compactionStartedAt: number | null;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  totalRawMessagesLoaded: number;
  totalMessageCount: number;
  messagesTruncated: boolean;
  toolsExpanded: boolean;
};

export type SessionRenderEffect = {
  type: 'render_message';
  messageId: string;
  streaming: boolean;
  scroll: boolean;
};

export type SessionScrollEffect = { type: 'scroll_bottom' };
export type SessionEffect = SessionRenderEffect | SessionScrollEffect;

export type SessionSnapshotAction = {
  type: 'snapshot';
  payload: Record<string, unknown>;
};

export type SessionEventAction = {
  type: 'event';
  message: ServerMessage | Record<string, unknown>;
};

export type SessionAction = SessionSnapshotAction | SessionEventAction;

export type SessionReducerOptions = {
  now?: () => number;
  createId?: () => string;
};

export type SessionReducerResult = {
  state: SessionReducerState;
  effects: SessionEffect[];
  identityChanged: boolean;
  transcriptReplaced: boolean;
};

const defaultOptions: Required<SessionReducerOptions> = {
  now: () => Date.now(),
  createId: uid,
};

export function createSessionReducerState(
  overrides: Partial<SessionReducerState> = {}
): SessionReducerState {
  return {
    sessionId: null,
    isStreaming: false,
    activeToolName: undefined,
    model: null,
    thinkingLevel: 'off',
    availableModels: [],
    cwd: '',
    sessionPath: undefined,
    sessionName: undefined,
    messages: [],
    activeStreamMsg: null,
    toolsById: new Map(),
    contextUsage: null,
    queuedSteering: [],
    queuedFollowUp: [],
    isCompacting: false,
    compactionStartedAt: null,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    totalRawMessagesLoaded: 0,
    totalMessageCount: 0,
    messagesTruncated: false,
    toolsExpanded: false,
    ...overrides,
  };
}

function contextUsage(value: unknown, fallbackWindow = 0): ContextUsage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { tokens?: number | null; contextWindow?: number; percent?: number | null };
  const tokens = raw.tokens ?? null;
  const contextWindow = raw.contextWindow ?? fallbackWindow;
  return {
    tokens,
    contextWindow,
    percent:
      raw.percent ?? (tokens !== null && contextWindow > 0 ? (tokens / contextWindow) * 100 : null),
  };
}

function addToolIndex(state: SessionReducerState, message: UIMessage): void {
  if (message.role === 'tool' && message.toolCallId)
    state.toolsById.set(message.toolCallId, message);
}

function rebuildToolIndex(state: SessionReducerState): void {
  state.toolsById = new Map();
  for (const message of state.messages) addToolIndex(state, message);
}

function findTool(state: SessionReducerState, toolCallId: string): UIMessage | undefined {
  return state.toolsById.get(toolCallId);
}

function createTool(
  state: SessionReducerState,
  toolName: string,
  toolCallId: string | undefined,
  details: Record<string, unknown> | undefined,
  renderedCallHtml: string[] | undefined,
  options: Required<SessionReducerOptions>
): UIMessage | undefined {
  if (!toolCallId) return undefined;
  const existing = findTool(state, toolCallId);
  if (existing) {
    return existing;
  }
  const created: UIMessage = {
    id: options.createId(),
    role: 'tool',
    content: '',
    toolName,
    toolCallId,
    toolInput: formatToolInput(toolName, details),
    renderedCallHtml,
    streaming: true,
    expanded: state.toolsExpanded,
    startMs: options.now(),
    createdAt: options.now(),
  };
  state.messages.push(created);
  state.toolsById.set(toolCallId, created);
  return created;
}

function lastStreaming(state: SessionReducerState, role: UIMessage['role']): UIMessage | undefined {
  if (role === 'tool') {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const message = state.messages[i];
      if (message.role === 'tool' && message.streaming) return message;
    }
    return undefined;
  }
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i];
    if (message.role === role && message.streaming) return message;
  }
  return undefined;
}

function sealStreaming(state: SessionReducerState, effects: SessionEffect[]): void {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i];
    if (
      message.streaming &&
      message.role === 'assistant' &&
      !message.content &&
      !message.thinking
    ) {
      state.messages.splice(i, 1);
    } else if (message.streaming) {
      message.streaming = false;
      effects.push({
        type: 'render_message',
        messageId: message.id,
        streaming: false,
        scroll: false,
      });
    }
  }
  state.activeStreamMsg = null;
}

function applySnapshot(
  state: SessionReducerState,
  payload: Record<string, unknown>,
  effects: SessionEffect[],
  options: Required<SessionReducerOptions>
): { identityChanged: boolean; transcriptReplaced: boolean } {
  const previousSessionId = state.sessionId;
  const nextSessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  const identityChanged = nextSessionId !== undefined && nextSessionId !== previousSessionId;
  let transcriptReplaced = false;

  if (identityChanged) {
    state.sessionId = nextSessionId!;
    // Identity changes clear session-owned transcript and context before the
    // optional authoritative replacement below. This ordering is deliberate.
    state.messages = [];
    state.activeStreamMsg = null;
    state.toolsById = new Map();
    state.contextUsage = null;
    state.queuedSteering = [];
    state.queuedFollowUp = [];
    state.compactionStartedAt = null;
    state.isCompacting = false;
    transcriptReplaced = true;
  }
  const isFullSnapshot = payload.type === 'connected' || payload.type === 'session_loaded';
  if ('isStreaming' in payload) state.isStreaming = Boolean(payload.isStreaming);
  if ('activeToolName' in payload) {
    const incoming = payload.activeToolName;
    state.activeToolName =
      typeof incoming === 'string' && incoming.length > 0 ? incoming : undefined;
  } else if (isFullSnapshot || identityChanged) {
    state.activeToolName = undefined;
  }
  if (payload.model !== undefined) state.model = (payload.model as ModelInfo | null) ?? null;
  if (typeof payload.thinkingLevel === 'string') state.thinkingLevel = payload.thinkingLevel;
  if (payload.availableModels !== undefined)
    state.availableModels = (payload.availableModels as ModelInfo[]) ?? [];
  if (typeof payload.cwd === 'string' && payload.cwd) state.cwd = payload.cwd;
  if ('sessionPath' in payload) {
    state.sessionPath = typeof payload.sessionPath === 'string' ? payload.sessionPath : undefined;
  } else if (payload.sessionMode === 'in-memory') {
    state.sessionPath = undefined;
  }
  if ('sessionName' in payload) {
    state.sessionName = typeof payload.sessionName === 'string' ? payload.sessionName : undefined;
  } else if (isFullSnapshot) {
    state.sessionName = undefined;
  }

  if ('messages' in payload) {
    const raw = (payload.messages as unknown[]) ?? [];
    const streamingMessage = payload.streamingMessage;
    state.messages = rawMessagesToUI(
      streamingMessage === undefined ? raw : [...raw, streamingMessage]
    );
    rebuildToolIndex(state);
    state.activeStreamMsg = null;
    if (streamingMessage !== undefined && state.isStreaming) {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const message = state.messages[i];
        if (message.role === 'assistant') {
          message.streaming = true;
          state.activeStreamMsg = message;
          break;
        }
      }
    }
    state.totalRawMessagesLoaded = raw.length;
    if ('totalMessageCount' in payload)
      state.totalMessageCount = Number(payload.totalMessageCount) || 0;
    if ('messagesTruncated' in payload)
      state.messagesTruncated = Boolean(payload.messagesTruncated);
    transcriptReplaced = true;
  }

  if ('queuedSteering' in payload || 'queuedFollowUp' in payload) {
    state.queuedSteering = Array.isArray(payload.queuedSteering)
      ? [...(payload.queuedSteering as string[])]
      : [];
    state.queuedFollowUp = Array.isArray(payload.queuedFollowUp)
      ? [...(payload.queuedFollowUp as string[])]
      : [];
  } else if ('sessionId' in payload) {
    state.queuedSteering = [];
    state.queuedFollowUp = [];
  }

  let window = 0;
  if (state.model?.contextWindow) window = state.model.contextWindow;
  if ('contextUsage' in payload) {
    if (payload.contextUsage === null) {
      state.contextUsage = null;
    } else {
      const incoming = contextUsage(payload.contextUsage, window);
      if (incoming) {
        state.contextUsage = incoming;
        if (incoming.contextWindow > 0) window = incoming.contextWindow;
      }
    }
  }
  if (state.contextUsage === null && window > 0) {
    state.contextUsage = contextUsage({ tokens: null, contextWindow: window }, window);
  } else if (window > 0 && state.contextUsage) {
    state.contextUsage = { ...state.contextUsage, contextWindow: window };
  }

  if ('isCompacting' in payload) {
    state.isCompacting = Boolean(payload.isCompacting);
    state.compactionStartedAt = state.isCompacting
      ? (state.compactionStartedAt ?? options.now())
      : null;
  }
  if ('autoCompactionEnabled' in payload)
    state.autoCompactionEnabled = Boolean(payload.autoCompactionEnabled ?? true);
  if ('autoRetryEnabled' in payload)
    state.autoRetryEnabled = Boolean(payload.autoRetryEnabled ?? true);

  if (identityChanged) effects.push({ type: 'scroll_bottom' });
  return { identityChanged, transcriptReplaced };
}

function applyEvent(
  state: SessionReducerState,
  frame: Record<string, unknown>,
  effects: SessionEffect[],
  options: Required<SessionReducerOptions>
): void {
  const type = frame.type;
  switch (type) {
    case 'agent_start':
      state.isStreaming = true;
      state.activeToolName = undefined;
      return;
    case 'agent_end':
    case 'agent_error':
      state.isStreaming = false;
      state.activeToolName = undefined;
      sealStreaming(state, effects);
      return;
    case 'message_start': {
      const message = frame.message as { role?: string } | undefined;
      if (message?.role === 'assistant') {
        const assistant: UIMessage = {
          id: options.createId(),
          role: 'assistant',
          content: '',
          thinking: '',
          thinkingExpanded: false,
          streaming: true,
          startMs: options.now(),
          createdAt: options.now(),
        };
        state.messages.push(assistant);
        state.activeStreamMsg = assistant;
      }
      return;
    }
    case 'message_update': {
      const event = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      const active = state.activeStreamMsg;
      if (!active || typeof event?.delta !== 'string') return;
      if (event.type === 'text_delta') {
        active.content += event.delta;
        effects.push({
          type: 'render_message',
          messageId: active.id,
          streaming: true,
          scroll: true,
        });
      } else if (event.type === 'thinking_delta') {
        active.thinking = (active.thinking ?? '') + event.delta;
        if (!active.thinkingStartMs) active.thinkingStartMs = options.now();
        effects.push({
          type: 'render_message',
          messageId: active.id,
          streaming: true,
          scroll: false,
        });
      }
      return;
    }
    case 'message_end': {
      const endMessage = frame.message as
        | {
            role?: string;
            content?: {
              type: string;
              text?: string;
              thinking?: string;
              data?: string;
              mimeType?: string;
            }[];
            usage?: {
              input: number;
              output: number;
              totalTokens: number;
              cost?: { total?: number };
            };
            stopReason?: string;
          }
        | undefined;
      if (endMessage?.role === 'custom') {
        const [custom] = rawMessagesToUI([endMessage]);
        if (custom) state.messages.push(custom);
      }
      if (endMessage?.role === 'assistant') {
        const active = state.activeStreamMsg;
        if (active) {
          active.endMs = options.now();
          active.streaming = false;
          if (endMessage.stopReason === 'aborted') {
            active.aborted = true;
            active.content = 'Operation aborted';
          } else {
            const content = endMessage.content ?? [];
            const text = extractTextContent(content);
            const thinking = content
              .filter((block) => block.type === 'thinking')
              .map((block) => block.thinking ?? block.text ?? '')
              .join('');
            if (text) active.content = text;
            if (thinking) active.thinking = thinking;
            if (endMessage.usage) {
              active.usage = {
                input: endMessage.usage.input,
                output: endMessage.usage.output,
                totalTokens: endMessage.usage.totalTokens,
                cost: { total: endMessage.usage.cost?.total ?? 0 },
              };
            }
            const images = content.filter(
              (block) => block.type === 'image' && block.data && block.mimeType
            );
            if (images.length > 0)
              active.images = images.map((block) => `data:${block.mimeType};base64,${block.data}`);
          }
          effects.push({
            type: 'render_message',
            messageId: active.id,
            streaming: false,
            scroll: false,
          });
        }
      }
      state.activeStreamMsg = null;
      if (frame.contextUsage)
        state.contextUsage = contextUsage(
          frame.contextUsage,
          state.contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0
        );
      return;
    }
    case 'tool_execution_start': {
      const toolName = (frame.toolName as string | undefined) ?? 'tool';
      const toolCallId = frame.toolCallId as string | undefined;
      const details = (frame.args ?? frame.input ?? frame.details) as
        Record<string, unknown> | undefined;
      const tool = createTool(
        state,
        toolName,
        toolCallId,
        details,
        frame.renderedCallHtml as string[] | undefined,
        options
      );
      state.activeToolName = toolName;
      if (tool) {
        tool.toolName = toolName;
        tool.toolInput = formatToolInput(toolName, details);
        tool.renderedCallHtml = frame.renderedCallHtml as string[] | undefined;
        tool.streaming = true;
        tool.isError = false;
        tool.outputLoading = false;
        tool.outputElided = false;
        tool.endMs = undefined;
      }
      return;
    }
    case 'tool_execution_update': {
      const toolCallId = frame.toolCallId as string | undefined;
      const toolName = (frame.toolName as string | undefined) ?? state.activeToolName ?? 'tool';
      const details = (frame.args ?? frame.input ?? frame.details) as
        Record<string, unknown> | undefined;
      if (typeof frame.toolName === 'string') state.activeToolName = toolName;
      const tool = toolCallId
        ? createTool(
            state,
            toolName,
            toolCallId,
            details,
            frame.renderedCallHtml as string[] | undefined,
            options
          )
        : lastStreaming(state, 'tool');
      if (tool) {
        const partial = frame.partialResult as
          { content?: { type: string; text?: string }[] } | undefined;
        if (partial?.content) {
          tool.content = extractTextContent(partial.content);
          delete tool.renderedResultHtml;
        }
        if (frame.renderedResultHtml)
          tool.renderedResultHtml = frame.renderedResultHtml as string[];
      }
      return;
    }
    case 'tool_execution_end': {
      const toolCallId = frame.toolCallId as string | undefined;
      const toolName = (frame.toolName as string | undefined) ?? state.activeToolName ?? 'tool';
      const details = (frame.args ?? frame.input ?? frame.details) as
        Record<string, unknown> | undefined;
      const tool = toolCallId
        ? createTool(
            state,
            toolName,
            toolCallId,
            details,
            frame.renderedCallHtml as string[] | undefined,
            options
          )
        : lastStreaming(state, 'tool');
      state.activeToolName = undefined;
      if (!tool) return;
      if (frame.renderedResultHtml) tool.renderedResultHtml = frame.renderedResultHtml as string[];
      tool.streaming = false;
      tool.endMs = options.now();
      tool.isError = Boolean(frame.isError ?? false);
      const result = frame.result as
        | {
            content?: { type: string; text?: string; data?: string; mimeType?: string }[];
            details?: { diff?: string; patch?: string };
          }
        | undefined;
      if (result?.content) {
        tool.content = extractTextContent(result.content);
        const images = result.content.filter(
          (block) => block.type === 'image' && block.data && block.mimeType
        );
        if (images.length > 0)
          tool.images = images.map((block) => `data:${block.mimeType};base64,${block.data}`);
      }
      const diff = result?.details?.diff ?? result?.details?.patch;
      if (diff) {
        tool.diff = diff;
        tool.lineCount = diff.split('\n').length;
        tool.expanded = true;
      } else if (tool.content) {
        tool.lineCount = tool.content.split('\n').length;
        if (tool.isError || (tool.lineCount <= 8 && tool.content.length <= 400))
          tool.expanded = true;
      }
      return;
    }
    case 'bash_execution_update': {
      const id = frame.id as string | undefined;
      const bash = id ? createTool(state, 'bash', id, undefined, undefined, options) : undefined;
      state.activeToolName = 'bash';
      const delta = frame.delta as string | undefined;
      if (bash && delta) {
        bash.streaming = true;
        bash.lineCount = bash.content.split('\n').length;
        delete bash.renderedResultHtml;
      }
      return;
    }
    case 'tool_output': {
      const toolCallId = frame.toolCallId as string | undefined;
      if (!toolCallId) return;
      const tool = findTool(state, toolCallId);
      if (!tool) return;
      if (frame.content !== undefined) tool.content = frame.content as string;
      if (frame.details !== undefined) tool.details = frame.details as string;
      if (frame.diff !== undefined) {
        tool.diff = frame.diff as string;
        tool.lineCount = tool.diff.split('\n').length;
      }
      if (frame.renderedResultHtml !== undefined)
        tool.renderedResultHtml = frame.renderedResultHtml as string[];
      tool.outputLoading = false;
      tool.outputElided = false;
      if (tool.content && tool.lineCount === undefined)
        tool.lineCount = tool.content.split('\n').length;
      return;
    }
    case 'queue_update':
      state.queuedSteering = [...new Set((frame.steering as string[] | undefined) ?? [])];
      state.queuedFollowUp = [...new Set((frame.followUp as string[] | undefined) ?? [])];
      return;
    case 'compaction_start': {
      const startedAt = options.now();
      const reason = (frame.reason as string | undefined) ?? '';
      const beforeTokens = state.contextUsage?.tokens ?? undefined;
      state.isCompacting = true;
      state.compactionStartedAt = startedAt;
      state.messages.push({
        id: options.createId(),
        role: 'notice',
        content:
          reason === 'manual'
            ? 'compacting context…'
            : `auto-compacting context (${reason || 'automatic'})…`,
        noticeKind: 'compaction',
        compaction: {
          reason: reason || 'automatic',
          status: 'running',
          startedAt,
          ...(beforeTokens !== undefined ? { tokensBefore: beforeTokens } : {}),
        },
        streaming: true,
        createdAt: startedAt,
      });
      return;
    }
    case 'compaction_end': {
      const endedAt = options.now();
      const aborted = Boolean(frame.aborted ?? false);
      const willRetry = Boolean(frame.willRetry ?? false);
      const errorMessage = frame.errorMessage as string | undefined;
      const result = frame.result as
        { estimatedTokensAfter?: number; tokensBefore?: number } | undefined;
      const context = frame.contextUsage as
        { tokens?: number | null; contextWindow?: number } | undefined;
      const notice = [...state.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'notice' && message.noticeKind === 'compaction' && message.streaming
        );
      const previous = notice?.compaction;
      const startedAt =
        state.compactionStartedAt ?? previous?.startedAt ?? notice?.createdAt ?? endedAt;
      const status: CompactionNoticeDetails['status'] = willRetry
        ? 'retrying'
        : errorMessage
          ? 'failed'
          : aborted
            ? 'aborted'
            : 'completed';
      state.isCompacting = false;
      state.compactionStartedAt = null;
      const tokensBefore = result?.tokensBefore ?? previous?.tokensBefore;
      const tokensAfter = result?.estimatedTokensAfter ?? context?.tokens ?? previous?.tokensAfter;
      if (notice) {
        notice.streaming = false;
        notice.compaction = {
          ...(previous ?? { status: 'running', startedAt }),
          reason:
            ((frame.reason as string | undefined) ?? previous?.reason ?? 'automatic').trim() ||
            'automatic',
          status,
          startedAt,
          endedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          ...(tokensBefore !== undefined ? { tokensBefore } : {}),
          ...(tokensAfter !== undefined ? { tokensAfter } : {}),
          ...(errorMessage ? { errorMessage } : {}),
          willRetry,
        };
        notice.content = willRetry
          ? `compaction failed${errorMessage ? `: ${errorMessage}` : ''} · retrying…`
          : errorMessage
            ? `compaction failed: ${errorMessage}`
            : aborted
              ? 'compaction aborted'
              : result?.tokensBefore != null && result.estimatedTokensAfter != null
                ? `context compacted · ${result.tokensBefore.toLocaleString()} → ${result.estimatedTokensAfter.toLocaleString()} tokens`
                : 'context compacted';
        effects.push({
          type: 'render_message',
          messageId: notice.id,
          streaming: false,
          scroll: false,
        });
      }
      if (context)
        state.contextUsage = contextUsage(
          context,
          state.contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0
        );
      else if (result?.estimatedTokensAfter !== undefined)
        state.contextUsage = contextUsage({
          tokens: result.estimatedTokensAfter,
          contextWindow: state.contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0,
        });
      return;
    }
    case 'auto_retry_start': {
      const attempt = (frame.attempt as number | undefined) ?? 1;
      const max = (frame.maxAttempts as number | undefined) ?? 1;
      const delayS = Math.round(((frame.delayMs as number | undefined) ?? 0) / 1000);
      const errorMessage = (frame.errorMessage as string | undefined) ?? '';
      state.messages.push({
        id: options.createId(),
        role: 'notice',
        content: `retrying (${attempt}/${max}${delayS > 0 ? `, ${delayS}s` : ''})${errorMessage ? ` — ${errorMessage}` : ''}`,
        noticeKind: 'retry',
        streaming: true,
        createdAt: options.now(),
      });
      return;
    }
    case 'auto_retry_end': {
      const notice = [...state.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'notice' && message.noticeKind === 'retry' && message.streaming
        );
      if (notice) {
        notice.streaming = false;
        const success = Boolean(frame.success ?? false);
        const finalError = frame.finalError as string | undefined;
        notice.content = success
          ? 'retry succeeded'
          : `retry failed${finalError ? `: ${finalError}` : ''}`;
      }
      return;
    }
  }
}

/**
 * Reduce a snapshot or session-scoped SDK event without importing Svelte,
 * components, routes, or server infrastructure. Background residents use the
 * same event path as the visible session and simply discard render effects.
 */
export function reduceSession(
  state: SessionReducerState,
  action: SessionAction,
  suppliedOptions: SessionReducerOptions = {}
): SessionReducerResult {
  const options = { ...defaultOptions, ...suppliedOptions };
  const effects: SessionEffect[] = [];
  if (action.type === 'snapshot') {
    const result = applySnapshot(state, action.payload, effects, options);
    return { state, effects, ...result };
  }
  applyEvent(state, action.message as Record<string, unknown>, effects, options);
  return { state, effects, identityChanged: false, transcriptReplaced: false };
}
