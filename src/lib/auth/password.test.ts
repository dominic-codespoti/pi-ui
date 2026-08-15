import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  revokeToken,
  isJtiRevoked,
  getJwtSecret,
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

function b64url(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function toBuf(view: Uint8Array | ArrayBuffer): ArrayBuffer {
  return view instanceof Uint8Array ? (view.buffer as ArrayBuffer) : view;
}

/** Build a JWT signed with a raw HMAC-SHA256 key (not the derived secret). */
async function makeJWT(payload: Record<string, unknown>, rawHmacKey: Uint8Array): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = new TextEncoder().encode(`${header}.${payloadB64}`);
  const k = await crypto.subtle.importKey(
    'raw',
    toBuf(rawHmacKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = b64url(await crypto.subtle.sign('HMAC', k, toBuf(signingInput)));
  return `${header}.${payloadB64}.${sig}`;
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
      {
        pi: 1,
        iat: Math.floor(Date.now() / 1000),
        jti: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + 86400,
      },
      wrongSecret
    );
    expect(await verifySessionToken(badToken)).toBe(false);
  });

  it('rejects an expired token', async () => {
    const secret = await getJwtSecret();
    const expiredToken = await makeJWT(
      {
        pi: 1,
        iat: Math.floor(Date.now() / 1000) - 10,
        jti: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      secret
    );
    expect(await verifySessionToken(expiredToken)).toBe(false);
  });
});

describe('revokeToken / isJtiRevoked', () => {
  it('revokes a JTI immediately', () => {
    const jti = crypto.randomUUID();
    expect(isJtiRevoked(jti)).toBe(false);
    revokeToken(jti);
    expect(isJtiRevoked(jti)).toBe(true);
  });

  it('verifySessionToken rejects a revoked token', async () => {
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);
    const payloadB64 = token.split('.')[1];
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
          c.charCodeAt(0)
        )
      )
    );
    revokeToken(payload.jti as string, payload.exp as number);
    expect(await verifySessionToken(token)).toBe(false);
    expect(isJtiRevoked(payload.jti as string)).toBe(true);
  });

  it('prunes expired revocation entries', () => {
    const jti = crypto.randomUUID();
    revokeToken(jti, Math.floor(Date.now() / 1000) - 1);
    expect(isJtiRevoked(jti)).toBe(false);
  });
});

describe('JWT secret', () => {
  it('is random and not derivable from the password', async () => {
    const secret = await getJwtSecret();
    expect(secret.length).toBe(32);
    // The old scheme derived the key deterministically from the password via
    // HMAC-SHA256(password, 'pi-ui-session-v1') — that must no longer verify.
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode('hunter2'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const oldDerivation = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, enc.encode('pi-ui-session-v1'))
    );
    expect(secret).not.toEqual(oldDerivation);
  });

  it('honors PI_UI_JWT_SECRET for multi-process deployments', async () => {
    delete (globalThis as Record<string, unknown>).__piJwtSecret;
    const saved = process.env.PI_UI_JWT_SECRET;
    try {
      process.env.PI_UI_JWT_SECRET = 'a'.repeat(32) + 'multi-process-shared-secret';
      const secret = await getJwtSecret();
      expect(new TextDecoder().decode(secret)).toBe(process.env.PI_UI_JWT_SECRET);
    } finally {
      delete (globalThis as Record<string, unknown>).__piJwtSecret;
      if (saved === undefined) delete process.env.PI_UI_JWT_SECRET;
      else process.env.PI_UI_JWT_SECRET = saved;
    }
  });

  it('persists the secret across server restarts', async () => {
    // The secret file path is resolved at import time from $HOME (test-setup
    // points PI_UI_JWT_SECRET_FILE at /tmp, so a fresh module + HOME change
    // exercises the real file logic in isolation).
    const testHome = join(tmpdir(), 'pi-ui-jwt-secret-' + Date.now());
    const savedHome = process.env.HOME;
    const savedFile = process.env.PI_UI_JWT_SECRET_FILE;
    try {
      process.env.HOME = testHome;
      delete process.env.PI_UI_JWT_SECRET_FILE;
      mkdirSync(testHome, { recursive: true });
      delete (globalThis as Record<string, unknown>).__piJwtSecret;
      vi.resetModules();
      const first = await import('./password');
      const s1 = await first.getJwtSecret();
      expect(s1.length).toBe(32);
      expect(existsSync(join(testHome, '.pi', 'agent', 'pi-ui-jwt-secret'))).toBe(true);

      // Simulate a server restart: fresh module, cleared cache, same HOME —
      // the persisted key must be reused so existing cookies stay valid.
      delete (globalThis as Record<string, unknown>).__piJwtSecret;
      vi.resetModules();
      const second = await import('./password');
      const s2 = await second.getJwtSecret();
      expect(Buffer.from(s2).equals(Buffer.from(s1))).toBe(true);
    } finally {
      process.env.HOME = savedHome;
      if (savedFile === undefined) delete process.env.PI_UI_JWT_SECRET_FILE;
      else process.env.PI_UI_JWT_SECRET_FILE = savedFile;
      delete (globalThis as Record<string, unknown>).__piJwtSecret;
      try {
        rmSync(testHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
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
