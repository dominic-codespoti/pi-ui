import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { verifySessionToken, getTokenFromCookies } from '$lib/auth/password';

const PUBLIC_PATHS = new Set(['/login']);

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;

  // Exact match only — prevents /loginXSS or /login-admin from bypassing auth.
  if (PUBLIC_PATHS.has(pathname)) {
    return resolve(event);
  }

  const cookie = event.request.headers.get('cookie') ?? '';
  const token = getTokenFromCookies(cookie);

  if (!token || !(await verifySessionToken(token))) {
    redirect(302, '/login');
  }

  return resolve(event);
};
