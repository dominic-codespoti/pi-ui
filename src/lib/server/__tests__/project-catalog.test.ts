import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { clearSessionScanCache } from '../session-scan';
import type { SessionCatalog } from '../session-catalog';
import type { ProjectCatalog } from '../project-catalog';

const TEST_HOME = '/tmp/pi-ui-test-project-catalog-' + Date.now();
const ORIG_HOME = process.env.HOME;
const SESSIONS_ROOT = '/tmp/pi-ui-test-project-catalog-sessions-' + Date.now();

let sessions: SessionCatalog;
let catalog: ProjectCatalog;

beforeEach(async () => {
  process.env.HOME = TEST_HOME;
  mkdirSync(TEST_HOME, { recursive: true });
  mkdirSync(SESSIONS_ROOT, { recursive: true });
  clearSessionScanCache();
  vi.resetModules();
  const { SessionCatalog: SC } = await import('../session-catalog');
  const { ProjectCatalog: PC } = await import('../project-catalog');
  sessions = new SC(() => SESSIONS_ROOT);
  catalog = new PC(sessions);
});

afterEach(() => {
  process.env.HOME = ORIG_HOME;
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
    rmSync(SESSIONS_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function upsertSession(id: string, cwd: string, modified: number, count = 1): void {
  sessions.apply({
    kind: 'upsert',
    session: {
      path: `/sessions/${id}.jsonl`,
      id,
      cwd,
      created: new Date(1_700_000_000_000),
      modified: new Date(modified),
      messageCount: count,
      firstMessage: `msg from ${id}`,
    },
  });
}

describe('project-catalog', () => {
  it('merges registry records with live session counts and existence', async () => {
    catalog.apply({ kind: 'touch', path: '/proj/a' }); // registered, dir exists
    upsertSession('s1', '/proj/a', 1_700_000_100_000);
    upsertSession('s2', '/proj/a', 1_700_000_200_000);
    upsertSession('s3', '/proj/b', 1_700_000_300_000); // unregistered project

    const projects = await catalog.list();
    expect(projects).toHaveLength(2);
    const a = projects.find((p) => p.cwd === '/proj/a')!;
    expect(a.registered).toBe(true);
    expect(a.pinned).toBe(false);
    expect(a.sessionCount).toBe(2);
    // touch stamped lastOpened=now, which wins over the older session times.
    expect(a.lastActivity).toBeGreaterThanOrEqual(1_700_000_200_000);
    expect(a.exists).toBe(true); // touch stamped it
    const b = projects.find((p) => p.cwd === '/proj/b')!;
    expect(b.registered).toBe(false);
    expect(b.sessionCount).toBe(1);
    expect(b.lastActivity).toBe(1_700_000_300_000); // session-derived, no registry record
    expect(b.exists).toBe(false); // dir does not exist on disk
  });

  it('sorts pinned first, then by activity', async () => {
    catalog.apply({ kind: 'touch', path: '/proj/new' }); // lastOpened = now
    catalog.apply({ kind: 'setPinned', path: '/proj/old', pinned: true });
    upsertSession('s1', '/proj/old', 1_700_000_000_000);
    upsertSession('s2', '/proj/new', 1_700_000_100_000);

    const projects = await catalog.list();
    expect(projects.map((p) => p.cwd)).toEqual(['/proj/old', '/proj/new']);
  });

  it('setPinned upserts and toggles', async () => {
    catalog.apply({ kind: 'setPinned', path: '/proj/p', pinned: true });
    let projects = await catalog.list();
    expect(projects[0].pinned).toBe(true);
    expect(projects[0].registered).toBe(true);

    catalog.apply({ kind: 'setPinned', path: '/proj/p', pinned: false });
    projects = await catalog.list();
    expect(projects[0].pinned).toBe(false);
  });

  it('rename sets a custom name and empty clears it', async () => {
    catalog.apply({ kind: 'touch', path: '/proj/r' });
    catalog.apply({ kind: 'rename', path: '/proj/r', name: 'My Project' });
    expect((await catalog.list())[0].name).toBe('My Project');

    catalog.apply({ kind: 'rename', path: '/proj/r', name: '  ' });
    expect((await catalog.list())[0].name).toBe('r');
  });

  it('remove drops the record and the existence cache', async () => {
    catalog.apply({ kind: 'touch', path: '/proj/gone' });
    expect(await catalog.list()).toHaveLength(1);
    catalog.apply({ kind: 'remove', path: '/proj/gone' });
    expect(await catalog.list()).toHaveLength(0);
    expect(existsSync(join(TEST_HOME, '.pi', 'agent', 'pi-ui-projects.json'))).toBe(false);
  });

  it('onChange fires on apply, on session changes, and stops on unsubscribe', async () => {
    const events: string[] = [];
    const off = catalog.onChange(() => events.push('project'));
    catalog.apply({ kind: 'touch', path: '/proj/x' });
    upsertSession('s1', '/proj/x', 1_700_000_000_000); // session catalog emits → project catalog forwards
    expect(events).toEqual(['project', 'project']);
    off();
    catalog.apply({ kind: 'remove', path: '/proj/x' });
    expect(events).toEqual(['project', 'project']);
  });

  it('persists debounced writes on flush', async () => {
    catalog.apply({ kind: 'touch', path: '/proj/keep' });
    catalog.apply({ kind: 'setPinned', path: '/proj/keep', pinned: true });
    await catalog.flush();

    vi.resetModules();
    const { loadProjectRecords } = await import('../project-registry');
    expect(loadProjectRecords()).toEqual([
      { path: '/proj/keep', pinned: true, lastOpened: expect.any(Number) },
    ]);
  });
});
