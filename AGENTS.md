# Repository Guidelines

## Project overview

pi-ui (v0.26.0, `@thed24/pi-ui`) is a **self-hosted PWA frontend for the `pi` coding agent**, like OpenChamber for OpenCode: a standalone Bun server that bridges `pi` SDK events to the browser over one WebSocket. It runs on a Raspberry Pi (in Dom's setup a Pi 5 under a systemd memory cap), so memory use must stay bounded.

Key constraints: ESM-only, Bun ≥1.0.0 (the server does not run on Node), no TTS, no Workbox, no node-pty.

Deep dives: [`docs/architecture.md`](docs/architecture.md) (data flow, lifecycle, SDK integration), [`docs/codebase-map.md`](docs/codebase-map.md) (directories, important files, utility modules, protocol summary, runtime/test detail), [`docs/websocket-protocol.md`](docs/websocket-protocol.md), [`docs/testing.md`](docs/testing.md), [`docs/styling.md`](docs/styling.md), [`docs/app-extensions.md`](docs/app-extensions.md), [`docs/multi-session-design.md`](docs/multi-session-design.md).

## Architecture in brief

- CLI → `server.ts` → `Bun.serve()` → SvelteKit (HTTP) + WebSocket → resident pi SDK sessions. SDK events are forwarded tagged with `sessionId`; `message_update` drops the full partial message (only `assistantMessageEvent` + role) to avoid quadratic traffic. The SDK (~136 MB) and the SvelteKit handler load lazily.
- **Resident sessions:** a `Map<sessionId, ManagedSession>`, capped by count (`PI_UI_MAX_RESIDENT_SESSIONS`, default 4) and parsed-history bytes (`PI_UI_MAX_RESIDENT_HISTORY_MB`, default 48); running, tool-active, dialog-pending and awaiting-input sessions are pinned, others evicted LRU; one resident per `.jsonl` (the SDK has no file locking); `PI_UI_MAX_CONCURRENT_RUNS` (default 2) queues extra runs.
- **Session lists never use SDK `SessionManager.list/listAll`** (they read every file fully: OOM risk). Use `session-catalog.ts` / `project-catalog.ts` in `src/lib/server/` (streaming scan with an mtime/size cache, watcher, single `apply()` mutation point).
- **Wire payloads are bounded** in `src/lib/server/wire-messages.ts` (last 100 messages, per-block/per-message caps, 512 KB total); tool output over 2,000 chars is elided and fetched on demand with `get_tool_output`.
- **State files** (scan cache, project registry, UI settings, push, JWT secret) live in the agent dir via `piAgentDir()`, which honours `PI_CODING_AGENT_DIR`: tests pointed at scratch dirs must never touch `~/.pi/agent`.
- SDK built-in extensions load through `createSdkSession` (`getBuiltInExtensions()` in `slash-command-catalog.ts`), matching the pi CLI. Extensions and tools bind asynchronously via `bindRpcHost`. Extension UI requests block the session until answered (5 min timeout).
- App extensions add installation-wide views and operations (`docs/app-extensions.md`); the `pi-ui-app-extensions` skill in `skills/` is symlinked into `~/.pi/agent/skills`.
- CSRF is disabled in `vite.config.ts` (Bun URL construction conflicts with SvelteKit's origin check); the login action checks origin itself.
- Logging: `src/lib/server/logger.ts` (systemd priority prefixes under the journal); uncaught exceptions are logged and contained.

## Development commands

```bash
# Install
bun install

# Dev modes (3 variants)
bun run dev               # Vite dev server only (port 5173) — no WS, UI iteration only
bun run dev:ws            # Standalone WS server (port 5174) for WS testing
bun run dev:full          # Both Vite (5173) + WS server (5174) in parallel via scripts/dev.ts

# Build
bun run build             # SvelteKit frontend (adapter: svelte-adapter-bun)
bun run build:server      # Bundles server.ts → server.bundle.js (~253 KB, minified)

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
bun run test:unit         # vitest run (jsdom — 66 test files, 864 tests; Node >= 22.19)
bun run test:unit:watch   # vitest (watch mode)
bun run test:coverage     # vitest run --coverage (v8 provider)
bun run test:e2e          # playwright test (chains mock E2E suite + live agent suite)
bun run test:e2e:fast     # playwright test --project=chromium (mock suite only, fast iteration)
bun run test:e2e:live     # playwright test -c playwright.live.config.ts (live agent suite only, workers: 1)
bun run test:e2e:debug    # playwright test --debug

# CI
bun run test:ci           # check + check:sw + check:server + lint + test:unit + test:e2e
```

`scripts/maybe-build.ts` skips frontend rebuilds when `build/` is fresh; `e2e/global-setup.ts` recreates `/tmp/pi-ui-e2e-agent` and `/tmp/pi-ui-e2e-workspace` and points `models.json` at the fake LLM stub (`e2e/fake-llm.ts`).

## Code conventions

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

### Credential & search inputs

- Password inputs used for credentials must set `type="password"` only with `autocomplete="new-password"`, a unique `name`, and `data-1p-ignore`, `data-lpignore="true"`, `data-bwignore`, and `data-form-type="other"`. Search inputs use `autocomplete="off"`. Browser password managers can otherwise autofill the pi-ui login password into API-key fields.

### Auth Patterns

- **Password hashing**: `Bun.password.hash()` with bcrypt cost 10 (production); PBKDF2 600k iterations (Vite dev fallback)
- **JWT via native crypto.subtle** — no `jose` or external library. HMAC-SHA256 signing, 30-day expiry, in-memory JTI revocation. Signing key persisted to `~/.pi/agent/pi-ui-jwt-secret` (0600) on first boot so sessions survive server restarts; `PI_UI_JWT_SECRET` (≥32 chars) overrides the file for multi-process deployments (dev:full)
- **Cookie**: `pi-session`, httpOnly, sameSite:strict, secure when behind proxy
- **Rate limiter**: IP-based in-memory Map on `globalThis.__piRateLimit`; 5 fails/5min → 15min block
- **`hooks.server.ts`**: SvelteKit `Handle` — exact matches `/login` bypass auth, all other paths validate JWT

### Server Patterns

- **`switch(msg.type)` routing**: server dispatches 87 `ClientMessage` union variants. Notable handlers: `prompt`, `edit_message`, `navigate_tree`/`set_entry_label`, `cycle_model`/`cycle_thinking_level`, provider login, and SDK settings
- **Lazy imports**: SDK and SvelteKit handler both lazy-imported on first use
- **`globalThis` for state**: bcrypt hash, JWT secret, and rate limit data are stored on `globalThis`; resident sessions and selection are maintained in the server module
- **Bun pub/sub**: `server.publish('pi', payload)` sends to all WS clients
- **JSON-file persistence**: `project-registry.ts` uses atomic write (`tmp + rename`) to `~/.pi/agent/pi-ui-projects.json`
- **isInsideWorkspace(path)**: resolves symlinks, checks separator-suffixed root prefix. Path traversal guard on `read_file`/`write_file`
- **Null-byte rejection** in `read_file`/`write_file`

### Styling

- **Tailwind v4** + daisyUI — custom "pi" theme (OKLCH violet-obsidian), shadcn variable bridge
- **Typography**: `font-mono` root, `.prose` overrides to `font-sans` for assistant markdown
- **Animation**: 150ms micro-interactions, 250ms layout transitions. Reduced motion respected globally.
- **Formatting**: Prettier (2-space, single quotes, printWidth 100)

## Boundaries and gotchas

- **This checkout is the live custom backend** (`pi-ui.service` → `~/.local/bin/pi-ui-failover.sh` on `:9443`, stable npm fallback). Never stop or restart it from a session it hosts: KillMode=control-group kills every child. Run restarts/deploys as a transient unit (`systemd-run --user --collect --unit=<name> ...`). Local `main` diverges from origin: no pull/rebase without Dom.
- **Host binding:** every UI path registers sessions with `hostAlreadyBound=false`; `setActiveSession` starts `startHostBinding` in the background and `invokeRun` awaits it before a turn, so extensions always get `session_start` and a real `ctx.ui` first. Don't remove either (0.21.1 dropped the first; `e2e/live-session-bind.spec.ts` guards it).
- Adapter: vendored `svelte-adapter-bun` (`adapters/svelte-adapter-bun`), not `@sveltejs/adapter-node` (incompatible with WS). Keep the `vite` entry in package.json `overrides`, or vitest's nested Vite breaks Kit 3's `isRunnableDevEnvironment` check.
- `typescript` stays on `~6.0.3` until typescript-eslint and svelte-check support TS 7.
- Unit tests need Node ≥ 22.19 on PATH (`scripts/require-node.ts` fails fast). The Bun-native auth suite has one known failure (`password.test.ts` uses `vi.resetModules()`); it passes under Vitest.
- E2E: `auth.spec.ts` must use `getByText('password', { exact: true })` (`text=password` matches two elements); don't repeat login in test bodies when the fixture's `beforeEach` does it. UI is tested only through Playwright (no component unit tests).
- Key env vars: `PI_PASSWORD` (required), `PORT` (default 3000), `PI_CWD` (optional working dir).
