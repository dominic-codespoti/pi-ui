# Testing Guide

## Layer 1 — Unit Tests (Vitest)

| Aspect              | Value                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Framework           | Vitest v5.1 (`@vitest/coverage-v8` v5.1)                                                                                    |
| Runtime             | Node >= 22.19 (`.nvmrc`: 24) — undici 8 needs it; `scripts/require-node.ts` fails fast on older Node                        |
| Environment         | jsdom                                                                                                                       |
| Setup               | `@testing-library/jest-dom/vitest` (auto-imported)                                                                          |
| Test locations      | `src/**/*.test.ts` (66 test files / 864 tests across `lib/`, `server/`, `state/`, `controllers/`, `components/`, `routes/`) |
| Coverage            | v8 provider, 60% stmts/funcs/lines, 50% branches                                                                            |
| Coverage exclusions | `src/lib/components/ui/**`, test files, service-worker                                                                      |
| Mocking             | `vi.mock()` module mocking, `vi.mocked()` typed mocks, `vi.resetModules()` for fresh imports                                |

### Test Files by Area (66 Files / 864 Tests)

#### Client Core & Protocol Helpers (`src/lib/__tests__/`, `src/lib/`)

- `src/lib/__tests__/client-messages.test.ts` — uid, extractTextContent, formatToolInput, agentMsgToUI, rawMessagesToUI, reconnectDelay, SDK 1.5 responseModel / provider-billed usage
- `src/lib/__tests__/draft-store.test.ts` — durable per-session composer drafts: round trip, blank removal, TTL, count/size caps, corrupt storage
- `src/lib/__tests__/diff-parser.test.ts` — unified diff parser and hunk formatting
- `src/lib/__tests__/adapter-bun.test.ts` — vendored svelte-adapter-bun distribution files and package exports
- `src/lib/__tests__/extension-modals.test.ts` — extension modal / confirm / input state transformations
- `src/lib/__tests__/markdown.test.ts` — renderMarkdown, LaTeX math block rendering, memoization cache, highlightCode
- `src/lib/__tests__/notification-prefs.test.ts` — web push notification preferences & storage serialization
- `src/lib/__tests__/session-identity.test.ts` — device-scoped last-session identity persistence and resume priority
- `src/lib/__tests__/session-snapshot.test.ts` — session snapshot hydration and message projection
- `src/lib/__tests__/session-view-cache.test.ts` — bounded per-session client view cache: retention cap, LRU eviction order, base64/attachment stripping on save, restore equivalence
- `src/lib/__tests__/tui-stubs.test.ts` — stripAnsi, StubTui, parseComponentTree, callFactoryAndParse, editor / isEditor stubs, SDK 1.5 render contexts (keyText/keyHint, outputPad, markdown-transform messageId/timestamp), separate call/result renderer slots (SDK MCP renderers)
- `src/lib/__tests__/utils.test.ts` — cn, formatRelativeDate, type helpers

#### App Extensions — client (`src/lib/app-extensions/`, `src/lib/state/__tests__/`)

- `src/lib/app-extensions/client-loader.test.ts` — client module loading, client API construction, subscription tracking, teardown
- `src/lib/app-extensions/manifest.test.ts` — `pi-ui.extension.json` manifest parsing and validation
- `src/lib/app-extensions/slots.test.ts` — view slot metadata and grouping by slot
- `src/lib/app-extensions/transport.test.ts` — client transport for extension operations and events
- `src/lib/state/__tests__/app-extensions-state.test.ts` — app extension catalog / active view state

#### Authentication & Security (`src/lib/auth/`)

- `src/lib/auth/password.test.ts` — JWT round-trip, expiry, tamper detection, cookie parsing, WebCrypto signature verification
- `src/lib/auth/rate-limiter.test.ts` — sliding window, block, IP normalization, time-travel via `__piRateLimit`

#### State Management (`src/lib/state/__tests__/`)

- `src/lib/state/__tests__/projects-state.test.ts` — project/session groups derivation, filtering, runtime indicators, handleMessage, content-search request correlation

#### Client Controllers (`src/lib/controllers/__tests__/`)

- `src/lib/controllers/__tests__/client-websocket-controller.test.ts` — socket lifecycle, reconnect backoff, send queueing
- `src/lib/controllers/__tests__/composer-completion-controller.test.ts` — file / extension / command completion channels and debouncing
- `src/lib/controllers/__tests__/composer-controller.test.ts` — composer draft, submit and queue behaviour
- `src/lib/controllers/__tests__/notification-controller.test.ts` — in-app / push notification decisions
- `src/lib/controllers/__tests__/session-coordinator.test.ts` — active vs background session views, frame routing
- `src/lib/controllers/__tests__/session-reducer.test.ts` — SDK event → message-list reducer (streaming, tools, message_end)
- `src/lib/controllers/__tests__/tool-output-controller.test.ts` — lazy elided tool-output fetching

#### WebSocket Schemas (`src/lib/ws/__tests__/`)

- `src/lib/ws/__tests__/server-message-schema.test.ts` — Valibot parsing & validation for server-to-client message schemas

#### Server & Session Management (`src/lib/server/`, `src/lib/server/__tests__/`)

- `src/lib/server/push-notifications.test.ts` — Web Push VAPID delivery & subscription persistence
- `src/lib/server/__tests__/agent-dir.test.ts` — `piAgentDir()` honours `PI_CODING_AGENT_DIR` (absolute, `~/`, relative, blank)
- `src/lib/server/__tests__/compaction-watchdog.test.ts` — auto-compaction trigger thresholds and watchdog lifecycle
- `src/lib/server/__tests__/extension-changelog.test.ts` — SDK 1.5 extension-package changelogs (real SDK parser), collapsed/full notice formatting
- `src/lib/server/__tests__/extension-completions.test.ts` — slash-command completions provider from active extensions
- `src/lib/server/__tests__/phase-timer.test.ts` — stalled-phase warnings stop on completion; slow/failed phases listed
- `src/lib/server/__tests__/project-catalog.test.ts` — multi-root project scanning and cataloging
- `src/lib/server/__tests__/project-registry.test.ts` — project CRUD, persistence under `/tmp`
- `src/lib/server/__tests__/provider-auth.test.ts` — provider API key resolution, OAuth / custom token checks
- `src/lib/server/__tests__/provider-login-session.test.ts` — requester-scoped provider login prompt bridge
- `src/lib/server/__tests__/session-catalog.test.ts` — session catalog grouping, sorting, search index
- `src/lib/server/__tests__/session-content-search.test.ts` — message-text search: case, JSON-escaped queries, caps, abort/deadline, query normalisation
- `src/lib/server/__tests__/session-scan.test.ts` — JSONL session log scanning, header extraction, metadata parsing, per-day/per-model usage buckets (incremental + persisted cache v3)
- `src/lib/server/__tests__/session-watcher.test.ts` — inotify / file watcher events on `.pi` session logs
- `src/lib/server/__tests__/terminal-input.test.ts` — raw terminal mode keystroke and input handling
- `src/lib/server/__tests__/tool-update-coalescer.test.ts` — coalescing of streamed tool updates
- `src/lib/server/__tests__/usage-summary.test.ts` — cross-session usage window, day fill, model/project ranking, clamping
- `src/lib/server/__tests__/ui-settings.test.ts` — durable UI settings and last-session pointer persistence
- `src/lib/server/__tests__/wire-messages.test.ts` — server wire serialization, protocol framing, message encoding
- `src/lib/server/__tests__/ws-helpers.test.ts` — path utilities, serialization, semver, formatting

#### Server Runtime & Handlers (`src/lib/server/runtime/__tests__/`, `src/lib/server/handlers/__tests__/`)

- `src/lib/server/runtime/__tests__/extension-runtime.test.ts` — extension UI runtime state, dialog promises, SDK 1.5 `blocked` / awaiting-input classification
- `src/lib/server/runtime/__tests__/resident-sessions.test.ts` — resident session store, pinning, LRU eviction
- `src/lib/server/runtime/__tests__/session-operation-gate.test.ts` — serialized session operations
- `src/lib/server/runtime/__tests__/websocket-transport.test.ts` — frame decoding, auth and socket lifecycle
- `src/lib/server/handlers/__tests__/app-extension-handlers.test.ts` — app extension WS messages (enable, cancel, reload)
- `src/lib/server/handlers/__tests__/extension-ui-handlers.test.ts` — extension UI responses and component events
- `src/lib/server/handlers/__tests__/filesystem-handlers.test.ts` — read/write/complete with workspace guards
- `src/lib/server/handlers/__tests__/project-handlers.test.ts` — project WS messages
- `src/lib/server/handlers/__tests__/system-handlers.test.ts` — system / settings WS messages

#### App Extensions — server (`src/lib/server/app-extensions/`)

- `src/lib/server/app-extensions/agent-tools.test.ts` — exposeToAgent tool filtering, naming and execution
- `src/lib/server/app-extensions/context.test.ts` — scoped workspace reads/writes, `cli.run`, storage, emit
- `src/lib/server/app-extensions/host.test.ts` — package scanning without code execution, enablement, dispatch, reload
- `src/lib/server/app-extensions/package-loader.test.ts` — package loading, entry safety, malformed modules, asset resolution
- `src/lib/server/app-extensions/runtime.test.ts` — operation registry lifecycle, dispatch, events
- `src/lib/server/app-extensions/sdk-tools.test.ts` — SDK tool parameter mapping, scope derivation, abort handling

#### UI Component Units (`src/lib/components/**/__tests__/`)

- `src/lib/components/chat/__tests__/message-row-helpers.test.ts` — usage breakdown tooltip (incl. billed vs estimated cost)

#### SvelteKit Route Handlers (`src/routes/__tests__/`)

- `src/routes/__tests__/hooks.server.test.ts` — SvelteKit Handle guard logic, auth redirects, cookie validation
- `src/routes/__tests__/login-page-server.test.ts` — login form actions, credentials verification, rate limit responses

### Key Patterns

- Unit tests target **pure functions, store runes logic, and server logic** — no full browser DOM rendering
- Dynamic imports for SvelteKit route modules (`await import('../(auth)/login/+page.server')`)
- `try/catch` to catch SvelteKit's `redirect()` throws
- Real filesystem for persistence tests (project-registry and session-scan write to `/tmp`)
- WebCrypto API to build custom JWTs for signature/expiry tests
- `globalThis.__piRateLimit` manipulation for time-travel in rate limiter tests

---

## Layer 2 — E2E Tests (Playwright)

| Aspect           | Value                                                                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework        | Playwright v1.62+                                                                                                                                                                                                                                                                  |
| Test dir         | `e2e/*.spec.ts` (24 spec files)                                                                                                                                                                                                                                                    |
| Browsers         | Chromium (`Desktop Chrome`) + Mobile (`Pixel 5`)                                                                                                                                                                                                                                   |
| Parallelism      | `fullyParallel: false`, `workers: process.env.CI ? 2 : 4` (mock suite)                                                                                                                                                                                                             |
| CI retries       | 2                                                                                                                                                                                                                                                                                  |
| Global Setup     | `e2e/global-setup.ts` creates scratch dirs `/tmp/pi-ui-e2e-agent` and `/tmp/pi-ui-e2e-workspace`                                                                                                                                                                                   |
| Web Servers      | `webServer[0]`: `bun e2e/fake-llm.ts` on port 8787 (`http://127.0.0.1:8787/health`)<br>`webServer[1]`: `bun scripts/maybe-build.ts && PI_PASSWORD=... PI_CODING_AGENT_DIR=/tmp/pi-ui-e2e-agent PI_CWD=/tmp/pi-ui-e2e-workspace PORT=3000 bun run start` on `http://127.0.0.1:3000` |
| Live Suite Split | `testIgnore: ['e2e/live-agent.spec.ts', 'e2e/live-widget.spec.ts']` in `playwright.config.ts`. Handled serially (`workers: 1`) via `playwright.live.config.ts`                                                                                                                     |
| Fixtures         | `mockWs` (intercepts `/ws` via `page.routeWebSocket`), `login` helper, `loginViaCookie`, `CONNECTED_PAYLOAD` factory                                                                                                                                                               |

### Live vs. Mock Test Suite Separation

1. **Mock WebSocket Suites (`playwright.config.ts`)**:
   - Runs with per-file parallelism (`workers: process.env.CI ? 2 : 4`).
   - Mock WebSocket specs are page-isolated and intercept `/ws` using `page.routeWebSocket`.
   - Never interact with the real pi SDK agent pool.
2. **Live SDK Suites (`playwright.live.config.ts`)**:
   - `e2e/live-agent.spec.ts` and `e2e/live-widget.spec.ts`.
   - Run serially with `workers: 1` (`bun run test:e2e:live` or automatically chained in `bun run test:e2e`).
   - Exercises real Bun server + real `@earendil-works/pi-coding-agent` SDK connected to local OpenAI-compatible stub (`e2e/fake-llm.ts` on port 8787).
   - Verifies real widget loading via `jiti`, extension reloads, live turn loops, and above-editor widget factories without external LLM API costs.

### Mock WS Architecture & Fixtures (`e2e/fixtures.ts`)

- **`mockWs(page, opts)`**: Traps `/ws` via `page.routeWebSocket('/ws')`. Automatically pushes `CONNECTED_PAYLOAD` immediately upon socket open.
  - When `autoInit: true` (default), auto-replies to `get_projects` with `PROJECTS_LIST_PAYLOAD` and `get_all_sessions` with `ALL_SESSIONS_LIST_PAYLOAD`.
- **`login(page, password?)`**: Navigates to `/login`, fills credentials, submits, and waits for `/`.
- **`loginViaCookie(page)`**: Directly generates a session token signed with `PI_UI_JWT_SECRET` and attaches the auth cookie to the browser context, bypassing the login form submission.
- **`CONNECTED_PAYLOAD` Factory (`e2e/mocks/payloads.ts`)**: Generates pre-populated connected states, mock session headers, and helper factories (`extensionSetWidgetPayload`, `extensionConfirmPayload`, `extensionInputPayload`, `extensionNotifyPayload`, `textDeltaPayload`, `thinkingDeltaPayload`).

### Test Files (28 Specs)

- `auth.spec.ts` — login form redirection, wrong password error banner, valid login, persisted auth cookie, native sign-in with JavaScript disabled or the app entry chunk unavailable
- `auth-expiry.spec.ts` — WS close code 4001 session expiry banner and reconnect flows
- `chat.spec.ts` — composer visibility, prompt WS dispatch, streaming text deltas, thinking deltas, slash commands & subcommands, message resumption, touch selection (11+ tests)
- `compaction.spec.ts` — auto-compaction banner and in-flight compaction status
- `connectivity.spec.ts` — connection state indicators, disconnect banners, reconnect backoff with jitter, tooltip hints, offline overlays
- `extension-ui.spec.ts` — confirm dialogs, input dialogs, notify toast / chat banners, widgets (loaders, progress bars, text), multi-session widget scoping (16+ tests)
- `draft-persistence.spec.ts` — unsent composer draft restored after reload; sending clears it
- `file-viewer.spec.ts` — file reference link clicks, modal viewer, WS `read_file` / `file_content` flows
- `history-pagination.spec.ts` — virtualized message scroll, upward pagination, history chunk requests
- `horizontal-scroll.spec.ts` — wide markdown tables horizontal panning, wide code block scrolling, page-level overflow containment
- `live-agent.spec.ts` — live end-to-end turn against real pi SDK and fake LLM stub
- `live-widget.spec.ts` — live above-editor extension widget loading and rendering
- `multi-session.spec.ts` — background running/tool orbs, unread and clear-on-switch with outbound `session_focus`, needs-attention affordance, and background streaming isolation
- `notifications.spec.ts` — browser notification permission requests, web push registration, sound toggle preferences
- `projects.spec.ts` — sidebar project groups, project search filter, session switching without reload (8+ tests)
- `provider-login.spec.ts` — provider sign-in dialog: OAuth URL, redirect-paste prompt, callback cancellation (`provider_login_cancel`) and success
- `providers.spec.ts` — provider list, API key input, OAuth modal triggers, custom model configs (4+ tests)
- `resume.spec.ts` — resuming existing session from persisted JSONL snapshot vs live connection takeover
- `server-smoke.spec.ts` — real HTTP tests against server: `/login` 200, 404 handler, `/ws` 401 without cookie, login HTML structure
- `session-identity.spec.ts` — device identity resume priority (URL param vs. persisted vs. server default) and self-heal on a stale/deleted identity
- `session-orbs.spec.ts` — restored background-session orbs and per-session orb selection
- `share-target.spec.ts` — PWA Web Share Target API handling for files and incoming text
- `sidebar-nesting.spec.ts` — hierarchical sub-session nesting under parent roots in sidebar
- `sidebar-order.spec.ts` — chronological and pinned session sorting order
- `sticky-user-message.spec.ts` — only the current turn's user message sticks at the top of the transcript
- `tools.spec.ts` — tool list panel, tool toggles, bash stdout streaming, tool error states, diff parser views
- `usage-and-search.spec.ts` — Settings → Usage request/render and window switch; sidebar message search, highlighted hit, switch on click, stale results dropped
- `visual-review.spec.ts` — screenshot capture of clean states, widgets, modals, and responsive layout across desktop/mobile

### Common Test Fixes & Troubleshooting

| Symptom                               | Cause                                                 | Fix                                                                                                      |
| ------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `chrome-error://chromewebdata/`       | Login POST blocked by CSRF / origin check during test | Use `login` fixture or `loginViaCookie()` to attach cookie directly to context                           |
| `page.routeWebSocket timed out`       | WebSocket not connected or no handshake reply         | Ensure mock handler sends `CONNECTED_PAYLOAD` on open and replies to `get_projects`/`get_all_sessions`   |
| Blank Screenshot                      | Captured before DOM or assets finished rendering      | Add `await page.waitForTimeout(1000)` or wait on a specific locator (`locator('textarea')`) after `goto` |
| `text=password` strict mode violation | Multiple elements match (label + hint span)           | Use `getByText('password', { exact: true })` instead of `locator('text=password')`                       |
| Duplicate inline login                | Re-logging in when fixture already set cookie         | Avoid repeating `login(page)` in test bodies if `login` was already invoked in `beforeEach`              |

#### Harness Lessons

- A service worker may be terminated and respawned at any time: re-resolve the worker handle before each `evaluate` and never rely on worker-local state.
- A drawer's bounding box remains non-zero during its close transition, so read whether it is open from the authoritative `aria-hidden`/animation state.
- Drive frames around assertions rather than using fixed timers; fixed delays can race when running with `workers: 4`.
- Exact URLs are brittle when the app legitimately appends `?session=`; assert `url.pathname` instead.
- Mock socket events (close, delayed `connected`) should fire on the client frame that defines the moment — e.g. close when the second key arrives, finish a held handshake and wait for `get_app_extensions` (sent in the same handler that completes it) — never on a timer after an earlier frame.
- Type debounce bursts inside the page (`page.evaluate` with short in-page gaps), not as consecutive `page.fill` calls: each Playwright round trip can exceed the debounce window on a loaded host.
- Judge "did the click register" by state bound to the control (`aria-expanded`), and lazily mounted, sliding content separately with a polled wait.

#### Reproducing host-speed flakes

- `PI_UI_E2E_CPU_THROTTLE=8 bunx playwright test …` slows the page's CPU via Chromium CDP (`e2e/fixtures.ts` page fixture). Timer-based tests that pass locally but fail on a Raspberry Pi or busy CI runner usually fail deterministically at 6–8×.
- `PI_UI_E2E_PORT=3100` runs the suites on another port when a real pi-ui already holds 3000.

---

## Layer 3 — CI (GitHub Actions)

- **Trigger**: Push or PR to `main`
- **Runtime**: Bun 1.2+ (`oven-sh/setup-bun`) + Node from `.nvmrc` (`actions/setup-node@v7`) for vitest/Playwright
- **Package Installation**: `bun install --frozen-lockfile` (preserves lockfile integrity)
- **Pipeline Steps**:
  1. `bun run check` (`svelte-kit sync && svelte-check`)
  2. `bun run check:sw` (`tsc --noEmit -p src/service-worker/tsconfig.json`)
  3. `bun run check:server` (`tsc --noEmit --project tsconfig.server.json`)
  4. `bun run lint` (`eslint .`)
  5. `bun run test:unit` (`vitest run`)
  6. `bun run test:e2e` (`playwright test && playwright test -c playwright.live.config.ts`)
