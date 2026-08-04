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
  model: ModelInfo;
  availableModels: ModelInfo[];
  messages: AgentMessage[];
  totalMessageCount: number;
  messagesTruncated: boolean;
  cwd: string;
  sessionName: string | undefined;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  queuedSteering: string[];
  queuedFollowUp: string[];
  piVersion: string;
  uiVersion: string;
  sessionMode: 'persisted' | 'in-memory';
  sessionPath: string | undefined;
  contextUsage: ContextUsage;
  /** Extension widgets owned by this active session; replayed on reconnect/switch. */
  widgets?: WidgetPayload[];
}
```

#### `session_loaded`
Broadcast when session changes (switch, fork, edit rewind).

`session_loaded` includes the same optional `widgets` array for the newly active session.

#### SDK Events (forwarded as-is)
- `agent_start` — Generation started
- `message_start` — Turn started
- `message_update` — Text/thinking delta during streaming
- `message_end` — Final message with usage costs
- `tool_execution_start/update/end` — Tool call lifecycle
- `agent_end` — Generation completed

#### Custom Server Events
- `model_changed` — Model selection updated
- `update_status` — Update check results
- `server_restarting` — Server shutdown initiated
- `agent_error` — Error from SDK or server
- `extension_ui_request` with `method: 'setWidget'` — session-stamped widget update. The payload includes `widgetKey`, `widgetType`, widget data, and optional `widgetPlacement` (`'aboveEditor'` or `'belowEditor'`).

### Client → Server

#### Messaging
| Type | Payload | Purpose |
|------|---------|---------|
| `prompt` | `{ message, images? }` | Send a user turn |
| `edit_message` | `{ originalMessage, newMessage }` | Edit a user message (rewinds + resends) |
| `steer` | `{ message }` | Send steering during streaming |
| `follow_up` | `{ message }` | Queue a follow-up message |
| `abort` | — | Cancel current generation |

#### Session Management
| Type | Payload | Purpose |
|------|---------|---------|
| `new_session` | `{ targetCwd? }` | Start a new session |
| `switch_session` | `{ path }` | Switch to an existing session |
| `fork_session` | `{ entryId }` | Fork session at a specific entry |
| `get_session_tree` | — | Request session branch tree |
| `get_fork_points` | — | Request user messages for forking |
| `compact` | — | Manually compact session context |
| `rename_session` / `rename_current_session` | `{ path, name }` / `{ name }` | Set session display name |
| `delete_session` | `{ path }` | Delete a session file |

#### Model & Provider
| Type | Payload | Purpose |
|------|---------|---------|
| `set_model` | `{ provider, modelId }` | Switch active model |
| `set_thinking_level` | `{ level }` | Set reasoning depth |
| `get_providers` | — | Request provider list |
| `set_provider_key` | `{ provider, key }` | Set API key for provider |
| `remove_provider_key` | `{ provider }` | Remove API key |

#### Project & Filesystem
| Type | Payload | Purpose |
|------|---------|---------|
| `get_projects` | — | Request project list |
| `add_project` | `{ path }` | Register a project directory |
| `remove_project` | `{ cwd }` | Unregister a project |
| `pin_project` | `{ cwd, pinned }` | Pin/unpin a project |
| `rename_project` | `{ cwd, name }` | Set project display name |
| `dir_complete` | `{ prefix }` | Directory path autocomplete |
| `file_complete` | `{ query }` | File path autocomplete |
| `read_file` | `{ path }` | Read file contents |
| `write_file` | `{ path, content }` | Write file contents |

#### Extension UI
| Type | Payload | Purpose |
|------|---------|---------|
| `extension_ui_response` | `{ id, value?, confirmed?, cancelled? }` | Respond to extension dialog |
| `dismiss_widget` | `{ key }` | Tear down a widget server-side and broadcast its removal |
| `extension_custom_input` | `{ id, key, alt?, ctrl?, meta?, shift? }` | Send keyboard input to extension |
| `editor_text_response` | `{ id, text }` | Respond to editor text request |

#### Admin
| Type | Payload | Purpose |
|------|---------|---------|
| `get_tools` | — | Request tool list |
| `set_active_tools` | `{ toolNames }` | Set active tool subset |
| `get_resources` | — | Request skills/prompts |
| `get_extensions` | — | Request extension list |
| `get_commands` | — | Request slash commands |
| `install_skill` | `{ url, scope }` | Install a skill from URL |
| `get_update_status` | — | Check for updates |
| `run_update` | `{ target }` | Execute update |
| `request_restart` | — | Request server restart |
| `restart_server` | `{ nonce? }` | Restart server process |

## Edit Message Flow

1. Client sends `{ type: 'edit_message', originalMessage, newMessage }`
2. Server calls `sessionManager.getUserMessagesForForking()` to find the entry by matching `originalMessage`
3. Server calls `session.navigateTree(entryId)` to rewind the session
4. Server calls `session.prompt(newMessage)` to send the edited message
5. Session events flow back naturally, rebuilding the response

## Extension UI Flow

1. Server sends `extension_ui_request` with dialog config
2. Client renders the dialog (confirm, input, select, or custom)
3. User interacts → client sends `extension_ui_response`
4. Server unblocks the session (5 min timeout)
5. Widgets are replayed from `connected`/`session_loaded` and stamped broadcasts from other sessions are ignored by the client.
6. User dismissal sends `dismiss_widget`; the server disposes the factory and broadcasts removal to every tab.

## Error Handling

- `agent_error` events contain a human-readable error string
- Server logs errors to console with `[pifrontier]` prefix
- Client should display errors in the UI and allow retry
