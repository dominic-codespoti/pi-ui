# WebSocket Protocol Reference

## Overview

All communication between client and server happens over a single WebSocket at `/ws`. Messages are JSON-encoded with a `type` field for dispatch.

## Message Types

### Server → Client

#### `connected`

Sent on WS open. Contains full session state.

```ts
{
  type: 'connected';
  sessionId: string;
  isStreaming: boolean;
  thinkingLevel: string;
  model: ModelInfo | null;
  availableModels: ModelInfo[];
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;
  totalMessageCount?: number;
  messagesTruncated?: boolean;
  cwd?: string;
  sessionName?: string;
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
  autoRetryEnabled?: boolean;
  queuedSteering?: string[];
  queuedFollowUp?: string[];
  pushVapidKey?: string | null;
  piVersion?: string;
  uiVersion?: string;
  sessionMode?: 'persisted' | 'in-memory';
  sessionPath?: string;
  contextUsage?: ContextUsage;
  webhookUrl?: string;
  projectTrust?: ProjectTrustInfo;
  diagnostics?: RuntimeDiagnostic[];
  modelFallbackMessage?: string;
  tools?: Array<{ name: string; description: string; isBuiltin: boolean; origin?: string }>;
  activeToolNames?: string[];
  /** Legacy extension widgets replayed for this active session. */
  widgets?: WidgetPayload[];
  /** Full extension UI snapshot (statuses, widgets, dialogs, terminalInputActive). */
  extensionUiState?: ExtensionUiStatePayload;
}
```

#### `session_loaded`

Broadcast when session changes (switch, fork, edit rewind, or after successful compaction).

```ts
{
  type: 'session_loaded';
  sessionId: string;
  isStreaming: boolean;
  thinkingLevel: string;
  model: ModelInfo | null;
  availableModels: ModelInfo[];
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;
  totalMessageCount?: number;
  messagesTruncated?: boolean;
  cwd?: string;
  sessionName?: string;
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
  autoRetryEnabled?: boolean;
  queuedSteering?: string[];
  queuedFollowUp?: string[];
  piVersion?: string;
  uiVersion?: string;
  projectTrust?: ProjectTrustInfo;
  diagnostics?: RuntimeDiagnostic[];
  modelFallbackMessage?: string;
  sessionPath?: string;
  requestId?: string;
  contextUsage?: ContextUsage;
  tools?: Array<{ name: string; description: string; isBuiltin: boolean; origin?: string }>;
  activeToolNames?: string[];
  widgets?: WidgetPayload[];
}
```

Session operations may include a client-generated `requestId`; the server echoes it on the corresponding `session_loaded` or `sessions_error`. Clients correlate `requestId` to discard late snapshots from timed-out or superseded operations.

#### Session Summaries & `parentSession`

Session listing payloads (`sessions_list`, `all_sessions_list`, `session_updated`) convey `SessionSummary` objects:

```ts
interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: number;       // Unix ms
  modified: number;      // Unix ms
  messageCount: number;  // Raw message count
  turns?: number;        // User + assistant turns
  parentSession?: string;// Forked file path or subagent task parent session ID
  firstMessage: string;
}
```

When `parentSession` is present, clients organize sessions into hierarchical trees/threads under the parent session.
#### SDK Events (forwarded as-is)

- `agent_start` — Generation started
- `message_start` — Turn started
- `message_update` — Text/thinking delta during streaming
- `message_end` — Final message with usage costs; server enriches this event with real-time `contextUsage: ContextUsage`
- `tool_execution_start/update/end` — Tool call lifecycle
- `agent_end` — Generation completed
- `compaction_start` / `compaction_end` — Compaction lifecycle; server watchdog clears on `compaction_end` and `message_end` / `compact` events carry `contextUsage`

#### Custom Server Events

- `model_changed` — `{ model: ModelInfo | null, thinkingLevel?: string }`; model selection or thinking level updated
- `thinking_level_changed` — `{ level: string }`; reasoning depth updated
- `available_models_changed` — `{ availableModels: ModelInfo[], sessionId?: string }`; session-stamped refreshes from a prior session are ignored by clients
- `sessions_error` — `{ message: string, requestId?: string }`; operation error echoed with optional `requestId` correlation
- `session_runtime` — `{ sessionId: string, isRunning: boolean, unseen: boolean, lastActivity: number }`; global runtime metadata broadcast across sessions
- `session_updated` — `{ session: SessionSummary }`; coalesced live delta for one session (emitted on `message_end` turns)
- `all_sessions_list` / `sessions_list` — `{ sessions: SessionSummary[] }`; full session inventory
- `projects_list` — `{ projects: ProjectInfo[] }`; merged list of registered and discovered session projects
- `dir_completions` — `{ prefix: string, entries: string[] }`; filesystem directory completion matches
- `file_completions` — `{ query: string, entries: string[] }`; workspace file completion matches for composer `@` references
- `file_content` — `{ path: string, content: string, error?: string }`; file read response
- `file_saved` — `{ path: string, error?: string }`; file write response
- `extension_terminal_input_active` — `{ active: boolean, sessionId?: string }`; emitted when a session's `onTerminalInput` handler set appears/disappears (register, unregister, extension reload, session dispose)
- `extension_terminal_input_result` — `{ id: string, consumed: boolean, data?: string, sessionId?: string }`; verdict for a client's `extension_terminal_input` round trip (`consumed: true` swallows the key; `data` replaces it)
- `extension_ui_state` — `{ sessionId: string, ui: ExtensionUiStatePayload }`; full extension UI snapshot
- `extension_ui_request` — `{ id, method, ... }`; extension modal/dialog request (e.g. `setWidget` with `widgetKey`, `widgetType`, `widgetPlacement`)
- `extension_ui_dismiss` — `{ id: string, sessionId?: string }`; dismisses an open extension dialog across all tabs
- `update_status` — Update check results
- `server_restarting` — Server shutdown initiated
- `agent_error` — Error from SDK or server
### Client → Server

#### Messaging

| Type           | Payload                           | Purpose                                 |
| -------------- | --------------------------------- | --------------------------------------- |
| `prompt`       | `{ message, images? }`            | Send a user turn                        |
| `edit_message` | `{ originalMessage, newMessage }` | Edit a user message (rewinds + resends) |
| `steer`        | `{ message }`                     | Send steering during streaming          |
| `follow_up`    | `{ message }`                     | Queue a follow-up message               |
| `abort`        | —                                 | Cancel current generation               |

#### Session Management

| Type                                        | Payload                       | Purpose                                                                              |
| ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| `new_session`                               | `{ targetCwd?, requestId? }`  | Start a new session; echoes `requestId` in `session_loaded`/`sessions_error`           |
| `switch_session`                            | `{ path, requestId? }`        | Switch to an existing session; echoes `requestId` in `session_loaded`/`sessions_error` |
| `fork_session`                              | `{ entryId }`                 | Fork session at a specific entry                                                     |
| `get_all_sessions`                          | —                             | Request all sessions across all project directories (replies with `all_sessions_list`) |
| `get_session_tree`                          | —                             | Request session branch tree                                                          |
| `get_fork_points`                           | —                             | Request user messages for forking                                                    |
| `compact`                                   | —                             | Manually compact session context (carries updated `contextUsage`)                    |
| `set_auto_compaction`                       | `{ enabled }`                 | Toggle auto-compaction                                                               |
| `set_auto_retry`                            | `{ enabled }`                 | Toggle auto-retry                                                                    |
| `rename_session` / `rename_current_session` | `{ path, name }` / `{ name }` | Set session display name                                                             |
| `delete_session`                            | `{ path }`                    | Delete a session file (active session protected)                                     |
#### Model & Provider

| Type                  | Payload                 | Purpose                      |
| --------------------- | ----------------------- | ---------------------------- |
| `set_model`           | `{ provider, modelId }` | Switch active model          |
| `set_thinking_level`  | `{ level }`             | Set reasoning depth          |
| `get_providers`       | —                       | Request provider list        |
| `set_provider_key`    | `{ provider, key }`     | Persist API key for provider |
| `remove_provider_key` | `{ provider }`          | Remove stored API key        |

#### Project & Filesystem

| Type             | Payload             | Purpose                                                                                        |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `get_projects`   | —                   | Request project list (replies with `projects_list`)                                            |
| `add_project`    | `{ path }`          | Register a project directory                                                                   |
| `remove_project` | `{ cwd }`           | Unregister a project from registry (sessions untouched)                                        |
| `delete_project` | `{ cwd }`           | Permanently delete a project and all its sessions (cannot delete active project)               |
| `pin_project`    | `{ cwd, pinned }`   | Pin or unpin a project (pinned projects sort to top)                                           |
| `rename_project` | `{ cwd, name }`     | Set project custom display name                                                                |
| `dir_complete`   | `{ prefix }`        | Directory path autocomplete (replies with `dir_completions`)                                   |
| `file_complete`  | `{ query }`         | Workspace file autocomplete for `@` mentions (replies with `file_completions`)                 |
| `read_file`      | `{ path }`          | Read file contents with workspace guard + null-byte rejection (replies with `file_content`)    |
| `write_file`     | `{ path, content }` | Write file contents with workspace guard + null-byte rejection (replies with `file_saved`)      |
#### Extension UI

| Type                           | Payload                                  | Purpose                                                                                                                                                             |
| ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension_ui_response`        | `{ id, value?, confirmed?, cancelled? }` | Respond to extension dialog                                                                                                                                         |
| `dismiss_widget`               | `{ key }`                                | Tear down a widget server-side and broadcast its removal                                                                                                            |
| `extension_custom_input`       | `{ id, data }`                           | Forward raw terminal bytes to an interactive custom() overlay component (`data` is the pi-tui key sequence)                                                         |
| `extension_custom_resize`      | `{ id, columns, rows }`                  | Report live viewport size for interactive custom overlays                                                                                                           |
| `extension_terminal_input`     | `{ id, data, sessionId }`                | Forward a composer keystroke (encoded as pi-tui key bytes) to the session's `onTerminalInput` handlers; the server replies with `extension_terminal_input_result`   |
| `extension_editor_text_change` | `{ text, sessionId }`                    | Sync the composer content to the server's per-session editor mirror (feeds synchronous `ctx.ui.getEditorText()`)                                                    |
#### Admin

| Type                | Payload          | Purpose                                                               |
| ------------------- | ---------------- | --------------------------------------------------------------------- |
| `get_tools`         | —                | Request full tool list and active tools (replies with `tools_list`)   |
| `set_active_tools`  | `{ toolNames }`  | Set active tool subset for the active session                         |
| `get_resources`     | —                | Request skills/prompts (replies with `resources_list`)                 |
| `get_extensions`    | —                | Request extension list (replies with `extensions_list`)               |
| `get_commands`      | —                | Request slash commands (replies with `commands_list`)                 |
| `install_skill`     | `{ url, scope }` | Install a skill from URL (replies with `skill_install_result`)         |
| `get_update_status` | —                | Check for updates (replies with `update_status`)                      |
| `run_update`        | `{ target }`     | Execute update (`ui` or `sdk`)                                        |
| `request_restart`   | —                | Request single-use nonce for server restart                           |
| `restart_server`    | `{ nonce? }`     | Restart server process                                                |
## Edit Message Flow

1. Client sends `{ type: 'edit_message', originalMessage, newMessage }`
2. Server calls `sessionManager.getUserMessagesForForking()` to find the entry by matching `originalMessage`
3. Server calls `session.navigateTree(entryId)` to rewind the session
4. Server calls `session.prompt(newMessage)` to send the edited message
5. Session events flow back naturally, rebuilding the response

## Extension UI & Markdown Flow

1. Server sends `extension_ui_request` with dialog config.
2. Client renders the dialog (`confirm`, `input`, `select`, `editor`, or `custom`).
3. User interacts → client sends `extension_ui_response` (or `extension_custom_input` for raw terminal key streams).
4. Server unblocks the session (5 min timeout).
5. Widgets are replayed from `connected`/`session_loaded` and stamped broadcasts from other sessions are ignored by the client.
6. User dismissal sends `dismiss_widget`; the server disposes the factory and broadcasts removal to every tab.
7. Display-only `CustomEntry` state (`pi.appendEntry`) rendered by `registerEntryRenderer` reaches the client as a synthetic `role:"custom"` message on `message_end` (flagged `fromEntry:true`, HTML pre-rendered server-side); history reloads interleave these notices with messages by timestamp.
8. When extensions register markdown transformers (`registerMarkdownTransformer`), final user/assistant `message_end` payloads may arrive flagged `contentTransformed:true` — the client replaces its streamed buffer with the transformed text so live and reloaded views stay identical.
9. Markdown rendering supports inline and display LaTeX math (`$math$`, `$$math$$`, `\(math\)`, `\[math\]`), rendered via `@earendil-works/pi-tui/dist/latex.js` into Unicode formatted markup during streaming and final message display.

## Terminal Input Roundtrip

1. When extensions register `onTerminalInput` handlers on the active session, the server broadcasts `{ type: 'extension_terminal_input_active', active: true, sessionId }`.
2. The client intercepts composer keystrokes, encodes them into `pi-tui` legacy terminal byte sequences (`terminal-key-encoder.ts`), and sends `{ type: 'extension_terminal_input', id, data, sessionId }`.
3. The server dispatches the key bytes through the session's handler chain and responds with `{ type: 'extension_terminal_input_result', id, consumed, data?, sessionId }`.
4. If `consumed: true`, the client swallows the default keyboard action. If `data` is returned, the client applies the rewritten key replacement.
## Error Handling

- `agent_error` events contain a human-readable error string from the SDK or server.
- `sessions_error` events contain `{ message: string, requestId?: string }`. Clients correlate `requestId` with pending `new_session` or `switch_session` operations to reset loading state or display actionable alerts.
- Server logs errors to console with `[pifrontier]` prefix.
- File operations (`read_file` / `write_file`) enforce workspace boundary guards (`isInsideWorkspace`) and reject null-byte path injections (`\0`), returning explicit `error` fields in `file_content` / `file_saved`.
- Client displays errors in the UI and allows retry.

## Session Expiry

- The server closes an established socket with close code **4001** (`Session expired`) when the JWT expires or is revoked (checked on message and on a 60s timer).
- On **4001** the client redirects to `/login?redirect=<current-url>` instead of reconnecting.
- A rejected upgrade (401) is indistinguishable from a dead server to the WS API, so after any other abnormal close the client probes `HEAD /`; `hooks.server` answers with a 302 to `/login` when the JWT is invalid, and the client redirects there.

