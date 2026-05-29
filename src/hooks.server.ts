import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { verifySessionToken, getTokenFromCookies, COOKIE_NAME } from '$lib/auth/password';

const PUBLIC_PATHS = ['/login'];

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return resolve(event);
  }

  const cookie = event.request.headers.get('cookie') ?? '';
  const token = getTokenFromCookies(cookie);

  if (!token || !(await verifySessionToken(token))) {
    redirect(302, '/login');
  }

  return resolve(event);
};
