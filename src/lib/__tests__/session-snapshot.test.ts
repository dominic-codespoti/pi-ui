import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveSnapshot,
  loadSnapshot,
  clearSnapshot,
  SNAPSHOT_KEY,
  type SessionSnapshot,
} from '../session-snapshot';
import type { UIMessage } from '../client-messages';

function msg(overrides: Partial<UIMessage> = {}): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: 'hello world',
    streaming: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

const PATH = '/home/u/.pi/sessions/proj/2026-01-01_abc.jsonl';

// Node ≥22 ships an experimental `localStorage` accessor that is undefined
// without --localstorage-file and shadows jsdom's implementation on the merged
// window/globalThis. Install a Map-backed Storage stub for deterministic tests.
function makeStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
  };
}
Object.defineProperty(globalThis, 'localStorage', {
  value: makeStorageStub(),
  configurable: true,
});

beforeEach(() => {
  localStorage.clear();
});

describe('saveSnapshot / loadSnapshot roundtrip', () => {
  it('persists and restores the conversation tail', () => {
    const messages = [msg({ content: 'first' }), msg({ content: 'second' })];
    saveSnapshot(PATH, 'My session', messages);
    const snap = loadSnapshot(PATH);
    expect(snap).not.toBeNull();
    expect(snap!.sessionPath).toBe(PATH);
    expect(snap!.sessionName).toBe('My session');
    expect(snap!.messages.map((m) => m.content)).toEqual(['first', 'second']);
    // Ids survive — they drive the keyed {#each} diff on reconnect
    expect(snap!.messages[0].id).toBe(messages[0].id);
  });

  it('does nothing without a session path or messages', () => {
    saveSnapshot(undefined, undefined, [msg()]);
    saveSnapshot(PATH, undefined, []);
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  it('clears streaming flags — a resumed snapshot is never mid-stream', () => {
    saveSnapshot(PATH, undefined, [msg({ streaming: true })]);
    expect(loadSnapshot(PATH)!.messages[0].streaming).toBe(false);
  });

  it('strips heavy fields: images, toolArgs, cached HTML', () => {
    saveSnapshot(PATH, undefined, [
      msg({
        images: ['data:image/png;base64,AAAA'],
        toolArgs: { huge: 'x'.repeat(100) },
        renderedContent: '<p>html</p>',
        renderedThinking: '<p>think</p>',
      }),
    ]);
    const m = loadSnapshot(PATH)!.messages[0];
    expect(m.images).toBeUndefined();
    expect(m.toolArgs).toBeUndefined();
    expect(m.renderedContent).toBeUndefined();
    expect(m.renderedThinking).toBeUndefined();
  });

  it('keeps only the last 50 messages and clips long fields', () => {
    const messages = Array.from({ length: 60 }, (_, i) => msg({ content: `m${i}` }));
    messages.push(msg({ content: 'y'.repeat(10_000) }));
    saveSnapshot(PATH, undefined, messages);
    const snap = loadSnapshot(PATH)!;
    expect(snap.messages.length).toBeLessThanOrEqual(50);
    const longest = Math.max(...snap.messages.map((m) => m.content.length));
    expect(longest).toBeLessThanOrEqual(4000);
  });

  it('evicts oldest messages when the payload exceeds the byte budget', () => {
    // 50 messages × ~4000 chars ≈ 200 KB+ — forces eviction
    const messages = Array.from({ length: 50 }, (_, i) =>
      msg({ content: `${i}:` + 'z'.repeat(3990) })
    );
    saveSnapshot(PATH, undefined, messages);
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    expect(raw).not.toBeNull();
    expect(raw!.length).toBeLessThanOrEqual(200 * 1024);
    const snap = loadSnapshot(PATH)!;
    // The newest message always survives eviction
    expect(snap.messages.at(-1)!.content.startsWith('49:')).toBe(true);
  });
});

describe('loadSnapshot gating', () => {
  it('returns null for a different session path', () => {
    saveSnapshot(PATH, undefined, [msg()]);
    expect(loadSnapshot('/other/session.jsonl')).toBeNull();
  });

  it('returns the snapshot when no session param is present (PWA relaunch)', () => {
    saveSnapshot(PATH, undefined, [msg()]);
    expect(loadSnapshot(null)).not.toBeNull();
  });

  it('returns null for stale snapshots (> 7 days)', () => {
    saveSnapshot(PATH, undefined, [msg()]);
    const stored = JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!) as SessionSnapshot;
    stored.savedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(stored));
    expect(loadSnapshot(PATH)).toBeNull();
  });

  it('returns null for corrupt or wrong-version payloads', () => {
    localStorage.setItem(SNAPSHOT_KEY, 'not json{');
    expect(loadSnapshot(PATH)).toBeNull();
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: 999, sessionPath: PATH, savedAt: Date.now(), messages: [msg()] }));
    expect(loadSnapshot(PATH)).toBeNull();
  });
});

describe('clearSnapshot', () => {
  it('removes the stored snapshot', () => {
    saveSnapshot(PATH, undefined, [msg()]);
    clearSnapshot();
    expect(loadSnapshot(PATH)).toBeNull();
  });
});
