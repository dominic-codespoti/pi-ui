import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectRecord } from '../project-registry';

const TEST_HOME = '/tmp/pi-ui-test-registry-' + Date.now();
const ORIG_HOME = process.env.HOME;

beforeEach(() => {
  process.env.HOME = TEST_HOME;
  // Ensure the dir exists so the registry save's mkdirSync doesn't fail
  mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  process.env.HOME = ORIG_HOME;
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function freshRegistry() {
  vi.resetModules();
  return await import('../project-registry');
}

describe('project-registry', () => {
  it('loads empty when no file exists', async () => {
    const { loadProjectRecords } = await freshRegistry();
    expect(loadProjectRecords()).toEqual([]);
  });

  it('persists records and reloads them', async () => {
    const records: ProjectRecord[] = [
      { path: '/proj/a', name: 'Alpha', pinned: true, lastOpened: 123 },
      { path: '/proj/b', pinned: false, lastOpened: 456 },
    ];
    const { saveProjectRecords } = await freshRegistry();
    saveProjectRecords(records);
    const reloaded = await freshRegistry();
    expect(reloaded.loadProjectRecords()).toEqual(records);
  });

  it('starts empty on a corrupt file', async () => {
    const registryDir = join(TEST_HOME, '.pi', 'agent');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, 'pi-ui-projects.json'), 'not json at all');
    const { loadProjectRecords } = await freshRegistry();
    expect(loadProjectRecords()).toEqual([]);
  });

  it('drops invalid records on load', async () => {
    const registryDir = join(TEST_HOME, '.pi', 'agent');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, 'pi-ui-projects.json'),
      JSON.stringify({
        projects: [
          { path: '/proj/a', pinned: true, lastOpened: 1 },
          { pinned: false, lastOpened: 2 }, // no path — dropped
          { path: '', pinned: false, lastOpened: 3 }, // empty path — dropped
        ],
      })
    );
    const { loadProjectRecords } = await freshRegistry();
    expect(loadProjectRecords()).toEqual([{ path: '/proj/a', pinned: true, lastOpened: 1 }]);
  });

  it('normalizes pinned and drops whitespace-only names on load', async () => {
    const registryDir = join(TEST_HOME, '.pi', 'agent');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, 'pi-ui-projects.json'),
      JSON.stringify({
        projects: [
          { path: '/proj/a', name: '  spaced name  ', pinned: 1, lastOpened: 7 },
          { path: '/proj/b', name: '   ', pinned: 0, lastOpened: 8 },
        ],
      })
    );
    const { loadProjectRecords } = await freshRegistry();
    expect(loadProjectRecords()).toEqual([
      { path: '/proj/a', name: '  spaced name  ', pinned: true, lastOpened: 7 },
      { path: '/proj/b', pinned: false, lastOpened: 8 },
    ]);
  });
});
