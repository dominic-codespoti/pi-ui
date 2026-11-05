import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeSearchQuery,
  searchSessionContent,
  type ContentSearchFile,
} from '../session-content-search';

const ROOT = `/tmp/pi-ui-test-content-search-${process.pid}`;

function session(
  name: string,
  modified: number,
  messages: Array<{ role: string; text: string | unknown[] }>
): ContentSearchFile {
  const path = join(ROOT, `${name}.jsonl`);
  const lines = [JSON.stringify({ type: 'session', id: name, cwd: '/w', timestamp: 'x' })];
  messages.forEach((m, i) =>
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `${name}-${i}`,
        timestamp: '2026-11-05T00:00:00.000Z',
        message: {
          role: m.role,
          content: typeof m.text === 'string' ? [{ type: 'text', text: m.text }] : m.text,
        },
      })
    )
  );
  writeFileSync(path, lines.join('\n') + '\n');
  return { path, id: name, cwd: '/w', firstMessage: 'first', modified: new Date(modified) };
}

describe('searchSessionContent', () => {
  let files: ContentSearchFile[];
  beforeAll(() => {
    mkdirSync(ROOT, { recursive: true });
    files = [
      session('old', 1, [{ role: 'user', text: 'The Voynich manuscript cipher' }]),
      session('new', 2, [
        { role: 'user', text: 'nothing here' },
        { role: 'assistant', text: 'Discussing the VOYNICH theory at length' },
        { role: 'assistant', text: 'voynich again' },
      ]),
      session('tools', 3, [
        { role: 'toolResult', text: 'voynich inside a tool result is ignored' },
        { role: 'assistant', text: [{ type: 'thinking', thinking: 'voynich in thinking' }] },
      ]),
      session('quote', 0, [{ role: 'user', text: 'say "hello world" please' }]),
    ];
  });
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  it('finds case-insensitive matches in user/assistant text, newest first', async () => {
    const res = await searchSessionContent(files, 'voynich');
    expect(res.results.map((r) => r.sessionId)).toEqual(['new', 'old']);
    expect(res.results[0]).toMatchObject({ matchCount: 2 });
    const first = res.results[0]!.matches[0]!;
    expect(first.role).toBe('assistant');
    expect(first.snippet.slice(first.matchStart, first.matchStart + first.matchLength)).toBe(
      'VOYNICH'
    );
    expect(res.scannedFiles).toBe(4);
    expect(res.truncated).toBe(false);
  });

  it('matches queries containing JSON-escaped characters', async () => {
    const res = await searchSessionContent(files, '"hello world"');
    expect(res.results.map((r) => r.sessionId)).toEqual(['quote']);
  });

  it('caps sessions and matches per session, reporting truncation', async () => {
    const res = await searchSessionContent(files, 'voynich', {
      maxSessions: 1,
      maxMatchesPerSession: 1,
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.matches).toHaveLength(1);
    expect(res.results[0]!.matchCount).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it('stops on abort or deadline', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = await searchSessionContent(files, 'voynich', { signal: controller.signal });
    expect(aborted).toMatchObject({ results: [], truncated: true, scannedFiles: 0 });
    let t = 0;
    const late = await searchSessionContent(files, 'voynich', {
      deadlineMs: 5,
      now: () => (t += 10),
    });
    expect(late.truncated).toBe(true);
  });

  it('normalizes queries', () => {
    expect(normalizeSearchQuery('  a ')).toBeNull();
    expect(normalizeSearchQuery('ab')).toBe('ab');
    expect(normalizeSearchQuery(42)).toBeNull();
    expect(normalizeSearchQuery('x'.repeat(500))?.length).toBe(200);
  });
});
