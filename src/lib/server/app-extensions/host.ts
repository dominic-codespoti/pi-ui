/**
 * Server-side host for trusted app-extension package folders.
 *
 * TRUSTED CODE WARNING: extension packages are explicitly trusted executable
 * code — the same posture as `package-loader.ts` and `context.ts`. This host
 * does NOT sandbox extension code, does NOT run install scripts, and does NOT
 * install dependencies. It only reads `pi-ui.extension.json` manifests during
 * scans and dynamically imports a package's `serverEntry` module when (and
 * only when) that package is explicitly enabled via `setEnabled(id, true)`
 * (or restored via `init()`, which replays the same explicit-enable path for
 * previously persisted IDs). Disabled packages are never imported. There are
 * no sandbox or permission claims here — do not treat validation as isolation.
 *
 * Layout:
 * - `extensionsRoot`: directory whose direct child folders are explicit
 *   installed candidates. Each candidate must contain
 *   `pi-ui.extension.json`; the child directory basename must equal
 *   `manifest.id`.
 * - `dataRoot`: directory holding the enabled-IDs JSON file
 *   (`<dataRoot>/<enabledFileName>`, default `app-extensions.enabled.json`).
 *   Default is disabled: a missing/corrupt file means nothing is enabled.
 *
 * Scan safety (no code execution):
 * - Symlink package directories are rejected via `lstat` (never followed).
 * - Entry escapes are rejected with the existing loader helper
 *   `resolvePackageAsset()` (lexical + symlink-aware containment, missing-file
 *   checks). Both `clientEntry` and `serverEntry` must resolve inside the
 *   canonical package root.
 * - Manifests are parsed with the shared `parseAppExtensionManifest()` parser,
 *   which enforces every currently required field: `schemaVersion: 1`,
 *   `apiVersion`, non-empty `id`/`name`, semver `version`, relative
 *   `clientEntry`/`serverEntry`, `views[]`, and `operations[]` (plus
 *   uniqueness/operation-shape rules). Invalid packages are skipped with a
 *   diagnostic — one bad folder never takes down the rest.
 *
 * Testability: filesystem access (`readdir`/`lstat`/`readFile`/`writeFile`/
 * `rename`/`mkdir`/`unlink`), asset resolution, and the package loader are all
 * injectable via options so unit tests can use fakes without touching disk or
 * importing real extension code. Production defaults use `node:fs` sync APIs
 * and `loadAppExtensionPackage`.
 */

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { parseAppExtensionManifest } from '../../app-extensions/manifest.ts';
import type {
  AppExtensionCallContext,
  AppExtensionCapability,
  AppExtensionManifest,
  AppExtensionOperationDeclaration,
  AppExtensionSummary,
} from '../../app-extensions/types.ts';
import {
  APP_EXTENSION_MANIFEST_FILENAME,
  loadAppExtensionPackage,
  resolvePackageAsset,
  type LoadedAppExtensionPackage,
} from './package-loader.ts';
import { AppExtensionRuntime } from './runtime.ts';

/** File holding the persisted enabled-ID set under `dataRoot`. */
export const APP_EXTENSION_ENABLED_FILENAME = 'app-extensions.enabled.json';

/**
 * Private directory under `dataRoot` holding the content-addressed copies that
 * server entries are imported from. Created 0700; safe to delete at any time (a
 * reload recreates it).
 */
export const APP_EXTENSION_RUNTIME_CACHE_DIRNAME = 'app-extensions-runtime';

/** Persisted file version (forward-compat stamp; currently only `1` is written). */
const ENABLED_FILE_VERSION = 1;

export type AppExtensionHostErrorCode = 'not-installed' | 'disabled' | 'persistence-error';

export class AppExtensionHostError extends Error {
  readonly code: AppExtensionHostErrorCode;
  constructor(code: AppExtensionHostErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts as ErrorOptions);
    this.name = 'AppExtensionHostError';
    this.code = code;
  }
}

export interface AppExtensionHostDiagnostic {
  /** Package directory (or data root for persistence notes). */
  dir: string;
  /** Manifest id when known (basename-mismatch and parse failures may omit it). */
  extensionId?: string;
  code: string;
  message: string;
}

/** Minimal sync filesystem surface (injectable for tests). */
export interface AppExtensionHostFs {
  readdir(dir: string): string[];
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
  readFile(path: string, encoding: 'utf8'): string;
  writeFile(path: string, data: string, encoding: 'utf8'): void;
  rename(oldPath: string, newPath: string): void;
  mkdir(path: string, options: { recursive: boolean }): unknown;
  unlink(path: string): void;
}

const defaultFs: AppExtensionHostFs = {
  readdir: (dir) => readdirSync(dir),
  lstat: (path) => lstatSync(path),
  readFile: (path, encoding) => readFileSync(path, encoding),
  rename: (oldPath, newPath) => renameSync(oldPath, newPath),
  mkdir: (path, options) => mkdirSync(path, options),
  writeFile: (path, data, encoding) => writeFileSync(path, data, encoding),
  unlink: (path) => unlinkSync(path),
};

export type AppExtensionHostLoadPackage = (
  packageDir: string,
) => Promise<LoadedAppExtensionPackage>;

export type AppExtensionHostResolveAsset = (
  packageDir: string,
  relativePath: string,
) => string;

export interface AppExtensionHostOptions {
  /** Directory whose direct child folders are installed candidates. */
  extensionsRoot: string;
  /** Directory holding the enabled-IDs JSON file. */
  dataRoot: string;
  /** Enabled-file basename (default `app-extensions.enabled.json`). */
  enabledFileName?: string;
  /** Injected runtime (default a fresh `AppExtensionRuntime`). */
  runtime?: AppExtensionRuntime;
  /** Injected package loader (default `loadAppExtensionPackage`). */
  loadPackage?: AppExtensionHostLoadPackage;
  /** Injected asset resolver (default `resolvePackageAsset`). */
  resolveAsset?: AppExtensionHostResolveAsset;
  /** Partial filesystem overrides merged over the `node:fs` defaults. */
  fs?: Partial<AppExtensionHostFs>;
  /** Optional per-skip observer (in addition to `diagnostics()`). */
  onDiagnostic?: (diagnostic: AppExtensionHostDiagnostic) => void;
}

interface InstalledEntry {
  manifest: AppExtensionManifest;
  /** Package directory as joined from `extensionsRoot` (pre-canonical). */
  packageDir: string;
  /** Canonical absolute client entry (inside the package root). */
  clientEntryPath: string;
  /** Canonical absolute server entry (inside the package root). */
  serverEntryPath: string;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function diagnosticCodeOf(err: unknown): string {
  if (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return 'invalid-manifest';
}

/**
 * Normalize persisted enabled payloads. Accepts the canonical
 * `{ version: 1, enabled: [...] }`, the legacy `{ enabledIds: [...] }`, and a
 * bare `string[]`. Anything else yields an empty set.
 */
function parseEnabledIds(raw: unknown): Set<string> {
  const out = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) out.add(value);
  };
  if (Array.isArray(raw)) {
    for (const v of raw) push(v);
    return out;
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const list = rec['enabled'] ?? rec['enabledIds'];
    if (Array.isArray(list)) {
      for (const v of list) push(v);
    }
  }
  return out;
}

export class AppExtensionHost {
  private readonly extensionsRoot: string;
  private readonly dataRoot: string;
  private readonly enabledFileName: string;
  private readonly runtime: AppExtensionRuntime;
  private readonly loadPackage: AppExtensionHostLoadPackage;
  private readonly resolveAsset: AppExtensionHostResolveAsset;
  private readonly fs: AppExtensionHostFs;
  private readonly onDiagnostic?: (diagnostic: AppExtensionHostDiagnostic) => void;

  private readonly installed = new Map<string, InstalledEntry>();
  private readonly enabledIds = new Set<string>();
  private diagnosticsList: AppExtensionHostDiagnostic[] = [];
  private tmpCounter = 0;

  constructor(options: AppExtensionHostOptions) {
    if (!options || typeof options.extensionsRoot !== 'string' || options.extensionsRoot.length === 0) {
      throw new AppExtensionHostError('persistence-error', 'AppExtensionHost requires a non-empty extensionsRoot');
    }
    if (!options || typeof options.dataRoot !== 'string' || options.dataRoot.length === 0) {
      throw new AppExtensionHostError('persistence-error', 'AppExtensionHost requires a non-empty dataRoot');
    }
    this.extensionsRoot = options.extensionsRoot;
    this.dataRoot = options.dataRoot;
    this.enabledFileName = options.enabledFileName ?? APP_EXTENSION_ENABLED_FILENAME;
    this.runtime = options.runtime ?? new AppExtensionRuntime();
    this.loadPackage = options.loadPackage ?? ((packageDir: string) =>
      // Default loader, pointed at a private cache dir so reloading an edited extension
      // re-imports the current bytes (Bun cannot invalidate a module by query string).
      loadAppExtensionPackage(packageDir, {
        runtimeCacheRoot: join(this.dataRoot, APP_EXTENSION_RUNTIME_CACHE_DIRNAME),
      }));
    this.resolveAsset = options.resolveAsset ?? resolvePackageAsset;
    this.fs = { ...defaultFs, ...options.fs };
    this.onDiagnostic = options.onDiagnostic;
    // Scan + load persisted intent synchronously; no code is imported here.
    this.refresh();
    this.loadPersistedEnabled();
  }

  get extensionsRootPath(): string {
    return this.extensionsRoot;
  }

  get dataRootPath(): string {
    return this.dataRoot;
  }

  get enabledFilePath(): string {
    return join(this.dataRoot, this.enabledFileName);
  }

  /** Underlying runtime (for adapter wiring/tests). Registrations mirror enabled IDs. */
  get innerRuntime(): AppExtensionRuntime {
    return this.runtime;
  }

  /**
   * Rescan `extensionsRoot` for installed candidates without importing any
   * `serverEntry` code. Invalid packages are skipped with a diagnostic.
   * Runtime registrations for folders that vanished are dropped; the enabled
   * file is left untouched (use `setEnabled`/`init` to persist).
   */
  refresh(): void {
    this.installed.clear();
    this.diagnosticsList = [];
    let entries: string[];
    try {
      entries = this.fs.readdir(this.extensionsRoot);
    } catch (err) {
      if (isEnoent(err)) return; // Fresh install: no root yet means nothing installed.
      this.pushDiagnostic({
        dir: this.extensionsRoot,
        code: diagnosticCodeOf(err),
        message: `cannot list extensions root: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const sorted = [...entries].sort();
    for (const name of sorted) {
      if (name.length === 0) continue;
      const dir = join(this.extensionsRoot, name);
      let st: { isDirectory(): boolean; isSymbolicLink(): boolean };
      try {
        st = this.fs.lstat(dir);
      } catch (err) {
        if (isEnoent(err)) continue; // Raced deletion.
        this.pushDiagnostic({
          dir,
          code: diagnosticCodeOf(err),
          message: `cannot stat package directory: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      // Reject symlink package directories outright — never follow them, even
      // when they point inside the root.
      if (st.isSymbolicLink()) {
        this.pushDiagnostic({
          dir,
          code: 'symlink-package',
          message: `extension package must not be a symlink: ${dir}`,
        });
        continue;
      }
      if (!st.isDirectory()) continue; // Stray files are not candidates; ignore silently.
      try {
        const entry = this.scanOne(dir);
        if (this.installed.has(entry.manifest.id)) {
          this.pushDiagnostic({
            dir,
            extensionId: entry.manifest.id,
            code: 'duplicate',
            message: `duplicate extension id "${entry.manifest.id}" — keeping the first directory`,
          });
          continue;
        }
        this.installed.set(entry.manifest.id, entry);
      } catch (err) {
        const code = diagnosticCodeOf(err);
        this.pushDiagnostic({
          dir,
          code,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Drop runtime registrations and in-memory enabled flags for folders that
    // disappeared. The file is rewritten only via setEnabled/init.
    for (const summary of this.runtime.list()) {
      if (!this.installed.has(summary.id)) {
        this.runtime.unregister(summary.id);
      }
    }
    for (const id of [...this.enabledIds]) {
      if (!this.installed.has(id)) this.enabledIds.delete(id);
    }
  }

  /**
   * Restore persisted enabled IDs by dynamically importing each package and
   * registering it. This is the only startup path that executes `serverEntry`
   * code, and it replays the explicit `setEnabled(id, true)` path per ID:
   * disabled packages are never imported. Packages that are missing or fail
   * to load are dropped from the in-memory set with a diagnostic and the
   * pruned set is persisted once.
   */
  async init(): Promise<void> {
    this.loadPersistedEnabled();
    const wanted = [...this.enabledIds].sort();
    let pruned = false;
    for (const id of wanted) {
      const entry = this.installed.get(id);
      if (!entry) {
        this.enabledIds.delete(id);
        pruned = true;
        this.pushDiagnostic({
          dir: join(this.extensionsRoot, id),
          extensionId: id,
          code: 'missing-file',
          message: `enabled extension "${id}" is no longer installed — dropping it`,
        });
        continue;
      }
      try {
        const loaded = await this.loadPackage(entry.packageDir);
        if (loaded.manifest.id !== id) {
          throw new AppExtensionHostError(
            'not-installed',
            `loaded manifest id "${loaded.manifest.id}" does not match requested "${id}"`,
          );
        }
        if (this.runtime.get(id)) {
          this.runtime.enable(id);
        } else {
          try {
            this.runtime.register(loaded.manifest, loaded.handlers, { enabled: true });
          } catch (err) {
            // A duplicate here means a concurrent enable won the race.
            if (!this.runtime.get(id)) throw err;
            this.runtime.enable(id);
          }
        }
      } catch (err) {
        this.enabledIds.delete(id);
        pruned = true;
        try {
          this.runtime.unregister(id);
        } catch {
          // Best effort: leave no half-registered entry behind.
        }
        this.pushDiagnostic({
          dir: entry.packageDir,
          extensionId: id,
          code: diagnosticCodeOf(err),
          message: `failed to enable extension "${id}": ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    if (pruned) this.persistEnabled();
  }

  /** Copy of the last scan/restore diagnostics (skipped packages, load failures). */
  diagnostics(): AppExtensionHostDiagnostic[] {
    return this.diagnosticsList.map((d) => ({ ...d }));
  }

  /** All valid installed summaries with the persisted enabled flag. Sorted by id. */
  list(): AppExtensionSummary[] {
    return [...this.installed.values()]
      .sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0))
      .map((entry) => ({
        id: entry.manifest.id,
        name: entry.manifest.name,
        version: entry.manifest.version,
        ...(entry.manifest.description !== undefined ? { description: entry.manifest.description } : {}),
        enabled: this.enabledIds.has(entry.manifest.id),
        views: entry.manifest.views.map((v) => ({ ...v })),
        capabilities: [...(entry.manifest.capabilities ?? [])],
      }));
  }

  get(extensionId: string): AppExtensionSummary | undefined {
    const entry = this.installed.get(extensionId);
    if (!entry) return undefined;
    return {
      id: entry.manifest.id,
      name: entry.manifest.name,
      version: entry.manifest.version,
      ...(entry.manifest.description !== undefined ? { description: entry.manifest.description } : {}),
      enabled: this.enabledIds.has(entry.manifest.id),
      views: entry.manifest.views.map((v) => ({ ...v })),
      capabilities: [...(entry.manifest.capabilities ?? [])],
    };
  }

  isInstalled(extensionId: string): boolean {
    return this.installed.has(extensionId);
  }

  isEnabled(extensionId: string): boolean {
    return this.enabledIds.has(extensionId);
  }

  installedIds(): string[] {
    return [...this.installed.keys()].sort();
  }

  /**
   * Enable (dynamically import + register + persist) or disable (unregister +
   * persist) a package. Enabling is the ONLY scan-independent path that
   * executes `serverEntry` code — trusted code, no sandbox. Disabling an
   * unknown id is an idempotent no-op that still normalizes the file; enabling
   * an unknown id throws `not-installed`.
   */
  async setEnabled(extensionId: string, enabled: boolean): Promise<void> {
    if (enabled) {
      const entry = this.installed.get(extensionId);
      if (!entry) {
        throw new AppExtensionHostError(
          'not-installed',
          `extension "${extensionId}" is not installed under ${this.extensionsRoot}`,
        );
      }
      if (this.enabledIds.has(extensionId) && this.runtime.get(extensionId)?.enabled) return;
      const loaded = await this.loadPackage(entry.packageDir);
      if (loaded.manifest.id !== extensionId) {
        throw new AppExtensionHostError(
          'not-installed',
          `loaded manifest id "${loaded.manifest.id}" does not match requested "${extensionId}"`,
        );
      }
      if (this.runtime.get(extensionId)) {
        this.runtime.enable(extensionId);
      } else {
        this.runtime.register(loaded.manifest, loaded.handlers, { enabled: true });
      }
      this.enabledIds.add(extensionId);
      this.persistEnabled();
      return;
    }
    this.enabledIds.delete(extensionId);
    this.runtime.unregister(extensionId);
    this.persistEnabled();
  }

  /**
   * Re-import an enabled extension's server entry and swap its handlers in place, leaving the
   * host running. This is the hot path for editing extension code: the loader imports the entry
   * from a content-addressed copy under `<dataRoot>/app-extensions-runtime/`, because Bun
   * cannot invalidate a cached module in place, so a changed file resolves to a new path
   * while an unchanged one reuses the copy it already has.
   * one stays cached.
   *
   *   Refuses disabled extensions: re-running a server entry executes trusted code, and Enable is
   *   the action that grants that trust. Enable-then-reload covers "I edited a disabled app" too.
   *
   *   In-flight operations for the extension are cancelled, exactly as a disable would do. The
   *   enabled set is unchanged, so nothing is re-persisted.
   */
  async reload(extensionId: string): Promise<void> {
    if (!this.installed.has(extensionId)) {
      throw new AppExtensionHostError(
        'not-installed',
        `extension "${extensionId}" is not installed under ${this.extensionsRoot}`
      );
    }
    if (!this.enabledIds.has(extensionId)) {
      throw new AppExtensionHostError(
        'disabled',
        `extension "${extensionId}" is disabled; enable it to run its server entry`
      );
    }
    const entry = this.installed.get(extensionId);
    if (!entry) {
      throw new AppExtensionHostError(
        'not-installed',
        `extension "${extensionId}" is not installed under ${this.extensionsRoot}`
      );
    }

    // Import before unregistering: a broken edit fails here, leaving the working handlers in
    // place. `loadPackage` already validates the manifest and its handler map.
    const loaded = await this.loadPackage(entry.packageDir);
    if (loaded.manifest.id !== extensionId) {
      throw new AppExtensionHostError(
        'not-installed',
        `loaded manifest id "${loaded.manifest.id}" does not match requested "${extensionId}"`
      );
    }

    this.runtime.unregister(extensionId);
    // `loadPackage` already validated the manifest and handler map, so this only fails on a
    // duplicate registration, which cannot happen after the unregister above. Let the runtime's
    // own error surface rather than wrapping it in a less accurate code.
    this.runtime.register(loaded.manifest, loaded.handlers, { enabled: true });
    this.enabledIds.add(extensionId);
  }

  /**
   * Declared operations for an enabled extension (copies). Throws
   * `not-installed` when unknown and `disabled` when installed but not
   * enabled/registered.
   */
  operations(extensionId: string): AppExtensionOperationDeclaration[] {
    this.requireEnabled(extensionId);
    return this.runtime.operations(extensionId);
  }

  /** Declared event names for an enabled extension (used to validate emit()). */
  eventNames(extensionId: string): string[] {
    return [...(this.requireEnabled(extensionId).manifest.events ?? [])];
  }

  /** Declared sensitive capabilities for an enabled extension (used to gate ctx use). */
  capabilities(extensionId: string): AppExtensionCapability[] {
    return [...(this.requireEnabled(extensionId).manifest.capabilities ?? [])];
  }

  /**
   * Canonical absolute client entry for an enabled extension. Throws
   * `not-installed` when unknown and `disabled` when installed but not
   * enabled. The path was containment-checked at scan time via
   * `resolvePackageAsset`.
   */
  clientEntryPath(extensionId: string): string {
    const entry = this.requireEnabled(extensionId);
    return entry.clientEntryPath;
  }

  /** Package-relative client entry path used to form its authenticated URL. */
  clientEntryRelativePath(extensionId: string): string {
    const entry = this.requireEnabled(extensionId);
    const path = relative(entry.packageDir, entry.clientEntryPath);
    if (!path || path === '..' || path.startsWith(`..${sep}`)) {
      throw new AppExtensionHostError('not-installed', `invalid client entry path for extension "${extensionId}"`);
    }
    return path.split(sep).join('/');
  }

  /**
   * Resolve a client-side ESM chunk/asset only inside the client entry directory.
   * Server-entry code and the package manifest are never served as client assets.
   */
  clientAssetPath(extensionId: string, relativePath: string): string {
    const entry = this.requireEnabled(extensionId);
    const absolute = this.resolveAsset(entry.packageDir, relativePath);
    const publicRoot = dirname(entry.clientEntryPath);
    if (
      absolute === entry.serverEntryPath ||
      absolute === join(entry.packageDir, APP_EXTENSION_MANIFEST_FILENAME) ||
      (absolute !== publicRoot && !absolute.startsWith(publicRoot + sep))
    ) {
      throw new AppExtensionHostError(
        'not-installed',
        `client asset is outside the public client directory for extension "${extensionId}"`,
      );
    }
    return absolute;
  }

  /**
   * Dispatch a side-effect-free read via the runtime. Unknown extensions throw
   * `not-installed`; installed-but-disabled extensions throw `disabled`;
   * unknown operations and wrong-kind dispatches propagate the runtime error.
   */
  async read(
    extensionId: string,
    operationId: string,
    input?: Record<string, unknown>,
    ctx?: AppExtensionCallContext,
  ): Promise<unknown> {
    this.requireEnabled(extensionId);
    return this.runtime.read(extensionId, operationId, input, ctx);
  }

  /**
   * Dispatch an action via the runtime. Same enablement gating as `read()`.
   */
  async invoke(
    extensionId: string,
    operationId: string,
    input?: Record<string, unknown>,
    ctx?: AppExtensionCallContext,
  ): Promise<unknown> {
    this.requireEnabled(extensionId);
    return this.runtime.invoke(extensionId, operationId, input, ctx);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Validate one candidate directory without executing code: read + parse the
   * manifest, require basename === manifest.id, and containment-check both
   * entries with the injected asset resolver.
   */
  private scanOne(packageDir: string): InstalledEntry {
    const manifestPath = join(packageDir, APP_EXTENSION_MANIFEST_FILENAME);
    let rawText: string;
    try {
      rawText = this.fs.readFile(manifestPath, 'utf8');
    } catch (err) {
      throw new AppExtensionHostError(
        'not-installed',
        `extension manifest not found: ${manifestPath}`,
        { cause: err },
      );
    }
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(rawText) as unknown;
    } catch (err) {
      throw new AppExtensionHostError('not-installed', `extension manifest is not valid JSON: ${manifestPath}`, {
        cause: err,
      });
    }
    const parsed = parseAppExtensionManifest(rawJson);
    if (!parsed.ok) {
      throw new AppExtensionHostError(
        'not-installed',
        `invalid extension manifest in ${packageDir}: ${parsed.issues.join('; ')}`,
      );
    }
    const manifest = parsed.value as unknown as AppExtensionManifest;
    if (basename(packageDir) !== manifest.id) {
      throw new AppExtensionHostError(
        'not-installed',
        `extension directory basename "${basename(packageDir)}" must match manifest.id "${manifest.id}"`,
      );
    }
    // Containment + existence checks without importing code. The resolver
    // throws coded errors (invalid-entry/outside-root/missing-file) which the
    // caller converts to skip diagnostics.
    const clientEntryPath = this.resolveAsset(packageDir, manifest.clientEntry);
    const serverEntryPath = this.resolveAsset(packageDir, manifest.serverEntry);
    return { manifest, packageDir, clientEntryPath, serverEntryPath };
  }

  private requireInstalled(extensionId: string): InstalledEntry {
    const entry = this.installed.get(extensionId);
    if (!entry) {
      throw new AppExtensionHostError(
        'not-installed',
        `extension "${extensionId}" is not installed under ${this.extensionsRoot}`,
      );
    }
    return entry;
  }

  private requireEnabled(extensionId: string): InstalledEntry {
    const entry = this.requireInstalled(extensionId);
    const summary = this.runtime.get(extensionId);
    if (!this.enabledIds.has(extensionId) || !summary || !summary.enabled) {
      throw new AppExtensionHostError('disabled', `extension "${extensionId}" is disabled`);
    }
    return entry;
  }

  private pushDiagnostic(d: AppExtensionHostDiagnostic): void {
    this.diagnosticsList.push(d);
    try {
      this.onDiagnostic?.(d);
    } catch {
      // Observer failures must never break scans.
    }
  }

  private loadPersistedEnabled(): void {
    let text: string;
    try {
      text = this.fs.readFile(this.enabledFilePath, 'utf8');
    } catch (err) {
      if (isEnoent(err)) return; // Default: everything disabled.
      this.pushDiagnostic({
        dir: this.dataRoot,
        code: 'persistence-error',
        message: `cannot read enabled extensions file: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err) {
      this.pushDiagnostic({
        dir: this.dataRoot,
        code: 'persistence-error',
        message: `enabled extensions file is not valid JSON — starting disabled: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const ids = parseEnabledIds(raw);
    this.enabledIds.clear();
    for (const id of ids) {
      // Only installed IDs become effective; stale IDs are ignored here and
      // pruned on the next init()/setEnabled() persist.
      if (this.installed.has(id)) this.enabledIds.add(id);
    }
  }

  /** Atomically persist the sorted enabled-ID set (tmp file + rename). */
  private persistEnabled(): void {
    const payload = JSON.stringify(
      { version: ENABLED_FILE_VERSION, enabled: [...this.enabledIds].sort() },
      null,
      2,
    );
    try {
      this.fs.mkdir(this.dataRoot, { recursive: true });
      const target = this.enabledFilePath;
      const tmp = `${target}.${process.pid}.${Date.now()}.${this.tmpCounter++}.tmp`;
      try {
        this.fs.writeFile(tmp, payload, 'utf8');
        this.fs.rename(tmp, target);
      } catch (err) {
        try {
          this.fs.unlink(tmp);
        } catch {
          // Best effort: leave no stray tmp file behind.
        }
        throw err;
      }
    } catch (err) {
      throw new AppExtensionHostError(
        'persistence-error',
        `failed to persist enabled extensions: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}
