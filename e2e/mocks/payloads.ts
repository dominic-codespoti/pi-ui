/**
 * Common mock WebSocket payloads for pi event protocol.
 * These simulate what the real server would send over /ws.
 */

export const CONNECTED_PAYLOAD = {
  type: 'connected',
  sessionId: 'mock-session-001',
  isStreaming: false,
  thinkingLevel: 'medium',
  model: { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', reasoning: false, contextWindow: 128_000 },
  availableModels: [
    { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', reasoning: false, contextWindow: 128_000 },
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
};

export const SESSION_LOADED_PAYLOAD = {
  type: 'session_loaded',
  sessionId: 'mock-session-002',
  isStreaming: false,
  thinkingLevel: 'medium',
  model: { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', reasoning: false, contextWindow: 128_000 },
  availableModels: [
    { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', reasoning: false, contextWindow: 128_000 },
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
    { cwd: '/home/user/project-a', name: 'project-a', pinned: true, exists: true, registered: true, sessionCount: 2, lastActivity: Date.now() },
    { cwd: '/home/user/project-b', name: 'project-b', pinned: false, exists: true, registered: true, sessionCount: 1, lastActivity: Date.now() - 3600000 },
  ],
};

export const ALL_SESSIONS_LIST_PAYLOAD = {
  type: 'all_sessions_list',
  sessions: [
    { id: 's1', path: '/home/user/project-a/s1.jsonl', cwd: '/home/user/project-a', name: 'Bug fix', created: Date.now() - 86400000, modified: Date.now() - 3600000, messageCount: 12, firstMessage: 'Fix the login bug' },
    { id: 's2', path: '/home/user/project-a/s2.jsonl', cwd: '/home/user/project-a', name: '', created: Date.now() - 43200000, modified: Date.now() - 7200000, messageCount: 5, firstMessage: 'Add tests' },
    { id: 's3', path: '/home/user/project-b/s1.jsonl', cwd: '/home/user/project-b', name: '', created: Date.now() - 7200000, modified: Date.now() - 1800000, messageCount: 3, firstMessage: 'hello world' },
  ],
};

export function agentStartPayload() {
  return { type: 'agent_start' };
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

export function assistantMessageEndPayload(usage?: { input: number; output: number; totalTokens: number; cost: { total: number } }) {
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

export function toolExecutionStartPayload(toolName: string, toolCallId: string, args?: Record<string, unknown>) {
  return { type: 'tool_execution_start', toolName, toolCallId, args: args ?? {} };
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

export const PROVIDERS_LIST_PAYLOAD = {
  type: 'providers_list',
  providers: [
    { id: 'openai', name: 'OpenAI', configured: true, source: 'environment', modelCount: 3 },
    { id: 'anthropic', name: 'Anthropic', configured: false, modelCount: 2 },
  ],
};

export const TOOLS_LIST_PAYLOAD = {
  type: 'tools_list',
  tools: [
    { name: 'read', description: 'Read a file', isBuiltin: true },
    { name: 'edit', description: 'Edit a file', isBuiltin: true },
    { name: 'bash', description: 'Run a shell command', isBuiltin: true },
  ],
  activeToolNames: ['read', 'edit', 'bash'],
};

export const RESOURCES_LIST_PAYLOAD = {
  type: 'resources_list',
  skills: [
    { name: 'debug', description: 'Debugging assistant', scope: 'user', isBuiltin: false, source: 'skills/debug.md' },
  ],
  prompts: [
    { name: 'review', description: 'Code review prompt', scope: 'project', isBuiltin: false, source: '.pi/prompts/review.md' },
  ],
};

// ── New payloads for extension component rendering ──────────────────────────

/** Simulate a setWidget message with a component tree (ProgressBar, Loader, etc.) */
export function extensionSetWidgetPayload(
  key: string,
  component: Record<string, unknown>,
  placement?: string,
) {
  return {
    type: 'extension_ui_request',
    id: crypto.randomUUID(),
    method: 'setWidget',
    widgetKey: key,
    widgetType: 'component',
    widgetComponent: component,
    ...(placement ? { widgetPlacement: placement } : {}),
  };
}

/** Simulate a setWidget message with plain text lines. */
export function extensionSetWidgetTextPayload(key: string, lines: string[]) {
  return {
    type: 'extension_ui_request',
    id: crypto.randomUUID(),
    method: 'setWidget',
    widgetKey: key,
    widgetType: 'text',
    widgetLines: lines,
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

/** Simulate an extension_event with a level. */
export function extensionEventPayload(source: string, event: string, level: string, message?: string) {
  return {
    type: 'extension_event',
    source,
    event,
    level,
    ...(message ? { message } : {}),
  };
}
