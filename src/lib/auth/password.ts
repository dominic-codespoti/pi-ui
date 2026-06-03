import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';

export const COOKIE_NAME = 'pi-session';

// ── JWT secret ────────────────────────────────────────────────────────────────
// Derived deterministically from the password so every process in a given
// run can verify the same session tokens.

const g = globalThis as Record<string, unknown>;

/** Derive a 256-bit JWT signing key from the password. */
async function deriveSecret(): Promise<Uint8Array> {
  if (g.__piJwtSecret) return g.__piJwtSecret as Uint8Array;
  const password = process.env.PI_PASSWORD ?? 'dev-secret-replace-me-set-PI_PASSWORD';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('pi-ui-session-v1'));
  g.__piJwtSecret = new Uint8Array(sig);
  return g.__piJwtSecret as Uint8Array;
}

// ── Token revocation ──────────────────────────────────────────────────────────
// Lightweight in-memory token ID blacklist. Cleared on restart.

function revokedSet(): Set<string> {
  if (!g.__piRevokedJtis) g.__piRevokedJtis = new Set<string>();
  return g.__piRevokedJtis as Set<string>;
}

/** Revoke a specific token by its JTI claim (called on logout). */
export function revokeToken(jti: string): void {
  revokedSet().add(jti);
}

// ── Password hashing ──────────────────────────────────────────────────────────
// bcrypt hash stored in globalThis so it is shared between server.ts's
// module context and the SvelteKit bundle (separate module graphs, same process).

export async function initPassword(plain: string): Promise<void> {
  g.__piHash = await bcrypt.hash(plain, 10);
  // Pre-derive the JWT secret so it's ready when the first token is created.
  await deriveSecret();
}

export async function verifyPassword(plain: string): Promise<boolean> {
  let hash = g.__piHash as string | undefined;
  if (!hash) {
    // In dev mode (Vite process) initPassword() is never called explicitly.
    // Auto-initialize from the env var so login works without a separate call.
    const envPwd = process.env.PI_PASSWORD;
    if (!envPwd) return false;
    await initPassword(envPwd);
    hash = g.__piHash as string;
  }
  return bcrypt.compare(plain, hash);
}

// ── JWT creation / verification ───────────────────────────────────────────────

/** Session token expiry (24 hours instead of 7 days). */
const TOKEN_EXPIRY = '24h';

export async function createSessionToken(): Promise<string> {
  const jti = crypto.randomUUID();
  const secret = await deriveSecret();
  return new SignJWT({ pi: 1 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setJti(jti)
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(secret);
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    const secret = await deriveSecret();
    const { payload } = await jwtVerify(token, secret);
    // Check revocation list
    if (payload.jti && revokedSet().has(payload.jti)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Extract the JTI from a token without full verification (for logout). */
export async function extractJti(token: string): Promise<string | undefined> {
  try {
    const secret = await deriveSecret();
    const { payload } = await jwtVerify(token, secret);
    return payload.jti;
  } catch {
    return undefined;
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
