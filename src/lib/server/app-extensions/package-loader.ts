/**
 * Server-side loader for trusted app-extension package folders.
 *
 * SERVER-ONLY: uses node:fs/node:url dynamic import. A package folder
 * contains `pi-ui.extension.json`; the manifest is validated with the shared
 * `parseAppExtensionManifest()` parser and the `serverEntry` module's default
 * export (or named `extension` export) must be a handler-map object
 * `{ reads?, actions? }` suitable for `AppExtensionRuntime.register()`.
 *
 * Trust boundary: package code is explicitly trusted executable code. This
 * loader does NOT sandbox it, does NOT run install scripts, and does NOT
 * install dependencies — it only reads the manifest JSON and dynamically
 * imports the declared `serverEntry` module.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAppExtensionManifest } from '../../app-extensions/manifest.ts';
import type { AppExtensionManifest } from '../../app-extensions/types.ts';
import type { AppExtensionHandlerMaps } from './runtime.ts';

/** Manifest file present at the root of every extension package folder. */
export const APP_EXTENSION_MANIFEST_FILENAME = 'pi-ui.extension.json';

export type AppExtensionPackageErrorCode =
  | 'invalid-manifest'
  | 'invalid-entry'
  | 'missing-file'
  | 'outside-root'
  | 'invalid-module';

export class AppExtensionPackageError extends Error {
  readonly code: AppExtensionPackageErrorCode;
  constructor(code: AppExtensionPackageErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts as ErrorOptions);
    this.name = 'AppExtensionPackageError';
    this.code = code;
  }
}

export interface LoadedAppExtensionPackage {
  manifest: AppExtensionManifest;
  handlers: AppExtensionHandlerMaps;
  /** Canonical (symlink-resolved) package root. */
  packageRoot: string;
  /** Canonical absolute path of the validated client entry file. */
  clientEntryPath: string;
  /** Canonical absolute path of the validated server entry module. */
  serverEntryPath: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Defensive entry-path shape check mirroring the manifest schema: relative,
 * forward-slash, no `..`/empty segments, no query/fragment, no null bytes.
 * The shared parser already enforces this for `clientEntry`; `serverEntry`
 * is re-checked here so the loader stays safe while the parallel parser
 * change lands.
 */
function assertSafeEntryPath(entry: string, label: 'clientEntry' | 'serverEntry'): void {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new AppExtensionPackageError(
      'invalid-entry',
      `extension ${label} must be a non-empty path`,
    );
  }
  if (entry.includes('\0')) {
    throw new AppExtensionPackageError(
      'invalid-entry',
      `extension ${label} must not contain null bytes`,
    );
  }
  if (entry.includes('\\')) {
    throw new AppExtensionPackageError(
      'invalid-entry',
      `extension ${label} must use forward slashes`,
    );
  }
  if (entry.includes('?') || entry.includes('#')) {
    throw new AppExtensionPackageError(
      'invalid-entry',
      `extension ${label} must not contain a query string or fragment`,
    );
  }
  if (isAbsolute(entry) || /^[a-zA-Z]:/.test(entry)) {
    throw new AppExtensionPackageError(
      'outside-root',
      `extension ${label} must be a relative path (got ${JSON.stringify(entry)})`,
    );
  }
  const segments = entry.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new AppExtensionPackageError(
        'invalid-entry',
        `extension ${label} must not contain empty path segments`,
      );
    }
    if (segment === '..') {
      throw new AppExtensionPackageError(
        'outside-root',
        `extension ${label} must not contain ".." segments`,
      );
    }
  }
}

/**
 * Resolve a package-relative asset path to a canonical absolute file path.
 * Rejects absolute paths, `..` escape, null bytes, ambiguous separators,
 * missing files, and symlink escapes (a symlink inside the package pointing
 * outside the canonical root). Returned path is guaranteed inside the root.
 */
export function resolvePackageAsset(packageRoot: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new AppExtensionPackageError('invalid-entry', 'asset path must be a non-empty string');
  }
  if (relativePath.includes('\0')) {
    throw new AppExtensionPackageError('invalid-entry', 'asset path must not contain null bytes');
  }
  if (relativePath.includes('\\')) {
    throw new AppExtensionPackageError(
      'invalid-entry',
      'asset path must use forward slashes (backslashes are ambiguous)',
    );
  }
  if (relativePath.includes('?') || relativePath.includes('#')) {
    throw new AppExtensionPackageError(
      'invalid-entry',
      'asset path must not contain a query string or fragment',
    );
  }
  if (isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    throw new AppExtensionPackageError(
      'outside-root',
      `asset path must be package-relative (got ${JSON.stringify(relativePath)})`,
    );
  }
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new AppExtensionPackageError(
        'invalid-entry',
        'asset path must not contain empty path segments',
      );
    }
    if (segment === '..') {
      throw new AppExtensionPackageError(
        'outside-root',
        'asset path must not contain ".." segments',
      );
    }
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(packageRoot);
  } catch (err) {
    throw new AppExtensionPackageError(
      'missing-file',
      `extension package root not found: ${packageRoot}`,
      { cause: err },
    );
  }
  const joined = resolve(canonicalRoot, relativePath);
  if (joined !== canonicalRoot && !joined.startsWith(canonicalRoot + sep)) {
    throw new AppExtensionPackageError(
      'outside-root',
      `asset path escapes the package root: ${JSON.stringify(relativePath)}`,
    );
  }
  let real: string;
  try {
    real = realpathSync(joined);
  } catch (err) {
    throw new AppExtensionPackageError('missing-file', `extension asset not found: ${relativePath}`, {
      cause: err,
    });
  }
  if (real !== canonicalRoot && !real.startsWith(canonicalRoot + sep)) {
    throw new AppExtensionPackageError(
      'outside-root',
      `asset symlink escapes the package root: ${JSON.stringify(relativePath)}`,
    );
  }
  return real;
}

/** Validate the imported server module's handler-map shape. */
function toHandlerMaps(candidate: unknown, serverEntryPath: string): AppExtensionHandlerMaps {
  if (!isPlainRecord(candidate)) {
    throw new AppExtensionPackageError(
      'invalid-module',
      `extension server module at ${serverEntryPath} must export a handler-map object with optional reads/actions`,
    );
  }
  const reads = (candidate as { reads?: unknown }).reads ?? {};
  const actions = (candidate as { actions?: unknown }).actions ?? {};
  if ('reads' in candidate && !isPlainRecord(reads)) {
    throw new AppExtensionPackageError(
      'invalid-module',
      `extension server module at ${serverEntryPath}: reads must be an object`,
    );
  }
  if ('actions' in candidate && !isPlainRecord(actions)) {
    throw new AppExtensionPackageError(
      'invalid-module',
      `extension server module at ${serverEntryPath}: actions must be an object`,
    );
  }
  for (const [id, fn] of Object.entries(reads as Record<string, unknown>)) {
    if (typeof fn !== 'function') {
      throw new AppExtensionPackageError(
        'invalid-module',
        `extension server module at ${serverEntryPath}: read handler "${id}" is not a function`,
      );
    }
  }
  for (const [id, fn] of Object.entries(actions as Record<string, unknown>)) {
    if (typeof fn !== 'function') {
      throw new AppExtensionPackageError(
        'invalid-module',
        `extension server module at ${serverEntryPath}: action handler "${id}" is not a function`,
      );
    }
  }
  return {
    reads: reads as AppExtensionHandlerMaps['reads'],
    actions: actions as AppExtensionHandlerMaps['actions'],
  };
}

function ensureFile(path: string, label: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (err) {
    throw new AppExtensionPackageError('missing-file', `extension ${label} not found: ${path}`, {
      cause: err,
    });
  }
  if (!stat.isFile()) {
    throw new AppExtensionPackageError(
      'invalid-entry',
      `extension ${label} is not a file: ${path}`,
    );
  }
}

/**
 * Stage a content-addressed copy of the package and return the server entry inside it.
 *
 * Bun — the only runtime pi-ui supports, since `bin/pifrontier` execs it — keys its module
 * cache on the resolved real path. It ignores `?v=` query strings, symlinks pointing at the same
 * real path, and changed file content, so a stat-based query cannot invalidate an already-imported
 * server entry. Importing from a copy at a different path is the mechanism that does work: the
 * cache cannot match it, and copying the whole tree keeps the entry's relative imports working.
 *
 * Only the server entry is imported from the copy. Browser assets are still served from the
 * installed path, so the existing asset containment checks are untouched. An extension that
 * locates its own files through `import.meta.url` sees the cache path rather than the install
 * path.
 */
function stagePackageForImport(
  runtimeCacheRoot: string,
  packageRoot: string,
  serverEntryPath: string
): string {
  const entryStat = statSync(serverEntryPath);
  const fingerprint = `${entryStat.mtimeMs}-${entryStat.size}`;
  const slug = basename(packageRoot).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
  mkdirSync(runtimeCacheRoot, { recursive: true, mode: 0o700 });
  const dir = join(runtimeCacheRoot, `${slug}-${fingerprint}`);
  if (!existsSync(join(dir, APP_EXTENSION_MANIFEST_FILENAME))) {
    rmSync(dir, { recursive: true, force: true });
    cpSync(packageRoot, dir, { recursive: true });
  }
  // Keep only the fingerprint just used, so a run of edits cannot grow the cache without bound.
  const keep = `${slug}-${fingerprint}`;
  for (const name of readdirSync(runtimeCacheRoot)) {
    if (name.startsWith(`${slug}-`) && name !== keep) {
      rmSync(join(runtimeCacheRoot, name), { recursive: true, force: true });
    }
  }
  return join(dir, relative(packageRoot, serverEntryPath));
}

/**
 * Load a trusted extension package folder: parse + validate the manifest,
 * resolve both entries inside the canonical root, and dynamically import the
 * server module. The import comes from a content-addressed copy (see
 * `stagePackageForImport`) so that editing an enabled extension and reloading it
 * takes effect without restarting the host.
 */
export async function loadAppExtensionPackage(
  packageDir: string,
  options: { runtimeCacheRoot?: string } = {},
): Promise<LoadedAppExtensionPackage> {
  // Set only when the host supplies a cache location; without it the import falls back to the
  // installed path (fine for a first load, but a later reload would reuse the cached module).
  const runtimeCacheRoot = options.runtimeCacheRoot;
  let packageRoot: string;
  try {
    packageRoot = realpathSync(packageDir);
  } catch (err) {
    throw new AppExtensionPackageError(
      'missing-file',
      `extension package not found: ${packageDir}`,
      { cause: err },
    );
  }
  let rootStat: ReturnType<typeof statSync>;
  try {
    rootStat = statSync(packageRoot);
  } catch (err) {
    throw new AppExtensionPackageError(
      'missing-file',
      `extension package not found: ${packageDir}`,
      { cause: err },
    );
  }
  if (!rootStat.isDirectory()) {
    throw new AppExtensionPackageError(
      'invalid-entry',
      `extension package is not a directory: ${packageDir}`,
    );
  }

  const manifestPath = join(packageRoot, APP_EXTENSION_MANIFEST_FILENAME);
  let rawText: string;
  try {
    rawText = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new AppExtensionPackageError(
      'missing-file',
      `extension manifest not found: ${manifestPath}`,
      { cause: err },
    );
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (err) {
    throw new AppExtensionPackageError(
      'invalid-manifest',
      `extension manifest is not valid JSON: ${manifestPath}`,
      { cause: err },
    );
  }
  const parsed = parseAppExtensionManifest(rawJson);
  if (!parsed.ok) {
    throw new AppExtensionPackageError(
      'invalid-manifest',
      `invalid extension manifest: ${parsed.issues.join('; ')}`,
    );
  }

  // `serverEntry` is required by the shared contract; fall back to the raw
  // JSON value while the parallel parser change lands (looseObject keeps
  // unknown keys, so parsed usually already carries it).
  const rawRecord = (isPlainRecord(rawJson) ? rawJson : {}) as Record<string, unknown>;
  const parsedRecord = parsed.value as unknown as Record<string, unknown>;
  const clientEntry = parsedRecord['clientEntry'] as unknown;
  const serverEntry = (parsedRecord['serverEntry'] ?? rawRecord['serverEntry']) as unknown;
  if (typeof clientEntry !== 'string' || clientEntry.length === 0) {
    throw new AppExtensionPackageError(
      'invalid-manifest',
      'extension manifest requires a non-empty clientEntry',
    );
  }
  if (typeof serverEntry !== 'string' || serverEntry.length === 0) {
    throw new AppExtensionPackageError(
      'invalid-manifest',
      'extension manifest requires a non-empty serverEntry',
    );
  }
  assertSafeEntryPath(clientEntry, 'clientEntry');
  assertSafeEntryPath(serverEntry, 'serverEntry');

  const clientEntryPath = resolvePackageAsset(packageRoot, clientEntry);
  const serverEntryPath = resolvePackageAsset(packageRoot, serverEntry);
  ensureFile(clientEntryPath, 'clientEntry');
  ensureFile(serverEntryPath, 'serverEntry');

  const importPath = runtimeCacheRoot
    ? stagePackageForImport(runtimeCacheRoot, packageRoot, serverEntryPath)
    : serverEntryPath;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ pathToFileURL(importPath).href)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    throw new AppExtensionPackageError(
      'invalid-module',
      `failed to import extension server module at ${serverEntryPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const candidate =
    (mod as { default?: unknown }).default ?? (mod as { extension?: unknown }).extension;
  if (candidate === undefined) {
    throw new AppExtensionPackageError(
      'invalid-module',
      `extension server module at ${serverEntryPath} must have a default export (or named "extension" export)`,
    );
  }
  const handlers = toHandlerMaps(candidate, serverEntryPath);
  const manifest = {
    ...(parsed.value as unknown as Record<string, unknown>),
    clientEntry,
    serverEntry,
  } as unknown as AppExtensionManifest;
  return { manifest, handlers, packageRoot, clientEntryPath, serverEntryPath };
}
