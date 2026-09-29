import { describe, expect, test, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { APP_EXTENSION_API_VERSION } from '../../app-extensions/types.ts';
import { AppExtensionRuntime } from './runtime.ts';
import {
  AppExtensionPackageError,
  loadAppExtensionPackage,
  resolvePackageAsset,
} from './package-loader.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Temp packages live inside the project root: vitest's SSR runner can only
 * dynamically import files under the project (imports of /tmp files fail
 * with ERR_MODULE_NOT_FOUND), while production Bun/Node has no such
 * restriction. Production behaviour is unchanged — only test fixtures move.
 */
function tempDir(prefix: string): string {
  return mkdtempSync(join(process.cwd(), prefix));
}

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    apiVersion: APP_EXTENSION_API_VERSION,
    id: 'test.ext',
    name: 'Test Ext',
    version: '1.0.0',
    clientEntry: 'dist/client.js',
    serverEntry: 'dist/server.mjs',
    views: [],
    operations: [
      { id: 'get', kind: 'read', description: 'Get things' },
      { id: 'do', kind: 'action', description: 'Do things' },
    ],
    ...overrides,
  };
}

const GOOD_SERVER = `export default {
  reads: { get: async () => ({ ok: true }) },
  actions: { do: async () => ({ done: true }) },
};
`;

function makePackage(opts: {
  manifest?: Record<string, unknown>;
  rawManifestText?: string;
  client?: string | null;
  server?: string | null;
  serverFile?: string;
  extraFiles?: Record<string, string>;
} = {}): string {
  const dir = tempDir('.tmp-pi-ext-pkg-');
  dirs.push(dir);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const manifest = opts.manifest ?? baseManifest();
  if (opts.rawManifestText !== undefined) {
    writeFileSync(join(dir, 'pi-ui.extension.json'), opts.rawManifestText);
  } else {
    writeFileSync(join(dir, 'pi-ui.extension.json'), JSON.stringify(manifest));
  }
  if (opts.client !== null) {
    writeFileSync(join(dir, 'dist/client.js'), opts.client ?? `console.log('client');\n`);
  }
  const serverFile = opts.serverFile ?? 'dist/server.mjs';
  if (opts.server !== null) {
    writeFileSync(join(dir, serverFile), opts.server ?? GOOD_SERVER);
  }
  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

async function expectPackageCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (err) => err instanceof AppExtensionPackageError && (err as { code: string }).code === code,
  );
}

describe('loadAppExtensionPackage good package', () => {
  test('loads manifest, handlers, and canonical paths; handlers register in the runtime', async () => {
    const dir = makePackage();
    const loaded = await loadAppExtensionPackage(dir);
    expect(loaded.manifest.id).toBe('test.ext');
    expect(loaded.manifest.clientEntry).toBe('dist/client.js');
    expect(loaded.manifest.serverEntry).toBe('dist/server.mjs');
    expect(loaded.clientEntryPath.endsWith('dist/client.js')).toBe(true);
    expect(typeof loaded.handlers.reads?.['get']).toBe('function');
    expect(typeof loaded.handlers.actions?.['do']).toBe('function');

    const rt = new AppExtensionRuntime();
    rt.register(loaded.manifest, loaded.handlers);
    expect(await rt.read('test.ext', 'get', {})).toEqual({ ok: true });
    expect(await rt.invoke('test.ext', 'do', {})).toEqual({ done: true });
  });

  test('accepts the named "extension" export when there is no default export', async () => {
    const dir = makePackage({
      server: `export const extension = {
        reads: { get: async () => 1 },
        actions: { do: async () => 2 },
      };\n`,
    });
    const loaded = await loadAppExtensionPackage(dir);
    expect(typeof loaded.handlers.reads?.['get']).toBe('function');
  });

  test('re-import from a runtime cache picks up updated server code', async () => {
    // The staged-copy path is what the host actually uses. Bun ignores `?v=` query strings and
    // caches by resolved real path, so a stat-based query alone cannot invalidate the module; the
    // host therefore imports from a content-addressed copy. This test pins that behaviour rather
    // than the query-string form, which only ever worked on Node.
    const dir = makePackage({
      server: `export default { reads: { get: async () => 'v1' }, actions: { do: async () => 0 } };\n`,
    });
    const cacheRoot = tempDir('.tmp-pi-ext-cache-');
    const load = () => loadAppExtensionPackage(dir, { runtimeCacheRoot: cacheRoot });
    const first = await load();
    expect(await first.handlers.reads?.['get']?.({}, { scope: {}, caller: { kind: 'ui' } })).toBe(
      'v1',
    );
    const serverPath = join(dir, 'dist/server.mjs');
    writeFileSync(
      serverPath,
      `export default { reads: { get: async () => 'v2' }, actions: { do: async () => 0 } };\n`,
    );
    // Guarantee a distinct fingerprint so the staged copy lands on a new path.
    const future = new Date(Date.now() + 5000);
    utimesSync(serverPath, future, future);
    const second = await load();
    expect(await second.handlers.reads?.['get']?.({}, { scope: {}, caller: { kind: 'ui' } })).toBe(
      'v2',
    );
  });

  test('a staged copy keeps sibling imports of the server entry working', async () => {
    // The copy has to be a whole-package copy: an extension may import siblings of its
    // serverEntry, and those must resolve inside the staged tree.
    const dir = makePackage({
      server:
        `import { marker } from './helper.mjs';\n` +
        `export default { reads: { get: async () => marker }, actions: { do: async () => 0 } };\n`,
      extraFiles: { 'dist/helper.mjs': `export const marker = 'FROM-SIBLING';\n` },
    });
    const cacheRoot = tempDir('.tmp-pi-ext-cache-');
    const loaded = await loadAppExtensionPackage(dir, { runtimeCacheRoot: cacheRoot });
    expect(await loaded.handlers.reads?.['get']?.({}, { scope: {}, caller: { kind: 'ui' } })).toBe(
      'FROM-SIBLING',
    );
  });
});

describe('loadAppExtensionPackage entry safety', () => {
  test('rejects ".." entries', async () => {
    const dir = makePackage({ manifest: baseManifest({ clientEntry: '../evil.js' }) });
    await expect(loadAppExtensionPackage(dir)).rejects.toThrow(AppExtensionPackageError);
    const dir2 = makePackage({ manifest: baseManifest({ serverEntry: '../evil.mjs' }) });
    await expect(loadAppExtensionPackage(dir2)).rejects.toThrow(AppExtensionPackageError);
  });

  test('rejects absolute entries', async () => {
    const dir = makePackage({ manifest: baseManifest({ clientEntry: '/tmp/evil.js' }) });
    await expect(loadAppExtensionPackage(dir)).rejects.toThrow(AppExtensionPackageError);
    const dir2 = makePackage({ manifest: baseManifest({ serverEntry: '/tmp/evil.mjs' }) });
    await expect(loadAppExtensionPackage(dir2)).rejects.toThrow(AppExtensionPackageError);
  });

  test('rejects missing entry files', async () => {
    const dir = makePackage({ manifest: baseManifest({ clientEntry: 'dist/missing.js' }) });
    await expectPackageCode(loadAppExtensionPackage(dir), 'missing-file');
    const dir2 = makePackage({ manifest: baseManifest({ serverEntry: 'dist/missing.mjs' }) });
    await expectPackageCode(loadAppExtensionPackage(dir2), 'missing-file');
  });

  test('rejects directory entries', async () => {
    const dir = makePackage({ manifest: baseManifest({ clientEntry: 'dist' }) });
    await expect(loadAppExtensionPackage(dir)).rejects.toThrow(AppExtensionPackageError);
  });

  test('rejects a manifest missing serverEntry and malformed JSON', async () => {
    const noServer = baseManifest();
    delete (noServer as Record<string, unknown>)['serverEntry'];
    const dir = makePackage({ manifest: noServer });
    await expectPackageCode(loadAppExtensionPackage(dir), 'invalid-manifest');
    const bad = makePackage({ rawManifestText: '{ not json' });
    await expectPackageCode(loadAppExtensionPackage(bad), 'invalid-manifest');
  });
});

describe('loadAppExtensionPackage malformed server module', () => {
  test('rejects modules without a handler-map export', async () => {
    const dir = makePackage({ server: `export const nothing = 1;\n` });
    await expectPackageCode(loadAppExtensionPackage(dir), 'invalid-module');
  });

  test('rejects non-function handlers and non-object maps', async () => {
    const badReads = makePackage({
      server: `export default { reads: { get: 'nope' }, actions: { do: async () => 0 } };\n`,
    });
    await expectPackageCode(loadAppExtensionPackage(badReads), 'invalid-module');

    const badShape = makePackage({ server: `export default 42;\n` });
    await expectPackageCode(loadAppExtensionPackage(badShape), 'invalid-module');

    const badActions = makePackage({
      server: `export default { reads: {}, actions: [] };\n`,
    });
    await expectPackageCode(loadAppExtensionPackage(badActions), 'invalid-module');
  });

  test('rejects unimportable server modules', async () => {
    const dir = makePackage({ server: `this is not valid javascript ((;\n` });
    await expectPackageCode(loadAppExtensionPackage(dir), 'invalid-module');
  });
});

describe('resolvePackageAsset', () => {
  test('resolves files inside the root and rejects escape/missing', () => {
    const dir = makePackage({ extraFiles: { 'dist/data.json': '{"a":1}' } });
    expect(resolvePackageAsset(dir, 'dist/data.json').endsWith('dist/data.json')).toBe(true);
    expect(() => resolvePackageAsset(dir, '../outside.js')).toThrow(AppExtensionPackageError);
    expect(() => resolvePackageAsset(dir, '/abs/path.js')).toThrow(AppExtensionPackageError);
    expect(() => resolvePackageAsset(dir, 'dist/nope.json')).toThrow(AppExtensionPackageError);
  });

  test('rejects symlink escape when symlinks are supported', async () => {
    const dir = makePackage();
    const outside = tempDir('.tmp-pi-ext-outside-');
    dirs.push(outside);
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'secret');
    const link = join(dir, 'dist/link.mjs');
    try {
      symlinkSync(secret, link);
      // Sanity: the link really points outside.
      expect(readlinkSync(link)).toBe(secret);
    } catch {
      // Symlinks need privileges on some platforms — skip when unsupported.
      expect(true).toBe(true);
      return;
    }
    expect(() => resolvePackageAsset(dir, 'dist/link.mjs')).toThrow(AppExtensionPackageError);
    const linkPkg = makePackage();
    const link2 = join(linkPkg, 'dist/server.mjs');
    rmSync(link2, { force: true });
    symlinkSync(secret, link2);
    await expect(loadAppExtensionPackage(linkPkg)).rejects.toThrow(AppExtensionPackageError);
  });
});
