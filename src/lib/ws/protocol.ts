/**
 * Shared WebSocket message types between server and browser.
 * Server forwards pi SDK events as-is, plus custom handshake/control messages.
 */

import type { ParsedComponent } from '$lib/tui-stubs';

// ── Shared data shapes ────────────────────────────────────────────────────────

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  /** Context window size in tokens (from the model definition). */
  contextWindow?: number;
  /** Map of thinking levels this model supports (keys = level names). */
  thinkingLevelMap?: Record<string, string | null>;
}

/** Real-time context window usage — from pi SDK's getContextUsage(). */
export interface ContextUsage {
  /** Estimated context tokens, or null if unknown (e.g. after compaction). */
  tokens: number | null;
  /** Model's maximum context window. */
  contextWindow: number;
  /** Context usage as percentage, or null if tokens is unknown. */
  percent: number | null;
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
  /** SDK's raw message count (includes tool results, bash executions, etc.). */
  messageCount: number;
  /** User-facing turn count — only user + assistant messages. */
  turns?: number;
  firstMessage: string;
}

/**
 * A first-class project — a working directory pi-ui knows about.
 * Combines the server's persisted project registry with directories
 * discovered from existing session files.
 */
export interface ProjectInfo {
  /** Absolute path of the project directory (canonical identifier). */
  cwd: string;
  /** Display name — defaults to the directory basename, user-renamable. */
  name: string;
  /** Pinned projects sort to the top of pickers and the sidebar. */
  pinned: boolean;
  /** Whether the directory currently exists on disk. */
  exists: boolean;
  /** True when the project is in the persisted registry (vs. only inferred from sessions). */
  registered: boolean;
  /** Number of persisted sessions whose cwd is this directory. */
  sessionCount: number;
  /** Unix ms of the most recent activity (session modified or last opened). */
  lastActivity: number;
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

export interface ExtensionSummary {
  source: string;
  path: string;
  scope: 'user' | 'project' | 'temporary';
  origin: 'package' | 'top-level';
  tools: { name: string; description: string }[];
  commands: { name: string; description: string }[];
  flags?: string[];
}

export interface UpdatePackageStatus {
  name: string;
  current: string;
  latest?: string;
  updateAvailable?: boolean;
  error?: string;
}

export interface UpdateStatus {
  appRoot: string;
  mode: 'source' | 'package' | 'ephemeral';
  updateCommand?: string;
  busy: boolean;
  canUpdateUi: boolean;
  canUpdateSdk: boolean;
  ui: UpdatePackageStatus;
  sdk: UpdatePackageStatus;
  notes: string[];
}

export type UpdateTarget = 'ui' | 'sdk';

// ── Extension widget content types ────────────────────────────────────────────

export type WidgetContent =
  | { type: 'text'; lines: string[]; htmlLines?: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'badge'; text: string; variant: 'info' | 'warning' | 'error' | 'success' }
  | { type: 'component'; component: ParsedComponent };

/** A node in the session tree for visual display. */
export interface TreeNode {
  entryId: string;
  type: string;
  role?: string;
  text?: string;
  label?: string;
  children: TreeNode[];
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
  /** Recent raw SDK message window at connect time. */
  messages: unknown[];
  /** Partial SDK message currently being streamed; allows a switched session to resume rendering. */
  streamingMessage?: unknown;
  /** Total number of messages in the session (may exceed messages.length). */
  totalMessageCount?: number;
  /** True when messages were truncated to limit initial payload size. */
  messagesTruncated?: boolean;
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
  /** pi SDK version (e.g. "0.75.5"). */
  piVersion?: string;
  /** pi-ui server version (e.g. "0.1.6"). */
  uiVersion?: string;
  /** 'in-memory' when SessionManager.inMemory() is active; omitted for disk-persisted sessions. */
  sessionMode?: 'in-memory' | 'persisted';
  /** Session file path on disk — used to persist the active session across page reloads. */
  sessionPath?: string;
  /** Real-time context window usage from the SDK. */
  contextUsage?: ContextUsage;
  /** Current notification webhook URL (empty/null = disabled). */
  webhookUrl?: string;
}

/**
 * All other server messages are either:
 *   (a) pi SDK AgentSessionEvents forwarded verbatim, or
 *   (b) custom server-emitted events:
 *
 * Custom server events (not from the SDK):
 *   { type: "model_changed",           model: ModelInfo | null }
 *   { type: "session_loaded",          sessionId, isStreaming, thinkingLevel, model, availableModels, messages, contextUsage }
 *   { type: "sessions_list",           sessions: SessionSummary[] }
 *   { type: "all_sessions_list",       sessions: SessionSummary[] }
 *   { type: "projects_list",           projects: ProjectInfo[] }
 *   { type: "dir_completions",         prefix: string; entries: string[] }
 *   { type: "file_completions",        query: string; entries: string[] }
 *   { type: "providers_list",          providers: ProviderInfo[] }
 *   { type: "available_models_changed", availableModels: ModelInfo[] }
 *   { type: "sessions_error",          message: string }
 *   { type: "fork_points",             entries: Array<{ entryId: string; text: string }> }
 *   { type: "tools_list",              tools: Array<{ name: string; description: string; isBuiltin: boolean }>, activeToolNames: string[] }
 *   { type: "resources_list",          skills: SkillSummary[], prompts: PromptSummary[] }
 *   { type: "extensions_list",         extensions: ExtensionSummary[], errors: Array<{ path: string; error: string }> }
 *   { type: "commands_list",           commands: Array<{ name: string; description?: string; source: string }> }
 *   { type: "skill_install_result",    success: boolean; name?: string; error?: string }
 *   { type: "update_status",           ...UpdateStatus }
 *   { type: "update_progress",         target: "ui" | "sdk", command?: string, message: string }
 *   { type: "restart_nonce",           nonce: string }
 *   { type: "server_restarting" }
 *
 *   { type: "notification_webhook_url", url: string | null }

 *   { type: "slash_result",            command: string, message: string, level?: "info" | "warning" | "error" }
 *   { type: "file_content",            path: string, content: string, error?: string }
 *   { type: "older_messages",          messages: unknown[], totalMessageCount: number, messagesTruncated: boolean }
 *
 * SDK events the browser must handle:
 *   { type: "agent_start" }
 *   { type: "agent_end",               messages: AgentMessage[], willRetry: boolean }
 *   { type: "message_start" }
 *   { type: "message_update",          assistantMessageEvent: { type: "text_delta", delta: string, ... } }
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
 *
 *   Custom extension events (forwarded from pi.events — lifecycle, state changes):
 *   { type: "extension_event",         source: string, event: string, data?: Record<string, unknown> }
 *
 *   Custom component update (re-rendered lines for interactive custom() components):
 *   { type: "custom_render",           id: string, lines: string[] }
 *
 *   Live update to an open custom() dialog's parsed component tree (after a
 *   real extension callback ran, or on animation tick for loaders/progress):
 *   { type: "extension_ui_update",     id: string, parsed: ParsedComponent }
 *
 *   Sent whenever a pending extension_ui_request resolves for ANY reason
 *   (user response, extension self-resolved via done(), cancel, timeout) —
 *   closes the dialog in every connected tab, not just the one that answered:
 *   { type: "extension_ui_dismiss",    id: string }
 *
 *   Session runtime status (lightweight — no message content, just metadata):
 *   { type: "session_runtime",         sessionId: string, isRunning: boolean, unseen: boolean, lastActivity: number }
 *
 *   Supported extension_ui_request methods:
 *     confirm    – dialog with confirm/cancel (title, message)
 *     input      – dialog with text input (title, placeholder)
 *     select     – dialog with option buttons (title, options)
 *     editor     – dialog with textarea (title, prefill)
 *     custom     – generic overlay dialog (title) — promise resolves with user input.
 *                  When the factory returns a component with render() + handleInput(),
 *                  the server stores the instance and forwards keyboard events from
 *                  the browser via extension_custom_input messages. Rendered output
 *                  is broadcast as custom_render messages.
 *     notify     – toast notification (message, notifyType)
 *     setStatus  – update status text (statusKey, statusText)
 *     setWidget  – register/update widget panel (widgetKey, widgetType?, widgetData?, widgetLines?, widgetHtmlLines?, widgetPlacement?). widgetHtmlLines carries ANSI-styled text (theme.fg()/bold()) converted to safe inline-styled HTML — the client prefers it over widgetLines when present.
 *     setTitle   – update document.title (title)
 *     set_editor_text – replace textarea content (text)
 *     paste_to_editor – insert text at cursor (text)
 *     request_editor_text – request current textarea content (id)
 *     setWorkingMessage – streaming indicator text (message)
 *     setWorkingVisible – streaming indicator visibility (visible)
 *     setWorkingIndicator – animated frame indicator (frames/intervalMs)
 *     setHiddenThinkingLabel – thinking label text (label)
 *     setToolsExpanded – global tool output expansion (expanded)
 *     set_header – extension header content (content), or empty to clear
 *     set_footer – extension footer content (content), or empty to clear
 *     set_editor_component – parsed component panel above composer (parsed), or null to clear
 *     extension_completions – response to get_extension_autocomplete (trigger, query, items[])
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
  /** Request the merged project list (registry + session dirs). Server replies with projects_list. */
  | { type: 'get_projects' }
  /** Register a directory as a project without switching to it (created if missing). */
  | { type: 'add_project'; path: string }
  /** Forget a project from the registry. Sessions and files are untouched. */
  | { type: 'remove_project'; cwd: string }
  /** Pin or unpin a project. Pinning an unregistered project registers it. */
  | { type: 'pin_project'; cwd: string; pinned: boolean }
  /** Set a custom display name for a project. Empty name resets to the basename. */
  | { type: 'rename_project'; cwd: string; name: string }
  /** Request filesystem directory entries for path autocomplete. Server replies with dir_completions. */
  | { type: 'dir_complete'; prefix: string }
  /** Request lightweight workspace file matches for composer @ references. */
  | { type: 'file_complete'; query: string }
  /** Request extension-registered autocomplete items for a trigger character. */
  | { type: 'get_extension_autocomplete'; trigger: string; query: string }
  /** Forward raw terminal input to an interactive custom component (ConversationViewer
   * etc). `data` is the exact byte sequence a real terminal would send for the
   * keystroke/paste — see `$lib/terminal-key-encoder` — and is passed straight to
   * the component's `handleInput()`. */
  | { type: 'extension_custom_input'; id: string; data: string }
  /** Interaction with a parsed component inside an open custom() dialog — the
   * server invokes the corresponding LIVE callback (onSelect/onClick/onToggle/
   * onSubmit/updateValue) on the component at `path` and re-parses the tree. */
  | { type: 'extension_component_event'; id: string; path: number[]; event: 'select' | 'click' | 'toggle' | 'submit' | 'setting'; value?: string }
  /** Response to a blocking extension_ui_request (select / confirm / input / editor / custom). */
  | { type: 'extension_ui_response'; id: string; value?: string; confirmed?: boolean; cancelled?: true }
  /** Editor text content response to a request_editor_text extension_ui_request. */
  | { type: 'editor_text_response'; id: string; text: string }
  /** Request list of all providers with auth status. */
  | { type: 'get_providers' }
  /** Persist an API key for a provider. */
  | { type: 'set_provider_key'; provider: string; key: string }
  /** Remove stored API key for a provider. */
  | { type: 'remove_provider_key'; provider: string }
  /** Rename a session (by file path) to a new display name. */
  | { type: 'rename_session'; path: string; name: string }
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
  /** Edit a user message: server finds the entry, rewinds session, and resends. */
  | { type: 'edit_message'; originalMessage: string; newMessage: string }
  /** Request the full list of tools and which are active. Server replies with tools_list. */
  | { type: 'get_tools' }
  /** Set the active tool set by name. */
  | { type: 'set_active_tools'; toolNames: string[] }
  /** Request skills and prompt templates. Server replies with resources_list. */
  | { type: 'get_resources' }
  /** Request loaded extensions. Server replies with extensions_list. */
  | { type: 'get_extensions' }
  /** Request registered slash commands (builtin + extension). Server replies with commands_list. */
  | { type: 'get_commands' }
  /**
   * Fetch a skill markdown file from a URL (GitHub blob / raw / direct) and
   * write it to either the project or user skills directory.
   * Server replies with skill_install_result.
   */
  | { type: 'install_skill'; url: string; scope: 'project' | 'user' }
  /** Check current and latest available pi-ui / pi SDK versions. */
  | { type: 'get_update_status' }
  /** Run an authenticated in-app update for the UI source checkout or pi SDK package. */
  | { type: 'run_update'; target: UpdateTarget }
  /** Request a single-use nonce before restarting the server. */
  | { type: 'request_restart' }
  /** Restart the server process in-place (re-exec with same args + env). */
  | { type: 'restart_server'; nonce?: string }
  /** Execute a built-in slash command in the server session context. */
  | { type: 'run_builtin'; command: string; args?: string }
  /** Request the session tree data for visual display. Server replies with session_tree. */
  | { type: 'get_session_tree' }
  /** Request file contents for the file viewer modal. */
  | { type: 'read_file'; path: string }
  /** Write file content from the file viewer modal's edit mode. */
  | { type: 'write_file'; path: string; content: string }
  /** Request older messages before the current window. Server replies with older_messages. */
  | { type: 'load_messages'; count: number; alreadyHasCount: number }
  /** Request argument completions for an extension slash command. Server replies with command_completions. */
  | { type: 'get_command_completions'; command: string; prefix: string }
  /** Set the notification webhook URL (ntfy.sh, Pushover, Gotify, etc.). Empty string clears. */
  /** Read persisted UI settings. Server replies with 'settings' event. */
  | { type: 'get_settings' }
  /** Persist UI settings to disk. Values are merged shallowly into the stored object. */
  | { type: 'set_settings'; settings: Record<string, unknown> }
  /** Heartbeat — server replies with `{ type: 'pong' }`. Keeps the socket alive and detects zombies. */
  | { type: 'ping' }
  /** Set the notification webhook URL (ntfy.sh, Pushover, Gotify, etc.). Empty string clears. */
  | { type: 'set_notification_webhook_url'; url: string };
