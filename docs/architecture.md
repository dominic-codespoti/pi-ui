# Architecture Deep Dive

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                       Bun.serve()                           │
│                                                             │
│  ┌─────────────┐     HTTP     ┌──────────────────────────┐  │
│  │  bin/pifron- │  ────────── │  server.ts               │  │
│  │  tier.ts     │  (or HMR)   │                           │  │
│  │  (CLI)       │             │  ┌─────────────────────┐  │  │
│  └─────────────┘             │  │ SvelteKit handler    │  │  │
│                               │  │ (build/handler.js)   │  │  │
│                               │  └─────────────────────┘  │  │
│                               │                           │  │
│                               │  /ws ─── WebSocket ────  │  │
│                               │    (JWT auth-gated)       │  │
│                               │           │               │  │
│                               │           ▼               │  │
│                               │  ┌─────────────────────┐  │  │
│                               │  │  pi SDK session     │  │  │
│                               │  │  (lazy-loaded)      │  │  │
│                               │  │                     │  │  │
│                               │  │ session.subscribe() │  │  │
│                               │  │   → pub/sub to all  │  │  │
│                               │  │     WS clients      │  │  │
│                               │  └─────────────────────┘  │  │
│  ┌─────────────────────┐      │                           │  │
│  │ Session pool (LRU)  │◄─────│ sessionPool Map          │  │
│  │ idle cleanup 30 min │      └──────────────────────────┘  │
│  └─────────────────────┘                                    │
│                                                             │
│  Dependency: @earendil-works/pi-coding-agent SDK            │
│  (~136 MB on first import, ~32 MB RSS idle)                 │
└─────────────────────────────────────────────────────────────┘
```

## Lifecycle

1. **CLI (`pi-ui`)** parses args, resolves password (env var → interactive prompt), optionally daemonizes
2. **server.ts** validates `PI_PASSWORD`, initializes bcrypt hash + JWT secret
3. **Bun.serve** starts on `PORT` (default 3000); requests route to SvelteKit handler except `/ws`
4. **First WebSocket connect** at `/ws`:
   - JWT cookie validated
   - pi SDK lazily imported
   - `SessionManager.continueRecent(cwd)` resumes most recent session
   - `AgentSession` created, registered in **session pool** with LRU idle cleanup (30 min)
   - SDK events forwarded to all WS clients via `server.publish()`
5. **On client disconnect**: 15s grace period before cancelling pending extension dialogs
6. **Session switch**: preserves old session in pool, registers new one, broadcasts `session_loaded` with max 100 messages

## Session Pool

- Sessions are keyed by `cwd` (working directory)
- Idle sessions are evicted after 30 minutes
- Reconnecting to an existing pool entry reuses the session (preserves in-progress state)
- `activeSession()` returns the current session; throws if none

## SDK Integration

The pi SDK (`@earendil-works/pi-coding-agent`) provides:

- **`AgentSession`** — Main session object. Handles prompting, streaming, steering, thinking levels
- **`SessionManager`** — File-based session persistence. Manages `.jsonl` session files under `~/.pi/agent/sessions/`
- **`ModelRegistry`** — Available models from configured providers
- **Event subscription** — `session.subscribe()` emits `AgentSessionEvent` for all session activity

### Key SDK Methods

| Method | Purpose |
|--------|---------|
| `session.prompt(text, options?)` | Send a user turn |
| `session.steer(text)` | Send steering during streaming |
| `session.navigateTree(targetId, options?)` | Rewind session to a specific entry |
| `sessionManager.getUserMessagesForForking()` | Get `{ entryId, text }[]` for all user messages |
| `sessionManager.createBranchedSession(entryId)` | Fork session at a point |
| `sessionManager.isPersisted()` | Check if session is saved to disk |

## Lazy Loading

Both the SDK and SvelteKit handler are lazy-loaded to minimize startup memory:

- **SDK**: Imported on first WebSocket connection (~136 MB)
- **SvelteKit handler**: Imported on first HTTP request (~30 MB)
- This keeps initial process RSS low for the CLI startup phase

## Bun-Specific Patterns

- **`Bun.serve()`** — Single server handles both HTTP and WebSocket
- **`server.publish('pi', payload)`** — Bun's built-in pub/sub for broadcasting to all WS clients
- **`server.upgrade(req)`** — WebSocket upgrade handling
- **`globalThis`** for shared state — bcrypt hash, JWT secret, rate limit data, session pool
