# Repository Guidelines

## Project Overview

pi-ui (v0.17.1, `@thed24/pi-ui`) is a **self-hosted PWA frontend for the `pi` coding agent** — analogous to how OpenChamber fronts OpenCode. It runs as a standalone Bun server that bridges `pi` SDK events to a browser over a single WebSocket. Designed for low-memory environments (Raspberry Pi).

Key constraints: ESM-only, Bun ≥1.0.0, no TTS, no Workbox, no node-pty.

---

## Architecture & Data Flow

Bun server bridges pi SDK events to browser over WebSocket. Key flow: CLI → server.ts → Bun.serve() → SvelteKit (HTTP) + WebSocket → resident pi SDK sessions → events broadcast to all clients.

- Pi as near-pass-through — SDK events forwarded with a `sessionId` tag; `message_update` is stripped of its full partial message (only `assistantMessageEvent` + role forwarded) to avoid quadratic WS traffic on long reasoning turns
- Lazy SDK load (~136 MB) on first WS connect; lazy SvelteKit handler (~30 MB) on first HTTP
- Background `bindRpcHost` — extensions and tools are bound asynchronously on session initialization, broadcasting updated `tools_list` and `commands_list` without blocking early socket connection or session creation
- The server retains a resident `Map<sessionId, ManagedSession>` rather than a singleton session runtime. `selectedSessionId` is the server default and each socket has a `focusedSessionId`; switching changes selection without disposing the previous resident. Residency is capped by count (`PI_UI_MAX_RESIDENT_SESSIONS`, default 4) and estimated parsed-history bytes (`PI_UI_MAX_RESIDENT_HISTORY_MB`, default 48 MiB), with both limits env-overridable and bounded. Running sessions, sessions with an active tool or pending extension dialog, and sessions in `awaiting-input` are pinned, while least-recently-active (LRU) unpinned residents are evicted (project outliers are preferred to reduce extension-cache churn). Admission keeps one resident per `.jsonl` path because the SDK has no session-file locking. Residents own per-session services and all resident events are forwarded with their `sessionId`; a separate concurrent-run cap (`PI_UI_MAX_CONCURRENT_RUNS`, default 2) queues work beyond the limit. Non-resident sessions remain disk-backed catalog entries, with idle sidebar status until resident again.
- Optimistic new-chat stash — when creating a new session, previous messages are stashed and cleared immediately for instant UI feedback, restoring on watchdog timeout or error
- Extension UI requests block session until response (5 min timeout); terminal input flow bridges browser key events to headless extension TUI handlers with optimistic/awaited key classification
- CSRF disabled (`csrf.trustedOrigins: ['*']` in `vite.config.ts`) — Bun URL construction conflicts with SvelteKit's origin check; login server action has its own origin check
- Message editing via `edit_message` — rewinds session via `navigateTree()`, resends. See `pi-sdk-session-manipulation` skill
- Real-time context usage ring — `contextUsage` (tokens, contextWindow, percent) streamed in `connected`/`session_loaded`/SDK events and displayed in chat header ring indicator
- History payloads (`connected`/`session_loaded`/`older_messages`) are size-bounded: the last 100 messages (`MAX_INITIAL_MESSAGES`), with an 80 KB per-block cap and 128 KB per-message cap. Oversized tool-result output is elided above `MAX_WIRE_TOOL_OUTPUT_CHARS` (2,000 characters), retaining `outputElided`/`outputBytes` metadata and fetched on demand via `get_tool_output`. `totalBudget` (512 KB) is a hard ceiling covering both message content and rendered extension aux fields; `MAX_WIRE_AUX_TOTAL_CHARS` (256 KB) is a sub-cap inside that total in `src/lib/server/wire-messages.ts`. A failed `connected` send retries without history instead of closing the socket. The requester receives exactly one `session_loaded` per stamped request.
- Session lists never use SDK `SessionManager.list/listAll` (they load every file fully and build `allMessagesText` — OOM risk at multi-hundred-MB stores). Listing goes through two catalogs in `src/lib/server/`: `session-catalog.ts` (merged session list — `session-scan.ts` streams line-by-line with a per-file (mtime,size) cache persisted to `~/.pi/agent/pi-ui-session-scan.json`; restarts are stat-only, composed with a resident-session overlay so resident session files are never re-read after every message, watched via `session-watcher.ts` with trailing 500 ms debounce, a 5 s max coalescing window, and resident-path `isIgnored` exclusion) and `project-catalog.ts` (merged project list — persisted registry + resident session counts, debounced sync-write persistence). `switch_session` validates with targeted `hasFile` rather than a full `list()`; catalogs are warmed after `Bun.serve`; `projects_list` broadcasts are deduped. Both are singletons with a single `apply()` mutation chokepoint, a `list()` read, and `onChange()` change events
- Valibot runtime validation — incoming WebSocket server messages are parsed through `parseServerMessage` with loose schemas (`server-message-schema.ts`), separating valid custom/SDK events from malformed frames
- Markdown & LaTeX rendering — marked parser with LaTeX block/inline extensions (`@earendil-works/pi-tui/dist/latex.js`), wrapped by `memoizedRenderMarkdown` using an FNV-1a hash key with LRU cache bounds (300 entries / 4,000,000 characters)
- Logging via `src/lib/server/logger.ts` — sd-daemon `<N>` priority prefixes under systemd (`JOURNAL_STREAM` set), ISO timestamps otherwise; `uncaughtException`/`unhandledRejection` are logged and contained (process keeps serving)

> **Deep dive:** [`docs/architecture.md`](docs/architecture.md) — full data flow diagram, lifecycle, SDK integration, lazy loading patterns

---

## Key Directories

| Path                           | Purpose                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/auth/`                | Password hashing (bcrypt/PBKDF2), JWT (crypto.subtle), IP rate limiter (`rate-limiter.ts`)                                                 |
| `src/lib/ws/`                  | Shared WebSocket protocol types (`protocol.ts`), Valibot wire schemas (`server-message-schema.ts`)                                         |
| `src/lib/server/`              | Server-side helpers: session catalog, project catalog, wire bounding, watcher, extension tools/completions, webhooks, push                 |
| `src/lib/state/`               | Runes-based shared stores: `projects-state.svelte.ts`, `extension-ui-state.svelte.ts`                                                      |
| `src/lib/components/chat/`     | Chat components: `message-list.svelte`, `chat-header.svelte`, `status-banners.svelte` (reconnection/read-only alerts, context meter)       |
| `src/lib/components/panels/`   | Panel components: `right-panel.svelte`, `settings-panel.svelte` (theme, notifications, UI options), lazy panel wrappers                    |
| `src/lib/components/dialogs/`  | Dialogs: `confirm-dialog.svelte`, `fork-dialog.svelte`, `session-tree-modal.svelte`, `extension-overlays.svelte`, `toast-container.svelte` |
| `src/lib/components/projects/` | Project management: `projects-sidebar.svelte`, `project-picker.svelte`, `directory-picker.svelte`                                          |
| `src/lib/components/`          | Svelte 5 components: chat, panels, projects, dialogs, `file-viewer-modal.svelte`, `diff-viewer.svelte`, `sidebar-panel.svelte`             |
| `src/lib/components/ui/`       | shadcn-style primitives (button, dialog, select, switch, tabs, card, tooltip, scroll-area, separator, bottom-sheet)                        |
| `src/routes/(app)/`            | Main SPA (chat UI) — `ssr=false, prerender=false`                                                                                          |
| `src/routes/(auth)/`           | Login page (auth group separates routing from hooks guard)                                                                                 |
| `bin/`                         | CLI entry point (`pifrontier.ts`) and shell shim                                                                                           |
| `scripts/`                     | Dev orchestrator (`dev.ts` — parallel Vite + WS server), `maybe-build.ts` freshness check guard                                            |
| `e2e/`                         | Playwright E2E tests: mock WS specs, live agent specs, `global-setup.ts` scratch dirs, fake LLM server stub                                |
| `static/`                      | PWA assets: icons, manifest.webmanifest                                                                                                    |

---

## Development Commands

```bash
# Install
bun install

# Dev modes (3 variants)
bun run dev               # Vite dev server only (port 5173) — no WS, UI iteration only
bun run dev:ws            # Standalone WS server (port 5174) for WS testing
bun run dev:full          # Both Vite (5173) + WS server (5174) in parallel via scripts/dev.ts

# Build
bun run build             # SvelteKit frontend (adapter: svelte-adapter-bun)
bun run build:server      # Bundles server.ts → server.bundle.js (~165 KB, minified)

# Production
PI_PASSWORD=secret bun run start          # CLI entry (prefers server.bundle.js)
PI_PASSWORD=secret PORT=3000 bun run start

# Quality
bun run check             # svelte-kit sync + svelte-check (JS compiler — tsgo can't type #lib/*.svelte subpath imports)
bun run check:sw          # tsc --noEmit on the service-worker project (src/service-worker/tsconfig.json)
bun run check:server      # tsc --noEmit on server.ts + bin/
bun run lint              # eslint (flat config)
bun run format            # prettier --write .

# Tests
bun test src/lib/auth     # Bun-native test runner for auth/rate-limiter (timeout 15s)
bun run test:unit         # vitest run (jsdom — 34 test files, 451 tests)
bun run test:unit:watch   # vitest (watch mode)
bun run test:coverage     # vitest run --coverage (v8 provider)
bun run test:e2e          # playwright test (chains mock E2E suite + live agent suite)
bun run test:e2e:fast     # playwright test --project=chromium (mock suite only, fast iteration)
bun run test:e2e:live     # playwright test -c playwright.live.config.ts (live agent suite only, workers: 1)
bun run test:e2e:debug    # playwright test --debug

# CI
bun run test:ci           # check + check:sw + check:server + lint + test:unit + test:e2e
```

> **Note on builds & test setup:**
>
> - `scripts/maybe-build.ts` checks input vs output timestamps on `build/` before launching test servers to avoid unnecessary frontend rebuilds.
> - `e2e/global-setup.ts` wipes and creates isolated `/tmp/pi-ui-e2e-agent` and `/tmp/pi-ui-e2e-workspace` directories before Playwright runs, configuring `models.json` against the local fake LLM stub (`e2e/fake-llm.ts`).

---

## Code Conventions & Common Patterns

### TypeScript & ESM

- **ESM only** — `"type": "module"` in package.json; use `.ts` extensions in imports
- **Strict mode** — `tsconfig.json` has `strict: true`, `moduleResolution: "bundler"`
- **`types: ["bun"]`** — Bun globals available without imports
- **`tsconfig.server.json`** extends the base config with `allowImportingTsExtensions`, `noEmit`; includes `server.ts` and `bin/`
- **Architecture boundaries (`eslint-plugin-boundaries`)** — ESLint config enforces strict architectural layer boundaries across elements (`protocol`, `state`, `components`, `server`, `auth`, `app`, `service-worker`). Client stores and components cannot import server modules; stores cannot import UI components; server stays self-contained behind shared protocol.

### Svelte 5 (Runes) & State

- **`$state()` / `$derived()` / `$effect()`** — never Svelte 4 `let x = ...` or `$:` reactive declarations
- **Callback props, not events** — components use `$props()` destructuring with callback functions; never `createEventDispatcher` or `on:click`
- **`$bindable()`** for two-way-bound parent state
- **`{#snippet children()}…{/snippet}`** instead of slots
- Client state is intentionally limited to the `ProjectsState` singleton (projects/sessions catalog and session-operation lifecycle) and the `ExtensionUiState` singleton. The main chat container owns live message and transport state directly rather than through a store.
- **`SvelteSet` / `SvelteMap`** for reactive collections in runes state classes
- **Valibot validation** — `v.looseObject({...})` schemas in `src/lib/ws/server-message-schema.ts` for safe schema validation allowing unknown forward-compatible fields

### Component Patterns

- **shadcn-style UI primitives**: each component is a subdirectory with compound sub-components + `index.ts` that re-exports with both singular (`Root`) and prefixed names (`Button`, `DialogContent`)
- **bits-ui wrapping**: Dialog, Select, Tabs, Tooltip, ScrollArea, Switch, Separator wrap `bits-ui` primitives
- **`tailwind-variants`** (`tv()`): used for variant/size class generation (e.g., `buttonVariants`)
- **`cn()` from `#lib/utils.js`**: Tailwind class merging via clsx + twMerge
- **Data attributes** like `data-slot="button"`, `data-size="sm"` drive internal styling
- **No component unit tests** — UI is tested exclusively via Playwright E2E

### Auth Patterns

- **Password hashing**: `Bun.password.hash()` with bcrypt cost 10 (production); PBKDF2 600k iterations (Vite dev fallback)
- **JWT via native crypto.subtle** — no `jose` or external library. HMAC-SHA256 signing, 30-day expiry, in-memory JTI revocation. Signing key persisted to `~/.pi/agent/pi-ui-jwt-secret` (0600) on first boot so sessions survive server restarts; `PI_UI_JWT_SECRET` (≥32 chars) overrides the file for multi-process deployments (dev:full)
- **Cookie**: `pi-session`, httpOnly, sameSite:strict, secure when behind proxy
- **Rate limiter**: IP-based in-memory Map on `globalThis.__piRateLimit`; 5 fails/5min → 15min block
- **`hooks.server.ts`**: SvelteKit `Handle` — exact matches `/login` bypass auth, all other paths validate JWT

### Server Patterns

- **`switch(msg.type)` routing**: server.ts dispatches ~76 ClientMessage types in one large switch. Notable handlers: `prompt` (send to SDK), `edit_message` (rewind + resend via `navigateTree`), `fork_session` (branch session at entry)
- **Lazy imports**: SDK and SvelteKit handler both lazy-imported on first use
- **`globalThis` for state**: bcrypt hash, JWT secret, and rate limit data are stored on `globalThis`; resident sessions and selection are maintained in the server module
- **Bun pub/sub**: `server.publish('pi', payload)` sends to all WS clients
- **JSON-file persistence**: `project-registry.ts` uses atomic write (`tmp + rename`) to `~/.pi/agent/pi-ui-projects.json`
- **isInsideWorkspace(path)**: resolves symlinks, checks separator-suffixed root prefix. Path traversal guard on `read_file`/`write_file`
- **Null-byte rejection** in `read_file`/`write_file`

### Utility Modules

- **`client-messages.ts`** — `UIMessage` type conversion pipeline: `agentMsgToUI()` maps SDK messages → flat `UIMessage[]`; `rawMessagesToUI()` single-pass batch converter; `formatToolInput()` extracts per-tool one-line summaries; `reconnectDelay()` exponential backoff 1s→30s with jitter; `outputElided`/`outputBytes`/`outputLoading` track lazy tool-result output
- **`session-view-cache.ts`** — Bounded LRU of three per-session client views (messages, streams, tools, expansion, draft, context, queues); clones views while stripping base64 image data and attachments from inactive-session state
- **`thinking-levels.ts`** — `THINKING_LEVEL_CANONICAL` ('off', 'minimal', 'low', 'medium', 'high', 'max'), `getSupportedThinkingLevels()`, and `clampThinkingLevelForModel()`
- **`attachments.ts`** — File attachment handling: `prepareImage()` (in-browser downscale ≤1600px, base64 encoding ≤3 MB), `fileToText()`, accepted text extensions
- **`terminal-key-encoder.ts`** — Encodes browser key events into terminal byte sequences
- **`notification-prefs.ts`** — Client-side notification preferences (`loadNotificationPrefs`, `saveNotificationPrefs`, VAPID key conversion `urlBase64ToUint8Array`)
- **`extension-modals.ts`** — Helpers for inspecting and partitioning custom extension component trees (`parsedComponentHasAction`, `customModalNeedsTextInput`, `extensionOptionParts`)
- **`server-message-schema.ts`** — Valibot schemas (`parseServerMessage`) validating all inbound server WebSocket frames into typed envelopes
- **`server/wire-messages.ts`** — `boundMessagesForWire()` enforcing the 80 KB per-block cap, 128 KB per-message cap, a hard 512 KB `totalBudget` covering both message content and rendered extension aux fields, and elision of oversized tool output above `MAX_WIRE_TOOL_OUTPUT_CHARS`; `MAX_WIRE_AUX_TOTAL_CHARS` (256 KB) is a sub-cap inside the total
- **`server/session-watcher.ts`** — `startSessionWatch()` filesystem watcher with trailing 500 ms debounce, a 5 s max coalescing window, and optional live-path `isIgnored` exclusion
- **`server/ui-settings.ts`** — Server-side UI settings persistence, including the durable `lastSession` pointer
- **`server/extension-tools.ts`** & **`extension-completions.ts`** — Extension tool discovery, dynamic tool enablement (`activateNewExtensionTools`), and slash command argument auto-completions
- **`markdown.ts`** — `marked` configured with HTML stripping, hljs language registration, file links, LaTeX block/inline extensions (`@earendil-works/pi-tui/dist/latex.js`), an escaped `<pre><code>` fallback for large source-dump-shaped bodies, and `memoizedRenderMarkdown()` (FNV-1a 300/4M LRU cache)
- **`tui-stubs.ts`** — `StubTui` and `HeadlessTerminal` running pi-tui extension factories server-side; `parseComponentTree()` parses interactive components; `applyMarkdownTransformersToMessages()` and `customEntriesForWire()` translate custom entries and markdown transforms for web rendering
- **`diff-parser.ts`** — `parseDiff()` → `DiffFile[]` with hunks, line numbers, add/delete/context lines
- **`utils.ts`** — `cn()` (clsx+twMerge), `formatRelativeDate()`, Svelte 5 `WithElementRef`/`WithoutChildren` type helpers

### WebSocket Protocol (`protocol.ts`)

- **ConnectedMessage**: sent server→client on WS open (session state, models, thinkingLevel, contextUsage, tools, activeToolNames, truncated messages)
- **ServerMessage** includes `tool_output` for requester-only lazy tool-result responses
- **ClientMessage**: union of ~76 tagged types; messages targeting an existing session accept optional `sessionId` (path-based `switch_session`, `rename_session`, and `delete_session` remain path-targeted) and resolve explicit target → socket `focusedSessionId` → server `selectedSessionId`
- - Session lifecycle: `new_session`, `switch_session`, `fork_session`, `rename_session`, `delete_session`
- - Session focus: `session_focus` updates the socket's visible session and unread semantics
- - Messaging: `prompt`, `edit_message`, `steer`, `follow_up`, `abort`
- - Model & settings: `set_model`, `set_thinking_level`, `set_settings`
- - Projects: `get_projects`, `get_all_sessions`, `pin_project`, `rename_project`, `delete_project` (removes project dir & all sessions)
- - Extensions & tools: `get_tools`, `set_active_tools`, `extension_ui_response`, `extension_terminal_input` (interactive terminal input loop)
- - Filesystem & completions: `read_file`, `write_file`, `dir_complete`, `file_complete`, `get_command_completions`
- - Session recovery: `get_tool_output`, `resync_session`

> **Deep dive:** [`docs/websocket-protocol.md`](docs/websocket-protocol.md) — full message type reference, edit flow, extension UI flow

### Styling

- **Tailwind v4** + daisyUI — custom "pi" theme (OKLCH violet-obsidian), shadcn variable bridge
- **Typography**: `font-mono` root, `.prose` overrides to `font-sans` for assistant markdown
- **Animation**: 150ms micro-interactions, 250ms layout transitions. Reduced motion respected globally.
- **Formatting**: Prettier (2-space, single quotes, printWidth 100)

> **Deep dive:** [`docs/styling.md`](docs/styling.md) — theme tokens, CSS classes, visual effects, accessibility

---

## Important Files

| File                                                   | Role                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `server.ts`                                            | Main Bun server (~6570 lines) — WS routing, resident session map, SDK bridge, extension UI, updates |
| `src/routes/(app)/+page.svelte`                        | Main chat UI (~8650 lines) — WS connect, message stream, STT, settings, tool/panel rendering        |
| `src/hooks.server.ts`                                  | SvelteKit auth guard — JWT validation, redirect to `/login`                                         |
| `src/routes/(auth)/login/+page.server.ts`              | Login action — CSRF, rate limit, verify password, set JWT cookie                                    |
| `src/lib/auth/password.ts`                             | Password hashing, JWT create/verify, cookie helpers                                                 |
| `src/lib/auth/rate-limiter.ts`                         | IP-based login rate limiter                                                                         |
| `src/lib/ws/protocol.ts`                               | Shared WS message types (ConnectedMessage, ServerMessage, ~76 ClientMessage types)                  |
| `src/lib/ws/server-message-schema.ts`                  | Valibot runtime validation schemas (`parseServerMessage`) for inbound WS messages                   |
| `src/lib/state/projects-state.svelte.ts`               | Runes-based projects/sessions state singleton                                                       |
| `src/lib/state/extension-ui-state.svelte.ts`           | Extension modals, widgets, status texts, and action responses state singleton                       |
| `src/lib/client-messages.ts`                           | UIMessage type, SDK→UI conversion, tool formatting                                                  |
| `src/lib/server/wire-messages.ts`                      | Payload budget bounding (`boundMessagesForWire`)                                                    |
| `src/lib/server/extension-tools.ts`                    | Tool activation and extension tool discovery helpers                                                |
| `src/lib/server/extension-completions.ts`              | Slash command argument completions resolver for extensions                                          |
| `src/lib/server/ws-helpers.ts`                         | Shared helpers (serializeModel, serializeSession, semver, GitHub URL, etc.)                         |
| `src/lib/components/chat/message-list.svelte`          | Message stream rendering, tool execution cards, thinking blocks, code blocks                        |
| `src/lib/components/chat/chat-header.svelte`           | Header bar with model selector, session title, context ring, and panel toggles                      |
| `src/lib/components/chat/status-banners.svelte`        | Top banner alerts (disconnected, read-only mode, server notifications)                              |
| `src/lib/components/panels/right-panel.svelte`         | Sidebar tabbed panel for models, tools, skills, prompts, extensions, stats                          |
| `src/lib/components/panels/settings-panel.svelte`      | User settings dialog for appearance, themes, notifications, and dev options                         |
| `src/lib/components/dialogs/extension-overlays.svelte` | Modal dialogs and overlay renderer for extension interactions                                       |
| `src/lib/markdown.ts`                                  | Configured marked + hljs + LaTeX renderer + FNV-1a LRU memoization                                  |
| `src/lib/tui-stubs.ts`                                 | Server-side pi-tui stub bridge, component tree parser, markdown transformer runner                  |
| `src/lib/diff-parser.ts`                               | Unified diff parser                                                                                 |
| `e2e/fixtures.ts`                                      | Playwright custom fixtures — `mockWs`, `login`                                                      |
| `e2e/global-setup.ts`                                  | E2E test suite scratch directory initialization and fake LLM config                                 |
| `e2e/mocks/payloads.ts`                                | Mock WS message factory functions                                                                   |
| `scripts/dev.ts`                                       | Dev orchestrator (parallel Vite + WS server)                                                        |
| `scripts/maybe-build.ts`                               | Incremental build cache freshness check                                                             |
| `benchmark.ts`                                         | Playwright-based WS latency benchmark                                                               |
| `static/manifest.webmanifest`                          | PWA manifest                                                                                        |
| `.env.example`                                         | Required env vars documented                                                                        |

---

## Runtime & Tooling Preferences

- **Runtime**: Bun ≥1.0.0 (Node.js NOT supported)
- **Package manager**: Bun (bun install, bun run, bun add)
- **Module system**: ESM only (`"type": "module"`)
- **Adapter**: vendored `svelte-adapter-bun` at `adapters/svelte-adapter-bun` (NOT `@sveltejs/adapter-node` — incompatible with WS). Vendored because upstream peers on kit ^2 and is unmaintained. Two local changes: `builder.config.kit.paths.base` → `builder.config.paths?.base ?? ''` for SvelteKit 3, and a rewritten post-build patch for the `websocket` hook (`dist/index.js`, function `X`) — kit ≥ `3.0.0-next.25` keeps hooks in a module-level store instead of `this.#options.hooks`, so the upstream regexes silently missed and still injected `websocket() { return this.#options.hooks.websocket }` against an undeclared private field, making `build/server/index.js` a SyntaxError and every production HTTP request a 500. The patch now declares a module-level `__sk_websocket_hook`, fills it after `get_hooks()`, and returns it from the injected accessor. Keep the `vite` `overrides` entry in package.json — vitest bundles its own nested Vite otherwise, and kit 3's `isRunnableDevEnvironment` instanceof check fails across instances.
- **PWA**: Custom minimal service worker (`src/service-worker/index.ts` + `src/service-worker/tsconfig.json`, excluded from the root tsconfig) — no Workbox, no chat-data caching
  - Install: precaches immutable build chunks + static files (versioned cache `pi-ui-shell-<version>` using `$app/env` version), `self.skipWaiting()`
  - Activate: drops old-version caches, `clients.claim()`
  - Fetch: cache-first for **precached assets only** — navigations, `/ws`, and dynamic requests bypass the SW (auth redirects never staled)
  - Notifications: listens for `show_notification` messages from client pages
  - Registration: conditional (browser only, production only) via `register-service-worker.ts`
- **Cold-start resume**: `src/lib/session-snapshot.ts` persists a text-only tail (≤50 msgs, ≤200 KB) of the conversation to localStorage (saved on `agent_end`/`connected`/`session_loaded` + page-hidden); `+page.svelte` hydrates it on boot before the WS connects, so a discarded PWA repaints instantly instead of showing the connecting splash. Live `connected`/`session_loaded` state replaces it wholesale.
- **Auth library**: `crypto.subtle` (no `jose`, no external JWT library)
- **Dependencies & DevDeps**:
  - `@earendil-works/pi-coding-agent` (0.85.1) & `@earendil-works/pi-tui` (0.85.1) — pi SDK, ESM-only
  - `svelte` (^5.57.0), `@sveltejs/kit` (3.0.0-next.23)
  - `@lucide/svelte` (^1.37.0) — UI icons
  - `valibot` (^1.4.2) — schema validation
  - `msw` (^2.15.0) — API & network mocking for testing
- **Key env vars**: `PI_PASSWORD` (required), `PORT` (default 3000), `PI_CWD` (optional working dir)

---

## Testing & QA

Three layers: **Unit** (Vitest, jsdom — 34 test files, 451 tests), **E2E** (Playwright with mock WebSocket + Live SDK suite), **CI** (GitHub Actions). The Bun-native auth suite still has one pre-existing failure: `password.test.ts` uses `vi.resetModules()`, which Bun's runner does not implement; it passes under Vitest.

```bash
bun run test:unit         # vitest run (jsdom — 34 test files, 451 tests)
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
