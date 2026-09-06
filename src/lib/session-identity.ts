/**
 * Session identity — client-side, per-device record of "the session I was
 * last looking at". This is the sole source of truth for which session a
 * fresh app load should resume, and it deliberately lives in `localStorage`
 * rather than the `?session=` URL param: installed PWAs relaunched from a
 * home-screen icon always cold-start at the manifest `start_url` ("/"),
 * discarding whatever query string was in the tab when the OS suspended or
 * killed it. The URL param remains a secondary, higher-priority signal for
 * explicit navigation/deep links (e.g. a shared session link) — see
 * `getSessionParam()` in +page.svelte — but it cannot be relied on to
 * survive a cold PWA relaunch, so it must never be the only persistence
 * layer for "resume my last chat".
 *
 * Unlike `session-snapshot.ts` (a best-effort, size-capped cache of recent
 * message *content* for instant first paint), this record is small,
 * unconditional, and has no age limit: identity should be honored even if
 * the session has been untouched for a week — that is the entire point of
 * "take me back to my last chat".
 */

export const IDENTITY_KEY = 'pi-ui-last-session-id';
const IDENTITY_VERSION = 1;

export interface SessionIdentity {
  v: number;
  /** Session file path — the same value carried by the `?session=` URL param. */
  path: string;
  id?: string;
  name?: string;
  /** Unix ms when this record was last written. */
  updatedAt: number;
}

/** Persist the session currently being viewed. No-op without a path. */
export function saveIdentity(path: string | undefined, id?: string, name?: string): void {
  if (!path) return;
  try {
    localStorage.setItem(
      IDENTITY_KEY,
      JSON.stringify({
        v: IDENTITY_VERSION,
        path,
        id,
        name,
        updatedAt: Date.now(),
      } satisfies SessionIdentity)
    );
  } catch {
    // Quota exceeded or storage unavailable (private mode) — never break the app.
  }
}

/** Load the last-known session identity for boot-time resume. */
export function loadIdentity(): SessionIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionIdentity;
    if (parsed?.v !== IDENTITY_VERSION) return null;
    if (typeof parsed.path !== 'string' || !parsed.path) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Remove the stored identity — e.g. it points at a session that no longer exists. */
export function clearIdentity(): void {
  try {
    localStorage.removeItem(IDENTITY_KEY);
  } catch {
    // storage unavailable
  }
}
