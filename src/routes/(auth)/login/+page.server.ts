import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  verifyPassword, verifySessionToken, createSessionToken, COOKIE_NAME,
} from '$lib/auth/password';
import { checkRateLimit, recordFailure, clearRecord, getClientIp } from '$lib/auth/rate-limiter';

/** Detect if we're behind a reverse proxy (Cloudflare Tunnel, nginx, etc.). */
function isBehindProxy(request: Request): boolean {
  return !!(
    request.headers.get('x-forwarded-proto') ||
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')
  );
}

/** Cookie options shared by auth session writes. */
function cookieOpts(request: Request): { path: string; httpOnly: boolean; sameSite: 'strict'; secure: boolean; maxAge: number } {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    // Secure when behind a TLS-terminating proxy (Cloudflare Tunnel) or when
    // the request itself is HTTPS. Only false for bare-HTTP local dev.
    secure: isBehindProxy(request) || request.url.startsWith('https'),
    maxAge: 60 * 60 * 24, // 24h — matches JWT expiry
  };
}

export const load: PageServerLoad = async ({ cookies }) => {
  const token = cookies.get(COOKIE_NAME);
  // Only redirect to / if the token is actually valid — avoids infinite redirect
  // loops when a stale/expired cookie exists but hooks rejects it.
  if (token && (await verifySessionToken(token))) {
    redirect(302, '/');
  }
};

export const actions: Actions = {
  default: async ({ request, cookies, getClientAddress }) => {
    const ip = getClientIp(request, getClientAddress());

    // ── CSRF origin check ─────────────────────────────────────────────────
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          return fail(403, { error: 'Origin mismatch — request blocked.' });
        }
      } catch {
        return fail(403, { error: 'Invalid origin header.' });
      }
    }

    // ── Rate limit ────────────────────────────────────────────────────────
    const rl = checkRateLimit(ip);
    if (rl.blocked) {
      const mins = Math.ceil((rl.retryAfterSecs ?? 0) / 60);
      return fail(429, {
        error: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`,
      });
    }

    const data = await request.formData();
    const password = data.get('password');

    if (typeof password !== 'string' || !password) {
      return fail(400, { error: 'Password required' });
    }

    const valid = await verifyPassword(password);
    if (!valid) {
      const after = recordFailure(ip);
      if (after.blocked) {
        const mins = Math.ceil((after.retryAfterSecs ?? 0) / 60);
        return fail(429, {
          error: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`,
        });
      }
      const hint = after.remaining === 1 ? ' (1 attempt left)' : after.remaining <= 3 ? ` (${after.remaining} attempts left)` : '';
      return fail(401, { error: `Incorrect password${hint}` });
    }

    clearRecord(ip);

    const token = await createSessionToken();
    cookies.set(COOKIE_NAME, token, cookieOpts(request));

    redirect(302, '/');
  },
};
