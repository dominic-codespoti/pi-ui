import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getLastSession,
  readSettings,
  setLastSession,
  setUISettingsStoreDir,
} from '../ui-settings';

describe('ui-settings last session', () => {
  it('reads older files, then round-trips and clears the durable session pointer', () => {
    const home = mkdtempSync(join(homedir(), '.pi-ui-settings-test-'));
    const file = join(home, 'pi-ui-settings.json');
    mkdirSync(home, { recursive: true });
    writeFileSync(file, JSON.stringify({ settings: { theme: 'dark' } }));
    setUISettingsStoreDir(home);
    expect(getLastSession()).toBeUndefined();
    expect(readSettings()).toEqual({ theme: 'dark' });

    const entry = { path: '/tmp/project/session.jsonl', cwd: '/tmp/project' };
    setLastSession(entry);
    expect(getLastSession()).toEqual(entry);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      settings: { theme: 'dark' },
      lastSession: entry,
    });

    setLastSession(undefined);
    expect(getLastSession()).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      settings: { theme: 'dark' },
    });

    rmSync(home, { recursive: true, force: true });
  });
});
