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
│                                    │  │   → session_loaded (100msgs)│ │ │
│                                    │  │ Warm: connected (100 msgs)  │ │ │
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
│  │ Single live session    │◄───────│ live AgentSession binding   │    │
│  │ • exactly one runtime  │        │ (hostBound flag, diag)      │    │
│  │ • switch disposes/opens│        └─────────────────────────────┼────┘
│  └────────────────────────┘                                      │
│                                                                  │
│  ┌────────────────────────┐        ┌─────────────────────────────┼────┐
│  │ session-watcher        │───────►│ session-catalog / scanner   │    │
│  │ (fs.watch on sessions  │ debounced│ (stat cache + tasks/ scan)│    │
│  │  dir dirty signals)    │        └─────────────────────────────┼────┘
│  └────────────────────────┘                                      │
│                                                                  ▼
│  Dependency: @earendil-works/pi-coding-agent SDK        Extension RPC
│  (~136 MB on first import, ~32 MB RSS baseline)          (tools, dialogs)
└─────────────────────────────────────────────────────────────────────────┘
```

## Lifecycle

1. **CLI (`pi-ui`)** parses args, resolves password (env var → interactive prompt), optionally daemonizes
2. **server.ts** validates `PI_PASSWORD`, initializes bcrypt hash + JWT secret
3. **Bun.serve** starts on `PORT` (default 3000); requests route to SvelteKit handler except `/ws`
4. **First WebSocket connect** at `/ws`:
   - JWT cookie validated
   - pi SDK lazily imported
   - **Cold start** (no live session): sends a shell `connected` immediately (0 messages) so the client paints instantly from its snapshot cache; full initial history follows as `session_loaded` with max 100 messages once the SDK finishes parsing the JSONL session file. Extension host binding (`bindRpcHost`) runs in the background to avoid blocking initial UI paint.
   - **Warm reconnect**: reuses the live `AgentSession` and sends `connected` with max 100 messages directly (bounded for wire transfer).
   - SDK events forwarded to all WS clients via `server.publish()`
5. **On client disconnect**: 15s grace period before cancelling pending extension dialogs
6. **Session switch**: disposes the current live `AgentSession`, opens the target from its on-disk `.jsonl` file, and broadcasts one authoritative bounded `session_loaded` snapshot (max 100 messages) to every tab.

## Single Live Session

- The server retains exactly one live `AgentSession` runtime at a time, with diagnostics and a `hostBound` flag indicating whether background `bindRpcHost` extension host binding completed.
- Switching disposes the current runtime before opening the target session from its on-disk `.jsonl` file; reconnecting while that session remains live reuses it.
- Switching back to a previous session re-reads its bounded message tail from disk instead of resuming from memory. This is intended design.
- Non-live sessions have no in-memory background run/unread state. Sidebar liveness covers the active session; other sessions update through the filesystem watcher.
- Session catalogs (`session-catalog.ts` / `project-catalog.ts`) surface non-live sessions from on-disk `.jsonl` files. Discovery scans the session storage directory and walks subagent `tasks/` subdirectories (`<parent_stem>/tasks/*.jsonl`) with line-by-line streaming and a persisted mtime/size stat cache.
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
- **`globalThis`** for shared state — bcrypt hash, JWT secret, rate limit data, and the single live session binding
- **`boundMessagesForWire`** — Character-budgeted wire message bounding (per-block cap 80 KB, per-message cap 128 KB). `totalBudget` (512 KB) is a hard ceiling covering both message content and rendered extension aux fields; `MAX_WIRE_AUX_TOTAL_CHARS` (256 KB) is a sub-cap inside that total. These bounds prevent WS payload stalls on giant reasoning or file outputs. Derived extension HTML, parsed component trees, terminal lines, and session trees have independent node/character caps.
- **Valibot validation (`parseServerMessage`)** — Strict schema validation for incoming server-sent WebSocket payloads on the client to ensure type safety and early detection of payload mismatches.
