import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, appendFileSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  scanAllSessions,
  scanSessionsForCwd,
  encodeSessionDirName,
  clearSessionScanCache,
  initSessionScanCache,
} from '../session-scan';

const ROOT = '/tmp/pi-ui-test-session-scan-' + Date.now();
const CWD = '/home/user/proj';
const DIR = join(ROOT, encodeSessionDirName(CWD));

function writeSession(
  file: string,
  opts: { id: string; ts: string; name?: string; messages?: { role: string; text: string; ts?: number }[] }
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

beforeEach(() => {
  clearSessionScanCache();
  mkdirSync(DIR, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('session-scan', () => {
  it('parses header, name, message count, and first user message', async () => {
    writeSession('a.jsonl', {
      id: 's1',
      ts: '2026-01-01T00:00:00.000Z',
      name: 'My session',
      messages: [
        { role: 'assistant', text: 'ignored for first-message' },
        { role: 'user', text: 'hello world' },
      ],
    });
    const infos = await scanAllSessions(ROOT);
    expect(infos).toHaveLength(1);
    expect(infos[0].id).toBe('s1');
    expect(infos[0].cwd).toBe(CWD);
    expect(infos[0].name).toBe('My session');
    expect(infos[0].messageCount).toBe(2);
    expect(infos[0].firstMessage).toBe('hello world');
  });

  it('sorts by last activity descending and skips invalid files', async () => {
    writeSession('old.jsonl', {
      id: 'old',
      ts: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', text: 'a', ts: 1_000 }],
    });
    writeSession('new.jsonl', {
      id: 'new',
      ts: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', text: 'b', ts: 2_000 }],
    });
    writeFileSync(join(DIR, 'junk.jsonl'), 'not json\n');
    writeFileSync(join(DIR, 'headerless.jsonl'), JSON.stringify({ type: 'message' }) + '\n');
    const infos = await scanAllSessions(ROOT);
    expect(infos.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('scanSessionsForCwd only sees the encoded project directory', async () => {
    writeSession('a.jsonl', { id: 's1', ts: '2026-01-01T00:00:00.000Z' });
    const otherDir = join(ROOT, encodeSessionDirName('/other/proj'));
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      join(otherDir, 'b.jsonl'),
      JSON.stringify({ type: 'session', id: 's2', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/other/proj' }) + '\n'
    );
    const infos = await scanSessionsForCwd(ROOT, CWD);
    expect(infos.map((i) => i.id)).toEqual(['s1']);
  });

  it('re-parses when a file changes and serves cache when it does not', async () => {
    const path = writeSession('a.jsonl', {
      id: 's1',
      ts: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', text: 'one', ts: 1_000 }],
    });
    const first = await scanAllSessions(ROOT);
    expect(first[0].messageCount).toBe(1);

    // Append a message — size+mtime change forces a re-parse.
    appendFileSync(
      path,
      JSON.stringify({
        type: 'message',
        id: 'm9',
        timestamp: '2026-01-02T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], timestamp: 2_000 },
      }) + '\n'
    );
    const second = await scanAllSessions(ROOT);
    expect(second[0].messageCount).toBe(2);

    // Unchanged stat → cached object identity is reused (no re-parse).
    utimesSync(path, new Date(5_000_000), new Date(5_000_000));
    const third = await scanAllSessions(ROOT);
    utimesSync(path, new Date(5_000_000), new Date(5_000_000));
    const fourth = await scanAllSessions(ROOT);
    expect(fourth[0]).toBe(third[0]);
  });

  it('drops results and cache entries for deleted files', async () => {
    const path = writeSession('a.jsonl', { id: 's1', ts: '2026-01-01T00:00:00.000Z' });
    expect(await scanAllSessions(ROOT)).toHaveLength(1);
    rmSync(path);
    expect(await scanAllSessions(ROOT)).toHaveLength(0);
  });

  it('persists summaries across restarts — unchanged files are not re-read', async () => {
    const cacheFile = join(ROOT, 'scan-cache.json');
    initSessionScanCache(cacheFile);
    const path = writeSession('a.jsonl', {
      id: 's1',
      ts: '2026-01-01T00:00:00.000Z',
      name: 'Original name',
      messages: [{ role: 'user', text: 'hello', ts: 1_000 }],
    });
    // Pin mtime to whole-millisecond precision — the fs may report fractional
    // ms that utimesSync can't reproduce, which would defeat the cache check.
    const pinned = new Date(1_700_000_000_000);
    utimesSync(path, pinned, pinned);
    const first = await scanAllSessions(ROOT);
    expect(first[0].name).toBe('Original name');
    expect(existsSync(cacheFile)).toBe(true);

    // Simulate a restart: wipe in-memory state, rewrite the session file with
    // identical size + mtime but different content. If the persisted cache is
    // honoured, the OLD summary comes back without the file being re-read.
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace('Original name', 'Tampered name'));
    utimesSync(path, pinned, pinned);

    clearSessionScanCache();
    initSessionScanCache(cacheFile);
    const second = await scanAllSessions(ROOT);
    expect(second[0].name).toBe('Original name');
    expect(second[0].id).toBe('s1');
    expect(second[0].messageCount).toBe(1);
    expect(second[0].modified.getTime()).toBe(first[0].modified.getTime());
  });

  it('starts empty on a corrupt cache file and re-parses', async () => {
    const cacheFile = join(ROOT, 'scan-cache.json');
    writeFileSync(cacheFile, 'not json at all');
    initSessionScanCache(cacheFile);
    writeSession('a.jsonl', { id: 's1', ts: '2026-01-01T00:00:00.000Z' });
    const infos = await scanAllSessions(ROOT);
    expect(infos).toHaveLength(1);
    expect(infos[0].id).toBe('s1');
  });
});
