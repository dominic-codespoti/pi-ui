import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { verifyPassword, verifySessionToken, createSessionToken, COOKIE_NAME } from '$lib/auth/password';
import { checkRateLimit, recordFailure, clearRecord } from '$lib/auth/rate-limiter';

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
    const ip = getClientAddress();

    // Check rate limit before doing any work
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
    cookies.set(COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      // Set secure: true in production behind HTTPS
      secure: false,
      maxAge: 60 * 60 * 24 * 7,
    });

    redirect(302, '/');
  },
};
