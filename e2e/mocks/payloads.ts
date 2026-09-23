/**
 * Common mock WebSocket payloads for pi event protocol.
 * These simulate what the real server would send over /ws.
 */

export const CONNECTED_PAYLOAD = {
  type: 'connected',
  sessionId: 'mock-session-001',
  isStreaming: false,
  thinkingLevel: 'medium',
  availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  scopedModels: [],
  hideThinkingBlock: false,
  builtinCommands: [
    { name: 'help', description: 'Show available commands' },
    { name: 'hotkeys', description: 'Show keyboard shortcuts' },
    { name: 'session', description: 'Show session information' },
    { name: 'tree', description: 'Browse the session tree' },
    { name: 'compact', description: 'Compact the conversation' },
  ],
  model: {
    provider: 'openai',
    id: 'gpt-4o',
    name: 'GPT-4o',
    reasoning: false,
    contextWindow: 128_000,
    available: true,
  },
  availableModels: [
    {
      provider: 'openai',
      id: 'gpt-4o',
      name: 'GPT-4o',
      reasoning: false,
      contextWindow: 128_000,
      available: true,
    },
  ],
  messages: [],
  cwd: '/home/user/project',
  sessionName: undefined,
  isCompacting: false,
  autoCompactionEnabled: true,
  autoRetryEnabled: true,
  piVersion: '0.79.1',
  uiVersion: '0.3.8',
  sessionMode: 'persisted',
  contextUsage: { tokens: 1500, contextWindow: 128_000, percent: 1.2 },
  projectTrust: {
    cwd: '/home/user/project',
    decision: 'ask',
    requiresDecision: true,
    persisted: false,
  },
  diagnostics: [],
};

export const SESSION_LOADED_PAYLOAD = {
  type: 'session_loaded',
  sessionId: 'mock-session-002',
  isStreaming: false,
  thinkingLevel: 'medium',
  availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  scopedModels: [],
  hideThinkingBlock: false,
  model: {
    provider: 'openai',
    id: 'gpt-4o',
    name: 'GPT-4o',
    reasoning: false,
    contextWindow: 128_000,
    available: true,
  },
  availableModels: [
    {
      provider: 'openai',
      id: 'gpt-4o',
      name: 'GPT-4o',
      reasoning: false,
      contextWindow: 128_000,
      available: true,
    },
  ],
  messages: [
    {
      role: 'user',
      content: 'Hello',
      timestamp: Date.now() - 60000,
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi! How can I help?' }],
      usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.0001 } },
      stopReason: 'endTurn',
      timestamp: Date.now() - 55000,
    },
  ],
  cwd: '/home/user/project',
  sessionName: 'Test Session',
  isCompacting: false,
  autoCompactionEnabled: true,
  autoRetryEnabled: true,
  piVersion: '0.79.1',
  uiVersion: '0.3.8',
  sessionMode: 'persisted',
};

export const PROJECTS_LIST_PAYLOAD = {
  type: 'projects_list',
  projects: [
    {
      cwd: '/home/user/project-a',
      name: 'project-a',
      pinned: true,
      exists: true,
      registered: true,
      sessionCount: 2,
      lastActivity: Date.now(),
    },
    {
      cwd: '/home/user/project-b',
      name: 'project-b',
      pinned: false,
      exists: true,
      registered: true,
      sessionCount: 1,
      lastActivity: Date.now() - 3600000,
    },
  ],
};

export const ALL_SESSIONS_LIST_PAYLOAD = {
  type: 'all_sessions_list',
  sessions: [
    {
      id: 's1',
      path: '/home/user/project-a/s1.jsonl',
      cwd: '/home/user/project-a',
      name: 'Bug fix',
      created: Date.now() - 86400000,
      modified: Date.now() - 3600000,
      messageCount: 12,
      firstMessage: 'Fix the login bug',
    },
    {
      id: 's2',
      path: '/home/user/project-a/s2.jsonl',
      cwd: '/home/user/project-a',
      name: '',
      created: Date.now() - 43200000,
      modified: Date.now() - 7200000,
      messageCount: 5,
      firstMessage: 'Add tests',
    },
    {
      id: 's3',
      path: '/home/user/project-b/s1.jsonl',
      cwd: '/home/user/project-b',
      name: '',
      created: Date.now() - 7200000,
      modified: Date.now() - 1800000,
      messageCount: 3,
      firstMessage: 'hello world',
    },
  ],
};

export function agentStartPayload() {
  return { type: 'agent_start' };
}

/**
 * Runtime status for any resident session (active or background).
 * Drives the sidebar orbs and mirrors the session_runtime wire contract.
 */
export type SessionRuntimePhase = 'idle' | 'running' | 'awaiting-input' | 'error';

export type SessionRuntimeOptions = {
  phase: SessionRuntimePhase;
  activeToolName?: string;
  unread?: boolean;
  needsAttention?: boolean;
  resident?: boolean;
  lastActivity?: number;
};

export function sessionRuntimePayload(sessionId: string, options: SessionRuntimeOptions) {
  const {
    phase,
    activeToolName,
    unread = false,
    needsAttention = false,
    resident = true,
    lastActivity = Date.now(),
  } = options;
  return {
    type: 'session_runtime' as const,
    sessionId,
    phase,
    isRunning: phase === 'running',
    ...(activeToolName ? { activeToolName } : {}),
    lastActivity,
    unread,
    needsAttention,
    resident,
  };
}

export function assistantMessageStartPayload() {
  return { type: 'message_start', message: { role: 'assistant' } };
}

export function textDeltaPayload(text: string) {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } };
}

export function thinkingDeltaPayload(text: string) {
  return { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: text } };
}

export function assistantMessageEndPayload(usage?: {
  input: number;
  output: number;
  totalTokens: number;
  cost: { total: number };
}) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      usage: usage ?? { input: 50, output: 100, totalTokens: 150, cost: { total: 0.002 } },
      stopReason: 'endTurn',
      content: [],
    },
  };
}

export function agentEndPayload(willRetry = false) {
  return { type: 'agent_end', willRetry };
}

export function toolExecutionUpdatePayload(toolCallId: string, text: string) {
  return {
    type: 'tool_execution_update',
    toolCallId,
    partialResult: { content: [{ type: 'text', text }] },
  };
}

export function toolExecutionEndPayload(toolCallId: string, content: string, isError = false) {
  return {
    type: 'tool_execution_end',
    toolCallId,
    isError,
    result: { content: [{ type: 'text', text: content }] },
  };
}

export function extensionConfirmPayload(id: string, title: string, message: string) {
  return { type: 'extension_ui_request', id, method: 'confirm', title, message };
}

export function extensionInputPayload(id: string, title: string, placeholder?: string) {
  return { type: 'extension_ui_request', id, method: 'input', title, placeholder };
}

export function extensionSelectPayload(id: string, title: string, options: string[]) {
  return { type: 'extension_ui_request', id, method: 'select', title, options };
}

export function extensionNotifyPayload(message: string, notifyType: string) {
  return { type: 'extension_ui_request', id: 'n1', method: 'notify', message, notifyType };
}

export const TOOLS_LIST_PAYLOAD = {
  type: 'tools_list',
  tools: [
    { name: 'read', description: 'Read a file', isBuiltin: true },
    { name: 'edit', description: 'Edit a file', isBuiltin: true },
    { name: 'bash', description: 'Run a shell command', isBuiltin: true },
  ],
  activeToolNames: ['read', 'edit', 'bash'],
};

// ── New payloads for extension component rendering ──────────────────────────

/** Simulate a setWidget message with a component tree (ProgressBar, Loader, etc.) */
export function extensionSetWidgetPayload(
  key: string,
  component: Record<string, unknown>,
  placement?: string,
  sessionId: string = CONNECTED_PAYLOAD.sessionId
) {
  return {
    type: 'extension_ui_request',
    id: crypto.randomUUID(),
    method: 'setWidget',
    widgetKey: key,
    widgetType: 'component',
    widgetComponent: component,
    sessionId,
    ...(placement ? { widgetPlacement: placement } : {}),
  };
}

/** Simulate a setWidget message with plain text lines, optionally with ANSI-derived HTML lines (mirrors server.ts's widgetHtmlLines field). */
export function extensionSetWidgetTextPayload(
  key: string,
  lines: string[],
  htmlLines?: string[],
  sessionId: string = CONNECTED_PAYLOAD.sessionId
) {
  return {
    type: 'extension_ui_request',
    id: crypto.randomUUID(),
    method: 'setWidget',
    widgetKey: key,
    widgetType: 'text',
    widgetLines: lines,
    sessionId,
    ...(htmlLines ? { widgetHtmlLines: htmlLines } : {}),
  };
}

/** Simulate a custom modal with a parsed component tree. */
export function extensionCustomPayload(id: string, title: string, parsed: Record<string, unknown>) {
  return {
    type: 'extension_ui_request',
    id,
    method: 'custom',
    title,
    parsed,
  };
}

/** Simulate an interactive custom overlay (keyboard-driven terminal-emulation
 *  components like pi-subagents' TranscriptOverlay) — no `parsed` tree, just
 *  rendered lines and the `interactive: true` flag that drives the de-chromed
 *  floating-close-button overlay. */
export function extensionInteractiveCustomPayload(
  id: string,
  lines: string[],
  htmlLines?: string[]
) {
  return {
    type: 'extension_ui_request',
    id,
    method: 'custom',
    interactive: true,
    lines,
    ...(htmlLines ? { htmlLines } : {}),
  };
}

/** Simulate an extension_event with a level. */
export function extensionEventPayload(
  source: string,
  event: string,
  level: string,
  message?: string
) {
  return {
    type: 'extension_event',
    source,
    event,
    level,
    ...(message ? { message } : {}),
  };
}

export function providerLoginStatePayload(
  loginId: string,
  status: 'started' | 'succeeded' | 'failed' | 'cancelled',
  overrides: Record<string, unknown> = {}
) {
  return {
    type: 'provider_login_state',
    loginId,
    provider: 'anthropic',
    providerName: 'Anthropic',
    authType: 'oauth',
    status,
    ...overrides,
  };
}

export function providerLoginEventPayload(loginId: string, event: Record<string, unknown>) {
  return { type: 'provider_login_event', loginId, event };
}

export function providerLoginPromptPayload(
  loginId: string,
  promptId: string,
  prompt: Record<string, unknown>
) {
  return { type: 'provider_login_prompt', loginId, promptId, prompt };
}

export function providerLoginPromptCancelPayload(loginId: string, promptId: string) {
  return { type: 'provider_login_prompt_cancel', loginId, promptId };
}
