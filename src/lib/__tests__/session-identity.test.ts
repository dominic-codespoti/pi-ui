import { describe, it, expect, beforeEach } from 'vitest';
import { saveIdentity, loadIdentity, clearIdentity, IDENTITY_KEY } from '../session-identity';

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

const PATH = '/home/u/.pi/sessions/proj/2026-01-01_abc.jsonl';

describe('session identity', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips path, id, and name', () => {
    saveIdentity(PATH, 's1', 'Bug fix');
    const identity = loadIdentity();
    expect(identity).toMatchObject({ path: PATH, id: 's1', name: 'Bug fix' });
    expect(identity!.updatedAt).toBeGreaterThan(0);
  });

  it('returns null when nothing is stored', () => {
    expect(loadIdentity()).toBeNull();
  });

  it('is a no-op without a path — never stamps an empty/undefined session', () => {
    saveIdentity(undefined, 's1', 'Bug fix');
    saveIdentity('', 's1', 'Bug fix');
    expect(loadIdentity()).toBeNull();
  });

  it('has no age limit — a week-old identity is still honored', () => {
    saveIdentity(PATH, 's1');
    const stored = JSON.parse(localStorage.getItem(IDENTITY_KEY)!);
    stored.updatedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(stored));
    expect(loadIdentity()).toMatchObject({ path: PATH });
  });

  it('returns null for corrupt or wrong-version payloads', () => {
    localStorage.setItem(IDENTITY_KEY, 'not json{');
    expect(loadIdentity()).toBeNull();
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({ v: 999, path: PATH, updatedAt: Date.now() }));
    expect(loadIdentity()).toBeNull();
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({ v: 1, path: '', updatedAt: Date.now() }));
    expect(loadIdentity()).toBeNull();
  });

  it('clearIdentity removes the record', () => {
    saveIdentity(PATH, 's1');
    clearIdentity();
    expect(loadIdentity()).toBeNull();
  });

  it('later saves overwrite the previous identity', () => {
    saveIdentity(PATH, 's1', 'Bug fix');
    saveIdentity('/other/path.jsonl', 's2', 'Add tests');
    expect(loadIdentity()).toMatchObject({ path: '/other/path.jsonl', id: 's2' });
  });
});
