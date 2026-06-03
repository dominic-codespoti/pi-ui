/**
 * In-memory IP-based rate limiter for the login endpoint.
 *
 * Stored on `globalThis` so the state survives across SvelteKit hot-reloads
 * in development and is shared between all import sites in the same process.
 *
 * Policy:
 *   - Up to MAX_ATTEMPTS failures within WINDOW_MS → IP is blocked for BLOCK_MS.
 *   - A successful login clears the failure record for that IP.
 */

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60 * 1000;    // 5-minute sliding window
const BLOCK_MS  = 15 * 60 * 1000;   // 15-minute lockout after exceeding the limit

type AttemptRecord = {
  count: number;
  firstAttempt: number;
  blockedUntil: number | null;
};

type RateLimitResult = {
  blocked: boolean;
  remaining: number;
  /** Seconds until the block expires. Non-null only when blocked === true. */
  retryAfterSecs: number | null;
};

function store(): Map<string, AttemptRecord> {
  const g = globalThis as Record<string, unknown>;
  if (!g.__piRateLimit) g.__piRateLimit = new Map<string, AttemptRecord>();
  return g.__piRateLimit as Map<string, AttemptRecord>;
}

/** Normalize IPv6-mapped IPv4 addresses to bare IPv4, e.g. ::ffff:127.0.0.1 → 127.0.0.1 */
function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
}

/**
 * Extract the real client IP, preferring Cloudflare's header over the raw
 * connection address (which is Cloudflare's edge IP behind a tunnel).
 */
export function getClientIp(request: Request, fallbackIp: string): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-real-ip') ??
    // X-Forwarded-For may be comma-separated — take the leftmost (client) IP.
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    fallbackIp
  );
}

/** Read the current rate-limit status without recording anything. */
export function checkRateLimit(rawIp: string): RateLimitResult {
  const ip = normalizeIp(rawIp);
  const map = store();
  const now = Date.now();
  const rec = map.get(ip);

  if (!rec) return { blocked: false, remaining: MAX_ATTEMPTS, retryAfterSecs: null };

  // Block expired?
  if (rec.blockedUntil !== null && now >= rec.blockedUntil) {
    map.delete(ip);
    return { blocked: false, remaining: MAX_ATTEMPTS, retryAfterSecs: null };
  }

  // Currently blocked?
  if (rec.blockedUntil !== null) {
    return {
      blocked: true,
      remaining: 0,
      retryAfterSecs: Math.ceil((rec.blockedUntil - now) / 1000),
    };
  }

  // Window expired?
  if (now - rec.firstAttempt >= WINDOW_MS) {
    map.delete(ip);
    return { blocked: false, remaining: MAX_ATTEMPTS, retryAfterSecs: null };
  }

  return { blocked: false, remaining: Math.max(0, MAX_ATTEMPTS - rec.count), retryAfterSecs: null };
}

/** Record a failed login attempt and return the updated status. */
export function recordFailure(rawIp: string): RateLimitResult {
  const ip = normalizeIp(rawIp);
  const map = store();
  const now = Date.now();
  const rec = map.get(ip);

  if (!rec || now - rec.firstAttempt >= WINDOW_MS) {
    // Fresh window
    map.set(ip, { count: 1, firstAttempt: now, blockedUntil: null });
    return { blocked: false, remaining: MAX_ATTEMPTS - 1, retryAfterSecs: null };
  }

  rec.count += 1;

  if (rec.count >= MAX_ATTEMPTS) {
    rec.blockedUntil = now + BLOCK_MS;
    return { blocked: true, remaining: 0, retryAfterSecs: Math.ceil(BLOCK_MS / 1000) };
  }

  return { blocked: false, remaining: MAX_ATTEMPTS - rec.count, retryAfterSecs: null };
}

/** Clear the failure record for an IP (called on successful login). */
export function clearRecord(rawIp: string): void {
  store().delete(normalizeIp(rawIp));
}
