import { redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import {
  COOKIE_NAME,
  extractJti,
  extractTokenExp,
  getTokenFromCookies,
  revokeToken,
} from '$lib/auth/password';

/**
 * Sign out: revoke the session token in-memory and clear the cookie.
 *
 * The session cookie is SameSite=strict, so forged cross-site requests never
 * carry it — a cookie-less GET here simply redirects to /login.
 */
export const GET = async ({ cookies, request }: RequestEvent) => {
  const token = getTokenFromCookies(request.headers.get('cookie') ?? '');
  if (token) {
    const jti = await extractJti(token);
    if (jti) revokeToken(jti, extractTokenExp(token));
  }
  cookies.delete(COOKIE_NAME, { path: '/' });
  redirect(302, '/login');
};
