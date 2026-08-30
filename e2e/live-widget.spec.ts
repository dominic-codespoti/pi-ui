import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Live above-editor widget spec — NO routeWebSocket.
 *
 * Exercises the REAL server widget pipeline that mocked specs skip:
 * extension file → jiti load via /reload → ctx.ui.setWidget factory →
 * tickWidgetFactory (250 ms ticks, 5-failure teardown) → broadcast →
 * client aboveEditor strip.
 *
 * The fixture extension reads `ctx.ui.theme` inside its factory render — the
 * pattern real extensions (pi-task, rpiv-todo) use. When ctx.ui.theme was
 * `undefined` the first render threw and the widget was silently torn down
 * ~1.2 s later; this spec fails if that regresses.
 */

const AGENT_DIR = '/tmp/pi-ui-e2e-agent';
const WIDGET_TIMEOUT = 120_000;

interface WsTapWindow {
  __wsLog?: string[];
}

/** Passive WS tap — records server⇄client traffic for failure diagnostics. */
async function tapWs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class Patched extends WebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        const stamp = (entry: string) => {
          const log = ((window as unknown as WsTapWindow).__wsLog ??= []);
          log.push(entry);
        };
        this.addEventListener('message', (e) => stamp(`< ${String(e.data)}`));
        const origSend = this.send.bind(this);
        this.send = (data) => {
          stamp(`> ${String(data)}`);
          return origSend(data);
        };
      }
    }
    window.WebSocket = Patched;
  });
}

async function dumpWs(page: Page): Promise<void> {
  const tail = await page.evaluate(() =>
    ((window as unknown as WsTapWindow).__wsLog ?? []).join('\n')
  );
  console.log(`[live-widget] WS timeline:\n${tail}`);
}

const EXTENSION_SOURCE = `
interface ThemeLike {
  fg?(color: string, text: string): string;
}
interface WidgetComponent {
  render(width: number): string[];
  invalidate?(): void;
}
interface UiLike {
  setWidget(key: string, content: unknown, options?: { placement?: string }): void;
  readonly theme: ThemeLike;
}
interface CtxLike {
  ui: UiLike;
}
interface PiLike {
  registerCommand(
    name: string,
    cmd: { description: string; handler: (args: string, ctx: CtxLike) => void }
  ): void;
}

export default function widgetTestExtension(pi: PiLike): void {
  pi.registerCommand('wtest', {
    description: 'Render above-editor widgets (pi-ui e2e)',
    handler: (_args, ctx) => {
      // Captured at command time, like pi-task/rpiv-todo capture ctx.ui.theme.
      const ctxTheme: ThemeLike = ctx.ui.theme;
      ctx.ui.setWidget(
        'wtest-ctxtheme',
        (_tui: unknown, _theme: ThemeLike): WidgetComponent => {
          let n = 0;
          // No fallback: this widget must hard-fail when ctx.ui.theme is
          // undefined — that is the regression this spec guards.
          const t: ThemeLike = ctxTheme;
          return {
            render: () => ['ctx: widget-live-ctx ' + ++n],
            invalidate: () => {},
          };
        },
        { placement: 'aboveEditor' }
      );
      ctx.ui.setWidget(
        'wtest-argtheme',
        (_tui: unknown, theme: ThemeLike): WidgetComponent => {
          let n = 0;
          return {
            render: () => ['arg: widget-live-arg ' + ++n],
            invalidate: () => {},
          };
        },
        { placement: 'aboveEditor' }
      );
    },
  });
}
`;

async function waitForReady(page: Page): Promise<void> {
  await expect(page.locator('textarea')).toBeEditable({ timeout: WIDGET_TIMEOUT });
}

async function sendSlash(page: Page, text: string): Promise<void> {
  await page.fill('textarea', text);
  await page.click('button[aria-label="Send message"]');
}

test.describe('Live above-editor widgets', () => {
  test.setTimeout(240_000);

  test.beforeEach(async () => {
    // The server loads global extensions from AGENT_DIR/extensions on /reload.
    mkdirSync(`${AGENT_DIR}/extensions`, { recursive: true });
    writeFileSync(`${AGENT_DIR}/extensions/pi-ui-widget-test.ts`, EXTENSION_SOURCE);
  });

  test('ctx.ui.theme-driven factory widgets render and survive the teardown window', async ({
    page,
    login,
  }) => {
    await tapWs(page);
    try {
      await login(page);
      await waitForReady(page);
      // WS-open ≠ session-ready: /reload hits activeSession() and throws
      // 'No active session' if the lazy SDK session is still initializing.
      await sendSlash(page, '/new');
      await waitForReady(page);
      await sendSlash(page, '/reload');
      await expect(page.getByText(/Reloaded extensions/i)).toBeVisible({
        timeout: WIDGET_TIMEOUT,
      });
      await sendSlash(page, '/wtest');

      // Both widgets appear…
      const ctxWidget = page.getByText(/widget-live-ctx \d+/);
      const argWidget = page.getByText(/widget-live-arg \d+/);
      await expect(ctxWidget.first()).toBeVisible({ timeout: 15_000 });
      await expect(argWidget.first()).toBeVisible({ timeout: 15_000 });

      // …and are STILL visible past the 5×250 ms failure-teardown window —
      // a factory that throws on every tick disappears within ~1.5 s. Tick
      // output is change-detected server-side, so a stateless factory re-
      // rendering identical lines correctly stays put without content churn.
      await page.waitForTimeout(2_000);
      await expect(ctxWidget.first()).toBeVisible();
      await expect(argWidget.first()).toBeVisible();
    } catch (err) {
      await dumpWs(page);
      throw err;
    }
  });
});
