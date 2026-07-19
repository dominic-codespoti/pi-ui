import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/pi-ui-test-registry-' + Date.now();
const ORIG_HOME = process.env.HOME;

beforeEach(() => {
  process.env.HOME = TEST_HOME;
  // Ensure the dir exists so mkdirSync in touchProject doesn't fail
  mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(async () => {
  process.env.HOME = ORIG_HOME;
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function freshImports() {
  vi.resetModules();
  return await import('../project-registry');
}

describe('project-registry', () => {
  it('listProjects returns empty array initially', async () => {
    const { listProjects } = await freshImports();
    expect(listProjects()).toEqual([]);
  });

  it('touchProject creates a new record', async () => {
    const { listProjects, touchProject } = await freshImports();
    const rec = touchProject('/home/user/project');
    expect(rec.path).toBe('/home/user/project');
    expect(rec.pinned).toBe(false);
    expect(listProjects()).toHaveLength(1);
  });

  it('touchProject updates lastOpened on existing', async () => {
    const { touchProject } = await freshImports();
    const rec1 = touchProject('/p');
    const rec2 = touchProject('/p');
    expect(rec2.lastOpened).toBeGreaterThanOrEqual(rec1.lastOpened);
  });

  it('removeProject removes existing record', async () => {
    const { listProjects, touchProject, removeProject } = await freshImports();
    touchProject('/p');
    expect(removeProject('/p')).toBe(true);
    expect(listProjects()).toHaveLength(0);
  });

  it('removeProject returns false for unknown path', async () => {
    const { removeProject } = await freshImports();
    expect(removeProject('/nope')).toBe(false);
  });

  it('setProjectPinned pins and unpins', async () => {
    const { listProjects, touchProject, setProjectPinned } = await freshImports();
    touchProject('/p');
    setProjectPinned('/p', true);
    expect(listProjects().find((r) => r.path === '/p')?.pinned).toBe(true);
    setProjectPinned('/p', false);
    expect(listProjects().find((r) => r.path === '/p')?.pinned).toBe(false);
  });

  it('setProjectPinned upserts when path unknown', async () => {
    const { listProjects, setProjectPinned } = await freshImports();
    setProjectPinned('/new', true);
    expect(listProjects().find((r) => r.path === '/new')?.pinned).toBe(true);
  });

  it('renameProject sets custom name', async () => {
    const { listProjects, touchProject, renameProject } = await freshImports();
    touchProject('/p');
    renameProject('/p', 'My Proj');
    expect(listProjects().find((r) => r.path === '/p')?.name).toBe('My Proj');
  });

  it('renameProject clears name on empty string', async () => {
    const { listProjects, touchProject, renameProject } = await freshImports();
    touchProject('/p');
    renameProject('/p', 'My Proj');
    renameProject('/p', '');
    expect(listProjects().find((r) => r.path === '/p')?.name).toBeUndefined();
  });

  it('renameProject upserts when path unknown', async () => {
    const { listProjects, renameProject } = await freshImports();
    renameProject('/new', 'New Proj');
    expect(listProjects().find((r) => r.path === '/new')?.name).toBe('New Proj');
  });

  it('persists to disk across imports', async () => {
    const mod1 = await freshImports();
    mod1.touchProject('/persist-test');
    const mod2 = await freshImports();
    const projects = mod2.listProjects();
    expect(projects.find((r) => r.path === '/persist-test')).toBeTruthy();
  });
});
