import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectExtensionChangelogUpdates,
  formatExtensionChangelogNotice,
  type ExtensionChangelogSettings,
} from '../extension-changelog.ts';
import { getExtensionChangelogDeps } from '../slash-command-catalog.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function packageDir(version: string, changelog: string, name = 'pi-demo-ext'): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-ui-ext-changelog-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

function memorySettings(initial: Record<string, string> = {}) {
  const versions = new Map(Object.entries(initial));
  const settings: ExtensionChangelogSettings = {
    getExtensionChangelogVersion: (key) => versions.get(key),
    setExtensionChangelogVersion: (key, version) => void versions.set(key, version),
  };
  return { settings, versions };
}

const CHANGELOG = `# Changelog

## [1.2.0] - 2026-11-01

- Added the shiny thing

## [1.1.0] - 2026-10-01

- Fixed the old thing

## [1.0.0] - 2026-09-01

- Initial release
`;

describe('extension changelogs (real SDK parser)', () => {
  it('records a fresh install silently, then shows only newer entries once', async () => {
    const deps = await getExtensionChangelogDeps();
    const baseDir = packageDir('1.2.0', CHANGELOG);
    const sourceInfo = {
      source: 'npm:pi-demo-ext',
      scope: 'user',
      origin: 'package',
      baseDir,
      changelogPath: join(baseDir, 'CHANGELOG.md'),
    };
    const key = deps.getSourcePackageKey(sourceInfo);

    const fresh = memorySettings();
    expect(collectExtensionChangelogUpdates([{ sourceInfo }], fresh.settings, deps)).toEqual([]);
    expect(fresh.versions.get(key)).toBe('1.2.0');

    const upgraded = memorySettings({ [key]: '1.0.0' });
    const updates = collectExtensionChangelogUpdates(
      [{ sourceInfo }, { sourceInfo }],
      upgraded.settings,
      deps
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].version).toBe('1.2.0');
    expect(updates[0].markdown).toContain('## pi-demo-ext [1.2.0]');
    expect(updates[0].markdown).toContain('## pi-demo-ext [1.1.0]');
    expect(updates[0].markdown).not.toContain('Initial release');
    expect(upgraded.versions.get(key)).toBe('1.2.0');

    // Shown once: the recorded version suppresses a repeat.
    expect(collectExtensionChangelogUpdates([{ sourceInfo }], upgraded.settings, deps)).toEqual([]);
  });

  it('ignores non-package extensions and packages without a changelog', async () => {
    const deps = await getExtensionChangelogDeps();
    const { settings, versions } = memorySettings();
    const updates = collectExtensionChangelogUpdates(
      [
        { sourceInfo: { source: 'local', scope: 'user', origin: 'top-level', baseDir: '/x' } },
        { sourceInfo: { source: 'npm:a', scope: 'user', origin: 'package', baseDir: '/x' } },
      ],
      settings,
      deps
    );
    expect(updates).toEqual([]);
    expect(versions.size).toBe(0);
  });
});

describe('formatExtensionChangelogNotice', () => {
  const updates = [
    { name: 'pi-a', version: '2.0.0', markdown: '## pi-a [2.0.0]\n\n- new' },
    { name: 'pi-b', version: '1.1.0', markdown: '## pi-b [1.1.0]\n\n- fix' },
  ];

  it('renders full entries under a heading', () => {
    const text = formatExtensionChangelogNotice(updates, false);
    expect(text.startsWith('**Extension Updates**')).toBe(true);
    expect(text).toContain('## pi-b [1.1.0]');
  });

  it('collapses to one line per package', () => {
    expect(formatExtensionChangelogNotice(updates, true)).toBe(
      'Updated pi-a to v2.0.0.\nUpdated pi-b to v1.1.0.'
    );
    expect(formatExtensionChangelogNotice([], false)).toBe('');
  });
});
