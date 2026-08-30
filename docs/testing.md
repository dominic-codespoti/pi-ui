# Testing Guide

## Layer 1 — Unit Tests (Vitest)

| Aspect              | Value                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------- |
| Framework           | Vitest v4.1.11 (`@vitest/coverage-v8` v4.1.11)                                               |
| Environment         | jsdom                                                                                        |
| Setup               | `@testing-library/jest-dom/vitest` (auto-imported)                                           |
| Test locations      | `src/**/*.test.ts` (37 test files across `lib/`, `server/`, `state/`, `components/`, `routes/`) |
| Coverage            | v8 provider, 60% stmts/funcs/lines, 50% branches                                             |
| Coverage exclusions | `src/lib/components/ui/**`, test files, service-worker                                       |
| Mocking             | `vi.mock()` module mocking, `vi.mocked()` typed mocks, `vi.resetModules()` for fresh imports |

### Test Files by Area (37 Files)

#### Client Core & Protocol Helpers (`src/lib/__tests__/`, `src/lib/`)
- `src/lib/__tests__/client-messages.test.ts` — uid, extractTextContent, formatToolInput, agentMsgToUI, thinking levels, reconnectDelay, rawMessagesToUI
- `src/lib/__tests__/composer-terminal-bridge.test.ts` — prompt routing and terminal input bridging
- `src/lib/__tests__/diff-parser.test.ts` — unified diff parser and hunk formatting
- `src/lib/__tests__/extension-modals.test.ts` — extension modal / confirm / input state transformations
- `src/lib/__tests__/markdown.test.ts` — renderMarkdown, LaTeX math block rendering, memoization cache, highlightCode
- `src/lib/__tests__/notification-prefs.test.ts` — web push notification preferences & storage serialization
- `src/lib/__tests__/session-snapshot.test.ts` — session snapshot hydration and message projection
- `src/lib/__tests__/session-view-cache.test.ts` — session view cache invalidation & hydration
- `src/lib/__tests__/thinking-levels.test.ts` — reasoning / thinking level definitions and cycle transitions
- `src/lib/__tests__/tui-stubs.test.ts` — stripAnsi, StubTui, parseComponentTree, callFactoryAndParse, editor / isEditor stubs
- `src/lib/__tests__/utils.test.ts` — cn, formatRelativeDate, type helpers
- `src/lib/session-view-cache.test.ts` — root-level session view cache unit coverage

#### Authentication & Security (`src/lib/auth/`)
- `src/lib/auth/password.test.ts` — JWT round-trip, expiry, tamper detection, cookie parsing, WebCrypto signature verification
- `src/lib/auth/rate-limiter.test.ts` — sliding window, block, IP normalization, time-travel via `__piRateLimit`

#### State Management (`src/lib/state/__tests__/`)
- `src/lib/state/__tests__/chat-store.test.ts` — chat message state, active turn tracking, streaming delta aggregation
- `src/lib/state/__tests__/connection-store.test.ts` — WebSocket connection status, reconnect state machine, socket lifecycle
- `src/lib/state/__tests__/panels-store.test.ts` — drawer & panel open/closed states, layout switching
- `src/lib/state/__tests__/projects-state.test.ts` — project/session groups derivation, filtering, runtime indicators, handleMessage

#### WebSocket Schemas (`src/lib/ws/__tests__/`)
- `src/lib/ws/__tests__/server-message-schema.test.ts` — Valibot parsing & validation for server-to-client message schemas

#### Server & Session Management (`src/lib/server/`, `src/lib/server/__tests__/`)
- `src/lib/server/push-notifications.test.ts` — Web Push VAPID delivery & subscription persistence
- `src/lib/server/__tests__/compaction-watchdog.test.ts` — auto-compaction trigger thresholds and watchdog lifecycle
- `src/lib/server/__tests__/extension-completions.test.ts` — slash-command completions provider from active extensions
- `src/lib/server/__tests__/extension-tools.test.ts` — dynamic extension tool discovery & registration
- `src/lib/server/__tests__/project-catalog.test.ts` — multi-root project scanning and cataloging
- `src/lib/server/__tests__/project-registry.test.ts` — project CRUD, persistence under `/tmp`
- `src/lib/server/__tests__/provider-auth.test.ts` — provider API key resolution, OAuth / custom token checks
- `src/lib/server/__tests__/session-catalog.test.ts` — session catalog grouping, sorting, search index
- `src/lib/server/__tests__/session-scan.test.ts` — JSONL session log scanning, header extraction, metadata parsing
- `src/lib/server/__tests__/session-watcher.test.ts` — inotify / file watcher events on `.pi` session logs
- `src/lib/server/__tests__/terminal-input.test.ts` — raw terminal mode keystroke and input handling
- `src/lib/server/__tests__/wire-messages.test.ts` — server wire serialization, protocol framing, message encoding
- `src/lib/server/__tests__/ws-helpers.test.ts` — path utilities, serialization, semver, formatting

#### UI Component Units (`src/lib/components/**/__tests__/`)
- `src/lib/components/chat/__tests__/header-and-banners.test.ts` — banner rendering, offline notices, session headers
- `src/lib/components/dialogs/__tests__/extension-overlays.test.ts` — extension modal overlays & custom dialog actions
- `src/lib/components/panels/__tests__/settings-panel.test.ts` — settings form state, theme / provider toggle controls

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

| Aspect              | Value                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Framework           | Playwright v1.62+                                                                               |
| Test dir            | `e2e/*.spec.ts` (22 spec files)                                                                 |
| Browsers            | Chromium (`Desktop Chrome`) + Mobile (`Pixel 5`)                                               |
| Parallelism         | `fullyParallel: false`, `workers: process.env.CI ? 2 : 4` (mock suite)                          |
| CI retries          | 2                                                                                               |
| Global Setup        | `e2e/global-setup.ts` creates scratch dirs `/tmp/pi-ui-e2e-agent` and `/tmp/pi-ui-e2e-workspace`|
| Web Servers         | `webServer[0]`: `bun e2e/fake-llm.ts` on port 8787 (`http://127.0.0.1:8787/health`)<br>`webServer[1]`: `bun scripts/maybe-build.ts && PI_PASSWORD=... PI_CODING_AGENT_DIR=/tmp/pi-ui-e2e-agent PI_CWD=/tmp/pi-ui-e2e-workspace PORT=3000 bun run start` on `http://127.0.0.1:3000` |
| Live Suite Split    | `testIgnore: ['e2e/live-agent.spec.ts', 'e2e/live-widget.spec.ts']` in `playwright.config.ts`. Handled serially (`workers: 1`) via `playwright.live.config.ts` |
| Fixtures            | `mockWs` (intercepts `/ws` via `page.routeWebSocket`), `login` helper, `loginViaCookie`, `CONNECTED_PAYLOAD` factory |

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

### Test Files (22 Specs)

- `auth.spec.ts` — login form redirection, wrong password error banner, valid login, persisted auth cookie
- `auth-expiry.spec.ts` — WS close code 4001 session expiry banner and reconnect flows
- `chat.spec.ts` — composer visibility, prompt WS dispatch, streaming text deltas, thinking deltas, slash commands & subcommands, message resumption, touch selection (11+ tests)
- `compaction.spec.ts` — auto-compaction banner and in-flight compaction status
- `connectivity.spec.ts` — connection state indicators, disconnect banners, reconnect backoff with jitter, tooltip hints, offline overlays
- `extension-ui.spec.ts` — confirm dialogs, input dialogs, notify toast / chat banners, widgets (loaders, progress bars, text), multi-session widget scoping (16+ tests)
- `file-viewer.spec.ts` — file reference link clicks, modal viewer, WS `read_file` / `file_content` flows
- `history-pagination.spec.ts` — virtualized message scroll, upward pagination, history chunk requests
- `horizontal-scroll.spec.ts` — wide markdown tables horizontal panning, wide code block scrolling, page-level overflow containment
- `live-agent.spec.ts` — live end-to-end turn against real pi SDK and fake LLM stub
- `live-widget.spec.ts` — live above-editor extension widget loading and rendering
- `notifications.spec.ts` — browser notification permission requests, web push registration, sound toggle preferences
- `projects.spec.ts` — sidebar project groups, project search filter, session switching without reload, runtime indicator orbs (8+ tests)
- `providers.spec.ts` — provider list, API key input, OAuth modal triggers, custom model configs (4+ tests)
- `resume.spec.ts` — resuming existing session from persisted JSONL snapshot vs live connection takeover
- `server-smoke.spec.ts` — real HTTP tests against server: `/login` 200, 404 handler, `/ws` 401 without cookie, login HTML structure
- `session-orbs.spec.ts` — background session streaming activity indicators and active session selection
- `share-target.spec.ts` — PWA Web Share Target API handling for files and incoming text
- `sidebar-nesting.spec.ts` — hierarchical sub-session nesting under parent roots in sidebar
- `sidebar-order.spec.ts` — chronological and pinned session sorting order
- `tools.spec.ts` — tool list panel, tool toggles, bash stdout streaming, tool error states, diff parser views
- `visual-review.spec.ts` — screenshot capture of clean states, widgets, modals, and responsive layout across desktop/mobile

### Common Test Fixes & Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `chrome-error://chromewebdata/` | Login POST blocked by CSRF / origin check during test | Use `login` fixture or `loginViaCookie()` to attach cookie directly to context |
| `page.routeWebSocket timed out` | WebSocket not connected or no handshake reply | Ensure mock handler sends `CONNECTED_PAYLOAD` on open and replies to `get_projects`/`get_all_sessions` |
| Blank Screenshot | Captured before DOM or assets finished rendering | Add `await page.waitForTimeout(1000)` or wait on a specific locator (`locator('textarea')`) after `goto` |
| `text=password` strict mode violation | Multiple elements match (label + hint span) | Use `getByText('password', { exact: true })` instead of `locator('text=password')` |
| Duplicate inline login | Re-logging in when fixture already set cookie | Avoid repeating `login(page)` in test bodies if `login` was already invoked in `beforeEach` |

---

## Layer 3 — CI (GitHub Actions)

- **Trigger**: Push or PR to `main`
- **Runtime**: Bun 1.2+ (`oven-sh/setup-bun`)
- **Package Installation**: `bun install --frozen-lockfile` (preserves lockfile integrity)
- **Pipeline Steps**:
  1. `bun run check` (`svelte-kit sync && svelte-check`)
  2. `bun run check:sw` (`tsc --noEmit -p src/service-worker/tsconfig.json`)
  3. `bun run check:server` (`tsc --noEmit --project tsconfig.server.json`)
  4. `bun run lint` (`eslint .`)
  5. `bun run test:unit` (`vitest run`)
  6. `bun run test:e2e` (`playwright test && playwright test -c playwright.live.config.ts`)
