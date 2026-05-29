import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';

export const COOKIE_NAME = 'pi-session';

// JWT secret derived from PI_PASSWORD at module load time.
// Both server.ts and the SvelteKit bundle read the same process.env,
// so tokens signed in one context verify in the other.
const SECRET = new TextEncoder().encode(
  process.env.PI_PASSWORD ?? 'dev-secret-replace-me-set-PI_PASSWORD'
);

// bcrypt hash stored in globalThis so it is shared between server.ts's
// module context and the SvelteKit bundle (separate module graphs, same process).
export async function initPassword(plain: string): Promise<void> {
  (globalThis as Record<string, unknown>).__piHash = await bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string): Promise<boolean> {
  const hash = (globalThis as Record<string, unknown>).__piHash as string | undefined;
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ pi: 1 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(SECRET);
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

export function getTokenFromCookies(cookieHeader: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? null;
}

export async function isValidSessionCookie(cookieHeader: string): Promise<boolean> {
  const token = getTokenFromCookies(cookieHeader);
  if (!token) return false;
  return verifySessionToken(token);
}
