/**
 * SDK 1.5 extension-package changelogs ("Extension Updates"). The SDK only
 * implements this inside its interactive TUI (`getExtensionChangelogUpdates`),
 * so pi-ui ports the same rules and feeds it the SDK's own changelog parser
 * and package-key helper (see `getExtensionChangelogDeps`):
 *
 * - only package extensions with a `changelogPath` (pi reads
 *   `pi.changelogPath` or the root `CHANGELOG.md`), one per package key;
 * - first sighting records the installed version without showing anything;
 * - later, entries newer than the last-seen version are shown once and the
 *   installed version is recorded;
 * - `collapseChangelog` condenses each package to one line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ChangelogEntry {
  major: number;
  minor: number;
  patch: number;
  content: string;
}

export interface ExtensionChangelogDeps {
  parseChangelog(path: string): ChangelogEntry[];
  getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[];
  getSourcePackageKey(identity: { source: string; scope: string }): string;
  readPackageJson?(baseDir: string): { name?: string; version?: string } | undefined;
}

export interface ExtensionChangelogSettings {
  getExtensionChangelogVersion(key: string): string | undefined;
  setExtensionChangelogVersion(key: string, version: string): void;
}

export interface ExtensionSourceInfo {
  source: string;
  scope: string;
  origin: string;
  baseDir?: string;
  changelogPath?: string;
}

export interface ExtensionChangelogUpdate {
  name: string;
  version: string;
  markdown: string;
}

function readPackageJson(baseDir: string): { name?: string; version?: string } | undefined {
  try {
    const raw = readFileSync(join(baseDir, 'package.json'), 'utf-8').replace(/^\uFEFF/, '');
    const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown };
    return {
      name: typeof pkg.name === 'string' ? pkg.name : undefined,
      version: typeof pkg.version === 'string' ? pkg.version : undefined,
    };
  } catch {
    return undefined;
  }
}

export function collectExtensionChangelogUpdates(
  extensions: ReadonlyArray<{ sourceInfo: ExtensionSourceInfo }>,
  settings: ExtensionChangelogSettings,
  deps: ExtensionChangelogDeps
): ExtensionChangelogUpdate[] {
  const readPkg = deps.readPackageJson ?? readPackageJson;
  const seen = new Set<string>();
  const updates: ExtensionChangelogUpdate[] = [];
  for (const { sourceInfo } of extensions) {
    if (sourceInfo.origin !== 'package' || !sourceInfo.baseDir || !sourceInfo.changelogPath) {
      continue;
    }
    const key = deps.getSourcePackageKey(sourceInfo);
    if (seen.has(key)) continue;
    seen.add(key);
    const pkg = readPkg(sourceInfo.baseDir);
    if (!pkg?.version) continue;
    const lastVersion = settings.getExtensionChangelogVersion(key);
    if (!lastVersion) {
      // Fresh install: record the version, show nothing.
      settings.setExtensionChangelogVersion(key, pkg.version);
      continue;
    }
    let entries: ChangelogEntry[];
    try {
      entries = deps.getNewEntries(deps.parseChangelog(sourceInfo.changelogPath), lastVersion);
    } catch {
      continue;
    }
    if (entries.length === 0) continue;
    settings.setExtensionChangelogVersion(key, pkg.version);
    const name = pkg.name || sourceInfo.source;
    // Prefix each "## [x.y.z]" heading with the package name, like pi's own notice.
    const markdown = entries
      .map((entry) => entry.content.replace(/^##\s+/, `## ${name} `))
      .join('\n\n')
      .trim();
    updates.push({ name, version: pkg.version, markdown });
  }
  return updates;
}

/** Markdown notice body: full entries, or one line per package when collapsed. */
export function formatExtensionChangelogNotice(
  updates: readonly ExtensionChangelogUpdate[],
  collapse: boolean
): string {
  if (updates.length === 0) return '';
  if (collapse) {
    return updates.map((update) => `Updated ${update.name} to v${update.version}.`).join('\n');
  }
  return `**Extension Updates**\n\n${updates.map((update) => update.markdown).join('\n\n')}`;
}
