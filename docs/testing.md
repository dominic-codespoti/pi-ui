# Testing Guide

## Layer 1 — Unit Tests (Vitest)

| Aspect | Value |
|--------|-------|
| Framework | Vitest v4 |
| Environment | jsdom |
| Setup | `@testing-library/jest-dom/vitest` (auto-imported) |
| Test locations | `src/**/*.test.ts` (co-located or `__tests__/`) |
| Coverage | v8 provider, 60% stmts/funcs/lines, 50% branches |
| Coverage exclusions | `src/lib/components/ui/**`, test files, service-worker |
| Mocking | `vi.mock()` module mocking, `vi.mocked()` typed mocks, `vi.resetModules()` for fresh imports |

### Test Files by Area

- `src/lib/__tests__/client-messages.test.ts` — uid, extractTextContent, formatToolInput, agentMsgToUI, reconnectDelay, rawMessagesToUI
- `src/lib/__tests__/diff-parser.test.ts` — unified diff format
- `src/lib/__tests__/tui-stubs.test.ts` — stripAnsi, StubTui, parseComponentTree, callFactoryAndParse
- `src/lib/__tests__/markdown.test.ts` — renderMarkdown, highlightCode
- `src/lib/__tests__/utils.test.ts` — cn, formatRelativeDate, type helpers
- `src/lib/auth/password.test.ts` — JWT round-trip, expiry, tamper detection, cookie parsing
- `src/lib/auth/rate-limiter.test.ts` — sliding window, block, IP normalization, time-travel
- `src/lib/server/__tests__/project-registry.test.ts` — CRUD, persistence (real fs under /tmp)
- `src/lib/server/__tests__/ws-helpers.test.ts` — path utilities, serialization, semver, formatting
- `src/lib/state/__tests__/projects-state.test.ts` — groups derivation, filtering, actions, handleMessage
- `src/routes/__tests__/login-page-server.test.ts` — 11 tests for login load + actions (vi.mock)
- `src/routes/__tests__/hooks.server.test.ts` — 6 tests for Handle function guard logic

### Key Patterns

- Unit tests target **pure functions and server logic only** — no component rendering
- Dynamic imports for SvelteKit route modules (`await import('../(auth)/login/+page.server')`)
- `try/catch` to catch SvelteKit's `redirect()` throws
- Real filesystem for persistence tests (project-registry writes to /tmp)
- WebCrypto API to build custom JWTs for signature/expiry tests
- `globalThis.__piRateLimit` manipulation for time-travel in rate limiter tests

## Layer 2 — E2E Tests (Playwright)

| Aspect | Value |
|--------|-------|
| Framework | Playwright |
| Test dir | `e2e/*.spec.ts` |
| Browsers | Chromium (Desktop Chrome) + Pixel 5 (mobile) |
| Parallelism | `fullyParallel: false`, 1 worker |
| CI retries | 2 |
| Server | `bun run build && PI_PASSWORD=test-password PORT=3000 bun run start` |
| baseURL | `http://127.0.0.1:3000` |
| Fixtures | Custom `mockWs` (intercepts /ws via `page.routeWebSocket`), `login` helper |

### Mock WS Architecture (`e2e/fixtures.ts`)

- All E2E tests use a **mocked WebSocket** — no real pi SDK connection
- `mockWs()` traps `/ws` via `page.routeWebSocket`, sends `CONNECTED_PAYLOAD` on open
- Auto-replies to `get_projects` and `get_all_sessions`
- Each test can add custom WS message handlers or inject server events via `ws.send()`
- Mock payloads defined in `e2e/mocks/payloads.ts` — factory functions for every event type

### Test Files

- `auth.spec.ts` — 4 tests: redirect, wrong password, correct password, persisted session
- `chat.spec.ts` — 5 tests: composer visibility, prompt WS message, text deltas, existing messages, thinking deltas
- `tools.spec.ts` — 3 tests: bash stdout, tool error, edit tool diff
- `extension-ui.spec.ts` — 4 tests: confirm dialog, input dialog, toast notification
- `projects.spec.ts` — 3 tests: sidebar projects, search filter, runtime dots
- `connectivity.spec.ts` — 9 tests: connected state, disconnect banner, reconnection, auto-reconnect, tooltip, server restart overlay, visibility change
- `server-smoke.spec.ts` — 4 tests against real server (no mock): /login 200, 404, /ws 401, login page HTML
- `visual-review.spec.ts` — screenshot-based visual regression tests for extension components
- `file-viewer.spec.ts` — 1 test: file link modal with WS read_file/file_content flow

### Common Test Fixes

**`text=password` strict mode violation:** The login page has both a `<label>password</label>` and a `<span>PI_PASSWORD</span>` hint. Use `getByText('password', { exact: true })` instead of `locator('text=password')`.

**Duplicate inline login in test bodies:** Tests that use the `login` fixture in `beforeEach` should NOT re-do the login in the test body. The auth cookie persists — just `page.goto('/')` to trigger a fresh WS connection with a custom handler.

## Layer 3 — CI (GitHub Actions)

- **Trigger**: push or PR to `main`
- **Runtime**: Bun 1.2 (`oven-sh/setup-bun`)
- **Steps**: checkout → `bun install --frozen-lockfile` → `build` → `build:server` → `check` (svelte-check) → `check:server` (tsc) → `lint` (eslint) → `test:unit` (vitest run) → `test:e2e` (playwright test)
