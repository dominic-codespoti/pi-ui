# WebSocket Protocol Reference

## Overview

All communication between client and server happens over a single WebSocket at `/ws`. Messages are JSON-encoded with a `type` field for dispatch.

## Message Types

### Server → Client

#### `connected`

Sent on WS open. Contains the full state for the session selected for this connection.

```ts
{
  type: 'connected';
  sessionId: string;
  isStreaming: boolean;
  activeToolName?: string;
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
  /** Legacy extension widgets replayed for this session. */
  widgets?: WidgetPayload[];
  /** Full extension UI snapshot (statuses, widgets, dialogs, terminalInputActive). */
  extensionUiState?: ExtensionUiStatePayload;
}
```

#### `session_loaded`

Broadcast when the visible session changes (new session, switch, or fork) or after successful compaction. Editing rewinds the selected resident and streams the replacement response without a separate snapshot. Every tab receives one authoritative snapshot for the stamped session. `requestId`, when present, is a vestigial compatibility echo; clients do not require it to accept or apply the snapshot.

```ts
{
  type: 'session_loaded';
  sessionId: string;
  isStreaming: boolean;
  activeToolName?: string;
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
  /** Optional vestigial compatibility echo; clients do not use it for correlation. */
  requestId?: string;
  contextUsage?: ContextUsage;
  tools?: Array<{ name: string; description: string; isBuiltin: boolean; origin?: string }>;
  activeToolNames?: string[];
  widgets?: WidgetPayload[];
}
```

Legacy session-operation callers may include a `requestId`, and the server may echo it on `session_loaded` or `sessions_error`. The token is vestigial: clients do not correlate operations with it or reject snapshots without it. The broadcast `session_loaded` snapshot is authoritative for every tab.

#### Session Summaries & `parentSession`

Session listing payloads (`sessions_list`, `all_sessions_list`, `session_updated`) convey `SessionSummary` objects:

```ts
interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: number; // Unix ms
  modified: number; // Unix ms
  messageCount: number; // Raw message count
  turns?: number; // User + assistant turns
  parentSession?: string; // Forked file path or subagent task parent session ID
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

- `model_changed` — `{ model: ModelInfo | null, thinkingLevel?: string, sessionId?: string }`; model selection or thinking level updated for the stamped session
- **Session stamps** — Session-scoped events carry `sessionId` so clients route each event to the corresponding resident session view, rather than treating the stamp only as a stale-event guard. `connected` and `session_loaded` snapshots describe the session visible to the receiving client, while `session_runtime` deltas may describe any resident session.
- `thinking_level_changed` — `{ level: string }`; reasoning depth updated
- `available_models_changed` — `{ availableModels: ModelInfo[], sessionId?: string }`; session-stamped refreshes from a prior session are ignored by clients
- `models_refresh_result` — `{ success: boolean, message: string }`; completion status for a forced network model-catalog refresh
- `sessions_error` — `{ message: string, requestId?: string }`; operation error with an optional vestigial compatibility echo (clients do not correlate it)
- `session_runtime` — Coalesced runtime status for a resident session; see the field reference below. A snapshot for every resident session is sent during connection initialisation.

- `session_updated` — `{ session: SessionSummary }`; coalesced catalog delta for one session (emitted on `message_end` turns)
- `all_sessions_list` / `sessions_list` — `{ sessions: SessionSummary[] }`; full session inventory
- `projects_list` — `{ projects: ProjectInfo[] }`; merged list of registered and discovered session projects
- `dir_completions` — `{ prefix: string, entries: string[] }`; filesystem directory completion matches
- `file_completions` — `{ query: string, entries: string[] }`; workspace file completion matches for composer `@` references
- `file_content` — `{ path: string, content: string, error?: string }`; file read response
- `file_saved` — `{ path: string, error?: string }`; file write response
- `file_staged` — `{ name: string, path: string, error?: string }`; binary upload staged under `.pi-ui-uploads/` (workspace-relative `path`) for `@` references
- `extension_terminal_input_active` — `{ active: boolean, sessionId?: string }`; emitted when a session's `onTerminalInput` handler set appears/disappears (register, unregister, extension reload, session dispose)
- `extension_terminal_input_result` — `{ id: string, consumed: boolean, data?: string, sessionId?: string }`; verdict for a client's `extension_terminal_input` round trip (`consumed: true` swallows the key; `data` replaces it)
- `extension_ui_state` — `{ sessionId: string, ui: ExtensionUiStatePayload }`; full extension UI snapshot
- `extension_ui_request` — `{ id, method, ... }`; extension modal/dialog request (e.g. `setWidget` with `widgetKey`, `widgetType`, `widgetPlacement`)
- `extension_ui_dismiss` — `{ id: string, sessionId?: string }`; dismisses an open extension dialog across all tabs
- `update_status` — Update check results
- `server_restarting` — Server shutdown initiated
- `slash_result` — `{ command: string, message: string, level?: 'info' | 'warning' | 'error', sessionId?: string }`; output from built-in commands like direct shell execution (`!`)
- `agent_error` — Error from SDK or server

##### `session_runtime` fields

Runtime deltas are emitted only when the serialized status changes (with the server's 300 ms per-session debounce); connection initialisation separately sends one snapshot per resident. This is a delta stream for live residents, not a replacement for session inventory messages.

| Field            | Type                                                 | Meaning                                                                                         |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `sessionId`      | `string`                                             | Session whose runtime status changed                                                            |
| `phase`          | `'idle' \| 'running' \| 'awaiting-input' \| 'error'` | Canonical lifecycle phase                                                                       |
| `isRunning`      | `boolean`                                            | Compatibility field; true exactly when `phase` is `running`                                     |
| `activeToolName` | `string` (optional)                                  | Tool currently executing; omitted when no tool is active                                        |
| `lastActivity`   | `number`                                             | Unix epoch milliseconds of the latest session activity                                          |
| `unread`         | `boolean`                                            | True when a turn ended while no socket focused this session; cleared by `session_focus`         |
| `needsAttention` | `boolean`                                            | True for `awaiting-input` and `error` phases                                                    |
| `resident`       | `boolean`                                            | True for a live in-memory session; false for a non-resident status such as a deletion tombstone |

Non-resident sessions have no live runtime producer; their disk-backed metadata remains the inventory source, and rows without runtime status render idle until the session becomes resident.

### Client → Server

Session-scoped client messages accept an optional target field, `sessionId?: string`. The server resolves the target in this order: explicit `sessionId` → this socket's focused session (`focusedSessionId`) → server-selected session (`selectedSessionId`). Messages that identify a session by path (`switch_session`, `rename_session`, and `delete_session`) retain their path-based payloads and do not use this fallback. `session_focus` tells the server which session is visible on this socket and is also the event that clears that session's `unread` flag.

#### Messaging

| Type           | Payload                                       | Purpose                                 |
| -------------- | --------------------------------------------- | --------------------------------------- |
| `prompt`       | `{ sessionId?, message, images? }`            | Send a user turn                        |
| `edit_message` | `{ sessionId?, originalMessage, newMessage }` | Edit a user message (rewinds + resends) |
| `steer`        | `{ sessionId?, message }`                     | Send steering during streaming          |
| `follow_up`    | `{ sessionId?, message }`                     | Queue a follow-up message               |
| `abort`        | `{ sessionId? }`                              | Cancel current generation               |

#### Session Management

| Type                  | Payload                         | Purpose                                                                                                          |
| --------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `new_session`         | `{ targetCwd?, requestId? }`    | Start a new session; an optional legacy `requestId` may be echoed in `session_loaded`/`sessions_error`           |
| `switch_session`      | `{ path, requestId? }`          | Switch to an existing session; an optional legacy `requestId` may be echoed in `session_loaded`/`sessions_error` |
| `session_focus`       | `{ sessionId: string \| null }` | Set the session visible to this socket and clear its unread flag when non-null                                   |
| `fork_session`        | `{ sessionId?, entryId }`       | Fork a specific resident session at an entry                                                                     |
| `get_all_sessions`    | —                               | Request all sessions across all project directories (replies with `all_sessions_list`)                           |
| `get_session_tree`    | `{ sessionId? }`                | Request session branch tree                                                                                      |
| `get_fork_points`     | `{ sessionId? }`                | Request user messages for forking                                                                                |
| `compact`             | `{ sessionId? }`                | Manually compact session context (carries updated `contextUsage`)                                                |
| `set_auto_compaction` | `{ sessionId?, enabled }`       | Toggle auto-compaction                                                                                           |
| `set_auto_retry`      | `{ sessionId?, enabled }`       | Toggle auto-retry                                                                                                |
| `rename_session`      | `{ path, name }`                | Set session display name                                                                                         |
| `delete_session`      | `{ path }`                      | Delete a session file (resident session protected while busy)                                                    |

#### Model & Provider

| Type                  | Payload                             | Purpose                                           |
| --------------------- | ----------------------------------- | ------------------------------------------------- |
| `set_model`           | `{ sessionId?, provider, modelId }` | Switch session's model                            |
| `set_thinking_level`  | `{ sessionId?, level }`             | Set session reasoning depth                       |
| `get_providers`       | —                                   | Request provider list                             |
| `refresh_models`      | —                                   | Force a network refresh of dynamic model catalogs |
| `set_provider_key`    | `{ provider, key }`                 | Persist API key for provider                      |
| `remove_provider_key` | `{ provider }`                      | Remove stored API key                             |

#### Project & Filesystem

| Type             | Payload             | Purpose                                                                                                                                                                         |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_projects`   | —                   | Request project list (replies with `projects_list`)                                                                                                                             |
| `add_project`    | `{ path }`          | Register a project directory                                                                                                                                                    |
| `remove_project` | `{ cwd }`           | Unregister a project from registry (sessions untouched)                                                                                                                         |
| `delete_project` | `{ cwd }`           | Permanently delete a project and all its sessions (cannot delete active project)                                                                                                |
| `pin_project`    | `{ cwd, pinned }`   | Pin or unpin a project (pinned projects sort to top)                                                                                                                            |
| `rename_project` | `{ cwd, name }`     | Set project custom display name                                                                                                                                                 |
| `dir_complete`   | `{ prefix }`        | Directory path autocomplete (replies with `dir_completions`)                                                                                                                    |
| `file_complete`  | `{ query }`         | Workspace file autocomplete for `@` mentions (replies with `file_completions`)                                                                                                  |
| `read_file`      | `{ path }`          | Read file contents with workspace guard + null-byte rejection (replies with `file_content`)                                                                                     |
| `write_file`     | `{ path, content }` | Write file contents with workspace guard + null-byte rejection (replies with `file_saved`)                                                                                      |
| `upload_file`    | `{ name, data }`    | Stage a binary upload (base64 `data`) under `.pi-ui-uploads/` with sanitized unique name (bounded by the 4 MB WS frame — ~3 MB file; replies requester-only with `file_staged`) |

#### Extension UI

| Type                           | Payload                                              | Purpose                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension_ui_response`        | `{ sessionId?, id, value?, confirmed?, cancelled? }` | Respond to extension dialog                                                                                                                                       |
| `dismiss_widget`               | `{ key }`                                            | Tear down a widget server-side and broadcast its removal                                                                                                          |
| `extension_custom_input`       | `{ sessionId?, id, data }`                           | Forward raw terminal bytes to an interactive custom() overlay component (`data` is the pi-tui key sequence)                                                       |
| `extension_custom_resize`      | `{ sessionId?, id, columns, rows }`                  | Report live viewport size for interactive custom overlays                                                                                                         |
| `extension_terminal_input`     | `{ sessionId?, id, data }`                           | Forward a composer keystroke (encoded as pi-tui key bytes) to the session's `onTerminalInput` handlers; the server replies with `extension_terminal_input_result` |
| `extension_editor_text_change` | `{ sessionId?, text }`                               | Sync the composer content to the server's per-session editor mirror (feeds synchronous `ctx.ui.getEditorText()`)                                                  |

#### Admin

| Type                | Payload                     | Purpose                                                             |
| ------------------- | --------------------------- | ------------------------------------------------------------------- |
| `get_tools`         | —                           | Request full tool list and active tools (replies with `tools_list`) |
| `set_active_tools`  | `{ sessionId?, toolNames }` | Set the active tool subset for a session                            |
| `get_resources`     | —                           | Request skills/prompts (replies with `resources_list`)              |
| `get_extensions`    | —                           | Request extension list (replies with `extensions_list`)             |
| `install_skill`     | `{ url, scope }`            | Install a skill from URL (replies with `skill_install_result`)      |
| `get_update_status` | —                           | Check for updates (replies with `update_status`)                    |
| `run_update`        | `{ target }`                | Execute update (`ui` or `sdk`)                                      |
| `request_restart`   | —                           | Request single-use nonce for server restart                         |
| `restart_server`    | `{ nonce? }`                | Restart server process                                              |

## Session Switching

The server retains a resident `Map<sessionId, ManagedSession>` and a `selectedSessionId` default; each socket also tracks its `focusedSessionId`. Switching selects the target, reuses the existing resident when its `.jsonl` path is already open, or admits a new resident. It does not dispose or abort other residents, so their events and background runs continue in parallel and are routed by `sessionId`.

Residency is bounded by count (`PI_UI_MAX_RESIDENT_SESSIONS`, default 4) and estimated parsed-history bytes (`PI_UI_MAX_RESIDENT_HISTORY_MB`, default 48 MiB; `.jsonl` stat size × 5), with environment-overridable bounded caps. Running/tool/awaiting-input sessions are pinned; least-recently-active unpinned entries are evicted, with project outliers preferred to reduce extension-cache churn. `PI_UI_MAX_CONCURRENT_RUNS` (default 2) separately limits concurrent LLM/tool runs, queueing work above the cap. The server keeps one resident per `.jsonl` path because the SDK provides no session-file locking. Session runtime status is separate from the metadata inventory and is reported by `session_runtime`.

## Edit Message Flow

1. Client sends `{ type: 'edit_message', sessionId?, originalMessage, newMessage }`
2. Server calls `sessionManager.getUserMessagesForForking()` to find the entry by matching `originalMessage`
3. Server calls `session.navigateTree(entryId)` to rewind the session
4. Server calls `session.prompt(newMessage)` to send the edited message
5. Session events flow back naturally, rebuilding the response

## Extension UI & Markdown Flow

1. Server sends `extension_ui_request` with dialog config.
2. Client renders the dialog (`confirm`, `input`, `select`, `editor`, or `custom`).
3. User interacts → client sends `extension_ui_response` (or `extension_custom_input` for raw terminal key streams).
4. Server unblocks the session (5 min timeout).
5. Widgets are replayed from `connected`/`session_loaded`; stale stamped broadcasts buffered across a switch are ignored by the client.
6. User dismissal sends `dismiss_widget`; the server disposes the factory and broadcasts removal to every tab.
7. Display-only `CustomEntry` state (`pi.appendEntry`) rendered by `registerEntryRenderer` reaches the client as a synthetic `role:"custom"` message on `message_end` (flagged `fromEntry:true`, HTML pre-rendered server-side); history reloads interleave these notices with messages by timestamp.
8. When extensions register markdown transformers (`registerMarkdownTransformer`), final user/assistant `message_end` payloads may arrive flagged `contentTransformed:true` — the client replaces its streamed buffer with the transformed text so live and reloaded views stay identical.
9. Markdown rendering supports inline and display LaTeX math (`$math$`, `$$math$$`, `\(math\)`, `\[math\]`), rendered via `@earendil-works/pi-tui/dist/latex.js` into Unicode formatted markup during streaming and final message display.

## Terminal Input Roundtrip

1. When extensions register `onTerminalInput` handlers on a resident session, the server broadcasts `{ type: 'extension_terminal_input_active', active: true, sessionId }`.
2. The client intercepts composer keystrokes, encodes them into `pi-tui` legacy terminal byte sequences (`terminal-key-encoder.ts`), and sends `{ type: 'extension_terminal_input', id, data, sessionId }`.
3. The server dispatches the key bytes through the session's handler chain and responds with `{ type: 'extension_terminal_input_result', id, consumed, data?, sessionId }`.
4. If `consumed: true`, the client swallows the default keyboard action. If `data` is returned, the client applies the rewritten key replacement.

## Error Handling

- `agent_error` events contain a human-readable error string from the SDK or server.
- File operations (`read_file` / `write_file` / `upload_file`) enforce workspace boundary guards (`isInsideWorkspace`) and reject null-byte path injections (`\0`), returning explicit `error` fields in `file_content` / `file_saved` / `file_staged`.
- Server logs errors to console with `[pifrontier]` prefix.
- Client displays errors in the UI and allows retry.

## Session Expiry

- The server closes an established socket with close code **4001** (`Session expired`) when the JWT expires or is revoked (checked on message and on a 60s timer).
- On **4001** the client redirects to `/login?redirect=<current-url>` instead of reconnecting.
- A rejected upgrade (401) is indistinguishable from a dead server to the WS API, so after any other abnormal close the client probes `HEAD /`; `hooks.server` answers with a 302 to `/login` when the JWT is invalid, and the client redirects there.
