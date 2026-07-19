/**
 * Visual review — screenshots of all new extension component features.
 *
 * Bypasses CSRF by generating a valid session JWT server-side and
 * injecting it as a cookie before navigating to the main page.
 *
 * Run: npx playwright test e2e/visual-review.spec.ts --project=chromium
 */
import { test } from '@playwright/test';
import { execSync } from 'child_process';

const BASE_WS = {
  type: 'connected',
  sessionId: 's1',
  isStreaming: false,
  thinkingLevel: 'medium',
  model: null,
  availableModels: [],
  messages: [],
};

type WsHandle = { send(msg: string): void };

function sendInit(ws: WsHandle) {
  ws.send(JSON.stringify(BASE_WS));
  ws.send(JSON.stringify({ type: 'projects_list', projects: [] }));
  ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
}

/** Generate a valid session JWT by importing the server's auth code. */
function generateSessionToken(): string {
  const token = execSync(
    'PI_PASSWORD=test-password bun -e "import { createSessionToken } from \'./src/lib/auth/password.ts\'; console.log(await createSessionToken())"',
    { cwd: process.cwd(), encoding: 'utf-8', timeout: 10_000 },
  ).trim();
  return token;
}

/** Inject a valid session cookie into the browser context and navigate to /. */
async function loginViaCookie(page: import('@playwright/test').Page) {
  const token = generateSessionToken();
  await page.context().addCookies([{
    name: 'pi-session',
    value: token,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  }]);
  await page.goto('/');
}

test.describe('Extension component visual review', () => {
  test('screenshot all features', async ({ page }) => {
    // ── 1. Clean state ────────────────────────────────────────────────────
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      sendInit(ws);
    });
    await loginViaCookie(page);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/01-clean-state.png', fullPage: true });

    // ── 2. ProgressBar widget ─────────────────────────────────────────────
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      sendInit(ws);
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'extension_ui_request', id: 'pw-progress', method: 'setWidget',
          widgetKey: 'pw-progress', widgetType: 'component',
          widgetComponent: { kind: 'progress', label: 'Building extension…', progress: 0.65 },
        }));
      }, 500);
    });
    await page.goto('/');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/02-progress-widget.png', fullPage: true });

    // ── 3. Loader widget ──────────────────────────────────────────────────
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      sendInit(ws);
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'extension_ui_request', id: 'pw-loader', method: 'setWidget',
          widgetKey: 'pw-loader', widgetType: 'component',
          widgetComponent: { kind: 'loader', label: 'Fetching packages…' },
        }));
      }, 500);
    });
    await page.goto('/');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/03-loader-widget.png', fullPage: true });

    // ── 4. Container widget with children ──────────────────────────────────
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      sendInit(ws);
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'extension_ui_request', id: 'pw-container', method: 'setWidget',
          widgetKey: 'pw-container', widgetType: 'component',
          widgetComponent: {
            kind: 'container', direction: 'vertical',
            children: [
              { kind: 'text', label: '', content: 'OMP v3.2 — 12 extensions loaded' },
              { kind: 'button', label: 'Reload', variant: 'primary' },
              { kind: 'checkbox', label: 'Auto-update enabled', checked: true },
            ],
          },
        }));
      }, 500);
    });
    await page.goto('/');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/04-container-widget.png', fullPage: true });

    // ── 5. Multiple widgets (component + text + badge mixed) ──────────────
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      sendInit(ws);
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'extension_ui_request', id: 'pw-m1', method: 'setWidget',
          widgetKey: 'pw-multi-progress', widgetType: 'component',
          widgetComponent: { kind: 'progress', label: 'Deploying…', progress: 0.9 },
        }));
        ws.send(JSON.stringify({
          type: 'extension_ui_request', id: 'pw-m2', method: 'setWidget',
          widgetKey: 'pw-multi-status', widgetType: 'component',
          widgetComponent: { kind: 'text', label: '', content: 'Build: passing | Tests: 42/42' },
        }));
        ws.send(JSON.stringify({
          type: 'extension_ui_request', id: 'pw-m3', method: 'setWidget',
          widgetKey: 'pw-multi-badge', widgetType: 'badge',
          widgetData: { text: 'v3.2.1', variant: 'success' },
        }));
      }, 500);
    });
    await page.goto('/');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/05-multiple-widgets.png', fullPage: true });

    // ── 6. Custom modal with select ───────────────────────────────────────
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify({
            type: 'extension_ui_request', id: 'pw-modal-select', method: 'custom',
            title: 'Choose Extension',
            parsed: {
              kind: 'select', label: 'Select an extension to configure:',
              options: [
                { value: 'omp', label: 'OMP — Open Memory Protocol', description: 'Manages extension memory' },
                { value: 'git', label: 'Git Helper', description: 'Git operations assistant' },
                { value: 'test', label: 'Test Runner', description: 'Run and debug tests' },
              ],
            },
          }));
        }
      });
      sendInit(ws);
    });
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.fill('textarea', 'Configure extension');
    await page.press('textarea', 'Enter');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/06-modal-select.png', fullPage: true });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // ── 7. Custom modal with container tree ────────────────────────────────
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify({
            type: 'extension_ui_request', id: 'pw-modal-container', method: 'custom',
            title: 'Extension Dashboard',
            parsed: {
              kind: 'container', direction: 'vertical',
              children: [
                { kind: 'text', label: '', content: 'Extension Dashboard v1.0' },
                { kind: 'progress', label: 'Syncing data…', progress: 0.8 },
                { kind: 'container', direction: 'horizontal', children: [
                  { kind: 'button', label: 'Refresh', variant: 'primary' },
                  { kind: 'button', label: 'Settings' },
                ]},
                { kind: 'checkbox', label: 'Enable notifications', checked: false },
              ],
            },
          }));
        }
      });
      sendInit(ws);
    });
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.fill('textarea', 'Open dashboard');
    await page.press('textarea', 'Enter');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/07-modal-container.png', fullPage: true });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // ── 8. Warning toast ──────────────────────────────────────────────────
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify({
            type: 'extension_event', source: 'omp', event: 'quota_low',
            level: 'warning', message: 'Only 3 requests remaining',
          }));
        }
      });
      sendInit(ws);
    });
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.fill('textarea', 'Trigger warning');
    await page.press('textarea', 'Enter');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/08-warning-toast.png', fullPage: true });

    // ── 9. Error toast ───────────────────────────────────────────────────
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'prompt') {
          ws.send(JSON.stringify({
            type: 'extension_event', source: 'git-helper', event: 'push_failed',
            level: 'error', message: 'Permission denied: push to main',
          }));
        }
      });
      sendInit(ws);
    });
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.fill('textarea', 'Trigger error');
    await page.press('textarea', 'Enter');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/09-error-toast.png', fullPage: true });
  });
});
