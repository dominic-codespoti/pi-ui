import { describe, expect, expectTypeOf, it } from 'vitest';
import { parseAppExtensionManifest } from './manifest.js';
import type { AppExtensionManifestData } from './manifest.js';
import type { AppExtensionManifest } from './types.js';

function validManifest() {
  return {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'my-extension',
    name: 'My Extension',
    version: '1.2.3',
    description: 'A test extension',
    clientEntry: 'dist/client.js',
    serverEntry: 'dist/server.js',
    views: [{ id: 'main-view', title: 'Main', slot: 'sidebar' }],
    operations: [
      {
        id: 'get-status',
        kind: 'read',
        description: 'Read the current status',
        scope: 'project',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        exposeToAgent: true,
      },
    ],
    events: ['note-changed'],
  };
}

describe('parseAppExtensionManifest', () => {
  it('accepts a valid manifest and round-trips the value', () => {
    const raw = validManifest();
    const parsed = parseAppExtensionManifest(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(raw);
      expect(parsed.value.views).toHaveLength(1);
      expect(parsed.value.operations).toHaveLength(1);
    }
  });

  it('accepts minimal views/operations and a dotted relative client entry', () => {
    const raw = {
      ...validManifest(),
      description: undefined,
      clientEntry: './client.js',
      views: [],
      operations: [
        { id: 'run-task', kind: 'action', description: 'Run the task' },
      ],
    };
    // `description: undefined` is equivalent to absent for optional fields.
    delete (raw as Record<string, unknown>).description;
    const parsed = parseAppExtensionManifest(raw);
    expect(parsed.ok).toBe(true);
  });

  it('accepts declared capabilities and defaults them to absent', () => {
    const parsed = parseAppExtensionManifest({
      ...validManifest(),
      capabilities: ['workspace.write', 'session.read'],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.capabilities).toEqual(['workspace.write', 'session.read']);

    const absent = parseAppExtensionManifest(validManifest());
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value.capabilities).toBeUndefined();
  });

  it('rejects unknown or duplicate capabilities', () => {
    expect(parseAppExtensionManifest({ ...validManifest(), capabilities: ['shell.exec'] }).ok).toBe(false);
    expect(
      parseAppExtensionManifest({ ...validManifest(), capabilities: ['session.read', 'session.read'] }).ok
    ).toBe(false);
    expect(parseAppExtensionManifest({ ...validManifest(), capabilities: 'session.read' }).ok).toBe(false);
  });

  it('normalizes legacy primary slots to the unified Workspace slot', () => {
    const parsed = parseAppExtensionManifest({
      ...validManifest(),
      views: [
        { id: 'main', title: 'Main', slot: 'main-tab' },
        { id: 'page', title: 'Page', slot: 'full-page' },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.views.map((view) => view.slot)).toEqual(['workspace', 'workspace']);
  });

  it('keeps the inferred output compatible with the shared contract', () => {
    expectTypeOf<AppExtensionManifestData>().toMatchTypeOf<AppExtensionManifest>();
  });

  it('rejects wrong schemaVersion and apiVersion', () => {
    expect(parseAppExtensionManifest({ ...validManifest(), schemaVersion: 2 }).ok).toBe(
      false,
    );
    expect(parseAppExtensionManifest({ ...validManifest(), schemaVersion: 0 }).ok).toBe(
      false,
    );
    expect(parseAppExtensionManifest({ ...validManifest(), apiVersion: 999 }).ok).toBe(
      false,
    );
    expect(parseAppExtensionManifest({ ...validManifest(), apiVersion: 0 }).ok).toBe(
      false,
    );
    const parsed = parseAppExtensionManifest({ ...validManifest(), apiVersion: 2 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it('rejects invalid extension ids, versions, and names', () => {
    for (const id of ['', 'has space', 'a/b', '-leading-dash', '.leading-dot']) {
      expect(parseAppExtensionManifest({ ...validManifest(), id }).ok).toBe(false);
    }
    for (const version of ['', '1.0', 'v1.2.3', 'latest', '1.2.3.4']) {
      expect(parseAppExtensionManifest({ ...validManifest(), version }).ok).toBe(
        false,
      );
    }
    expect(parseAppExtensionManifest({ ...validManifest(), version: '2.0.0-beta.1' }).ok).toBe(
      true,
    );
    for (const name of ['', '   ']) {
      expect(parseAppExtensionManifest({ ...validManifest(), name }).ok).toBe(false);
    }
  });

  it('rejects unknown view slots', () => {
    const raw = validManifest();
    const parsed = parseAppExtensionManifest({
      ...raw,
      views: [{ id: 'v1', title: 'V', slot: 'header' }],
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects duplicate view ids and duplicate operation ids', () => {
    const dupViews = parseAppExtensionManifest({
      ...validManifest(),
      views: [
        { id: 'same', title: 'One', slot: 'sidebar' },
        { id: 'same', title: 'Two', slot: 'main-tab' },
      ],
    });
    expect(dupViews.ok).toBe(false);

    const dupOps = parseAppExtensionManifest({
      ...validManifest(),
      operations: [
        { id: 'same', kind: 'read', description: 'First' },
        { id: 'same', kind: 'action', description: 'Second' },
      ],
    });
    expect(dupOps.ok).toBe(false);
  });

  it('rejects unsafe clientEntry/serverEntry paths but accepts safe relative ones', () => {
    for (const clientEntry of [
      '../evil.js',
      'dist/../../evil.js',
      '/abs/client.js',
      'C:/win/client.js',
      'dist\\client.js',
      'client.js?v=2',
      'client.js#frag',
      'dist//client.js',
      'dist/client.js\0',
      '',
    ]) {
      expect(parseAppExtensionManifest({ ...validManifest(), clientEntry }).ok).toBe(
        false,
      );
      expect(parseAppExtensionManifest({ ...validManifest(), serverEntry: clientEntry }).ok).toBe(
        false,
      );
    }
    for (const clientEntry of ['client.js', 'dist/client.js', './client.js']) {
      expect(parseAppExtensionManifest({ ...validManifest(), clientEntry }).ok).toBe(
        true,
      );
      expect(parseAppExtensionManifest({ ...validManifest(), serverEntry: clientEntry }).ok).toBe(
        true,
      );
    }
  });

  it('requires serverEntry', () => {
    const raw = validManifest();
    delete (raw as Record<string, unknown>).serverEntry;
    expect(parseAppExtensionManifest(raw).ok).toBe(false);
  });

  it('rejects invalid operation metadata', () => {
    const base = validManifest();
    // Unknown kind.
    expect(
      parseAppExtensionManifest({
        ...base,
        operations: [{ id: 'op', kind: 'write', description: 'Do it' }],
      }).ok,
    ).toBe(false);
    // Empty description.
    expect(
      parseAppExtensionManifest({
        ...base,
        operations: [{ id: 'op', kind: 'read', description: '' }],
      }).ok,
    ).toBe(false);
    // Non-object schemas.
    for (const inputSchema of ['object', 42, ['type']] as unknown[]) {
      expect(
        parseAppExtensionManifest({
          ...base,
          operations: [{ id: 'op', kind: 'read', description: 'D', inputSchema }],
        }).ok,
      ).toBe(false);
    }
    // Non-boolean exposeToAgent.
    expect(
      parseAppExtensionManifest({
        ...base,
        operations: [
          { id: 'op', kind: 'read', description: 'D', exposeToAgent: 'yes' },
        ],
      }).ok,
    ).toBe(false);
    // Empty view title.
    expect(
      parseAppExtensionManifest({
        ...base,
        views: [{ id: 'v', title: '', slot: 'sidebar' }],
      }).ok,
    ).toBe(false);
  });

  it('validates operation scope values', () => {
    const base = validManifest();
    for (const scope of ['app', 'project', 'session']) {
      expect(
        parseAppExtensionManifest({
          ...base,
          operations: [{ id: 'op', kind: 'read', description: 'D', scope }],
        }).ok,
      ).toBe(true);
    }
    // Omitted scope means app-scoped.
    expect(
      parseAppExtensionManifest({
        ...base,
        operations: [{ id: 'op', kind: 'read', description: 'D' }],
      }).ok,
    ).toBe(true);
    for (const scope of ['global', '', 'PROJECT', 42] as unknown[]) {
      expect(
        parseAppExtensionManifest({
          ...base,
          operations: [{ id: 'op', kind: 'read', description: 'D', scope }],
        }).ok,
      ).toBe(false);
    }
  });

  it('validates declared events', () => {
    const base = validManifest();
    expect(
      parseAppExtensionManifest({ ...base, events: ['note-changed', 'timer.fired'] }).ok,
    ).toBe(true);
    expect(parseAppExtensionManifest({ ...base, events: [] }).ok).toBe(true);
    for (const events of [[''], ['   '], [['nested']], ['ok', 42], ['dup', 'dup']] as unknown[]) {
      expect(parseAppExtensionManifest({ ...base, events }).ok).toBe(false);
    }
  });

  it('never throws on non-object payloads', () => {
    for (const raw of [null, undefined, 42, 'string-payload', [], {}]) {
      const parsed = parseAppExtensionManifest(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.issues.length).toBeGreaterThan(0);
    }
    expect(() => parseAppExtensionManifest(null)).not.toThrow();
  });
});
