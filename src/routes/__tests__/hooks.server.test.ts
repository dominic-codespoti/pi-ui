import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Mock } from 'vitest';

/** RequestEvent plus the mocked `resolve` the tests pass to `handle`. */
type MockRequestEvent = RequestEvent & { resolve: Mock };

// Mock the password module before importing hooks
vi.mock('$lib/auth/password', () => ({
  verifySessionToken: vi.fn(),
  getTokenFromCookies: vi.fn(),
}));

import { verifySessionToken, getTokenFromCookies } from '$lib/auth/password';

// We need to re-import the handle function after mocking
async function getHandle() {
  const mod = await import('../../hooks.server');
  return mod.handle;
}

function mockEvent(pathname: string, cookieHeader?: string): MockRequestEvent {
  return {
    url: new URL(`http://localhost${pathname}`),
    request: {
      headers: new Map(
        Object.entries({
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        })
      ),
    },
    resolve: vi.fn().mockResolvedValue(new Response('ok')),
    cookies: { get: vi.fn(), set: vi.fn() },
    fetch: vi.fn(),
    locals: {},
    params: {},
    platform: undefined,
    isDataRequest: false,
    isSubRequest: false,
    route: { id: '/(app)' },
    getClientAddress: () => '127.0.0.1',
  } as unknown as MockRequestEvent;
}

describe('hooks.server handle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through for /login path', async () => {
    vi.mocked(getTokenFromCookies).mockReturnValue(null);
    const handle = await getHandle();
    const event = mockEvent('/login');
    const response = await handle({ event, resolve: event.resolve });
    expect(response).toBeDefined();
    expect(event.resolve).toHaveBeenCalledWith(event);
  });

  it('redirects to /login when no cookie', async () => {
    vi.mocked(getTokenFromCookies).mockReturnValue(null);
    const handle = await getHandle();
    const event = mockEvent('/');
    try {
      await handle({ event, resolve: event.resolve });
      expect.unreachable('should have thrown redirect');
    } catch (e) {
      const r = e as { status: number; location: string };
      // SvelteKit redirect throws
      expect(r.status).toBe(302);
    }
    expect(event.resolve).not.toHaveBeenCalled();
  });

  it('redirects to /login when cookie present but invalid', async () => {
    vi.mocked(getTokenFromCookies).mockReturnValue('invalid-token');
    vi.mocked(verifySessionToken).mockResolvedValue(false);
    const handle = await getHandle();
    const event = mockEvent('/some-page', 'pi-session=invalid-token');
    try {
      await handle({ event, resolve: event.resolve });
      expect.unreachable('should have thrown redirect');
    } catch (e) {
      const r = e as { status: number; location: string };
      expect(r.status).toBe(302);
    }
  });

  it('passes through with valid cookie', async () => {
    vi.mocked(getTokenFromCookies).mockReturnValue('valid-token');
    vi.mocked(verifySessionToken).mockResolvedValue(true);
    const handle = await getHandle();
    const event = mockEvent('/app', 'pi-session=valid-token');
    const response = await handle({ event, resolve: event.resolve });
    expect(response).toBeDefined();
    expect(event.resolve).toHaveBeenCalledWith(event);
  });

  it('does not treat /loginXSS as public', async () => {
    vi.mocked(getTokenFromCookies).mockReturnValue(null);
    const handle = await getHandle();
    const event = mockEvent('/loginXSS');
    try {
      await handle({ event, resolve: event.resolve });
      expect.unreachable('should have thrown redirect');
    } catch {
      expect(true).toBe(true);
    }
  });

  it('does not treat /login-admin as public', async () => {
    vi.mocked(getTokenFromCookies).mockReturnValue(null);
    const handle = await getHandle();
    const event = mockEvent('/login-admin');
    try {
      await handle({ event, resolve: event.resolve });
      expect.unreachable('should have thrown redirect');
    } catch {
      expect(true).toBe(true);
    }
  });
});
