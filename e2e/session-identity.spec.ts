import { test, expect } from './fixtures';

/**
 * Device session identity — the localStorage-backed "last session I was
 * looking at" pointer that a PWA cold relaunch (no `?session=` URL param,
 * since the manifest `start_url` always resets to "/") uses to resume the
 * right conversation instead of passively accepting whatever session the
 * server happens to default to.
 */

const IDENTITY_KEY = 'pi-ui-last-session-id';
const REMEMBERED_PATH = '/home/user/project-a/remembered.jsonl';
const SERVER_DEFAULT_PATH = '/home/user/project-a/server-default.jsonl';

function connectedPayload(sessionId: string, sessionPath: string) {
  return {
    type: 'connected',
    sessionId,
    sessionPath,
    isStreaming: false,
    thinkingLevel: 'medium',
    model: null,
    availableModels: [],
    messages: [],
    cwd: '/home/user/project-a',
  };
}

test.describe('Device session identity', () => {
  test('resumes the remembered session on a fresh connect with no URL param', async ({
    page,
    login,
  }) => {
    await page.addInitScript(
      ([key, path]) => {
        localStorage.setItem(
          key,
          JSON.stringify({ v: 1, path, id: 'remembered-id', updatedAt: Date.now() })
        );
      },
      [IDENTITY_KEY, REMEMBERED_PATH] as const
    );
    await login(page, 'test-password');

    const switchRequests: string[] = [];
    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'switch_session') {
          switchRequests.push(msg.path);
          ws.send(
            JSON.stringify({
              type: 'session_loaded',
              sessionId: 'remembered-id',
              sessionPath: REMEMBERED_PATH,
              isStreaming: false,
              thinkingLevel: 'medium',
              model: null,
              availableModels: [],
              messages: [],
              cwd: '/home/user/project-a',
              requestId: msg.requestId,
            })
          );
        }
      });
      // Server defaults to a different session than the one this device remembers.
      ws.send(JSON.stringify(connectedPayload('server-default-id', SERVER_DEFAULT_PATH)));
    });

    await page.goto('/');

    await expect.poll(() => switchRequests).toEqual([REMEMBERED_PATH]);
    await expect(page).toHaveURL(/session=%2Fhome%2Fuser%2Fproject-a%2Fremembered\.jsonl/);
  });

  test('adopts the server default and persists it when nothing is remembered', async ({
    page,
    login,
  }) => {
    await login(page, 'test-password');

    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(connectedPayload('server-default-id', SERVER_DEFAULT_PATH)));
    });

    await page.goto('/');

    await expect(page).toHaveURL(/session=%2Fhome%2Fuser%2Fproject-a%2Fserver-default\.jsonl/);
    const stored = await page.evaluate((key) => localStorage.getItem(key), IDENTITY_KEY);
    expect(JSON.parse(stored!)).toMatchObject({
      path: SERVER_DEFAULT_PATH,
      id: 'server-default-id',
    });
  });

  test('silently corrects a stale identity instead of erroring on cold boot', async ({
    page,
    login,
  }) => {
    await page.addInitScript(
      ([key, path]) => {
        localStorage.setItem(
          key,
          JSON.stringify({ v: 1, path, id: 'deleted-id', updatedAt: Date.now() })
        );
      },
      [IDENTITY_KEY, '/home/user/project-a/deleted.jsonl'] as const
    );
    await login(page, 'test-password');

    await page.routeWebSocket('/ws', (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'switch_session') {
          ws.send(
            JSON.stringify({
              type: 'sessions_error',
              requestId: msg.requestId,
              message: 'Session not found.',
            })
          );
        }
      });
      ws.send(JSON.stringify(connectedPayload('server-default-id', SERVER_DEFAULT_PATH)));
    });

    await page.goto('/');

    // The server's already-active session stays on screen — no disruptive
    // error toast for a resume attempt the user never initiated. The
    // optimistic ?session= param reverts to what it was before the attempt
    // (nothing, on a cold boot) — the localStorage identity is the pointer
    // that gets corrected, not left blank (a blank pointer would just
    // repeat the same guess after a restart).
    await expect.poll(() => new URL(page.url()).searchParams.has('session')).toBe(false);
    await expect(page.getByText('Session not found.')).not.toBeVisible();
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw).path : null;
        }, IDENTITY_KEY)
      )
      .toBe(SERVER_DEFAULT_PATH);
  });
});
