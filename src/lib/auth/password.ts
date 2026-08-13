export const COOKIE_NAME = 'pi-session';

const g = globalThis as Record<string, unknown>;

// ── JWT secret ────────────────────────────────────────────────────────────────
// Random per process by default so session tokens cannot outlive a server
// restart (restart = global sign-out) and so knowing the login password can
// never be used to forge tokens offline. Multi-process deployments (e.g. the
// dev:full split of login on Vite and /ws on the standalone server) share a
// secret by setting PI_UI_JWT_SECRET (≥32 chars) in both processes' env.

/** Resolve the 256-bit JWT signing key for this process. */
async function deriveSecret(): Promise<Uint8Array> {
  if (g.__piJwtSecret) return g.__piJwtSecret as Uint8Array;
  const envSecret = process.env.PI_UI_JWT_SECRET;
  let secret: Uint8Array;
  if (envSecret && envSecret.length >= 32) {
    secret = new TextEncoder().encode(envSecret);
  } else {
    secret = crypto.getRandomValues(new Uint8Array(32));
  }
  g.__piJwtSecret = secret;
  return secret;
}

/** Test/observability accessor for the current process JWT secret. */
export async function getJwtSecret(): Promise<Uint8Array> {
  return deriveSecret();
}

// ── Token revocation ──────────────────────────────────────────────────────────
// Lightweight in-memory token ID blacklist. Cleared on restart.

function revokedMap(): Map<string, number> {
  if (!(g.__piRevokedJtis instanceof Map)) g.__piRevokedJtis = new Map<string, number>();
  return g.__piRevokedJtis as Map<string, number>;
}

/** Revoke a specific token by its JTI claim (called on logout). Entries are
 *  pruned once their expiry passes, so logout churn cannot grow unbounded. */
export function revokeToken(jti: string, exp?: number): void {
  revokedMap().set(jti, exp ?? Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_S);
}

/** True when the JTI is currently revoked. Prunes expired entries. Used for
 *  cheap per-message revalidation on established WebSocket connections. */
export function isJtiRevoked(jti: string): boolean {
  const revoked = revokedMap();
  const revokeExp = revoked.get(jti);
  if (revokeExp === undefined) return false;
  if (Date.now() / 1000 > revokeExp) {
    revoked.delete(jti);
    return false;
  }
  return true;
}

// ── Password hashing ────────────────────────────────────────────────────────
// Uses Bun's native bcrypt when available (production), falls back to Web
// Crypto PBKDF2 for the Vite dev server (Node.js).

const hasBun = typeof Bun !== 'undefined';

async function pbkdf2Hash(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(plain), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' }, key, 256);
  const saltB64 = btoa(String.fromCharCode(...salt));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return `$pbkdf2$600000$${saltB64}$${hashB64}`;
}

async function pbkdf2Verify(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[1] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[2], 10);
  const salt = Uint8Array.from(atob(parts[3]), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(plain), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  const expected = atob(parts[4]);
  const actual = String.fromCharCode(...new Uint8Array(bits));
  return expected === actual;
}

export async function initPassword(plain: string): Promise<void> {
  if (hasBun) {
    g.__piHash = await Bun.password.hash(plain, { algorithm: 'bcrypt', cost: 10 });
  } else {
    g.__piHash = await pbkdf2Hash(plain);
  }
  await deriveSecret();
}

export async function verifyPassword(plain: string): Promise<boolean> {
  let hash = g.__piHash as string | undefined;
  if (!hash) {
    const envPwd = process.env.PI_PASSWORD;
    if (!envPwd) return false;
    await initPassword(envPwd);
    hash = g.__piHash as string;
  }
  if (hasBun) {
    return Bun.password.verify(plain, hash);
  }
  return pbkdf2Verify(plain, hash);
}

// ── JWT helpers (native crypto.subtle, no jose) ───────────────────────────────

const JWT_ALG = 'HS256';

function toBuf(view: Uint8Array | ArrayBuffer): ArrayBuffer {
  return view instanceof Uint8Array ? view.buffer as ArrayBuffer : view;
}

function b64url(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function hmacSign(data: Uint8Array, secret: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', toBuf(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, toBuf(data)));
}

// ── Session token ─────────────────────────────────────────────────────────────

/** Session token expiry (30 days). */
const TOKEN_EXPIRY_S = 30 * 86400;

export async function createSessionToken(): Promise<string> {
  const jti = crypto.randomUUID();
  const secret = await deriveSecret();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_EXPIRY_S;

  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: JWT_ALG, typ: 'JWT' })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ pi: 1, iat, jti, exp })));

  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const signature = b64url(await hmacSign(signingInput, secret));

  return `${header}.${payload}.${signature}`;
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const [headerB64, payloadB64, sigB64] = parts;
    if (!headerB64 || !payloadB64 || !sigB64) return false;

    const secret = await deriveSecret();

    // Verify signature
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigKey = await crypto.subtle.importKey('raw', toBuf(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', sigKey, toBuf(b64urlDecode(sigB64)), toBuf(signingInput));
    if (!valid) return false;

    // Decode and validate payload
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));

    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) return false;

    // Check revocation — prune expired entries while we're here.
    if (payload.jti && isJtiRevoked(payload.jti)) return false;

    return true;
  } catch {
    return false;
  }
}

/** Extract the JTI from a token (with full verification). */
export async function extractJti(token: string): Promise<string | undefined> {
  try {
    if (!(await verifySessionToken(token))) return undefined;
    const payloadB64 = token.split('.')[1];
    if (!payloadB64) return undefined;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    return payload.jti as string | undefined;
  } catch {
    return undefined;
  }
}

/** Extract the expiry timestamp (seconds since epoch) from a token WITHOUT verification. */
export function extractTokenExp(token: string): number | undefined {
  try {
    const payloadB64 = token.split('.')[1];
    if (!payloadB64) return undefined;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    return payload.exp as number | undefined;
  } catch {
    return undefined;
  }
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

export function getTokenFromCookies(cookieHeader: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? null;
}

export async function isValidSessionCookie(cookieHeader: string): Promise<boolean> {
  const token = getTokenFromCookies(cookieHeader);
  if (!token) return false;
  return verifySessionToken(token);
}
