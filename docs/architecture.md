# Architecture Deep Dive

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                               Bun.serve()                               │
│                                                                         │
│  ┌─────────────┐       HTTP        ┌──────────────────────────────────┐ │
│  │  bin/pifron-│  ───────────────  │  server.ts                       │ │
│  │  tier.ts    │    (or HMR)       │                                  │ │
│  │  (CLI)      │                   │  ┌─────────────────────────────┐ │ │
│  └─────────────┘                   │  │ SvelteKit handler           │ │ │
│                                    │  │ (build/handler.js)          │ │ │
│                                    │  └─────────────────────────────┘ │ │
│                                    │                                  │ │
│                                    │  /ws ──────── WebSocket ───────  │ │
│                                    │       (JWT auth-gated)           │ │
│                                    │              │                   │ │
│                                    │              ▼                   │ │
│                                    │  ┌─────────────────────────────┐ │ │
│                                    │  │ Cold: shell connected (0 ms)│ │ │
│                                    │  │   → session_loaded (40 msgs)│ │ │
│                                    │  │ Warm: connected (40 msgs)   │ │ │
│                                    │  │                             │ │ │
│                                    │  │ pi SDK session              │ │ │
│                                    │  │   (lazy-loaded)             │ │ │
│                                    │  │                             │ │ │
│                                    │  │ session.subscribe()         │ │ │
│                                    │  │   → pub/sub to all clients  │ │ │
│                                    │  │                             │ │ │
│                                    │  │ background bindRpcHost ──┐  │ │
│                                    │  │   → tools_list/commands  │  │ │
│                                    │  └──────────────────────────┼──┘ │
│  ┌────────────────────────┐        │                             │    │
│  │ Session pool (LRU)     │◄───────│ sessionPool Map             │    │
│  │ • keyed by sid/cwd     │        │ (hostBound flag, diag)      │    │
│  │ • idle cleanup 30 min  │        └─────────────────────────────┼────┘
│  └────────────────────────┘                                      │
│                                                                  │
│  ┌────────────────────────┐        ┌─────────────────────────────┼────┐
│  │ session-watcher        │───────►│ session-catalog / scanner   │    │
│  │ (fs.watch on sessions  │ debounced│ (stat cache + tasks/ scan)│    │
│  │  dir dirty signals)    │        └─────────────────────────────┼────┘
│  └────────────────────────┘                                      │
│                                                                  ▼
│  Dependency: @earendil-works/pi-coding-agent SDK        Extension RPC
│  (~136 MB on first import, ~32 MB RSS idle)             (tools, dialogs)
└─────────────────────────────────────────────────────────────────────────┘
```

## Lifecycle

1. **CLI (`pi-ui`)** parses args, resolves password (env var → interactive prompt), optionally daemonizes
2. **server.ts** validates `PI_PASSWORD`, initializes bcrypt hash + JWT secret
3. **Bun.serve** starts on `PORT` (default 3000); requests route to SvelteKit handler except `/ws`
4. **First WebSocket connect** at `/ws`:
   - JWT cookie validated
   - pi SDK lazily imported
   - **Cold start** (no pooled session): sends a shell `connected` immediately (0 messages) so the client paints instantly from its snapshot cache; full initial history follows as `session_loaded` with max 40 messages once the SDK finishes parsing the JSONL session file. Extension host binding (`bindRpcHost`) runs in the background to avoid blocking initial UI paint.
   - **Warm reconnect**: reuses the pooled `AgentSession` and sends `connected` with max 40 messages directly (bounded for wire transfer).
   - SDK events forwarded to all WS clients via `server.publish()`
5. **On client disconnect**: 15s grace period before cancelling pending extension dialogs
6. **Session switch**: saves current UI state in `SessionViewCache` (input drafts, collapsed/expanded user message views), correlates requests via `requestId`, preserves old session in pool, registers new one, and broadcasts `session_loaded` with max 40 messages

## Session Pool

- Sessions are managed in a server-side `sessionPool` Map tracking runtime instances, active state, diagnostics, and a `hostBound` flag (indicating whether background `bindRpcHost` extension host binding completed).
- Idle sessions are evicted after 30 minutes.
- Reconnecting to an existing pool entry reuses the session (preserves in-progress state).
- `activeSession()` returns the current session; throws if none.
- Session discovery scans the session storage directory and walks subagent `tasks/` subdirectories (`<parent_stem>/tasks/*.jsonl`) with line-by-line streaming and a persisted mtime/size stat cache.
- A recursive filesystem watcher (`startSessionWatch`) monitors session directory updates and invalidates the session scan cache with debouncing.

## SDK Integration

The pi SDK (`@earendil-works/pi-coding-agent`) provides:

- **`AgentSession`** — Main session object. Handles prompting, streaming, steering, thinking levels
- **`SessionManager`** — File-based session persistence. Manages `.jsonl` session files under `~/.pi/agent/sessions/`
- **`ModelRegistry`** — Available models from configured providers
- **Event subscription** — `session.subscribe()` emits `AgentSessionEvent` for all session activity
- **`MarkdownTransformer`** — Extensions can register markdown transformers (`sess.extensionRunner.getMarkdownTransformers()`) to rewrite message text before wire broadcast (`applyMarkdownTransformers`).
- **`CustomEntry` renderer** — Renders custom extension entries (`registerEntryRenderer`) into synthetic `role: 'custom'` wire notices (`renderCustomEntry` / `customEntriesForWire`) for display in the chat timeline.
- **`ThinkingLevelMap`** — Maps model-supported reasoning depth rungs (`thinkingLevelMap` on `ModelInfo`), allowing the UI to derive and clamp available thinking levels dynamically without hardcoded rungs.

### Key SDK Methods

| Method                                          | Purpose                                         |
| ----------------------------------------------- | ----------------------------------------------- |
| `session.prompt(text, options?)`                | Send a user turn                                |
| `session.steer(text)`                           | Send steering during streaming                  |
| `session.navigateTree(targetId, options?)`      | Rewind session to a specific entry              |
| `sessionManager.getUserMessagesForForking()`    | Get `{ entryId, text }[]` for all user messages |
| `sessionManager.createBranchedSession(entryId)` | Fork session at a point                         |
| `sessionManager.isPersisted()`                  | Check if session is saved to disk               |

## Lazy Loading

Both the SDK and SvelteKit handler are lazy-loaded to minimize startup memory:

- **SDK**: Imported on first WebSocket connection (~136 MB)
- **SvelteKit handler**: Imported on first HTTP request (~30 MB)
- This keeps initial process RSS low for the CLI startup phase

## Bun-Specific Patterns & Transport Utilities

- **`Bun.serve()`** — Single server handles both HTTP and WebSocket
- **`server.publish('pi', payload)`** — Bun's built-in pub/sub for broadcasting to all WS clients
- **`server.upgrade(req)`** — WebSocket upgrade handling
- **`globalThis`** for shared state — bcrypt hash, JWT secret, rate limit data, session pool
- **`boundMessagesForWire`** — Character-budgeted wire message bounding (per-block cap 80 KB, per-message cap 128 KB, total budget 512 KB, falling back to 512-byte min caps for older messages) preventing WS payload stalls on giant reasoning or file outputs.
- **Valibot validation (`parseServerMessage`)** — Strict schema validation for incoming server-sent WebSocket payloads on the client to ensure type safety and early detection of payload mismatches.
- **`SessionViewCache`** — Client-side caching of session-specific transient view state (input drafts, expanded user messages, truncated user message toggles) across session switches.
