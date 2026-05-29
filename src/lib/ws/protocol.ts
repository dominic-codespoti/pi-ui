/**
 * Shared WebSocket message types between server and browser.
 * Server forwards pi SDK events as-is, plus custom handshake/control messages.
 */

// ── Shared data shapes ────────────────────────────────────────────────────────

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  /** Context window size in tokens (from the model definition). */
  contextWindow?: number;
}

export interface SessionSummary {
  id: string;
  path: string;
  /** Working directory where this session was started. */
  cwd: string;
  name?: string;
  /** Unix ms */
  created: number;
  /** Unix ms */
  modified: number;
  messageCount: number;
  firstMessage: string;
}

export interface ProviderInfo {
  id: string;
  /** Human-readable display name */
  name: string;
  configured: boolean;
  /** How the credential is stored: 'stored' | 'runtime' | 'environment' | 'fallback' */
  source?: string;
  /** Number of models available for this provider */
  modelCount: number;
}

export interface SkillSummary {
  name: string;
  description: string;
  /** 'user' | 'project' | 'temporary' */
  scope: string;
  /** 'package' | 'top-level' — true when it's a built-in bundled skill */
  isBuiltin: boolean;
  /** Package / source identifier (e.g. package name or file path) */
  source: string;
}

export interface PromptSummary {
  name: string;
  description: string;
  argumentHint?: string;
  /** 'user' | 'project' | 'temporary' */
  scope: string;
  /** 'package' | 'top-level' */
  isBuiltin: boolean;
  source: string;
}

// ── Server → Browser ─────────────────────────────────────────────────────────

/** Sent once when a WebSocket connection is established. */
export interface ConnectedMessage {
  type: 'connected';
  sessionId: string;
  isStreaming: boolean;
  thinkingLevel: string;
  model: ModelInfo | null;
  availableModels: ModelInfo[];
  /** Full message history at connect time. */
  messages: unknown[];
  /** Server working directory. */
  cwd?: string;
  /** Display name of the current session (from session_info entries). */
  sessionName?: string;
  /** Whether context compaction is currently running. */
  isCompacting?: boolean;
  /** Whether auto-compaction is enabled for this session. */
  autoCompactionEnabled?: boolean;
  /** Whether auto-retry on transient errors is enabled. */
  autoRetryEnabled?: boolean;
}

/**
 * All other server messages are either:
 *   (a) pi SDK AgentSessionEvents forwarded verbatim, or
 *   (b) custom server-emitted events:
 *
 * Custom server events (not from the SDK):
 *   { type: "model_changed",           model: ModelInfo | null }
 *   { type: "session_loaded",          sessionId, isStreaming, thinkingLevel, model, availableModels, messages }
 *   { type: "sessions_list",           sessions: SessionSummary[] }
 *   { type: "all_sessions_list",       sessions: SessionSummary[] }
 *   { type: "dir_completions",         prefix: string; entries: string[] }
 *   { type: "providers_list",          providers: ProviderInfo[] }
 *   { type: "available_models_changed", availableModels: ModelInfo[] }
 *   { type: "sessions_error",          message: string }
 *   { type: "fork_points",             entries: Array<{ entryId: string; text: string }> }
 *   { type: "tools_list",              tools: Array<{ name: string; description: string; isBuiltin: boolean }>, activeToolNames: string[] }
 *   { type: "resources_list",          skills: SkillSummary[], prompts: PromptSummary[] }
 *   { type: "skill_install_result",    success: boolean; name?: string; error?: string }
 *
 * SDK events the browser must handle:
 *   { type: "agent_start" }
 *   { type: "agent_end",               messages: AgentMessage[], willRetry: boolean }
 *   { type: "message_start" }
 *   { type: "message_update",          event: { type: "text_delta", delta: string, ... } }
 *   { type: "message_end" }
 *   { type: "tool_execution_start",    toolName: string }
 *   { type: "tool_execution_update",   ... }
 *   { type: "tool_execution_end",      isError: boolean }
 *   { type: "queue_update",            steering: string[], followUp: string[] }
 *   { type: "thinking_level_changed",  level: string }
 *   { type: "compaction_start" }
 *   { type: "compaction_end" }
 *   { type: "auto_retry_start" }
 *   { type: "auto_retry_end" }
 *   { type: "extension_ui_request",    id, method, title?, message?, options?, placeholder?, prefill? }
 */
export type PiEvent = { type: string } & Record<string, unknown>;

export type ServerMessage = ConnectedMessage | PiEvent;

// ── Browser → Server ─────────────────────────────────────────────────────────

export type ClientMessage =
  | { type: 'prompt'; message: string; images?: Array<{ data: string; mimeType: string }> }
  | { type: 'steer'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'list_sessions' }
  | { type: 'new_session'; targetCwd?: string }
  | { type: 'switch_session'; path: string }
  /** Request all sessions across all project directories. Server replies with all_sessions_list. */
  | { type: 'get_all_sessions' }
  /** Request filesystem directory entries for path autocomplete. Server replies with dir_completions. */
  | { type: 'dir_complete'; prefix: string }
  /** Response to a blocking extension_ui_request (select / confirm / input / editor). */
  | { type: 'extension_ui_response'; id: string; value?: string; confirmed?: boolean; cancelled?: true }
  /** Request list of all providers with auth status. */
  | { type: 'get_providers' }
  /** Persist an API key for a provider. */
  | { type: 'set_provider_key'; provider: string; key: string }
  /** Remove stored API key for a provider. */
  | { type: 'remove_provider_key'; provider: string }
  /** Rename a session (by file path) to a new display name. */
  | { type: 'rename_session'; path: string; name: string }
  /** Rename the current active session without knowing its file path. */
  | { type: 'rename_current_session'; name: string }
  /** Permanently delete a session file (cannot delete the active session). */
  | { type: 'delete_session'; path: string }
  /** Manually compact the session context (aborts running agent first). */
  | { type: 'compact' }
  /** Enable or disable automatic context compaction. */
  | { type: 'set_auto_compaction'; enabled: boolean }
  /** Enable or disable automatic retry on transient errors. */
  | { type: 'set_auto_retry'; enabled: boolean }
  /** Request the list of fork-able user message entry IDs. Server replies with fork_points. */
  | { type: 'get_fork_points' }
  /** Fork the session at the given entry ID, creating a new branched session. */
  | { type: 'fork_session'; entryId: string }
  /** Request the full list of tools and which are active. Server replies with tools_list. */
  | { type: 'get_tools' }
  /** Set the active tool set by name. */
  | { type: 'set_active_tools'; toolNames: string[] }
  /** Request skills and prompt templates. Server replies with resources_list. */
  | { type: 'get_resources' }
  /**
   * Fetch a skill markdown file from a URL (GitHub blob / raw / direct) and
   * write it to either the project or user skills directory.
   * Server replies with skill_install_result.
   */
  | { type: 'install_skill'; url: string; scope: 'project' | 'user' };
