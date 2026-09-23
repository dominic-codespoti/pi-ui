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
  allModels: ModelInfo[];
  cwd: string;
  sessionPath: string | undefined;
  sessionName: string | undefined;
  messages: UIMessage[];
  activeStreamMsg: UIMessage | null;
  toolsById: Map<string, UIMessage>;
  pendingToolCalls: Map<
    number,
    {
      toolCallId: string;
      toolName: string;
      preview: string;
      args?: Record<string, unknown>;
    }
  >;
  contextUsage: ContextUsage | null;
  queuedSteering: string[];
  queuedFollowUp: string[];
  queuedDeferred: string[];
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
  structureChanged: boolean;
  touchedMessageIds: string[];
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
    allModels: [],
    cwd: '',
    sessionPath: undefined,
    sessionName: undefined,
    messages: [],
    activeStreamMsg: null,
    toolsById: new Map(),
    pendingToolCalls: new Map(),
    contextUsage: null,
    queuedSteering: [],
    queuedFollowUp: [],
    queuedDeferred: [],
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

function sealStreaming(
  state: SessionReducerState,
  effects: SessionEffect[],
  touchedMessageIds: Set<string>
): void {
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
      touchedMessageIds.add(message.id);
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
    state.pendingToolCalls = new Map();
    state.contextUsage = null;
    state.queuedSteering = [];
    state.queuedFollowUp = [];
    state.queuedDeferred = [];
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
  if (payload.availableModels !== undefined) {
    const models = (payload.availableModels as ModelInfo[]) ?? [];
    state.allModels = models;
    state.availableModels = models.filter((model) => model.available !== false);
  }
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

  if ('queuedSteering' in payload || 'queuedFollowUp' in payload || 'deferred' in payload) {
    state.queuedSteering = Array.isArray(payload.queuedSteering)
      ? [...(payload.queuedSteering as string[])]
      : [];
    state.queuedFollowUp = Array.isArray(payload.queuedFollowUp)
      ? [...(payload.queuedFollowUp as string[])]
      : [];
    state.queuedDeferred = Array.isArray(payload.deferred)
      ? [...(payload.deferred as string[])]
      : [];
  } else if ('sessionId' in payload) {
    state.queuedSteering = [];
    state.queuedFollowUp = [];
    state.queuedDeferred = [];
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
  options: Required<SessionReducerOptions>,
  touchedMessageIds: Set<string>
): void {
  const type = frame.type;
  switch (type) {
    case 'agent_start':
      state.isStreaming = true;
      state.pendingToolCalls.clear();
      state.activeToolName = undefined;
      return;
    case 'agent_end': {
      state.isStreaming = false;
      state.pendingToolCalls.clear();
      state.activeToolName = undefined;
      sealStreaming(state, effects, touchedMessageIds);
      const endedMessages = Array.isArray(frame.messages) ? frame.messages : [];
      for (const message of rawMessagesToUI(endedMessages)) {
        if (
          (message.role === 'compaction_summary' || message.role === 'branch_summary') &&
          !state.messages.some((existing) => existing.id === message.id)
        ) {
          state.messages.push(message);
        }
      }
      return;
    }
    case 'agent_error':
      state.pendingToolCalls.clear();
      state.isStreaming = false;
      state.activeToolName = undefined;
      sealStreaming(state, effects, touchedMessageIds);
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
      const event = frame.assistantMessageEvent as
        | {
            type?: string;
            delta?: string;
            contentIndex?: number;
            id?: string;
            toolName?: string;
            toolCall?: { id?: string; name?: string; arguments?: unknown };
          }
        | undefined;
      if (event?.type === 'toolcall_start') {
        const contentIndex = event.contentIndex;
        if (typeof contentIndex !== 'number' || !event.id || !event.toolName) return;
        const pending = { toolCallId: event.id, toolName: event.toolName, preview: '' };
        state.pendingToolCalls.set(contentIndex, pending);
        const tool = createTool(
          state,
          pending.toolName,
          pending.toolCallId,
          undefined,
          undefined,
          options
        );
        if (tool) {
          tool.toolName = pending.toolName;
          tool.toolArgsPreview = '';
          touchedMessageIds.add(tool.id);
        }
        return;
      }
      if (event?.type === 'toolcall_delta' || event?.type === 'toolcall_end') {
        const contentIndex = event.contentIndex;
        if (typeof contentIndex !== 'number') return;
        const pending = state.pendingToolCalls.get(contentIndex);
        if (!pending) return;
        if (event.type === 'toolcall_delta' && typeof event.delta === 'string') {
          pending.preview = (pending.preview + event.delta).slice(0, 1200);
        } else if (event.type === 'toolcall_end' && event.toolCall) {
          pending.toolCallId = event.toolCall.id ?? pending.toolCallId;
          pending.toolName = event.toolCall.name ?? pending.toolName;
          pending.args =
            event.toolCall.arguments && typeof event.toolCall.arguments === 'object'
              ? (event.toolCall.arguments as Record<string, unknown>)
              : undefined;
          try {
            pending.preview = JSON.stringify(pending.args ?? {}).slice(0, 1200);
          } catch {
            pending.preview = '';
          }
        }
        const tool = findTool(state, pending.toolCallId);
        if (tool) {
          tool.toolName = pending.toolName;
          tool.toolArgsPreview = pending.preview;
          if (pending.args) tool.toolArgs = pending.args;
          touchedMessageIds.add(tool.id);
          effects.push({
            type: 'render_message',
            messageId: tool.id,
            streaming: true,
            scroll: false,
          });
        }
        return;
      }
      const active = state.activeStreamMsg;
      if (!active || typeof event?.delta !== 'string') return;
      const blockType =
        event.type === 'text_delta' ? 'text' : event.type === 'thinking_delta' ? 'thinking' : null;
      if (!blockType) return;
      if (blockType === 'text') active.content += event.delta;
      else {
        active.thinking = (active.thinking ?? '') + event.delta;
        if (!active.thinkingStartMs) active.thinkingStartMs = options.now();
      }
      const blocks = active.blocks ?? (active.blocks = []);
      const last = blocks[blocks.length - 1];
      if (last?.type === blockType) last.text += event.delta;
      else blocks.push({ type: blockType, text: event.delta });
      touchedMessageIds.add(active.id);
      effects.push({
        type: 'render_message',
        messageId: active.id,
        streaming: true,
        scroll: blockType === 'text',
      });
      return;
    }
    case 'message_end': {
      const endMessage = frame.message as { role?: string } | undefined;
      if (endMessage) {
        const [converted] = rawMessagesToUI([endMessage]);
        const isBashExecution =
          typeof endMessage.role === 'string' &&
          ['bashexecution', 'bash_execution', 'bash'].includes(
            endMessage.role.toLowerCase().replace('_', '')
          );
        if (isBashExecution && converted?.role === 'tool') {
          const bash =
            (typeof (endMessage as Record<string, unknown>).id === 'string'
              ? findTool(state, (endMessage as Record<string, unknown>).id as string)
              : undefined) ?? lastStreaming(state, 'tool');
          if (bash?.toolName === 'bash') {
            Object.assign(bash, converted, {
              id: bash.id,
              toolCallId: bash.toolCallId,
              startMs: bash.startMs,
              endMs: options.now(),
              streaming: false,
            });
            touchedMessageIds.add(bash.id);
            effects.push({
              type: 'render_message',
              messageId: bash.id,
              streaming: false,
              scroll: false,
            });
          } else {
            state.messages.push(converted);
            addToolIndex(state, converted);
          }
        } else if (
          converted?.role === 'notice' ||
          converted?.role === 'diagnostic' ||
          converted?.role === 'compaction_summary' ||
          converted?.role === 'branch_summary'
        ) {
          state.messages.push(converted);
        } else if (converted?.role === 'assistant') {
          const active = state.activeStreamMsg;
          if (active) {
            const id = active.id;
            const startMs = active.startMs;
            const streamedBlocks = active.blocks;
            Object.assign(active, converted, {
              id,
              startMs,
              endMs: options.now(),
              streaming: false,
              // Some SDK end events omit the accumulated content. Keep the
              // ordered deltas already rendered rather than replacing them
              // with an empty final snapshot.
              ...(streamedBlocks?.length && !converted.blocks?.length
                ? {
                    content: active.content,
                    thinking: active.thinking,
                    blocks: streamedBlocks,
                  }
                : {}),
            });
            touchedMessageIds.add(active.id);
            effects.push({
              type: 'render_message',
              messageId: active.id,
              streaming: false,
              scroll: false,
            });
          } else {
            state.messages.push(converted);
          }
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
        tool.toolArgs = details;
        tool.toolInput = formatToolInput(toolName, details);
        tool.toolArgsPreview = undefined;
        tool.renderedCallHtml = frame.renderedCallHtml as string[] | undefined;
        tool.streaming = true;
        tool.isError = false;
        tool.outputLoading = false;
        tool.outputElided = false;
        tool.endMs = undefined;
        touchedMessageIds.add(tool.id);
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
          | {
              content?: { type: string; text?: string; data?: string; mimeType?: string }[];
              details?: Record<string, unknown>;
            }
          | undefined;
        if (partial?.content) {
          tool.content = extractTextContent(partial.content);
          const images = partial.content.filter(
            (block) => block.type === 'image' && block.data && block.mimeType
          );
          tool.images = images.map((block) => `data:${block.mimeType};base64,${block.data}`);
          delete tool.renderedResultHtml;
        }
        if (partial?.details) tool.toolDetails = partial.details as UIMessage['toolDetails'];
        if (frame.renderedResultHtml)
          tool.renderedResultHtml = frame.renderedResultHtml as string[];
        touchedMessageIds.add(tool.id);
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
            details?: Record<string, unknown>;
            diff?: string;
            exitCode?: number;
            cancelled?: boolean;
          }
        | undefined;
      if (result?.content) {
        tool.content = extractTextContent(result.content);
        const images = result.content.filter(
          (block) => block.type === 'image' && block.data && block.mimeType
        );
        tool.images = images.map((block) => `data:${block.mimeType};base64,${block.data}`);
      }
      const rawDetails = result?.details;
      if (rawDetails) tool.toolDetails = rawDetails as UIMessage['toolDetails'];
      const exitCodeFromOutput =
        toolName === 'bash' && tool.isError
          ? tool.content.match(/Command exited with code (-?\d+)/)?.[1]
          : undefined;
      const exitCode =
        typeof result?.exitCode === 'number'
          ? result.exitCode
          : exitCodeFromOutput !== undefined
            ? Number(exitCodeFromOutput)
            : undefined;
      if (exitCode !== undefined) tool.toolDetails = { ...tool.toolDetails, exitCode };
      if (typeof result?.cancelled === 'boolean') {
        tool.cancelled = result.cancelled;
        tool.toolDetails = { ...tool.toolDetails, cancelled: result.cancelled };
      }
      if (toolName === 'bash' && tool.isError && exitCode === undefined)
        tool.toolDetails = { ...tool.toolDetails, exitCode: null };
      const diff = result?.diff ?? rawDetails?.diff ?? rawDetails?.patch;
      const firstChangedLine = rawDetails?.firstChangedLine;
      if (typeof firstChangedLine === 'number')
        tool.toolDetails = { ...tool.toolDetails, firstChangedLine };
      if (typeof rawDetails?.patch === 'string')
        tool.toolDetails = { ...tool.toolDetails, patch: rawDetails.patch };
      for (const [contentIndex, pending] of state.pendingToolCalls) {
        if (pending.toolCallId === toolCallId) state.pendingToolCalls.delete(contentIndex);
      }
      tool.toolArgs = details;
      tool.toolArgsPreview = undefined;
      touchedMessageIds.add(tool.id);
      if (typeof diff === 'string' && diff) {
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
        bash.content += delta;
        bash.streaming = true;
        let addedLines = 0;
        for (let i = 0; i < delta.length; i++) {
          if (delta.charCodeAt(i) === 10) addedLines++;
        }
        bash.lineCount = (bash.lineCount ?? 1) + addedLines;
        delete bash.renderedResultHtml;
        touchedMessageIds.add(bash.id);
      }
      return;
    }
    case 'tool_renderer_update': {
      const tool = findTool(state, frame.toolCallId as string);
      if (!tool) return;
      if (Array.isArray(frame.renderedCallHtml))
        tool.renderedCallHtml = frame.renderedCallHtml as string[];
      if (Array.isArray(frame.renderedResultHtml))
        tool.renderedResultHtml = frame.renderedResultHtml as string[];
      touchedMessageIds.add(tool.id);
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
      if (frame.toolDetails && typeof frame.toolDetails === 'object')
        tool.toolDetails = frame.toolDetails as UIMessage['toolDetails'];
      if (tool.toolDetails?.fullOutputPath) tool.fullOutputPath = tool.toolDetails.fullOutputPath;
      if (tool.content && tool.lineCount === undefined)
        tool.lineCount = tool.content.split('\n').length;
      touchedMessageIds.add(tool.id);
      return;
    }
    case 'queue_update':
      state.queuedSteering = [...((frame.steering as string[] | undefined) ?? [])];
      state.queuedFollowUp = [...((frame.followUp as string[] | undefined) ?? [])];
      state.queuedDeferred = [...((frame.deferred as string[] | undefined) ?? [])];
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
        touchedMessageIds.add(notice.id);
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
        touchedMessageIds.add(notice.id);
      }
      return;
    }
    case 'summarization_retry_scheduled': {
      const delayMs = (frame.delayMs as number | undefined) ?? 0;
      const notice: UIMessage = {
        id: options.createId(),
        role: 'notice',
        content: `Summary retry scheduled${delayMs > 0 ? ` in ${Math.ceil(delayMs / 1000)}s` : ''}`,
        noticeKind: 'retry',
        streaming: true,
        createdAt: options.now(),
      };
      state.messages.push(notice);
      return;
    }
    case 'summarization_retry_attempt_start': {
      const source = frame.source === 'compaction' ? 'Context compaction' : 'Branch summary';
      const notice = [...state.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'notice' && message.noticeKind === 'retry' && message.streaming
        );
      if (notice) {
        notice.content = `${source} retry in progress…`;
        touchedMessageIds.add(notice.id);
        effects.push({
          type: 'render_message',
          messageId: notice.id,
          streaming: true,
          scroll: false,
        });
      } else
        state.messages.push({
          id: options.createId(),
          role: 'notice',
          content: `${source} retry in progress…`,
          noticeKind: 'retry',
          streaming: true,
          createdAt: options.now(),
        });
      return;
    }
    case 'summarization_retry_finished': {
      const notice = [...state.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'notice' && message.noticeKind === 'retry' && message.streaming
        );
      if (notice) {
        notice.streaming = false;
        notice.content = 'Summary retry finished';
        touchedMessageIds.add(notice.id);
      }
      return;
    }
    case 'agent_settled':
      state.isStreaming = false;
      state.activeToolName = undefined;
      sealStreaming(state, effects, touchedMessageIds);
      return;
    case 'entry_appended': {
      const entry = frame.entry as Record<string, unknown> | undefined;
      if (entry?.type === 'session_info') {
        if (typeof entry.name === 'string') state.sessionName = entry.name;
        return;
      }
      let candidate = (entry?.message ?? entry) as Record<string, unknown> | undefined;
      if (entry?.type === 'custom_message') {
        candidate = {
          ...entry,
          role: 'custom',
          timestamp:
            typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : entry.timestamp,
        };
      }
      if (
        candidate &&
        (candidate.role === 'custom' ||
          candidate.role === 'compactionSummary' ||
          candidate.role === 'branchSummary')
      ) {
        const [appended] = rawMessagesToUI([candidate]);
        if (
          appended &&
          !state.messages.some(
            (existing) =>
              existing.id === appended.id ||
              (existing.role === 'notice' &&
                existing.noticeKind === 'custom' &&
                existing.customType === appended.customType &&
                existing.content === appended.content &&
                existing.createdAt === appended.createdAt)
          )
        ) {
          state.messages.push(appended);
        }
      }
      // Label entries are consumed by the session-tree refresh path.
      return;
    }
    // Turn boundaries carry no additional transcript state; message events own rendering.
    case 'turn_start':
    case 'turn_end':
      return;
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
  const messagesBefore = state.messages;
  const lengthBefore = messagesBefore.length;
  const touchedMessageIds = new Set<string>();
  if (action.type === 'snapshot') {
    const result = applySnapshot(state, action.payload, effects, options);
    return {
      state,
      effects,
      ...result,
      structureChanged: state.messages !== messagesBefore,
      touchedMessageIds: [],
    };
  }
  applyEvent(state, action.message as Record<string, unknown>, effects, options, touchedMessageIds);
  return {
    state,
    effects,
    identityChanged: false,
    transcriptReplaced: false,
    structureChanged: state.messages !== messagesBefore || state.messages.length !== lengthBefore,
    touchedMessageIds: [...touchedMessageIds],
  };
}
