import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionCatalog } from '../session-catalog';
import { encodeSessionDirName, clearSessionScanCache, type SessionFileInfo } from '../session-scan';

const ROOT = '/tmp/pi-ui-test-session-catalog-' + Date.now();
const CWD = '/home/user/proj';
const DIR = join(ROOT, encodeSessionDirName(CWD));

function writeSession(
  file: string,
  opts: {
    id: string;
    ts: string;
    name?: string;
    messages?: { role: string; text: string; ts?: number }[];
  }
): string {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: opts.id, timestamp: opts.ts, cwd: CWD }),
  ];
  if (opts.name) lines.push(JSON.stringify({ type: 'session_info', id: 'i1', name: opts.name }));
  for (const [i, m] of (opts.messages ?? []).entries()) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `m${i}`,
        timestamp: opts.ts,
        message: { role: m.role, content: [{ type: 'text', text: m.text }], timestamp: m.ts },
      })
    );
  }
  const path = join(DIR, file);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function makeInfo(overrides: Partial<SessionFileInfo> = {}): SessionFileInfo {
  return {
    path: '/tmp/whatever.jsonl',
    id: 'mem-1',
    cwd: CWD,
    created: new Date(1_700_000_000_000),
    modified: new Date(1_700_000_100_000),
    messageCount: 0,
    firstMessage: '',
    ...overrides,
  };
}

function newCatalog(): SessionCatalog {
  clearSessionScanCache();
  return new SessionCatalog(() => ROOT);
}

beforeEach(() => {
  clearSessionScanCache();
  mkdirSync(DIR, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('session-catalog', () => {
  it('lists scanned sessions sorted by activity', async () => {
    writeSession('old.jsonl', {
      id: 's-old',
      ts: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', text: 'a', ts: 1_000 }],
    });
    writeSession('new.jsonl', {
      id: 's-new',
      ts: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', text: 'b', ts: 2_000 }],
    });
    const cat = newCatalog();
    const infos = await cat.list();
    expect(infos.map((i) => i.id)).toEqual(['s-new', 's-old']);
  });

  it('overlay upsert wins over disk and preserves created', async () => {
    writeSession('a.jsonl', {
      id: 's1',
      ts: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', text: 'hello', ts: 1_000 }],
    });
    const cat = newCatalog();
    const first = await cat.list();
    expect(first[0].messageCount).toBe(1);
    const diskCreated = first[0].created;

    // Pooled session changes memory state; disk is untouched (stale).
    cat.apply({
      kind: 'upsert',
      session: makeInfo({ id: 's1', messageCount: 42, modified: new Date(1_700_001_000_000) }),
    });
    const merged = await cat.list();
    expect(merged[0].messageCount).toBe(42);
    // created survives from the disk scan, not the upsert's "now".
    expect(merged[0].created.getTime()).toBe(diskCreated.getTime());
  });

  it('upsert adds sessions unknown to disk (in-memory)', async () => {
    const cat = newCatalog();
    expect(await cat.list()).toHaveLength(0);
    cat.apply({ kind: 'upsert', session: makeInfo({ id: 'mem-1', messageCount: 3 }) });
    const infos = await cat.list();
    expect(infos).toHaveLength(1);
    expect(infos[0].id).toBe('mem-1');
    expect(infos[0].messageCount).toBe(3);
  });

  it('release hands back to disk truth, re-parsing changed files', async () => {
    const path = writeSession('a.jsonl', {
      id: 's1',
      ts: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', text: 'one', ts: 1_000 }],
    });
    const cat = newCatalog();
    await cat.list(); // seed scan + createdById
    cat.apply({ kind: 'upsert', session: makeInfo({ id: 's1', messageCount: 99 }) });
    expect((await cat.list())[0].messageCount).toBe(99);

    // File grew while pooled; release drops the overlay → the next scan
    // stats the file, sees the change, and re-parses it.
    appendFileSync(
      path,
      JSON.stringify({
        type: 'message',
        id: 'm9',
        timestamp: '2026-01-02T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], timestamp: 2_000 },
      }) + '\n'
    );
    cat.apply({ kind: 'release', id: 's1' });
    const infos = await cat.list();
    expect(infos[0].messageCount).toBe(2);
    expect(infos[0].firstMessage).toBe('one');
  });

  it('rename patches the overlay and forces a fresh scan for others', async () => {
    writeSession('a.jsonl', {
      id: 's1',
      ts: '2026-01-01T00:00:00.000Z',
      name: 'Old name',
      messages: [{ role: 'user', text: 'hi', ts: 1_000 }],
    });
    const cat = newCatalog();
    await cat.list();

    // Pooled → overlay patched in place.
    cat.apply({ kind: 'upsert', session: makeInfo({ id: 's1', messageCount: 1 }) });
    cat.apply({ kind: 'rename', path: '/tmp/whatever.jsonl', name: 'Pooled rename' });
    expect((await cat.list())[0].name).toBe('Pooled rename');

    // Non-pooled → scan re-parses the file (session_info line appended,
    // mirroring sm.appendSessionInfo() in the rename handler).
    cat.apply({ kind: 'release', id: 's1' });
    appendFileSync(
      join(DIR, 'a.jsonl'),
      JSON.stringify({ type: 'session_info', id: 'i1', name: 'Disk rename' }) + '\n'
    );
    cat.apply({ kind: 'rename', path: join(DIR, 'a.jsonl'), name: 'Disk rename' });
    const infos = await cat.list();
    expect(infos[0].name).toBe('Disk rename');
  });

  it('remove drops overlay and re-scans without the deleted file', async () => {
    const path = writeSession('a.jsonl', { id: 's1', ts: '2026-01-01T00:00:00.000Z' });
    const cat = newCatalog();
    cat.apply({ kind: 'upsert', session: makeInfo({ id: 's1' }) });
    expect(await cat.list()).toHaveLength(1);

    rmSync(path);
    cat.apply({ kind: 'remove', path: '/tmp/whatever.jsonl' });
    expect(await cat.list()).toHaveLength(0);
  });

  it('listForCwd filters the merged list', async () => {
    writeSession('a.jsonl', { id: 's1', ts: '2026-01-01T00:00:00.000Z' });
    const cat = newCatalog();
    cat.apply({ kind: 'upsert', session: makeInfo({ id: 'mem-1', cwd: CWD }) });
    cat.apply({ kind: 'upsert', session: makeInfo({ id: 'mem-2', cwd: '/other/proj' }) });
    const infos = await cat.listForCwd(CWD);
    expect(infos.map((i) => i.id).sort()).toEqual(['mem-1', 's1']);
  });

  it('fresh bypasses the scan cache', async () => {
    const path = writeSession('a.jsonl', {
      id: 's1',
      ts: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', text: 'one', ts: 1_000 }],
    });
    const cat = newCatalog();
    expect((await cat.list())[0].messageCount).toBe(1);

    // External change (e.g. the pi TUI) after the scan was cached.
    appendFileSync(
      path,
      JSON.stringify({
        type: 'message',
        id: 'm9',
        timestamp: '2026-01-02T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], timestamp: 2_000 },
      }) + '\n'
    );
    expect((await cat.list())[0].messageCount).toBe(1); // cached
    expect((await cat.list({ fresh: true }))[0].messageCount).toBe(2); // re-scan
  });

  it('onChange fires per apply and unsubscribe works', () => {
    const cat = newCatalog();
    const cb = vi.fn();
    const off = cat.onChange(cb);
    cat.apply({ kind: 'upsert', session: makeInfo({ id: 'mem-1' }) });
    cat.apply({ kind: 'release', id: 'mem-1' });
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    cat.apply({ kind: 'upsert', session: makeInfo({ id: 'mem-1' }) });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('skip-paths: pooled files are not re-parsed while resident', async () => {
    const path = writeSession('a.jsonl', {
      id: 's1',
      ts: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', text: 'one', ts: 1_000 }],
    });
    const cat = newCatalog();
    cat.apply({ kind: 'upsert', session: makeInfo({ id: 's1', messageCount: 1, path }) });
    await cat.list();

    // Change the file on disk while pooled — the scan must not see it.
    appendFileSync(
      path,
      JSON.stringify({
        type: 'message',
        id: 'm9',
        timestamp: '2026-01-02T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], timestamp: 2_000 },
      }) + '\n'
    );
    const whilePooled = await cat.list();
    expect(whilePooled[0].messageCount).toBe(1); // overlay truth

    // After release, the stat sees the change and re-parses.
    cat.apply({ kind: 'release', id: 's1' });
    const afterRelease = await cat.list();
    expect(afterRelease[0].messageCount).toBe(2);
  });
});
