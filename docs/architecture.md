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
│                                    │  │ Cold: SDK loads resident     │ │ │
│                                    │  │   → connected (100 msgs)     │ │ │
│                                    │  │ Warm: connected (100 msgs)   │ │ │
│                                    │  │                             │ │ │
│                                    │  │ pi SDK resident sessions       │ │ │
│                                    │  │   (lazy-loaded per entry)      │ │ │
│                                    │  │                               │ │ │
│                                    │  │ each session.subscribe()       │ │ │
│                                    │  │   → pub/sub to all clients     │ │ │
│                                    │  │                             │ │ │
│                                    │  │ background bindRpcHost ──┐  │ │
│                                    │  │   → tools_list/commands  │  │ │
│                                    │  └──────────────────────────┼──┘ │
│  ┌────────────────────────┐        │                             │    │
│  │  Resident session set   │◄───────│ resident Map<sessionId,     │ │
│  │  • selected + focused  │        │ ManagedSession>              │ │
│  │  • count/bytes cap     │        │ per-session services/events  │ │
│  │  • pin + LRU eviction  │        │ concurrent-run queue         │ │
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
   - **Cold start** (no resident session): pi SDK creates or resumes the first resident and sends a bounded `connected` snapshot (max 100 messages). Extension host binding (`bindRpcHost`) runs in the background to avoid blocking session creation.
   - **Warm reconnect**: reuses the selected resident `AgentSession` and sends `connected` with max 100 messages directly (bounded for wire transfer).
   - SDK events from every resident are forwarded to all WS clients via `server.publish()`, stamped with that resident's `sessionId`
   - During connection initialisation, the socket receives one `session_runtime` snapshot for every resident session
5. **On client disconnect**: 15s grace period before cancelling pending extension dialogs
6. **Session switch**: resolves the target by its `.jsonl` path, reuses it when already resident (the one-owner-per-file rule), or admits a new resident; selection changes without disposing other residents or aborting their runs, and an authoritative bounded `session_loaded` snapshot is sent to the tabs

## Resident Sessions

- The server stores `ManagedSession` entries in a `resident` `Map` keyed by session id. `selectedSessionId` is the server default for un-targeted requests, while each socket's `focusedSessionId` records the session visible in that client.
- Admission reuses an entry for an already-resident `.jsonl` path; the SDK has no session-file locking, so the server never opens the same session file twice. Every resident owns its session services and extension runtime.
- Residency is bounded by count (`PI_UI_MAX_RESIDENT_SESSIONS`, default 4) and estimated parsed-history bytes (`PI_UI_MAX_RESIDENT_HISTORY_MB`, default 48 MiB), with both limits environment-overridable and bounded. The estimate is the session `.jsonl` stat size multiplied by 5. Running sessions, active-tool sessions, sessions with pending extension dialogs, sessions with queued runs or a prompt in flight, and `awaiting-input` sessions are pinned; least-recently-active unpinned, non-selected entries are evicted when a cap is exceeded, preferring project outliers to reduce extension-cache churn. Eviction disposes only an unpinned session; it is not used to park active work.
- A separate concurrent-run cap (`PI_UI_MAX_CONCURRENT_RUNS`, default 2) limits simultaneous LLM/tool runs. Work beyond that cap queues rather than starting another run; residency and run concurrency are independent.
- All resident sessions forward SDK events, each stamped with `sessionId`, so clients can route messages and runtime state to the corresponding view. Prompt, steer, follow-up, abort, edit, compact, model, thinking-level, and tool mutations are serialized per session; structural session operations and shared provider-credential mutations retain global queues.
- Each resident carries a `generation` epoch bumped on reload and before dispose. Async continuations (prompt/steer/follow-up, edit, queued dispatch, shortcuts, timers) capture it and abort stale work instead of touching a replaced session — the SDK invalidates the extension runner on reload even though the session object is unchanged, so object identity alone cannot detect it.
- Extension-host reloads (`reloadSessionHost`: skill/package/flag/trust mutations) defer while the session is busy (streaming, active tools, queued runs) and apply at the next non-retry `agent_end`; callers report `applied` vs `deferred`. Identical crash broadcasts are deduped (30 s window; full fidelity in the server log).
- Binary uploads (`upload_file`) stage under `<workspace>/.pi-ui-uploads/` with sanitized unique names (bounded by the 4 MB WS frame, ~3 MB per file; oldest-first prune past 20 files) and are referenced via `@` paths for the agent to open.
- Session catalogs (`session-catalog.ts` / `project-catalog.ts`) surface non-resident sessions from on-disk `.jsonl` files. Discovery scans the session storage directory and walks subagent `tasks/` subdirectories (`<parent_stem>/tasks/*.jsonl`) with line-by-line streaming and a persisted mtime/size stat cache.
- A recursive filesystem watcher (`startSessionWatch`) monitors session directory updates and invalidates the session scan cache with debouncing.

## Liveness and Sidebar Status

The server emits coalesced `session_runtime` deltas when a resident's serialized status changes and sends a snapshot for every resident on connect. Each frame contains:

| Field            | Meaning                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `sessionId`      | Resident session identified by the status                                                       |
| `phase`          | `idle`, `running`, `awaiting-input`, or `error`                                                 |
| `isRunning`      | Compatibility field; true exactly when `phase` is `running`                                     |
| `activeToolName` | Current tool name, omitted when no tool is active                                               |
| `lastActivity`   | Unix epoch milliseconds for the latest session activity                                         |
| `unread`         | A turn completed while no socket focused this session; cleared when it receives focus           |
| `needsAttention` | True for `awaiting-input` or `error`                                                            |
| `resident`       | True for a live in-memory session; false for a non-resident status such as a deletion tombstone |

The sidebar uses those fields in priority order: an active tool shows the tool spinner; otherwise `phase === 'running'` shows the green pulsing dot; then `needsAttention` shows the amber attention dot; then `unread` shows the primary unchecked-result dot. Idle child sessions use a branch icon when `parentSession` is present, otherwise an idle dot. A project row rolls up green when any child is running, otherwise primary when any child is unread.

Session targeting follows explicit `sessionId` → socket `focusedSessionId` → server `selectedSessionId`. The `session_focus` client message updates the socket's visible session and clears that session's unread flag.

## SDK Integration

The pi SDK (`@earendil-works/pi-coding-agent`) provides:

- **`AgentSession`** — Main session object. Handles prompting, streaming, steering, thinking levels
- **`SessionManager`** — File-based session persistence. Manages `.jsonl` session files under `~/.pi/agent/sessions/`
- **`ModelRegistry`** — Available models from configured providers
- **Event subscription** — `session.subscribe()` emits `AgentSessionEvent` for all session activity
- **`MarkdownTransformer`** — Extensions can register markdown transformers (`sess.extensionRunner.getMarkdownTransformers()`) to rewrite message text before wire broadcast (`applyMarkdownTransformers`).
- **`CustomEntry` renderer** — Renders custom extension entries (`registerEntryRenderer`) into synthetic `role: 'custom'` wire notices (`renderCustomEntry` / `customEntriesForWire`) for display in the chat timeline.
- **Bundled skill** — Pi UI bundles the generated `pi-ui-extension-ui` skill to teach agents how extension UI renders. `createSdkSession` passes it through `resourceLoaderOptions.additionalSkillPaths` (`src/lib/server/bundled-resources.ts`); it is generated from `src/lib/extension-ui-capabilities/`, with examples verified against the real parser in Vitest and staleness enforced by `check:skill`. Changes to extension UI behavior in `server.ts` or `extension-component.svelte` must update the catalog and regenerate the skill.

## SDK State and UI Projections

- **Thinking levels and scoped models** — The SDK session is authoritative for supported thinking levels, current level, and model scope. Model changes publish `thinkingLevel`, `availableThinkingLevels`, and `scopedModels`; clients request changes and render those server-reported values rather than calculating availability locally. The web UI deliberately does not expose model cycling or scoping (no `Ctrl+Alt+M`, no scope dialog, `/scoped-models` is hidden); the `cycle_model` / `set_scoped_models` protocol messages remain for other clients, and a scope saved in Pi settings (`enabledModels`) is still honoured by the SDK.
- **Footer data** — `src/lib/server/footer-data.ts` provides a per-session `SessionFooterDataProvider` to SDK extension footers: current Git branch, extension statuses, available-provider count, and branch-change notifications. It watches Git `HEAD` and the server publishes session `footer_data` including token/cost stats.
- **Tool details** — `src/lib/server/tool-details.ts` projects only recognized built-in tool detail fields into history and `tool_output`; extension details stay private. `filesystem-handlers.ts` permits `read_file` outside the workspace only for verified built-in bash result paths belonging to the focused session.
- **SDK settings** — `src/lib/server/handlers/sdk-settings-handlers.ts` reads the global/project settings snapshot but writes only an explicit key allow-list through public typed `SettingsManager` setters, currently at global scope. SDK 0.87.1 provides no public generic setter, so `compaction.reserveTokens`, `compaction.keepRecentTokens`, `branchSummary.reserveTokens`, `branchSummary.skipPrompt`, `retry.maxRetries`, `retry.baseDelayMs`, `retry.maxAgentDelayMs`, `retry.provider.timeoutMs`, `retry.provider.maxRetries`, `retry.provider.maxRetryDelayMs`, `websocketConnectTimeoutMs`, and `defaultTools` are read-only in this UI.
- **Tree navigation** — `src/lib/server/handlers/tree-handlers.ts` validates entry IDs and normalizes labels/instructions before SDK navigation or label updates. The server serializes current-leaf/current-path markers into tree nodes and responds to navigation via `tree_navigated`.
- **Provider login** — `provider-login-session.ts` bridges the SDK flow to the requesting WebSocket: a per-provider in-flight guard and a four-login concurrency cap prevent duplicate/overloaded flows. The adapter forwards SDK auth events and prompts to that socket, maps the SDK-wide `AuthInteraction.signal` and each prompt's own signal to cancellation (`provider_login_prompt_cancel`), and aborts that socket's logins on close. `runtime.login` runs outside the credential-mutation queue so interactive OAuth/API-key steps cannot block credential changes; only the post-login refresh/broadcast is queued. OAuth's manual redirect/paste interaction is supported for remote clients such as Raspberry Pi.
- **Project branch metadata** — `project-catalog.ts` reads `.git/HEAD` and caches the branch (or a short detached-HEAD hash); it resolves linked-worktree `.git` files (`gitdir:` pointers) as well as ordinary `.git` directories.
- **Session scan cache** — persisted cache format v2 stores enriched summaries (`lastModel`, `totalCost`, `totalTokens`, `labelCount`) and the incremental scan fold, alongside file stat identity, so restart hydration retains metadata and append-only changes can resume scanning.
- **Extension dialog cancellation** — Dialog requests have a server-side five-minute timeout and abort cancellation; `extension_ui_cancel` notifies clients whether a pending request ended by timeout or abort. Custom tool renderers retain per-call renderer state, broadcast `tool_renderer_update` HTML snapshots, and honor renderer invalidation.

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
- **`globalThis`** for shared state — bcrypt hash, JWT secret, and rate limit data are stored on `globalThis`; the resident map and selection remain in the server module
- **`boundMessagesForWire`** — Character-budgeted wire message bounding (per-block cap 80 KB, per-message cap 128 KB). `totalBudget` (512 KB) is a hard ceiling covering both message content and rendered extension aux fields; `MAX_WIRE_AUX_TOTAL_CHARS` (256 KB) is a sub-cap inside that total. These bounds prevent WS payload stalls on giant reasoning or file outputs. Derived extension HTML, parsed component trees, terminal lines, and session trees have independent node/character caps.
- **Valibot validation (`parseServerMessage`)** — Strict schema validation for incoming server-sent WebSocket payloads on the client to ensure type safety and early detection of payload mismatches.
