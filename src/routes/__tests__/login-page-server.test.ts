import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fail, redirect } from '@sveltejs/kit';

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
import { checkRateLimit, recordFailure, clearRecord, getClientIp } from '$lib/auth/rate-limiter';

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
}) {
  const formData = new FormData();
  if (options.password !== undefined) formData.append('password', options.password);
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
      url: options.host
        ? `https://${options.host}/login`
        : 'http://localhost/login',
    } as unknown as Request,
    cookies: {
      get: vi.fn(),
      set: vi.fn(),
    },
    getClientAddress: () => options.ip ?? '127.0.0.1',
  };
}

describe('login page load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to / when valid token exists', async () => {
    vi.mocked(verifySessionToken).mockResolvedValue(true);
    const load = await getLoad();
    const ctx = { cookies: { get: vi.fn().mockReturnValue('valid-token') } } as any;
    try {
      await load(ctx);
      expect.unreachable('should have redirected');
    } catch (e: any) {
      expect(e.status).toBe(302);
      expect(e.location).toBe('/');
    }
  });

  it('does not redirect when token is absent', async () => {
    const load = await getLoad();
    const ctx = { cookies: { get: vi.fn().mockReturnValue(null) } } as any;
    const result = await load(ctx);
    expect(result).toBeUndefined();
  });

  it('does not redirect for expired tokens', async () => {
    vi.mocked(verifySessionToken).mockResolvedValue(false);
    const load = await getLoad();
    const ctx = { cookies: { get: vi.fn().mockReturnValue('stale-token') } } as any;
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
    const result = await actions(ctx);
    expect(result.status).toBe(400);
  });

  it('returns 403 on origin mismatch', async () => {
    const actions = await getActions();
    const ctx = mockRequest({ password: 'secret', origin: 'http://evil.com', host: 'localhost' });
    const result = await actions(ctx);
    expect(result.status).toBe(403);
  });

  it('returns 401 on wrong password', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false);
    vi.mocked(recordFailure).mockReturnValue({ blocked: false, remaining: 4, retryAfterSecs: null });
    const actions = await getActions();
    const ctx = mockRequest({ password: 'wrong', origin: 'http://localhost', host: 'localhost' });
    const result = await actions(ctx);
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
    } catch (e: any) {
      expect(e.status).toBe(302);
      expect(e.location).toBe('/');
      expect(ctx.cookies.set).toHaveBeenCalledWith(
        'pi-session',
        'new-token',
        expect.objectContaining({ httpOnly: true, sameSite: 'strict' })
      );
    }
  });

  it('blocks when rate limit exceeded', async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ blocked: true, remaining: 0, retryAfterSecs: 300 });
    const actions = await getActions();
    const ctx = mockRequest({ password: 'any', origin: 'http://localhost', host: 'localhost' });
    const result = await actions(ctx);
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
    } catch (e: any) {
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
