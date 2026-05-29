import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import {
  initPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  getTokenFromCookies,
  isValidSessionCookie,
  COOKIE_NAME,
} from './password';

// Reset bcrypt hash before each suite that needs a known password
async function setupPassword(plain = 'hunter2') {
  delete (globalThis as Record<string, unknown>).__piHash;
  await initPassword(plain);
}

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
    const { SignJWT } = await import('jose');
    const wrongSecret = new TextEncoder().encode('completely-different-secret');
    const badToken = await new SignJWT({ pi: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(wrongSecret);
    expect(await verifySessionToken(badToken)).toBe(false);
  });

  it('rejects an expired token', async () => {
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(
      process.env.PI_PASSWORD ?? 'dev-secret-replace-me-set-PI_PASSWORD'
    );
    // Set expiration 1 second in the past
    const expiredToken = await new SignJWT({ pi: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 10)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(secret);
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
