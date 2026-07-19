---
name: ui-testing
description: Playwright-based visual testing and screenshot review for pi-ui extension components. Use when testing UI rendering of extension widgets, modals, toasts, or any visual feature via mocked WebSocket payloads. Leverages project fixtures and payload factories.
---

# UI Testing Skill — Playwright Visual Review

Systematic approach to visually test and screenshot UI features using Playwright
with mock WebSocket payloads. Uses project-standard fixtures and payload factories.

## Architecture

- **`e2e/fixtures.ts`**: Provides `mockWs` (auto-replies to init) and `login` fixtures.
- **`e2e/mocks/payloads.ts`**: Factory functions for every server→client message type.
- **`e2e/screenshots/`**: Output directory (gitignored).

## Prerequisites

- Playwright installed (`npx playwright --version`)
- Server builds with `bun run build`
- Playwright config at `playwright.config.ts` with `webServer` section

## Standard Pattern: Writing a Visual Review Test

### 1. Setup fixtures and payloads

```ts
import { test, expect } from '../fixtures';
import { CONNECTED_PAYLOAD, extensionSetWidgetPayload } from './mocks/payloads';
```

### 2. Login

Use the standard `login` fixture from `e2e/fixtures.ts`:

```ts
test('screenshot features', async ({ page, login }) => {
  await login(page);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'e2e/screenshots/01-clean.png', fullPage: true });
});
```

### 3. Mocking WebSocket and Pushing Payloads

To test extension widgets, re-route the WS to inject payloads:

```ts
test('widget screenshot', async ({ page, login }) => {
  // Re-route WS to inject a custom payload
  await page.routeWebSocket('/ws', (ws) => {
    ws.onMessage(() => {});
    ws.send(JSON.stringify(CONNECTED_PAYLOAD));
    
    setTimeout(() => {
      ws.send(JSON.stringify(extensionSetWidgetPayload('test', { kind: 'progress', label: 'Loading…', progress: 0.5 })));
    }, 500);
  });
  
  // Navigate to pick up the new route
  await login(page);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'e2e/screenshots/02-widget.png', fullPage: true });
});
```

## Key Techniques

### Re-routing WS mid-test

To test multiple features in one test, re-route the WS between screenshots. Navigate away and back to pick up the new route.

### Triggering modals

Modals require a user prompt. Use `page.fill` and `page.press` to send a message, then the mock responds:

```ts
await page.fill('textarea', 'trigger');
await page.press('textarea', 'Enter');
await page.waitForTimeout(1000);
```

### Using Payload Factories

Always use factories from `e2e/mocks/payloads.ts` instead of hardcoding JSON:

- `extensionConfirmPayload(id, title, message)`
- `extensionInputPayload(id, title, placeholder)`
- `extensionNotifyPayload(message, notifyType)`
- `textDeltaPayload(text)` / `thinkingDeltaPayload(text)`

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `chrome-error://chromewebdata/` | Login POST blocked by CSRF | Use `login` fixture or `loginViaCookie()` |
| `page.routeWebSocket timed out` | WS not connected | Ensure mock sends `CONNECTED_PAYLOAD` |
| Screenshot blank | Page not loaded | Add `await page.waitForTimeout(1000)` after `goto` |
