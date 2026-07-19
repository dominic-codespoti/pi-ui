/**
 * Session snapshot — client-side persistence of the last rendered conversation.
 *
 * Mobile OSes discard backgrounded PWAs under memory pressure; the next open is
 * a cold start that previously showed a blank "connecting…" screen until the
 * WebSocket delivered the `connected` payload. We persist a lightweight,
 * text-only snapshot of the visible messages to localStorage so the app can
 * paint the conversation immediately on boot, then reconcile with live server
 * state when the socket connects (stable message ids keep that swap cheap).
 *
 * Deliberately NOT a cache of record: the WS `connected`/`session_loaded`
 * payloads always overwrite hydrated state wholesale.
 */

import type { UIMessage } from '$lib/client-messages';

export interface SessionSnapshot {
  /** Schema version — bump to invalidate incompatible stored snapshots. */
  v: number;
  /** Session file path this snapshot belongs to (the `?session=` URL param). */
  sessionPath: string;
  sessionName?: string;
  /** Unix ms when the snapshot was written. */
  savedAt: number;
  messages: UIMessage[];
}

export const SNAPSHOT_KEY = 'pi-session-snapshot';
const SNAPSHOT_VERSION = 1;
/** Only the visible tail matters for first paint. */
const MAX_MESSAGES = 50;
/** Hard cap on the serialized payload — protects the ~5 MB localStorage quota. */
const MAX_BYTES = 200 * 1024;
/** Per-field cap; a snapshot only needs enough to fill a screen. */
const MAX_FIELD_CHARS = 4000;
/** Snapshots older than this are stale enough that a splash is more honest. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function clip(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s;
}

/**
 * Reduce a live UIMessage to its snapshot form: drop heavy payloads
 * (base64 images, raw tool args, cached HTML) and clip long text.
 * Streaming flags are cleared — a resumed snapshot is never mid-stream.
 */
function slim(m: UIMessage): UIMessage {
  return {
    id: m.id,
    role: m.role,
    content: clip(m.content) ?? '',
    toolInput: m.toolInput,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    isError: m.isError,
    streaming: false,
    aborted: m.aborted,
    expanded: m.expanded,
    diff: clip(m.diff),
    lineCount: m.lineCount,
    usage: m.usage,
    thinking: clip(m.thinking),
    startMs: m.startMs,
    endMs: m.endMs,
    noticeKind: m.noticeKind,
    customType: m.customType,
    level: m.level,
    source: m.source,
    details: clip(m.details),
    createdAt: m.createdAt,
  };
}

/** Persist the current conversation tail. No-op when there is nothing to save. */
export function saveSnapshot(
  sessionPath: string | undefined,
  sessionName: string | undefined,
  messages: UIMessage[]
): void {
  if (!sessionPath || messages.length === 0) return;
  try {
    let slimmed = messages.slice(-MAX_MESSAGES).map(slim);
    let payload = JSON.stringify({
      v: SNAPSHOT_VERSION,
      sessionPath,
      sessionName,
      savedAt: Date.now(),
      messages: slimmed,
    } satisfies SessionSnapshot);
    // Evict oldest messages until the payload fits the byte budget.
    while (payload.length > MAX_BYTES && slimmed.length > 1) {
      slimmed = slimmed.slice(Math.ceil(slimmed.length / 2));
      payload = JSON.stringify({
        v: SNAPSHOT_VERSION,
        sessionPath,
        sessionName,
        savedAt: Date.now(),
        messages: slimmed,
      } satisfies SessionSnapshot);
    }
    if (payload.length > MAX_BYTES) return; // single message still too large — skip
    localStorage.setItem(SNAPSHOT_KEY, payload);
  } catch {
    // Quota exceeded or storage unavailable (private mode) — never break the app.
  }
}

/**
 * Load the stored snapshot for boot-time hydration.
 *
 * `sessionPath` is the `?session=` URL param, if any:
 * - param present → snapshot must match it (never show another conversation);
 * - no param (PWA relaunch from the home screen) → the last-active snapshot
 *   is the best guess and the server's active session almost always matches.
 */
export function loadSnapshot(sessionPath: string | null): SessionSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as SessionSnapshot;
    if (snap?.v !== SNAPSHOT_VERSION) return null;
    if (!Array.isArray(snap.messages) || snap.messages.length === 0) return null;
    if (typeof snap.sessionPath !== 'string' || !snap.sessionPath) return null;
    if (Date.now() - snap.savedAt > MAX_AGE_MS) return null;
    if (sessionPath !== null && sessionPath !== snap.sessionPath) return null;
    return snap;
  } catch {
    return null;
  }
}

/** Remove the stored snapshot (e.g. corrupt state recovery). */
export function clearSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* storage unavailable */
  }
}
