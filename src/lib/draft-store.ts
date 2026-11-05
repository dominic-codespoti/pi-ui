/**
 * Durable composer drafts — unsent text survives a reload or a discarded PWA.
 *
 * The per-session view cache already keeps drafts across in-app session
 * switches, but only in memory. This is the cold-start backstop: text only
 * (attachments carry base64 payloads too large for localStorage), keyed by
 * session id, bounded by count, age and size.
 */

export const DRAFT_STORE_KEY = 'pi-ui:drafts:v1';
export const MAX_DRAFTS = 20;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_DRAFT_CHARS = 20_000;

type DraftEntry = { text: string; savedAt: number };
type DraftMap = Record<string, DraftEntry>;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(now: number): DraftMap {
  const store = storage();
  if (!store) return {};
  try {
    const parsed: unknown = JSON.parse(store.getItem(DRAFT_STORE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: DraftMap = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const { text, savedAt } = entry as Partial<DraftEntry>;
      if (typeof text !== 'string' || typeof savedAt !== 'number') continue;
      if (text === '' || now - savedAt > DRAFT_TTL_MS) continue;
      out[id] = { text, savedAt };
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: DraftMap): void {
  const store = storage();
  if (!store) return;
  const entries = Object.entries(map)
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, MAX_DRAFTS);
  try {
    if (entries.length === 0) store.removeItem(DRAFT_STORE_KEY);
    else store.setItem(DRAFT_STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* quota or private mode — drafts are best-effort */
  }
}

/** Persist (or, for blank text, forget) the draft for a session. */
export function saveDraft(sessionId: string, text: string, now = Date.now()): void {
  if (!sessionId) return;
  const map = read(now);
  if (text.trim() === '') {
    if (!(sessionId in map)) return;
    delete map[sessionId];
  } else {
    map[sessionId] = { text: text.slice(0, MAX_DRAFT_CHARS), savedAt: now };
  }
  write(map);
}

export function loadDraft(sessionId: string, now = Date.now()): string | null {
  if (!sessionId) return null;
  return read(now)[sessionId]?.text ?? null;
}

export function clearDraft(sessionId: string): void {
  saveDraft(sessionId, '');
}
