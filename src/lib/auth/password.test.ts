import { describe, it, expect, beforeAll } from 'bun:test';
import {
  initPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  getTokenFromCookies,
  isValidSessionCookie,
  COOKIE_NAME,
} from './password';

// Clear cached secrets — needed when we temporarily change PI_PASSWORD.
function clearSecrets() {
  const g = globalThis as Record<string, unknown>;
  delete g.__piHash;
  delete g.__piJwtSecret;
}

async function setupPassword(plain = 'hunter2') {
  clearSecrets();
  await initPassword(plain);
}

// ── Helpers to craft custom JWTs without jose ────────────────────────────────

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

/** Build a JWT signed with a raw HMAC-SHA256 key (not the derived secret). */
async function makeJWT(
  payload: Record<string, unknown>,
  rawHmacKey: Uint8Array,
): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = new TextEncoder().encode(`${header}.${payloadB64}`);
  const k = await crypto.subtle.importKey('raw', rawHmacKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64url(await crypto.subtle.sign('HMAC', k, signingInput));
  return `${header}.${payloadB64}.${sig}`;
}

/** Replicate the deriveSecret() logic so tests can create tokens with custom payloads. */
async function deriveTestSecret(password: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('pi-ui-session-v1')));
}

// ── initPassword / verifyPassword ────────────────────────────────────────────

describe('initPassword / verifyPassword', () => {
  beforeAll(() => setupPassword('hunter2'));

  it('returns true for the correct password', async () => {
    expect(await verifyPassword('hunter2')).toBe(true);
  });

  it('returns false for a wrong password', async () => {
    expect(await verifyPassword('notright')).toBe(false);
  });

  it('returns false when called before initPassword', async () => {
    delete (globalThis as Record<string, unknown>).__piHash;
    expect(await verifyPassword('hunter2')).toBe(false);
    await initPassword('hunter2'); // restore for later tests
  });
});

// ── createSessionToken / verifySessionToken ──────────────────────────────────

describe('createSessionToken / verifySessionToken', () => {
  it('produces a 3-part JWT string', async () => {
    const token = await createSessionToken();
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);
  });

  it('round-trips successfully', async () => {
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);
  });

  it('rejects a garbage string', async () => {
    expect(await verifySessionToken('not.a.jwt')).toBe(false);
    expect(await verifySessionToken('')).toBe(false);
    expect(await verifySessionToken('a.b.c')).toBe(false);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const wrongSecret = new TextEncoder().encode('completely-different-secret');
    const badToken = await makeJWT(
      { pi: 1, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 86400 },
      wrongSecret,
    );
    expect(await verifySessionToken(badToken)).toBe(false);
  });

  it('rejects an expired token', async () => {
    const secret = await deriveTestSecret(
      process.env.PI_PASSWORD ?? 'dev-secret-replace-me-set-PI_PASSWORD',
    );
    const expiredToken = await makeJWT(
      {
        pi: 1,
        iat: Math.floor(Date.now() / 1000) - 10,
        jti: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      secret,
    );
    expect(await verifySessionToken(expiredToken)).toBe(false);
  });
});

describe('getTokenFromCookies', () => {
  it('extracts the token when it is the only cookie', () => {
    expect(getTokenFromCookies(`${COOKIE_NAME}=abc123`)).toBe('abc123');
  });

  it('extracts the token from a multi-cookie header', () => {
    const header = `other=foo; ${COOKIE_NAME}=mytoken; another=bar`;
    expect(getTokenFromCookies(header)).toBe('mytoken');
  });

  it('handles the cookie appearing first', () => {
    expect(getTokenFromCookies(`${COOKIE_NAME}=first; other=second`)).toBe('first');
  });

  it('returns null when the cookie is absent', () => {
    expect(getTokenFromCookies('other=value')).toBeNull();
    expect(getTokenFromCookies('')).toBeNull();
  });

  it('returns null for a malformed header', () => {
    expect(getTokenFromCookies('noequals')).toBeNull();
  });
});

describe('isValidSessionCookie', () => {
  beforeAll(() => setupPassword('hunter2'));

  it('returns true for a valid session cookie header', async () => {
    const token = await createSessionToken();
    expect(await isValidSessionCookie(`${COOKIE_NAME}=${token}`)).toBe(true);
  });

  it('returns true even when other cookies are present', async () => {
    const token = await createSessionToken();
    expect(await isValidSessionCookie(`other=x; ${COOKIE_NAME}=${token}; more=y`)).toBe(true);
  });

  it('returns false when the named cookie is absent', async () => {
    expect(await isValidSessionCookie('other=value')).toBe(false);
    expect(await isValidSessionCookie('')).toBe(false);
  });

  it('returns false for a garbage token value', async () => {
    expect(await isValidSessionCookie(`${COOKIE_NAME}=notajwt`)).toBe(false);
  });
});
