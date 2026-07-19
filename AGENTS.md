# Repository Guidelines

## Project Overview

pi-ui (v0.6.0, `@thed24/pi-ui`) is a **self-hosted PWA frontend for the `pi` coding agent** — analogous to how OpenChamber fronts OpenCode. It runs as a standalone Bun server that bridges `pi` SDK events to a browser over a single WebSocket. Designed for low-memory environments (Raspberry Pi).

Key constraints: ESM-only, Bun ≥1.0.0, no TTS, no Workbox, no node-pty.

---

## Architecture & Data Flow

Bun server bridges pi SDK events to browser over WebSocket. Key flow: CLI → server.ts → Bun.serve() → SvelteKit (HTTP) + WebSocket → pi SDK session → events broadcast to all clients.

**Key design decisions:**

- Pi as near-pass-through — SDK events forwarded with a `sessionId` tag; `message_update` is stripped of its full partial message (only `assistantMessageEvent` + role forwarded) to avoid quadratic WS traffic on long reasoning turns
- Lazy SDK load (~136 MB) on first WS connect; lazy SvelteKit handler (~30 MB) on first HTTP
- Session pool with LRU idle cleanup (30 min); navigated-away idle sessions are additionally released after a 2-min grace (`scheduleNavOutDisposal`) unless running/unseen/queued/in-memory — switching back re-opens from disk
- Extension UI requests block session until response (5 min timeout)
- CSRF disabled (`checkOrigin: false`) — Bun URL construction conflicts with SvelteKit's check; server action has own origin check. See `sveltekit-bun-csrf-fix` skill.
- Message editing via `edit_message` — rewinds session via `navigateTree()`, resends. See `pi-sdk-session-manipulation` skill.
- History payloads (`connected`/`session_loaded`/`older_messages`) are size-bounded: last 100 messages, plus per-block 80 KB cap on text/thinking via `src/lib/server/wire-messages.ts`; a failed `connected` send retries without history instead of closing the socket
- Session lists never use SDK `SessionManager.list/listAll` (they load every file fully and build `allMessagesText` — OOM risk at multi-hundred-MB stores); `src/lib/server/session-scan.ts` streams line-by-line with a per-file (mtime,size) cache persisted to `~/.pi/agent/pi-ui-session-scan.json` (restarts are stat-only, ≤2 ms warm), fronted by a 15 s TTL cache in server.ts (`listAllSessions`/`listSessionsFor`), invalidated on session mutations
- Logging via `src/lib/server/logger.ts` — sd-daemon `<N>` priority prefixes under systemd (`JOURNAL_STREAM` set), ISO timestamps otherwise; `uncaughtException`/`unhandledRejection` are logged and contained (process keeps serving)

> **Deep dive:** [`docs/architecture.md`](docs/architecture.md) — full data flow diagram, lifecycle, SDK integration, lazy loading patterns

---

## Key Directories

| Path                          | Purpose                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/lib/auth/`               | Password hashing (bcrypt/PBKDF2), JWT (crypto.subtle), IP rate limiter                                                  |
| `src/lib/ws/`                 | Shared WebSocket protocol types (`protocol.ts`)                                                                         |
| `src/lib/server/`             | Server-side helpers: project registry (JSON file), WS helpers, session management                                       |
| `src/lib/state/`              | Runes-based shared state (`projects-state.svelte.ts`)                                                                   |
| `src/lib/components/chat/`    | Chat components: `message-list.svelte` (message stream, tool traces, thinking blocks, edit/copy buttons)                |
| `src/lib/components/panels/`  | Panel components: `right-panel.svelte` (models/tools/skills tabbed sidebar)                                             |
| `src/lib/components/dialogs/` | Dialog components: `confirm-dialog.svelte`, `fork-dialog.svelte`, `session-tree-modal.svelte`, `toast-container.svelte` |
| `src/lib/components/`         | Svelte 5 components: chat, panels, projects, dialogs, shadcn-style UI primitives                                        |
| `src/lib/components/ui/`      | shadcn-style primitives (button, dialog, select, switch, tabs, card, tooltip, scroll-area, separator)                   |
| `src/routes/(app)/`           | Main SPA (chat UI) — `ssr=false, prerender=false`                                                                       |
| `src/routes/(auth)/`          | Login page (auth group separates routing from hooks guard)                                                              |
| `bin/`                        | CLI entry point (`pifrontier.ts`) and shell shim                                                                        |
| `scripts/`                    | Dev orchestrator (`dev.ts` — parallel Vite + WS server)                                                                 |
| `e2e/`                        | Playwright E2E tests with custom WS mock fixtures                                                                       |
| `static/`                     | PWA assets: icons, manifest.webmanifest                                                                                 |

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
bun run check             # svelte-kit sync + svelte-check
bun run check:server      # tsc --noEmit on server.ts + bin/
bun run lint              # eslint (flat config)
bun run format            # prettier --write .

# Tests
bun test src/lib/auth     # Bun-native test runner for auth/rate-limiter (timeout 15s)
bun run test:unit         # vitest run (jsdom)
bun run test:unit:watch   # vitest (watch mode)
bun run test:coverage     # vitest run --coverage (v8 provider)
bun run test:e2e          # playwright test (builds + starts server first)
bun run test:e2e:debug    # playwright test --debug

# CI
bun run test:ci           # check + check:server + lint + test:unit + test:e2e
```

---

## Code Conventions & Common Patterns

### TypeScript & ESM

- **ESM only** — `"type": "module"` in package.json; use `.ts` extensions in imports
- **Strict mode** — `tsconfig.json` has `strict: true`, `moduleResolution: "bundler"`
- **`types: ["bun"]`** — Bun globals available without imports
- **`tsconfig.server.json`** extends the base config with `allowImportingTsExtensions`, `noEmit`; includes `server.ts` and `bin/`

### Svelte 5 (Runes)

- **`$state()` / `$derived()` / `$effect()`** — never Svelte 4 `let x = ...` or `$:` reactive declarations
- **Callback props, not events** — components use `$props()` destructuring with callback functions; never `createEventDispatcher` or `on:click`
- **`$bindable()`** for two-way-bound parent state
- **`{#snippet children()}…{/snippet}`** instead of slots
- **Shared state via class singletons** — `ProjectsState` class with `$state`/`$derived` fields, instantiated once and exported (see `projects-state.svelte.ts`)
- **`SvelteSet` / `SvelteMap`** for reactive collections in state classes

### Component Patterns

- **shadcn-style UI primitives**: each component is a subdirectory with compound sub-components + `index.ts` that re-exports with both singular (`Root`) and prefixed names (`Button`, `DialogContent`)
- **bits-ui wrapping**: Dialog, Select, Tabs, Tooltip, ScrollArea, Switch, Separator wrap `bits-ui` primitives
- **`tailwind-variants`** (`tv()`): used for variant/size class generation (e.g., `buttonVariants`)
- **`cn()` from `$lib/utils`**: Tailwind class merging via clsx + twMerge
- **Data attributes** like `data-slot="button"`, `data-size="sm"` drive internal styling
- **No component unit tests** — UI is tested exclusively via Playwright E2E

### Auth Patterns

- **Password hashing**: `Bun.password.hash()` with bcrypt cost 10 (production); PBKDF2 600k iterations (Vite dev fallback)
- **JWT via native crypto.subtle** — no `jose` or external library. HMAC-SHA256 signing, 24h expiry, in-memory JTI revocation
- **Cookie**: `pi-session`, httpOnly, sameSite:strict, secure when behind proxy
- **Rate limiter**: IP-based in-memory Map on `globalThis.__piRateLimit`; 5 fails/5min → 15min block
- **`hooks.server.ts`**: SvelteKit `Handle` — exact matches `/login` bypass auth, all other paths validate JWT

### Server Patterns

- **`switch(msg.type)` routing**: server.ts dispatches ~45 ClientMessage types in one large switch. Notable handlers: `prompt` (send to SDK), `edit_message` (rewind + resend via `navigateTree`), `fork_session` (branch session at entry)
- **Lazy imports**: SDK and SvelteKit handler both lazy-imported on first use
- **`globalThis` for state**: bcrypt hash, JWT secret, rate limit data, session pool all stored on `globalThis`
- **Bun pub/sub**: `server.publish('pi', payload)` sends to all WS clients
- **JSON-file persistence**: `project-registry.ts` uses atomic write (`tmp + rename`) to `~/.pi/agent/pi-ui-projects.json`
- **isInsideWorkspace(path)**: resolves symlinks, checks separator-suffixed root prefix. Path traversal guard on `read_file`/`write_file`
- **Null-byte rejection** in `read_file`/`write_file`

### Utility Modules

- **`client-messages.ts`** — `UIMessage` type conversion pipeline: `agentMsgToUI()` maps SDK messages → flat `UIMessage[]`; `formatToolInput()` extracts per-tool one-line summaries; `reconnectDelay()` exponential backoff 1s→30s with jitter
- **`diff-parser.ts`** — `parseDiff()` → `DiffFile[]` with hunks, line numbers, add/delete/context lines
- **`markdown.ts`** — `marked` configured: HTML stripping, hljs (14 languages), inline file-link detection, custom `fileLink` extension, URL sanitization
- **`tui-stubs.ts`** — `StubTui` class for running pi-tui extension factories server-side; duck-type detection of UI component types; `parseComponentTree()` walks trees for web rendering
- **`utils.ts`** — `cn()` (clsx+twMerge), `formatRelativeDate()`, Svelte 5 `WithElementRef`/`WithoutChildren` type helpers

### WebSocket Protocol (`protocol.ts`)

- **ConnectedMessage**: sent server→client on WS open (session state, models, truncated messages)
- **ClientMessage**: union of ~45 tagged types — session lifecycle, messaging (`prompt`, `edit_message`, `steer`, `follow_up`), model, project, filesystem, extension, admin, settings
- **Extension UI**: `extension_ui_response` from client unblocks the session (5 min timeout)

> **Deep dive:** [`docs/websocket-protocol.md`](docs/websocket-protocol.md) — full message type reference, edit flow, extension UI flow

### Styling

- **Tailwind v4** + daisyUI — custom "pi" theme (OKLCH violet-obsidian), shadcn variable bridge
- **Typography**: `font-mono` root, `.prose` overrides to `font-sans` for assistant markdown
- **Animation**: 150ms micro-interactions, 250ms layout transitions. Reduced motion respected globally.
- **Formatting**: Prettier (2-space, single quotes, printWidth 100)

> **Deep dive:** [`docs/styling.md`](docs/styling.md) — theme tokens, CSS classes, visual effects, accessibility

---

## Important Files

| File                                         | Role                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `server.ts`                                  | Main Bun server (~2634 lines) — WS routing, session pool, SDK bridge, extension UI, updates   |
| `bin/pifrontier.ts`                          | CLI entry — arg parsing, password prompt, daemon mode, update flow, server import             |
| `src/hooks.server.ts`                        | SvelteKit auth guard — JWT validation, redirect to `/login`                                   |
| `src/routes/(app)/+page.svelte`              | Main chat UI (~4216 lines) — WS connect, message rendering, streaming, STT, settings, sidebar |
| `src/routes/(auth)/login/+page.server.ts`    | Login action — CSRF, rate limit, verify password, set JWT cookie                              |
| `src/lib/auth/password.ts`                   | Password hashing, JWT create/verify, cookie helpers                                           |
| `src/lib/auth/rate-limiter.ts`               | IP-based login rate limiter                                                                   |
| `src/lib/ws/protocol.ts`                     | Shared WS message types (ConnectedMessage, ServerMessage, ~40 ClientMessage types)            |
| `src/lib/state/projects-state.svelte.ts`     | Runes-based projects/sessions state singleton                                                 |
| `src/lib/client-messages.ts`                 | UIMessage type, SDK→UI conversion, tool formatting                                            |
| `src/lib/server/project-registry.ts`         | JSON file persistence for project registry                                                    |
| `src/lib/server/ws-helpers.ts`               | Shared helpers (serializeModel, serializeSession, semver, GitHub URL, etc.)                   |
| `src/lib/markdown.ts`                        | Configured marked + hljs renderer                                                             |
| `src/lib/tui-stubs.ts`                       | Server-side pi-tui stub bridge                                                                |
| `src/lib/diff-parser.ts`                     | Unified diff parser                                                                           |
| `src/lib/components/ui/button/button.svelte` | Example shadcn-style primitive (tv variants, href support, index.ts re-export)                |
| `e2e/fixtures.ts`                            | Playwright custom fixtures — `mockWs`, `login`                                                |
| `e2e/mocks/payloads.ts`                      | Mock WS message factory functions                                                             |
| `scripts/dev.ts`                             | Dev orchestrator (parallel Vite + WS server)                                                  |
| `benchmark.ts`                               | Playwright-based WS latency benchmark                                                         |
| `static/manifest.webmanifest`                | PWA manifest                                                                                  |
| `.env.example`                               | Required env vars documented                                                                  |

---

## Runtime & Tooling Preferences

- **Runtime**: Bun ≥1.0.0 (Node.js NOT supported)
- **Package manager**: Bun (bun install, bun run, bun add)
- **Module system**: ESM only (`"type": "module"`)
- **Adapter**: `svelte-adapter-bun` (NOT `@sveltejs/adapter-node` — incompatible with WS)
- **PWA**: Custom minimal service worker (`src/service-worker.ts`) — no Workbox, no chat-data caching
  - Install: precaches immutable build chunks + static files (versioned cache `pi-ui-shell-<version>`), `self.skipWaiting()`
  - Activate: drops old-version caches, `clients.claim()`
  - Fetch: cache-first for **precached assets only** — navigations, `/ws`, and dynamic requests bypass the SW (auth redirects never staled)
  - Notifications: listens for `show_notification` messages from client pages
  - Registration: conditional (browser only, production only) via `register-service-worker.ts`
- **Cold-start resume**: `src/lib/session-snapshot.ts` persists a text-only tail (≤50 msgs, ≤200 KB) of the conversation to localStorage (saved on `agent_end`/`connected`/`session_loaded` + page-hidden); `+page.svelte` hydrates it on boot before the WS connects, so a discarded PWA repaints instantly instead of showing the connecting splash. Live `connected`/`session_loaded` state replaces it wholesale.
- **Auth library**: `crypto.subtle` (no `jose`, no external JWT library)
- **Dependency**: `@earendil-works/pi-coding-agent` (~0.79.x) — pi SDK, ESM-only
- **UI icons**: `@lucide/svelte`
- **Key env vars**: `PI_PASSWORD` (required), `PORT` (default 3000), `PI_CWD` (optional working dir)

---

## Testing & QA

Three layers: **Unit** (Vitest, jsdom), **E2E** (Playwright with mock WebSocket), **CI** (GitHub Actions).

```bash
bun run test:unit         # vitest run (jsdom)
bun run test:e2e          # playwright test (builds + starts server)
bun run test:ci           # check + check:server + lint + test:unit + test:e2e
```

**Key patterns:**

- Unit tests: pure functions only, no component rendering. Real fs for persistence tests.
- E2E: all tests mock WS via `page.routeWebSocket` — no real SDK. Custom `mockWs` + `login` fixtures.
- `auth.spec.ts` uses `getByText('password', { exact: true })` — `text=password` matches 2 elements
- Tests must not duplicate login in bodies when `beforeEach` already handles it via fixture

> **Deep dive:** [`docs/testing.md`](docs/testing.md) — full test file inventory, mock patterns, CI pipeline, common fixes
