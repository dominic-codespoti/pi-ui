import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent, ServerLoadEvent } from '@sveltejs/kit';

/** Event types pinned to the login route id so they satisfy the generated $types. */
type LoginLoadEvent = ServerLoadEvent<Record<string, never>, Record<string, never>, '/(auth)/login'>;
type LoginRequestEvent = RequestEvent<Record<string, never>, '/(auth)/login'>;

vi.mock('$lib/auth/password', () => ({
  verifyPassword: vi.fn(),
  verifySessionToken: vi.fn(),
  createSessionToken: vi.fn(),
  COOKIE_NAME: 'pi-session',
}));

vi.mock('$lib/auth/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
  recordFailure: vi.fn(),
  clearRecord: vi.fn(),
  getClientIp: vi.fn(),
}));

import { verifyPassword, verifySessionToken, createSessionToken } from '$lib/auth/password';
import { checkRateLimit, recordFailure, getClientIp } from '$lib/auth/rate-limiter';

async function getLoad() {
  const mod = await import('../(auth)/login/+page.server');
  return mod.load;
}

async function getActions() {
  const mod = await import('../(auth)/login/+page.server');
  return mod.actions.default;
}

function mockRequest(options: {
  method?: string;
  password?: string;
  origin?: string;
  host?: string;
  ip?: string;
  redirect?: string;
}) {
  const formData = new FormData();
  if (options.password !== undefined) formData.append('password', options.password);
  const proto = options.host?.includes('example.com') ? 'https' : 'http';
  const base = options.host ? `${proto}://${options.host}/login` : 'http://localhost/login';
  const urlStr = options.redirect ? `${base}?redirect=${encodeURIComponent(options.redirect)}` : base;
  return {
    request: {
      method: options.method ?? 'POST',
      headers: new Map(
        Object.entries({
          ...(options.origin ? { origin: options.origin } : {}),
          ...(options.host ? { host: options.host } : {}),
        })
      ),
      formData: () => Promise.resolve(formData),
      url: urlStr,
    } as unknown as Request,
    url: new URL(urlStr),
    cookies: {
      get: vi.fn(),
      set: vi.fn(),
    },
    getClientAddress: () => options.ip ?? '127.0.0.1',
    fetch: vi.fn(),
    locals: {},
    params: {},
    platform: undefined,
    isDataRequest: false,
    isSubRequest: false,
    route: { id: '/(auth)/login' },
  } as unknown as LoginRequestEvent;
}

describe('login page load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to / when valid token exists', async () => {
    vi.mocked(verifySessionToken).mockResolvedValue(true);
    const load = await getLoad();
    const ctx = { cookies: { get: vi.fn().mockReturnValue('valid-token') }, url: new URL('http://localhost/login') } as unknown as LoginLoadEvent;
    try {
      await load(ctx);
      expect.unreachable('should have redirected');
    } catch (err) {
      const e = err as { status: number; location: string };
      expect(e.status).toBe(302);
      expect(e.location).toBe('/');
    }
  });

  it('redirects to redirect param when valid token exists', async () => {
    vi.mocked(verifySessionToken).mockResolvedValue(true);
    const load = await getLoad();
    const ctx = { cookies: { get: vi.fn().mockReturnValue('valid-token') }, url: new URL('http://localhost/login?redirect=%2F%3Ffoo%3Dbar') } as unknown as LoginLoadEvent;
    try {
      await load(ctx);
      expect.unreachable('should have redirected');
    } catch (err) {
      const e = err as { status: number; location: string };
      expect(e.status).toBe(302);
      expect(e.location).toBe('/?foo=bar');
    }
  });

  it('does not redirect when token is absent', async () => {
    const load = await getLoad();
    const ctx = { cookies: { get: vi.fn().mockReturnValue(null) }, url: new URL('http://localhost/login') } as unknown as LoginLoadEvent;
    const result = await load(ctx);
    expect(result).toBeUndefined();
  });

  it('does not redirect for expired tokens', async () => {
    vi.mocked(verifySessionToken).mockResolvedValue(false);
    const load = await getLoad();
    const ctx = { cookies: { get: vi.fn().mockReturnValue('stale-token') }, url: new URL('http://localhost/login') } as unknown as LoginLoadEvent;
    const result = await load(ctx);
    expect(result).toBeUndefined();
  });
});

describe('login actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClientIp).mockReturnValue('127.0.0.1');
    vi.mocked(checkRateLimit).mockReturnValue({ blocked: false, remaining: 5, retryAfterSecs: null });
  });

  it('returns 400 when password is missing', async () => {
    const actions = await getActions();
    const ctx = mockRequest({ password: '' });
    const result = await actions(ctx) as { status: number };
    expect(result.status).toBe(400);
  });

  it('returns 403 on origin mismatch', async () => {
    const actions = await getActions();
    const ctx = mockRequest({ password: 'secret', origin: 'http://evil.com', host: 'localhost' });
    const result = await actions(ctx) as { status: number };
    expect(result.status).toBe(403);
  });

  it('returns 401 on wrong password', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false);
    vi.mocked(recordFailure).mockReturnValue({ blocked: false, remaining: 4, retryAfterSecs: null });
    const actions = await getActions();
    const ctx = mockRequest({ password: 'wrong', origin: 'http://localhost', host: 'localhost' });
    const result = await actions(ctx) as { status: number };
    expect(result.status).toBe(401);
  });

  it('sets cookie and redirects on success', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(createSessionToken).mockResolvedValue('new-token');
    const actions = await getActions();
    const ctx = mockRequest({ password: 'correct', origin: 'http://localhost', host: 'localhost' });
    try {
      await actions(ctx);
      expect.unreachable('should have redirected');
    } catch (err) {
      const e = err as { status: number; location: string };
      expect(e.status).toBe(302);
      expect(e.location).toBe('/');
      expect(ctx.cookies.set).toHaveBeenCalledWith(
        'pi-session',
        'new-token',
        expect.objectContaining({ httpOnly: true, sameSite: 'strict' })
      );
    }
  });

  it('preserves redirect param on successful login', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(createSessionToken).mockResolvedValue('t');
    const actions = await getActions();
    const ctx = mockRequest({ password: 'correct', origin: 'http://localhost', host: 'localhost', redirect: '/?foo=bar' });
    try {
      await actions(ctx);
      expect.unreachable('should have redirected');
    } catch (err) {
      const e = err as { status: number; location: string };
      expect(e.status).toBe(302);
      expect(e.location).toBe('/?foo=bar');
    }
  });

  it('blocks when rate limit exceeded', async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ blocked: true, remaining: 0, retryAfterSecs: 300 });
    const actions = await getActions();
    const ctx = mockRequest({ password: 'any', origin: 'http://localhost', host: 'localhost' });
    const result = await actions(ctx) as { status: number };
    expect(result.status).toBe(429);
  });

  it('uses x-forwarded-for when behind proxy', async () => {
    vi.mocked(getClientIp).mockReturnValue('203.0.113.5');
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(createSessionToken).mockResolvedValue('t');
    const actions = await getActions();
    const ctx = mockRequest({ password: 'correct', origin: 'https://example.com', host: 'example.com', ip: '203.0.113.5' });
    try {
      await actions(ctx);
    } catch (err) {
      const e = err as { status: number };
      expect(getClientIp).toHaveBeenCalled();
      expect(e.status).toBe(302);
    }
    expect(ctx.cookies.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ secure: true })
    );
  });
});
