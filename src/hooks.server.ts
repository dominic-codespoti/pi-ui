import { dev } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { verifySessionToken, getTokenFromCookies } from '$lib/auth/password';

const PUBLIC_PATHS = new Set(['/login']);

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname, search } = event.url;

  if (PUBLIC_PATHS.has(pathname) || (dev && pathname.startsWith('/dev'))) {
    return resolve(event);
  }

  const cookie = event.request.headers.get('cookie') ?? '';
  const token = getTokenFromCookies(cookie);

  if (!token || !(await verifySessionToken(token))) {
    // Preserve the original URL so login can redirect back after auth.
    const redirectTo = pathname + search;
    redirect(302, `/login?redirect=${encodeURIComponent(redirectTo)}`);
  }

  return resolve(event);
};
