# Codebase map

Reference detail moved out of `AGENTS.md` on 2026-11-07 so the agent guide stays short. Moved verbatim (v0.26.0); update it when you change what it describes.

## Architecture and data flow (detail)

Bun server bridges pi SDK events to browser over WebSocket. Key flow: CLI → server.ts → Bun.serve() → SvelteKit (HTTP) + WebSocket → resident pi SDK sessions → events broadcast to all clients.

- Pi as near-pass-through — SDK events forwarded with a `sessionId` tag; `message_update` is stripped of its full partial message (only `assistantMessageEvent` + role forwarded) to avoid quadratic WS traffic on long reasoning turns
- Lazy SDK load (~136 MB) on first WS connect; lazy SvelteKit handler (~30 MB) on first HTTP
- Background `bindRpcHost` — extensions and tools are bound asynchronously on session initialization, broadcasting updated `tools_list` and `commands_list` without blocking early socket connection or session creation
- SDK built-in extensions (`codemode`, `tool-search`, `mcp`, `llama.cpp`) are loaded by `createSdkSession` via `resourceLoaderOptions.extensionFactories` (`getBuiltInExtensions()` in `src/lib/server/slash-command-catalog.ts`), matching the pi CLI. Nested `ctx.executeTool()` calls (`parentToolCallId`) render as children of their parent tool card, live and from history (`nestedCalls`).
- App extensions (`docs/app-extensions.md`, `examples/app-extensions/project-cockpit`) add installation-wide views and operations; the `pi-ui-app-extensions` Pi skill (`skills/pi-ui-app-extensions/`, symlinked into `~/.pi/agent/skills`) teaches agents to build them. No skill is bundled into Pi UI sessions.
- The server retains a resident `Map<sessionId, ManagedSession>` rather than a singleton session runtime. `selectedSessionId` is the server default and each socket has a `focusedSessionId`; switching changes selection without disposing the previous resident. Residency is capped by count (`PI_UI_MAX_RESIDENT_SESSIONS`, default 4) and estimated parsed-history bytes (`PI_UI_MAX_RESIDENT_HISTORY_MB`, default 48 MiB), with both limits env-overridable and bounded. Running sessions, sessions with an active tool or pending extension dialog, and sessions in `awaiting-input` are pinned, while least-recently-active (LRU) unpinned residents are evicted (project outliers are preferred to reduce extension-cache churn). Admission keeps one resident per `.jsonl` path because the SDK has no session-file locking. Residents own per-session services and all resident events are forwarded with their `sessionId`; a separate concurrent-run cap (`PI_UI_MAX_CONCURRENT_RUNS`, default 2) queues work beyond the limit. Non-resident sessions remain disk-backed catalog entries, with idle sidebar status until resident again.
- Optimistic new-chat stash — when creating a new session, previous messages are stashed and cleared immediately for instant UI feedback, restoring on watchdog timeout or error
- Extension UI requests block session until response (5 min timeout); terminal input flow bridges browser key events to headless extension TUI handlers with optimistic/awaited key classification
- CSRF disabled (`csrf.trustedOrigins: ['*']` in `vite.config.ts`) — Bun URL construction conflicts with SvelteKit's origin check; login server action has its own origin check
- Message editing via `edit_message` — rewinds session via `navigateTree()`, resends. See `pi-sdk-session-manipulation` skill
- Real-time context usage ring — `contextUsage` (tokens, contextWindow, percent) streamed in `connected`/`session_loaded`/SDK events and displayed in chat header ring indicator
- History payloads (`connected`/`session_loaded`/`older_messages`) are size-bounded: the last 100 messages (`MAX_INITIAL_MESSAGES`), with an 80 KB per-block cap and 128 KB per-message cap. Oversized tool-result output is elided above `MAX_WIRE_TOOL_OUTPUT_CHARS` (2,000 characters), retaining `outputElided`/`outputBytes` metadata and fetched on demand via `get_tool_output`. `totalBudget` (512 KB) is a hard ceiling covering both message content and rendered extension aux fields; `MAX_WIRE_AUX_TOTAL_CHARS` (256 KB) is a sub-cap inside that total in `src/lib/server/wire-messages.ts`. A failed `connected` send retries without history instead of closing the socket. The requester receives exactly one `session_loaded` per stamped request.
- Session lists never use SDK `SessionManager.list/listAll` (they load every file fully and build `allMessagesText` — OOM risk at multi-hundred-MB stores). Listing goes through two catalogs in `src/lib/server/`: `session-catalog.ts` (merged session list — `session-scan.ts` streams line-by-line with a per-file (mtime,size) cache persisted to `<agent dir>/pi-ui-session-scan.json` (also folds per-day/per-model usage buckets for `get_usage_summary`); restarts are stat-only, composed with a resident-session overlay so resident session files are never re-read after every message, watched via `session-watcher.ts` with trailing 500 ms debounce, a 5 s max coalescing window, and resident-path `isIgnored` exclusion) and `project-catalog.ts` (merged project list — persisted registry + resident session counts, debounced sync-write persistence). `switch_session` validates with targeted `hasFile` rather than a full `list()`; catalogs are warmed after `Bun.serve`; `projects_list` broadcasts are deduped. Both are singletons with a single `apply()` mutation chokepoint, a `list()` read, and `onChange()` change events
- Valibot runtime validation — incoming WebSocket server messages are parsed through `parseServerMessage` with loose schemas (`server-message-schema.ts`), separating valid custom/SDK events from malformed frames
- Markdown & LaTeX rendering — marked parser with LaTeX block/inline extensions (`@earendil-works/pi-tui/dist/latex.js`), wrapped by `memoizedRenderMarkdown` using an FNV-1a hash key with LRU cache bounds (300 entries / 4,000,000 characters)
- All pi-ui state files (scan cache, project registry, UI settings/`lastSession`, push/VAPID, webhook, JWT secret) live in the SDK agent dir via `piAgentDir()` (`src/lib/server/agent-dir.ts`), which honours `PI_CODING_AGENT_DIR` like `getAgentDir()` — test servers pointed at scratch dirs must never touch `~/.pi/agent`
- Tool renderers keep separate `call`/`result` `lastComponent` slots (TUI parity); `createSdkSession` logs per-phase timings and warns every 30 s naming a stalled phase (`src/lib/server/phase-timer.ts`)
- Cross-session usage (Settings → Usage, `usage-section.svelte`) and message-text search (sidebar, `session-content-search.svelte` → `search_sessions`, streamed by `src/lib/server/session-content-search.ts`); composer drafts persist per session in localStorage (`src/lib/draft-store.ts`)
- Logging via `src/lib/server/logger.ts` — sd-daemon `<N>` priority prefixes under systemd (`JOURNAL_STREAM` set), ISO timestamps otherwise; `uncaughtException`/`unhandledRejection` are logged and contained (process keeps serving)

> **Deep dive:** [`docs/architecture.md`](docs/architecture.md) — full data flow diagram, lifecycle, SDK integration, lazy loading patterns

## Key directories

| Path                                               | Purpose                                                                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/auth/`                                    | Password hashing (bcrypt/PBKDF2), JWT (crypto.subtle), IP rate limiter (`rate-limiter.ts`)                                                                                 |
| `src/lib/ws/`                                      | Shared WebSocket protocol types (`protocol.ts`), Valibot wire schemas (`server-message-schema.ts`)                                                                         |
| `src/lib/server/`                                  | Server-side helpers: session catalog, project catalog, wire bounding, watcher, extension tools/completions, webhooks, push                                                 |
| `src/lib/server/handlers/`                         | Focused WebSocket handler modules: filesystem, extension UI, project/system, session-tree navigation, and SDK settings                                                     |
| `src/lib/server/footer-data.ts`                    | Per-session SDK footer data provider (Git branch, extension statuses, provider count, change notification)                                                                 |
| `src/lib/server/tool-details.ts`                   | Allow-listed projection of built-in tool-result details for WebSocket history                                                                                              |
| `src/lib/server/slash-command-catalog.ts`          | SDK-sourced built-in slash catalog plus SDK changelog/bug-report module loading                                                                                            |
| `src/lib/server/provider-login-session.ts`         | Requester-scoped provider login lifecycle, prompt bridging, and cancellation                                                                                               |
| `src/lib/server/provider-login.ts`                 | Provider selection/auth-type resolution and SDK login-flow helper                                                                                                          |
| `src/lib/server/handlers/tree-handlers.ts`         | Validated SDK tree navigation and entry-label helpers                                                                                                                      |
| `src/lib/server/handlers/sdk-settings-handlers.ts` | Allow-listed SDK settings read/write handler                                                                                                                               |
| `src/lib/state/`                                   | Runes-based shared stores: `projects-state.svelte.ts`, `extension-ui-state.svelte.ts`                                                                                      |
| `src/lib/components/chat/`                         | Chat components: `message-list.svelte`, `chat-header.svelte`, `status-banners.svelte` (reconnection/read-only alerts, context meter)                                       |
| `skills/pi-ui-app-extensions/`                     | Pi skill for building app extensions (views, operations, manifest); symlinked into `~/.pi/agent/skills`; hand-written against `docs/app-extensions.md`                     |
| `src/lib/components/panels/`                       | Panel components: `right-panel.svelte`, `settings-panel.svelte` (theme, notifications, UI options), lazy panel wrappers                                                    |
| `src/lib/components/dialogs/`                      | Dialogs: `confirm-dialog.svelte`, `fork-dialog.svelte`, `provider-login-dialog.svelte`, `session-tree-modal.svelte`, `extension-overlays.svelte`, `toast-container.svelte` |
| `src/lib/components/projects/`                     | Project management: `projects-sidebar.svelte` (including `gitBranch`), `project-picker.svelte`, `directory-picker.svelte`                                                  |
| `src/lib/components/`                              | Svelte 5 components: chat, panels, projects, dialogs, `file-viewer-modal.svelte`, `diff-viewer.svelte`, `sidebar-panel.svelte`                                             |
| `src/lib/components/ui/`                           | shadcn-style primitives (button, dialog, select, switch, tabs, card, tooltip, scroll-area, separator, bottom-sheet)                                                        |
| `src/routes/(app)/`                                | Main SPA (chat UI) — `ssr=false, prerender=false`                                                                                                                          |
| `src/routes/(auth)/`                               | Login page (auth group separates routing from hooks guard)                                                                                                                 |
| `bin/`                                             | CLI entry point (`pifrontier.ts`) and shell shim                                                                                                                           |
| `scripts/`                                         | Dev orchestrator (`dev.ts` — parallel Vite + WS server), `maybe-build.ts` freshness check guard                                                                            |
| `e2e/`                                             | Playwright E2E tests: mock WS specs, live agent specs, `global-setup.ts` scratch dirs, fake LLM server stub                                                                |
| `static/`                                          | PWA assets: icons, manifest.webmanifest                                                                                                                                    |

## Important files

| File                                                      | Role                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `server.ts`                                               | Main Bun server (~6570 lines) — WS routing, resident session map, SDK bridge, extension UI, updates                 |
| `src/routes/(app)/+page.svelte`                           | Main chat UI (~8650 lines) — WS connect, message stream, STT, settings, tool/panel rendering                        |
| `src/hooks.server.ts`                                     | SvelteKit auth guard — JWT validation, redirect to `/login`                                                         |
| `src/routes/(auth)/login/+page.server.ts`                 | Login action — CSRF, rate limit, verify password, set JWT cookie                                                    |
| `src/lib/auth/password.ts`                                | Password hashing, JWT create/verify, cookie helpers                                                                 |
| `src/lib/auth/rate-limiter.ts`                            | IP-based login rate limiter                                                                                         |
| `src/lib/server/provider-login-session.ts`                | Requester-scoped SDK provider login prompts, events, and cancellation                                               |
| `src/lib/server/provider-login.ts`                        | SDK provider login resolution and invocation                                                                        |
| `src/lib/components/projects/project-row.svelte`          | Project row rendering, including the optional `gitBranch` metadata                                                  |
| `src/lib/components/dialogs/provider-login-dialog.svelte` | Interactive SDK provider login prompts and status                                                                   |
| `src/lib/ws/server-message-schema.ts`                     | Valibot runtime validation schemas (`parseServerMessage`) for inbound WS messages                                   |
| `src/lib/state/projects-state.svelte.ts`                  | Runes-based projects/sessions state singleton                                                                       |
| `src/lib/state/extension-ui-state.svelte.ts`              | Extension modals, widgets, status texts, and action responses state singleton                                       |
| `src/lib/client-messages.ts`                              | UIMessage type, SDK→UI conversion, tool formatting                                                                  |
| `src/lib/server/wire-messages.ts`                         | Payload budget bounding (`boundMessagesForWire`)                                                                    |
| `src/lib/server/extension-tools.ts`                       | Tool activation and extension tool discovery helpers                                                                |
| `src/lib/server/extension-completions.ts`                 | Slash command argument completions resolver for extensions                                                          |
| `src/lib/server/ws-helpers.ts`                            | Shared helpers (serializeModel, serializeSession, semver, GitHub URL, etc.)                                         |
| `src/lib/server/footer-data.ts`                           | Session-owned data provider for SDK extension footers                                                               |
| `src/lib/server/tool-details.ts`                          | Built-in tool-details projection and output sanitation                                                              |
| `src/lib/server/handlers/tree-handlers.ts`                | Session tree navigation and label updates                                                                           |
| `src/lib/server/handlers/sdk-settings-handlers.ts`        | SDK settings allow-list and typed public setter operations                                                          |
| `src/lib/server/slash-command-catalog.ts`                 | SDK built-in slash catalog and changelog/bug-report loaders                                                         |
| `src/lib/components/projects/project-row.svelte`          | Project row rendering, including the optional `gitBranch` metadata                                                  |
| `src/lib/components/dialogs/provider-login-dialog.svelte` | Interactive SDK provider login prompts and status                                                                   |
| `src/lib/components/chat/chat-header.svelte`              | Header bar with model selector, session title, context ring, and panel toggles                                      |
| `src/lib/components/chat/status-banners.svelte`           | Top banner alerts (disconnected, read-only mode, server notifications)                                              |
| `src/lib/components/panels/right-panel.svelte`            | Sidebar tabbed panel for models, tools, skills, prompts, extensions, stats                                          |
| `src/lib/components/panels/settings-panel.svelte`         | User settings dialog for appearance, themes, notifications, and dev options                                         |
| `src/lib/components/dialogs/extension-overlays.svelte`    | Modal dialogs and overlay renderer for extension interactions                                                       |
| `src/lib/markdown.ts`                                     | Configured marked + hljs + LaTeX renderer + FNV-1a LRU memoization                                                  |
| `src/lib/tui-stubs.ts`                                    | Server-side pi-tui stub bridge, component tree parser, markdown transformer runner                                  |
| `src/lib/server/app-extensions/`                          | Server runtime for app extensions: manifest validation, package loading, operation registry, scope-checked handlers |
| `src/lib/diff-parser.ts`                                  | Unified diff parser                                                                                                 |
| `e2e/fixtures.ts`                                         | Playwright custom fixtures — `mockWs`, `login`                                                                      |
| `e2e/global-setup.ts`                                     | E2E test suite scratch directory initialization and fake LLM config                                                 |
| `e2e/mocks/payloads.ts`                                   | Mock WS message factory functions                                                                                   |
| `scripts/dev.ts`                                          | Dev orchestrator (parallel Vite + WS server)                                                                        |
| `scripts/maybe-build.ts`                                  | Incremental build cache freshness check                                                                             |
| `benchmark.ts`                                            | Playwright-based WS latency benchmark                                                                               |
| `static/manifest.webmanifest`                             | PWA manifest                                                                                                        |
| `.env.example`                                            | Required env vars documented                                                                                        |

## Utility modules

- **`client-messages.ts`** — `UIMessage` type conversion pipeline: `agentMsgToUI()` maps SDK messages → flat `UIMessage[]`; `rawMessagesToUI()` single-pass batch converter; `formatToolInput()` extracts per-tool one-line summaries; `reconnectDelay()` exponential backoff 1s→30s with jitter; `outputElided`/`outputBytes`/`outputLoading` track lazy tool-result output
- **`session-view-cache.ts`** — Bounded LRU of three per-session client views (messages, streams, tools, expansion, draft, context, queues); clones views while stripping base64 image data and attachments from inactive-session state
- **`thinking-levels.ts`** — `THINKING_LEVEL_CANONICAL` ordering for SDK-provided levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); supported levels and current level come from the server/SDK
- **`attachments.ts`** — File attachment handling: `prepareImage()` (in-browser downscale ≤1600px, base64 encoding ≤3 MB), `fileToText()`, accepted text extensions
- **`terminal-key-encoder.ts`** — Encodes browser key events into terminal byte sequences
- **`notification-prefs.ts`** — Client-side notification preferences (`loadNotificationPrefs`, `saveNotificationPrefs`, VAPID key conversion `urlBase64ToUint8Array`)
- **`extension-modals.ts`** — Helpers for inspecting and partitioning custom extension component trees (`parsedComponentHasAction`, `customModalNeedsTextInput`, `extensionOptionParts`)
- **`server-message-schema.ts`** — Valibot schemas (`parseServerMessage`) validating all inbound server WebSocket frames into typed envelopes
- **`server/wire-messages.ts`** — `boundMessagesForWire()` enforcing the 80 KB per-block cap, 128 KB per-message cap, a hard 512 KB `totalBudget` covering both message content and rendered extension aux fields, and elision of oversized tool output above `MAX_WIRE_TOOL_OUTPUT_CHARS`; `MAX_WIRE_AUX_TOTAL_CHARS` (256 KB) is a sub-cap inside the total
- **`server/session-watcher.ts`** — `startSessionWatch()` filesystem watcher with trailing 500 ms debounce, a 5 s max coalescing window, and optional live-path `isIgnored` exclusion
- **`server/ui-settings.ts`** — Server-side UI settings persistence, including the durable `lastSession` pointer
- **`server/extension-tools.ts`** & **`extension-completions.ts`** — Extension tool discovery, dynamic tool enablement (`activateNewExtensionTools`), and slash command argument auto-completions
- **`server/footer-data.ts`** — Session-owned SDK extension-footer data (Git branch, extension status map, provider count, branch-change notifications)
- **`server/tool-details.ts`** — Allow-lists built-in tool detail fields for safe wire projection
- **`server/handlers/tree-handlers.ts`** — Validates session-tree navigation targets and writes entry labels
- **`server/handlers/sdk-settings-handlers.ts`** — SDK settings read projection and allow-listed writes through public setters
- **`server/slash-command-catalog.ts`** — SDK built-in slash catalog, changelog, and bug-report module loaders
- **`server/provider-login-session.ts`** — Requester-scoped provider login lifecycle, prompt bridge, and cancellation
- **`server/provider-login.ts`** — Selects provider/auth method and invokes the SDK login flow
- **`markdown.ts`** — `marked` configured with HTML stripping, hljs language registration, file links, LaTeX block/inline extensions (`@earendil-works/pi-tui/dist/latex.js`), an escaped `<pre><code>` fallback for large source-dump-shaped bodies, and `memoizedRenderMarkdown()` (FNV-1a 300/4M LRU cache)
- **`tui-stubs.ts`** — `StubTui` and `HeadlessTerminal` running pi-tui extension factories server-side; `parseComponentTree()` parses interactive components; `applyMarkdownTransformersToMessages()` and `customEntriesForWire()` translate custom entries and markdown transforms for web rendering
- **`diff-parser.ts`** — `parseDiff()` → `DiffFile[]` with hunks, line numbers, add/delete/context lines
- **`utils.ts`** — `cn()` (clsx+twMerge), `formatRelativeDate()`, Svelte 5 `WithElementRef`/`WithoutChildren` type helpers

## WebSocket protocol summary (`protocol.ts`)

- **ConnectedMessage**: server→client session snapshot; includes SDK-supported thinking levels/scoped models, SDK built-in commands, visible queue/deferred state, provider/model metadata, and extension UI snapshot
- **ServerMessage** includes `tool_output` with projected `toolDetails`; custom events include `footer_data`, `tree_navigated`, `extension_ui_cancel`, and `tool_renderer_update`
- Model & provider: `set_model`, `set_thinking_level`, `cycle_model`, `cycle_thinking_level`, `set_scoped_models`, `provider_login` (non-blocking), `provider_login_response`, `provider_login_cancel`
- Tree navigation: `get_session_tree`, `navigate_tree`, `set_entry_label`; compact accepts optional `customInstructions`
- SDK settings/import: `get_sdk_settings`, `set_sdk_setting`, `import_session`
- Projects: `get_projects`, `get_all_sessions`, `pin_project`, `rename_project`, `delete_project`
- Usage & search: `get_usage_summary` → `usage_summary`, `search_sessions` → `session_search_results`
- Extensions & tools: `get_tools`, `set_active_tools`, `extension_ui_response`, `extension_terminal_input`
- Filesystem & completions: `read_file`, `write_file`, `dir_complete`, `file_complete`, `get_command_completions`
- Session recovery: `get_tool_output`, `resync_session`

> **Deep dive:** [`docs/websocket-protocol.md`](docs/websocket-protocol.md) — full message type reference, edit flow, extension UI flow

## Runtime and tooling (detail)

- **Runtime**: Bun ≥1.0.0 (Node.js NOT supported)
- **Package manager**: Bun (bun install, bun run, bun add)
- **Module system**: ESM only (`"type": "module"`)
- **Adapter**: vendored `svelte-adapter-bun` at `adapters/svelte-adapter-bun` (NOT `@sveltejs/adapter-node` — incompatible with WS). Vendored because upstream peers on kit ^2 and is unmaintained. It uses the SvelteKit 3 builder configuration (`config.paths?.base`, `config.appDir`) and `generateServerInstance`; the handler treats the server's websocket hook as optional because Kit 3 no longer exposes one. Keep the `vite` `overrides` entry in package.json — vitest bundles its own nested Vite otherwise, and kit 3's `isRunnableDevEnvironment` instanceof check fails across instances.
- **PWA**: Custom minimal service worker (`src/service-worker/index.ts` + `src/service-worker/tsconfig.json`, excluded from the root tsconfig) — no Workbox, no chat-data caching
  - Install: precaches immutable build chunks + static files (versioned cache `pi-ui-shell-<version>` using `$app/env` version), `self.skipWaiting()`
  - Activate: drops old-version caches, `clients.claim()`
  - Fetch: cache-first for **precached assets only** — navigations, `/ws`, and dynamic requests bypass the SW (auth redirects never staled)
  - Notifications: listens for `show_notification` messages from client pages
  - Registration: conditional (browser only, production only) via `register-service-worker.ts`
- **Cold-start resume**: `src/lib/session-snapshot.ts` persists a text-only tail (≤50 msgs, ≤200 KB) of the conversation to localStorage (saved on `agent_end`/`connected`/`session_loaded` + page-hidden); `+page.svelte` hydrates it on boot before the WS connects, so a discarded PWA repaints instantly instead of showing the connecting splash. Live `connected`/`session_loaded` state replaces it wholesale.
- **Auth library**: `crypto.subtle` (no `jose`, no external JWT library)
- **Dependencies & DevDeps**:
  - `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` & `@earendil-works/pi-ai` (1.5.0) — pi SDK, ESM-only
  - `svelte` (^5.57.3), `@sveltejs/kit` (^3.1.1)
  - `typescript` stays on `~6.0.3`: `typescript-eslint` (<6.1) and `svelte-check` (^6) don't support TS 7 yet; `@typescript/native` provides TS 7
  - `@lucide/svelte` (^1.69.0) — UI icons
  - `valibot` (^1.5.0) — schema validation
- **Key env vars**: `PI_PASSWORD` (required), `PORT` (default 3000), `PI_CWD` (optional working dir)

## Testing (detail)

Three layers: **Unit** (Vitest, jsdom — 66 test files, 864 tests; needs Node >= 22.19 on PATH, see `.nvmrc` — `scripts/require-node.ts` fails fast otherwise), **E2E** (Playwright with mock WebSocket + Live SDK suite), **CI** (GitHub Actions). The Bun-native auth suite still has one pre-existing failure: `password.test.ts` uses `vi.resetModules()`, which Bun's runner does not implement; it passes under Vitest.

```bash
bun run test:unit         # vitest run (jsdom — 66 test files, 864 tests; Node >= 22.19)
bun run test:e2e          # playwright test (chains mock suite + live agent suite)
bun run test:e2e:fast     # playwright test --project=chromium (mock suite only)
bun run test:e2e:live     # playwright test -c playwright.live.config.ts (live suite only)
bun run test:ci           # check + check:sw + check:server + lint + test:unit + test:e2e
```

**Key patterns:**

- **Unit tests**: pure functions and state classes, tested with Vitest & jsdom. Real filesystem in isolated temp dirs for catalog/persistence tests.
- **Mock E2E suite**: `playwright.config.ts` runs mock-WS specs with file-level parallelism (`workers: 4` locally, `workers: 2` in CI). All tests mock WS via `page.routeWebSocket` using custom `mockWs` + `login` fixtures.
- **Live E2E suite**: `playwright.live.config.ts` runs live agent/widget specs serialized (`workers: 1`) against a real Bun server + fake LLM server stub (`e2e/fake-llm.ts`).
- **Global setup**: `e2e/global-setup.ts` initializes clean `/tmp/pi-ui-e2e-agent` and `/tmp/pi-ui-e2e-workspace` scratch directories before runs to prevent dirty state carryover.
- `auth.spec.ts` uses `getByText('password', { exact: true })` — `text=password` matches 2 elements
- Tests must not duplicate login in bodies when `beforeEach` already handles it via fixture

> **Deep dive:** [`docs/testing.md`](docs/testing.md) — full test file inventory, mock patterns, CI pipeline, common fixes
