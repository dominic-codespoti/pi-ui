import { describe, expect, test, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { APP_EXTENSION_API_VERSION } from '../../app-extensions/types.ts';
import { resolvePackageAsset } from './package-loader.ts';
import { AppExtensionRuntime } from './runtime.ts';
import {
  AppExtensionHost,
  AppExtensionHostError,
  type AppExtensionHostDiagnostic,
} from './host.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Temp roots live inside the project so vitest's SSR runner can dynamically
 * import real server entries when a test uses the real loader. Tests that stub
 * the loader never import package code at all.
 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(process.cwd(), prefix));
  dirs.push(dir);
  return dir;
}

function baseManifest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    apiVersion: APP_EXTENSION_API_VERSION,
    id,
    name: `Name ${id}`,
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

/** Write a candidate package folder `<root>/<id>` (or explicit dirName). */
function writePackage(
  root: string,
  id: string,
  opts: {
    dirName?: string;
    manifest?: Record<string, unknown>;
    rawText?: string;
    client?: string | null;
    server?: string | null;
  } = {},
): string {
  const dir = join(root, opts.dirName ?? id);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  if (opts.rawText !== undefined) {
    writeFileSync(join(dir, 'pi-ui.extension.json'), opts.rawText);
  } else {
    writeFileSync(join(dir, 'pi-ui.extension.json'), JSON.stringify(opts.manifest ?? baseManifest(id)));
  }
  if (opts.client !== null) {
    writeFileSync(join(dir, 'dist/client.js'), opts.client ?? `console.log(${JSON.stringify(id)});\n`);
  }
  if (opts.server !== null) {
    writeFileSync(
      join(dir, 'dist/server.mjs'),
      opts.server ??
        `export default { reads: { get: async () => ({ ok: true }) }, actions: { do: async () => ({ done: true }) } };\n`,
    );
  }
  return dir;
}

/**
 * Stub loader: builds dummy handlers from the on-disk manifest WITHOUT
 * importing `serverEntry` code. Records every call so tests can prove scans
 * never execute package code.
 */
function stubLoader(calls: string[]) {
  return async (packageDir: string) => {
    calls.push(packageDir);
    const raw = JSON.parse(readFileSync(join(packageDir, 'pi-ui.extension.json'), 'utf8')) as {
      clientEntry: string;
      serverEntry: string;
      operations?: Array<{ id: string; kind: string }>;
    } & Record<string, unknown>;
    const reads: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {};
    const actions: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {};
    for (const op of raw.operations ?? []) {
      const fn = async (input: Record<string, unknown>) => ({ op: op.id, echo: input });
      if (op.kind === 'read') reads[op.id] = fn;
      else actions[op.id] = fn;
    }
    return {
      manifest: raw as unknown as Parameters<AppExtensionRuntime['register']>[0],
      handlers: { reads, actions } as never,
      packageRoot: packageDir,
      clientEntryPath: resolvePackageAsset(packageDir, raw.clientEntry),
      serverEntryPath: resolvePackageAsset(packageDir, raw.serverEntry),
    };
  };
}

async function expectHostCode(promise: Promise<unknown>, code: 'not-installed' | 'disabled') {
  await expect(promise).rejects.toSatisfy(
    (err) => err instanceof AppExtensionHostError && (err as { code: string }).code === code,
  );
}

function expectHostCodeSync(fn: () => unknown, code: 'not-installed' | 'disabled') {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppExtensionHostError);
    expect((err as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected AppExtensionHostError(${code})`);
}

// ── scanning ─────────────────────────────────────────────────────────────────

describe('AppExtensionHost scanning (no code execution)', () => {
  test('lists valid packages disabled by default without importing server code', () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'alpha.ext');
    writePackage(root, 'beta.ext');
    const calls: string[] = [];
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader(calls) });
    expect(calls).toEqual([]);
    expect(host.installedIds()).toEqual(['alpha.ext', 'beta.ext']);
    expect(host.list().map((s) => [s.id, s.enabled])).toEqual([
      ['alpha.ext', false],
      ['beta.ext', false],
    ]);
    expect(host.diagnostics()).toEqual([]);
    expect(host.isInstalled('alpha.ext')).toBe(true);
    expect(host.isEnabled('alpha.ext')).toBe(false);
  });

  test('requires the directory basename to match manifest.id', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'real.id', { dirName: 'wrong-name' });
    const calls: string[] = [];
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader(calls) });
    expect(host.list()).toEqual([]);
    expect(host.diagnostics()).toHaveLength(1);
    expect(host.diagnostics()[0]?.message).toMatch(/must match manifest\.id/);
    await expectHostCode(host.setEnabled('real.id', true), 'not-installed');
    expect(calls).toEqual([]);
  });

  test('rejects symlink package directories', () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'real.ext');
    const link = join(root, 'linked.ext');
    try {
      symlinkSync(join(root, 'real.ext'), link);
    } catch {
      expect(true).toBe(true); // Symlinks need privileges on some platforms.
      return;
    }
    const calls: string[] = [];
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader(calls) });
    // real.ext is valid; the symlink is skipped with a diagnostic.
    expect(host.installedIds()).toEqual(['real.ext']);
    expect(host.diagnostics().some((d) => d.code === 'symlink-package')).toBe(true);
    expect(calls).toEqual([]);
  });

  test('rejects entry escapes (.. and absolute) without executing code', () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'ok.ext');
    writePackage(root, 'bad.client', {
      manifest: baseManifest('bad.client', { clientEntry: '../evil.js' }),
    });
    writePackage(root, 'bad.server', {
      manifest: baseManifest('bad.server', { serverEntry: '/tmp/evil.mjs' }),
    });
    const calls: string[] = [];
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader(calls) });
    expect(host.installedIds()).toEqual(['ok.ext']);
    expect(host.diagnostics()).toHaveLength(2);
    expect(calls).toEqual([]);
  });

  test('rejects a symlink entry escape inside an otherwise valid package', () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    const outside = tempDir('.tmp-host-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    writePackage(root, 'ok.ext');
    const evilDir = writePackage(root, 'evil.ext');
    const link = join(evilDir, 'dist/client.js');
    rmSync(link, { force: true });
    try {
      symlinkSync(join(outside, 'secret.txt'), link);
    } catch {
      expect(true).toBe(true);
      return;
    }
    const calls: string[] = [];
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader(calls) });
    expect(host.installedIds()).toEqual(['ok.ext']);
    expect(host.diagnostics().some((d) => d.dir === evilDir)).toBe(true);
  });

  test('skips invalid packages with diagnostics; valid packages still work', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'good.ext');
    writePackage(root, 'broken.json', { dirName: 'broken.json', rawText: '{ not json' });
    const noServer = baseManifest('noserver.ext') as Record<string, unknown>;
    delete noServer['serverEntry'];
    writePackage(root, 'x', { dirName: 'noserver.ext', manifest: noServer });
    writePackage(root, 'missingfile.ext', {
      manifest: baseManifest('missingfile.ext', { clientEntry: 'dist/gone.js' }),
    });
    const seen: AppExtensionHostDiagnostic[] = [];
    const calls: string[] = [];
    const host = new AppExtensionHost({
      extensionsRoot: root,
      dataRoot: data,
      loadPackage: stubLoader(calls),
      onDiagnostic: (d) => seen.push(d),
    });
    expect(host.installedIds()).toEqual(['good.ext']);
    expect(host.diagnostics()).toHaveLength(3);
    expect(seen).toHaveLength(3);
    await host.setEnabled('good.ext', true);
    expect(host.isEnabled('good.ext')).toBe(true);
    expect(await host.read('good.ext', 'get', {})).toEqual({ op: 'get', echo: {} });
  });

  test('rejects manifests missing each required field', () => {
    const required: Array<[string, (m: Record<string, unknown>) => void]> = [
      ['id', (m) => delete m['id']],
      ['name', (m) => delete m['name']],
      ['version', (m) => delete m['version']],
      ['clientEntry', (m) => delete m['clientEntry']],
      ['serverEntry', (m) => delete m['serverEntry']],
      ['views', (m) => delete m['views']],
      ['operations', (m) => delete m['operations']],
      ['schemaVersion', (m) => (m['schemaVersion'] = 999)],
      ['apiVersion', (m) => (m['apiVersion'] = 999)],
    ];
    for (const [label, mutate] of required) {
      const root = tempDir('.tmp-host-root-');
      const data = tempDir('.tmp-host-data-');
      const id = `pkg.${label.replace(/[^a-z]/g, '')}`;
      const manifest = baseManifest(id) as unknown as Record<string, unknown>;
      mutate(manifest);
      // Keep basename === id only when the id itself was not removed; when it
      // was, the mismatch is itself a rejection (still skipped, still no load).
      const dirName = label === 'id' ? 'some.dir' : id;
      if (label === 'id') manifest['id'] = '';
      writePackage(root, id, { dirName, manifest });
      const calls: string[] = [];
      const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader(calls) });
      expect(host.installedIds(), `field ${label} should be rejected`).toEqual([]);
      expect(host.diagnostics().length, `field ${label} needs a diagnostic`).toBeGreaterThan(0);
      expect(calls).toEqual([]);
    }
  });
});

// ── enable / disable / persistence / dispatch ────────────────────────────────

describe('AppExtensionHost enablement and dispatch', () => {
  test('setEnabled(true) loads only on explicit call and persists atomically', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'alpha.ext');
    const calls: string[] = [];
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader(calls) });
    expect(calls).toEqual([]); // Scan must not import.
    expectHostCodeSync(() => host.operations('alpha.ext'), 'disabled');
    expectHostCodeSync(() => host.clientEntryPath('alpha.ext'), 'disabled');
    await expectHostCode(host.read('alpha.ext', 'get', {}), 'disabled');

    await host.setEnabled('alpha.ext', true);
    expect(calls).toEqual([join(root, 'alpha.ext')]);
    expect(host.list().find((s) => s.id === 'alpha.ext')?.enabled).toBe(true);
    expect(host.operations('alpha.ext').map((op) => op.id).sort()).toEqual(['do', 'get']);
    expect(host.clientEntryPath('alpha.ext').endsWith('dist/client.js')).toBe(true);
    expect(host.clientEntryRelativePath('alpha.ext')).toBe('dist/client.js');
    expect(host.clientAssetPath('alpha.ext', 'dist/client.js')).toBe(host.clientEntryPath('alpha.ext'));
    expect(() => host.clientAssetPath('alpha.ext', 'dist/server.mjs')).toThrow(/public client directory/);
    expect(() => host.clientAssetPath('alpha.ext', 'pi-ui.extension.json')).toThrow(/public client directory/);
    expect(await host.read('alpha.ext', 'get', { q: 1 })).toEqual({ op: 'get', echo: { q: 1 } });
    expect(await host.invoke('alpha.ext', 'do', { t: 2 })).toEqual({ op: 'do', echo: { t: 2 } });

    // Atomic JSON persistence: single file, sorted IDs, no stray tmp files.
    const raw = JSON.parse(readFileSync(join(data, 'app-extensions.enabled.json'), 'utf8')) as {
      version: number;
      enabled: string[];
    };
    expect(raw).toEqual({ version: 1, enabled: ['alpha.ext'] });
    expect(readdirSync(data).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('declared capabilities surface in summaries and gate ctx use', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'alpha.ext', {
      manifest: baseManifest('alpha.ext', { capabilities: ['session.read', 'catalog.list'] }),
    });
    const calls: string[] = [];
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader(calls) });
    expect(host.list().find((s) => s.id === 'alpha.ext')?.capabilities).toEqual([
      'session.read',
      'catalog.list',
    ]);
    await host.setEnabled('alpha.ext', true);
    expect(host.capabilities('alpha.ext')).toEqual(['session.read', 'catalog.list']);
    expect(host.list().find((s) => s.id === 'alpha.ext')?.capabilities).toEqual([
      'session.read',
      'catalog.list',
    ]);
    expect(() => host.capabilities('missing.ext')).toThrow(/not installed/);
  });

  test('enabled IDs round-trip to a new host via init(); default is disabled', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'alpha.ext');
    const callsA: string[] = [];
    const first = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader(callsA) });
    await first.setEnabled('alpha.ext', true);
    expect(callsA).toHaveLength(1);

    // A fresh host sees the persisted intent immediately but loads code only in init().
    const callsB: string[] = [];
    const second = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader(callsB) });
    expect(second.list().find((s) => s.id === 'alpha.ext')?.enabled).toBe(true);
    expect(callsB).toEqual([]);
    await expectHostCode(second.read('alpha.ext', 'get', {}), 'disabled'); // Not loaded yet.
    await second.init();
    expect(callsB).toEqual([join(root, 'alpha.ext')]);
    expect(await second.read('alpha.ext', 'get', {})).toEqual({ op: 'get', echo: {} });

    // Missing file means everything disabled.
    const emptyData = tempDir('.tmp-host-data-');
    const third = new AppExtensionHost({
      extensionsRoot: root,
      dataRoot: emptyData,
      loadPackage: stubLoader([]),
    });
    expect(third.list().every((s) => s.enabled === false)).toBe(true);
  });

  test('setEnabled(false) unregisters and clears persistence', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'alpha.ext');
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader([]) });
    await host.setEnabled('alpha.ext', true);
    expect(host.innerRuntime.get('alpha.ext')?.enabled).toBe(true);
    await host.setEnabled('alpha.ext', false);
    expect(host.isEnabled('alpha.ext')).toBe(false);
    expect(host.innerRuntime.get('alpha.ext')).toBeUndefined();
    expectHostCodeSync(() => host.operations('alpha.ext'), 'disabled');
    await expectHostCode(host.read('alpha.ext', 'get', {}), 'disabled');
    const raw = JSON.parse(readFileSync(join(data, 'app-extensions.enabled.json'), 'utf8')) as {
      enabled: string[];
    };
    expect(raw.enabled).toEqual([]);
  });

  test('read/invoke gating: not-installed vs disabled vs runtime errors', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'alpha.ext');
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader([]) });
    await expectHostCode(host.read('nope.ext', 'get', {}), 'not-installed');
    await expectHostCode(host.invoke('nope.ext', 'do', {}), 'not-installed');
    expectHostCodeSync(() => host.operations('nope.ext'), 'not-installed');
    expectHostCodeSync(() => host.clientEntryPath('nope.ext'), 'not-installed');

    await expectHostCode(host.read('alpha.ext', 'get', {}), 'disabled');
    await host.setEnabled('alpha.ext', true);
    // Unknown operation and wrong-kind propagate from the runtime.
    await expect(host.read('alpha.ext', 'missing', {})).rejects.toThrow(/unknown operation/);
    await expect(host.read('alpha.ext', 'do', {})).rejects.toThrow(/action/);
    await expect(host.invoke('alpha.ext', 'get', {})).rejects.toThrow(/read/);
  });

  test('setEnabled(true) on unknown ids fails; load failure does not persist', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'alpha.ext');
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader([]) });
    await expectHostCode(host.setEnabled('ghost.ext', true), 'not-installed');

    const failing = new AppExtensionHost({
      extensionsRoot: root,
      dataRoot: data,
      loadPackage: async () => {
        throw new Error('boom');
      },
    });
    await expect(failing.setEnabled('alpha.ext', true)).rejects.toThrow('boom');
    expect(failing.isEnabled('alpha.ext')).toBe(false);
    // A failed enable must not create persistence: no file, no stray tmp files.
    expect(readdirSync(data).filter((f) => f.includes('app-extensions.enabled'))).toEqual([]);
  });

  test('corrupt enabled file starts disabled with a diagnostic', () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'alpha.ext');
    writeFileSync(join(data, 'app-extensions.enabled.json'), '{ not json');
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: stubLoader([]) });
    expect(host.list().find((s) => s.id === 'alpha.ext')?.enabled).toBe(false);
    expect(host.diagnostics().some((d) => d.code === 'persistence-error')).toBe(true);
  });

  test('loads real server code end-to-end only after enable', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'real.ext', {
      server: `export default { reads: { get: async () => 'live' }, actions: { do: async () => 'did' } };\n`,
    });
    const { loadAppExtensionPackage } = await import('./package-loader.ts');
    const spy = vi.fn(loadAppExtensionPackage);
    const host = new AppExtensionHost({ extensionsRoot: root, dataRoot: data, loadPackage: spy });
    expect(spy).not.toHaveBeenCalled();
    expect(host.list()).toHaveLength(1);
    await host.setEnabled('real.ext', true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await host.read('real.ext', 'get', {})).toBe('live');
    expect(await host.invoke('real.ext', 'do', {})).toBe('did');
  });
});

// ── injectability ────────────────────────────────────────────────────────────

describe('AppExtensionHost injectable filesystem', () => {
  test('works with a fully injected memory fs without touching disk', async () => {
    const manifest = baseManifest('mem.ext');
    const files = new Map<string, string>([
      ['/fake/ext/mem.ext/pi-ui.extension.json', JSON.stringify(manifest)],
      ['/fake/ext/mem.ext/dist/client.js', 'client'],
      ['/fake/ext/mem.ext/dist/server.mjs', 'server'],
    ]);
    const persisted = new Map<string, string>();
    const memFs = {
      readdir: (dir: string) => {
        if (dir === '/fake/ext') return ['mem.ext'];
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      },
      lstat: (path: string) => {
        if (path === '/fake/ext/mem.ext') return { isDirectory: () => true, isSymbolicLink: () => false };
        if (path === '/fake/ext') return { isDirectory: () => true, isSymbolicLink: () => false };
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      },
      readFile: (path: string, encoding: 'utf8') => {
        void encoding;
        if (files.has(path)) return files.get(path) as string;
        if (persisted.has(path)) return persisted.get(path) as string;
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
      },
      writeFile: (path: string, data: string, encoding: 'utf8') => {
        void encoding;
        persisted.set(path, data);
      },
      rename: (oldPath: string, newPath: string) => {
        const data = persisted.get(oldPath);
        if (data === undefined) throw new Error('missing tmp');
        persisted.delete(oldPath);
        persisted.set(newPath, data);
      },
      mkdir: (path: string, opts: { recursive: boolean }) => {
        void path;
        void opts;
      },
      unlink: (path: string) => {
        persisted.delete(path);
      },
    };
    const loadCalls: string[] = [];
    const host = new AppExtensionHost({
      extensionsRoot: '/fake/ext',
      dataRoot: '/fake/data',
      fs: memFs,
      resolveAsset: (pkgDir, rel) => `${pkgDir}/${rel}`,
      loadPackage: async (packageDir: string) => {
        loadCalls.push(packageDir);
        return {
          manifest: manifest as never,
          handlers: {
            reads: { get: async () => 'mem-ok' },
            actions: { do: async () => 'mem-did' },
          } as never,
          packageRoot: packageDir,
          clientEntryPath: `${packageDir}/dist/client.js`,
          serverEntryPath: `${packageDir}/dist/server.mjs`,
        };
      },
    });
    expect(host.installedIds()).toEqual(['mem.ext']);
    expect(loadCalls).toEqual([]);
    await host.setEnabled('mem.ext', true);
    expect(loadCalls).toEqual(['/fake/ext/mem.ext']);
    expect(await host.read('mem.ext', 'get', {})).toBe('mem-ok');
    expect(host.clientEntryPath('mem.ext')).toBe('/fake/ext/mem.ext/dist/client.js');
    expect(JSON.parse(persisted.get('/fake/data/app-extensions.enabled.json') as string)).toEqual({
      version: 1,
      enabled: ['mem.ext'],
    });
    void basename;
  });
});

describe('AppExtensionHost reload', () => {
  test('re-imports an enabled extension and keeps it enabled', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'alpha.ext');
    const calls: string[] = [];
    const host = new AppExtensionHost({
      extensionsRoot: root,
      dataRoot: data,
      loadPackage: stubLoader(calls),
    });
    await host.setEnabled('alpha.ext', true);
    expect(calls).toHaveLength(1);
    const before = host.innerRuntime.get('alpha.ext');

    await host.reload('alpha.ext');

    // Re-imported from the same directory, and the registration was replaced rather than
    // duplicated (register() rejects an id that is already present).
    expect(calls).toEqual([join(root, 'alpha.ext'), join(root, 'alpha.ext')]);
    expect(host.innerRuntime.get('alpha.ext')).toBeDefined();
    expect(host.innerRuntime.get('alpha.ext')).not.toBe(before);
    expect(host.isEnabled('alpha.ext')).toBe(true);
    expect(host.list().find((s) => s.id === 'alpha.ext')?.enabled).toBe(true);
    expect(host.operations('alpha.ext').map((op) => op.id).sort()).toEqual(['do', 'get']);
    // Still dispatching through the new handlers.
    expect(await host.read('alpha.ext', 'get', { q: 3 })).toEqual({ op: 'get', echo: { q: 3 } });
  });

  test('refuses a disabled extension and an unknown id', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'alpha.ext');
    const calls: string[] = [];
    const host = new AppExtensionHost({
      extensionsRoot: root,
      dataRoot: data,
      loadPackage: stubLoader(calls),
    });

    await expectHostCode(host.reload('alpha.ext'), 'disabled');
    expect(calls).toEqual([]); // No server entry ran for a disabled extension.
    await expectHostCode(host.reload('missing.ext'), 'not-installed');
  });

  test('a failing import leaves the previous handlers registered', async () => {
    const root = tempDir('.tmp-host-root-');
    const data = tempDir('.tmp-host-data-');
    writePackage(root, 'alpha.ext');
    let failNext = false;
    const host = new AppExtensionHost({
      extensionsRoot: root,
      dataRoot: data,
      loadPackage: async (packageDir) => {
        if (failNext) throw new Error('server entry threw: boom');
        return stubLoader([])(packageDir);
      },
    });
    await host.setEnabled('alpha.ext', true);

    failNext = true;
    await expect(host.reload('alpha.ext')).rejects.toThrow(/boom/);

    // Import happens before unregister, so the working registration survives a broken edit.
    expect(host.innerRuntime.get('alpha.ext')).toBeDefined();
    expect(await host.read('alpha.ext', 'get', {})).toEqual({ op: 'get', echo: {} });
  });
});
