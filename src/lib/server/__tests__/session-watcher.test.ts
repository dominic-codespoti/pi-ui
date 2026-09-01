import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSessionWatch } from '../session-watcher';

const ROOT = '/tmp/pi-ui-test-session-watch-' + Date.now();

const stopHandles: (() => void)[] = [];

afterEach(() => {
  for (const stop of stopHandles) stop();
  stopHandles.length = 0;
  rmSync(ROOT, { recursive: true, force: true });
});

describe('session-watcher', () => {
  it('fires onDirty after an external append to a nested .jsonl', async () => {
    const dir = join(ROOT, '--tmp-proj--');
    mkdirSync(dir, { recursive: true });
    let fired = 0;
    const stop = startSessionWatch(
      () => ROOT,
      () => fired++
    );
    if (stop) stopHandles.push(stop);

    writeFileSync(
      join(dir, '2026-01-01T00-00-00-000Z_s1.jsonl'),
      JSON.stringify({ type: 'message' }) + '\n'
    );
    await new Promise((r) => setTimeout(r, 1200));
    expect(fired).toBeGreaterThan(0);
  });

  it('ignores non-jsonl writes', async () => {
    mkdirSync(ROOT, { recursive: true });
    let fired = 0;
    const stop = startSessionWatch(
      () => ROOT,
      () => fired++
    );
    if (stop) stopHandles.push(stop);

    writeFileSync(join(ROOT, 'scan-cache.json'), '{}');
    await new Promise((r) => setTimeout(r, 1200));
    expect(fired).toBe(0);
  });

  it('survives a missing root without throwing', () => {
    expect(() => {
      const stop = startSessionWatch(
        () => join(ROOT, 'does-not-exist'),
        () => {}
      );
      if (stop) stopHandles.push(stop);
    }).not.toThrow();
  });
});
