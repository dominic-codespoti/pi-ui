import { describe, expect, test } from 'vitest';
import {
  APP_EXTENSION_API_VERSION,
  type AppExtensionCallContext,
  type AppExtensionManifest,
  type AppExtensionScope,
} from '../../app-extensions/types.ts';
import {
  AppExtensionAgentToolError,
  buildAppExtensionAgentTools,
  toAgentToolName,
} from './agent-tools.ts';
import { AppExtensionError, AppExtensionRuntime } from './runtime.ts';

interface TestOp {
  id: string;
  kind: 'read' | 'action';
  exposeToAgent?: boolean;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface SeenCall {
  extensionId: string;
  operationId: string;
  input: unknown;
  ctx: AppExtensionCallContext;
}

function registerTestExtension(
  rt: AppExtensionRuntime,
  id: string,
  ops: TestOp[],
  calls: SeenCall[],
  opts?: { enabled?: boolean; name?: string },
): void {
  const manifest: AppExtensionManifest = {
    schemaVersion: 1,
    apiVersion: APP_EXTENSION_API_VERSION,
    id,
    name: opts?.name ?? id,
    version: '1.0.0',
    clientEntry: 'dist/client.js',
    serverEntry: 'dist/server.js',
    views: [],
    operations: ops.map((op) => ({
      id: op.id,
      kind: op.kind,
      description: op.description ?? `Do ${op.id}`,
      ...(op.exposeToAgent !== undefined ? { exposeToAgent: op.exposeToAgent } : {}),
      ...(op.inputSchema !== undefined ? { inputSchema: op.inputSchema } : {}),
    })),
  };
  const reads: Record<string, (input: Record<string, unknown>, ctx: AppExtensionCallContext) => Promise<unknown>> = {};
  const actions: Record<string, (input: Record<string, unknown>, ctx: AppExtensionCallContext) => Promise<unknown>> = {};
  for (const op of ops) {
    const fn = async (input: Record<string, unknown>, ctx: AppExtensionCallContext) => {
      calls.push({ extensionId: id, operationId: op.id, input, ctx });
      return { extensionId: id, operationId: op.id, echo: input };
    };
    if (op.kind === 'read') reads[op.id] = fn;
    else actions[op.id] = fn;
  }
  rt.register(manifest, { reads, actions }, { enabled: opts?.enabled ?? true });
}

function scopeFor(projectId = 'proj-1', sessionId = 'sess-1'): AppExtensionScope {
  return { projectId, sessionId };
}

describe('buildAppExtensionAgentTools filtering', () => {
  test('exposes only enabled extensions with exposeToAgent === true', () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'exta',
      [
        { id: 'r1', kind: 'read', exposeToAgent: true },
        { id: 'r2', kind: 'read', exposeToAgent: false },
        { id: 'a1', kind: 'action' },
      ],
      calls,
    );
    registerTestExtension(rt, 'extb', [{ id: 'x', kind: 'read', exposeToAgent: true }], calls, {
      enabled: false,
    });

    const { tools } = buildAppExtensionAgentTools(rt);
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.name).toBe('app_exta_r1');
    expect(tool.extensionId).toBe('exta');
    expect(tool.operationId).toBe('r1');
    expect(tool.kind).toBe('read');
    expect(tool.description).toBe('Do r1');
    expect(tool.label).toContain('exta');
    expect(tool.label).toContain('r1');
    expect(typeof tool.execute).toBe('function');
  });

  test('returns an empty list when nothing is agent-visible', () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(rt, 'plain', [{ id: 'list', kind: 'read' }], calls);
    expect(buildAppExtensionAgentTools(rt).tools).toEqual([]);
    expect(buildAppExtensionAgentTools(new AppExtensionRuntime()).tools).toEqual([]);
  });

  test('uses the manifest input schema or a generic object fallback', () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    const schema = {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    };
    registerTestExtension(
      rt,
      'exts',
      [
        { id: 'search', kind: 'read', exposeToAgent: true, inputSchema: schema },
        { id: 'ping', kind: 'read', exposeToAgent: true },
      ],
      calls,
    );
    const { tools } = buildAppExtensionAgentTools(rt);
    expect(tools).toHaveLength(2);
    const byOp = new Map(tools.map((t) => [t.operationId, t]));
    expect(byOp.get('search')?.inputSchema).toEqual(schema);
    expect(byOp.get('ping')?.inputSchema).toEqual({ type: 'object', additionalProperties: true });
    // Fresh copies — mutating one descriptor must not affect the next build.
    expect(byOp.get('search')?.inputSchema).not.toBe(schema);
    byOp.get('ping')!.inputSchema.extra = true;
    expect(
      buildAppExtensionAgentTools(rt).tools.find((t) => t.operationId === 'ping')?.inputSchema,
    ).toEqual({ type: 'object', additionalProperties: true });
  });
});

describe('agent tool naming', () => {
  test('normalizes to app_<extension>_<operation> deterministically', () => {
    expect(toAgentToolName('demo.notes', 'list')).toBe('app_demo_notes_list');
    expect(toAgentToolName('Demo.Notes', 'List')).toBe('app_demo_notes_list');
    expect(toAgentToolName('team-a', 'create item')).toBe('app_team_a_create_item');
    // Stable across builds regardless of registration order.
    const calls: SeenCall[] = [];
    const rt1 = new AppExtensionRuntime();
    registerTestExtension(rt1, 'zeta', [{ id: 'b', kind: 'read', exposeToAgent: true }], calls);
    registerTestExtension(rt1, 'alpha', [{ id: 'a', kind: 'read', exposeToAgent: true }], calls);
    const rt2 = new AppExtensionRuntime();
    registerTestExtension(rt2, 'alpha', [{ id: 'a', kind: 'read', exposeToAgent: true }], calls);
    registerTestExtension(rt2, 'zeta', [{ id: 'b', kind: 'read', exposeToAgent: true }], calls);
    const names1 = buildAppExtensionAgentTools(rt1).tools.map((t) => t.name);
    const names2 = buildAppExtensionAgentTools(rt2).tools.map((t) => t.name);
    expect(names1).toEqual(['app_alpha_a', 'app_zeta_b']);
    expect(names2).toEqual(names1);
  });

  test('rejects empty or blank ids', () => {
    for (const bad of ['', '   ']) {
      expect(() => toAgentToolName(bad, 'op')).toThrowError(AppExtensionAgentToolError);
      expect(() => toAgentToolName('ext', bad)).toThrowError(AppExtensionAgentToolError);
    }
    try {
      toAgentToolName('', 'op');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppExtensionAgentToolError);
      expect((err as AppExtensionAgentToolError).code).toBe('invalid-name');
    }
  });

  test('skips overlong generated names', () => {
    expect(() => toAgentToolName('e'.repeat(120), 'o'.repeat(20))).toThrowError(
      AppExtensionAgentToolError,
    );
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'e'.repeat(100),
      [{ id: 'o'.repeat(40), kind: 'read', exposeToAgent: true }],
      calls,
    );
    const built = buildAppExtensionAgentTools(rt);
    expect(built.tools).toEqual([]);
    expect(built.skipped).toHaveLength(1);
    expect(built.skipped[0]?.extensionId).toBe('e'.repeat(100));
  });

  test('skips colliding names within one extension', () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    // Distinct operation ids that normalize identically ('List' vs 'list').
    registerTestExtension(
      rt,
      'demo.notes',
      [
        { id: 'List', kind: 'read', exposeToAgent: true },
        { id: 'list', kind: 'read', exposeToAgent: true },
      ],
      calls,
    );
    const built = buildAppExtensionAgentTools(rt);
    expect(built.tools).toEqual([]);
    expect(built.skipped).toHaveLength(1);
    expect(built.skipped[0]?.extensionId).toBe('demo.notes');
    expect(built.skipped[0]?.message).toMatch(/collides/);
  });

  test('skips colliding names across extensions, keeping the first winner', () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    // 'team.a' + 'b_c' and 'team_a' + 'b.c' both normalize to app_team_a_b_c.
    registerTestExtension(rt, 'team.a', [{ id: 'b_c', kind: 'read', exposeToAgent: true }], calls);
    registerTestExtension(rt, 'team_a', [{ id: 'b.c', kind: 'read', exposeToAgent: true }], calls);
    const built = buildAppExtensionAgentTools(rt);
    expect(built.tools.map((t) => t.name)).toEqual(['app_team_a_b_c']);
    expect(built.tools[0]?.extensionId).toBe('team.a');
    expect(built.skipped).toHaveLength(1);
    expect(built.skipped[0]?.extensionId).toBe('team_a');
    expect(built.skipped[0]?.message).toMatch(/collides/);
  });

  test('one broken extension never takes down the rest', () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(rt, 'good', [{ id: 'ping', kind: 'read', exposeToAgent: true }], calls);
    registerTestExtension(rt, 'team.a', [{ id: 'b_c', kind: 'read', exposeToAgent: true }], calls);
    registerTestExtension(rt, 'team_a', [{ id: 'b.c', kind: 'read', exposeToAgent: true }], calls);
    registerTestExtension(rt, 'also-good', [{ id: 'pong', kind: 'read', exposeToAgent: true }], calls);
    const built = buildAppExtensionAgentTools(rt);
    expect(built.tools.map((t) => t.name).sort()).toEqual([
      'app_also_good_pong',
      'app_good_ping',
      'app_team_a_b_c',
    ]);
    expect(built.skipped.map((s) => s.extensionId)).toEqual(['team_a']);
  });
});

describe('agent tool execution', () => {
  test('dispatches reads and actions through the shared runtime handlers', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'demo.notes',
      [
        { id: 'list', kind: 'read', exposeToAgent: true },
        { id: 'create', kind: 'action', exposeToAgent: true },
      ],
      calls,
    );
    const { tools } = buildAppExtensionAgentTools(rt);
    const byOp = new Map(tools.map((t) => [t.operationId, t]));
    const scope = scopeFor();

    await expect(byOp.get('list')!.execute({ q: 'x' }, undefined, { scope })).resolves.toEqual({
      extensionId: 'demo.notes',
      operationId: 'list',
      echo: { q: 'x' },
    });
    await expect(
      byOp.get('create')!.execute({ title: 't' }, undefined, { scope }),
    ).resolves.toEqual({
      extensionId: 'demo.notes',
      operationId: 'create',
      echo: { title: 't' },
    });
    expect(calls.map((c) => `${c.extensionId}:${c.operationId}`)).toEqual([
      'demo.notes:list',
      'demo.notes:create',
    ]);
    // Results pass through unchanged (generic output, no truncation).
    expect(calls[0].input).toEqual({ q: 'x' });
  });

  test('supplies caller kind agent with explicit scope and preserves the signal', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(rt, 'demo.notes', [{ id: 'list', kind: 'read', exposeToAgent: true }], calls);
    const [tool] = buildAppExtensionAgentTools(rt).tools;
    const scope = scopeFor('proj-9', 'sess-9');
    const controller = new AbortController();

    await tool.execute({ q: 1 }, controller.signal, { scope, sessionId: 'sess-9' });
    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.caller).toEqual({ kind: 'agent', sessionId: 'sess-9' });
    expect(calls[0].ctx.scope).toBe(scope);
    expect(calls[0].ctx.signal).toBe(controller.signal);
  });

  test('omits sessionId when none is supplied', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(rt, 'demo.notes', [{ id: 'list', kind: 'read', exposeToAgent: true }], calls);
    const [tool] = buildAppExtensionAgentTools(rt).tools;
    await tool.execute({}, undefined, { scope: scopeFor() });
    expect(calls[0].ctx.caller).toEqual({ kind: 'agent' });
    expect('sessionId' in (calls[0].ctx.caller as object)).toBe(false);
    expect(calls[0].ctx.signal).toBeUndefined();
  });

  test('accepts the session object as the second argument', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(rt, 'demo.notes', [{ id: 'list', kind: 'read', exposeToAgent: true }], calls);
    const [tool] = buildAppExtensionAgentTools(rt).tools;
    const scope = scopeFor();
    await tool.execute({ q: 2 }, { scope, sessionId: 's-2' });
    expect(calls[0].ctx.caller).toEqual({ kind: 'agent', sessionId: 's-2' });
    expect(calls[0].ctx.scope).toBe(scope);
  });

  test('requires an explicit scope and never infers one', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'demo.notes',
      [{ id: 'list', kind: 'read', exposeToAgent: true }],
      calls,
    );
    const [tool] = buildAppExtensionAgentTools(rt).tools;
    await expect(tool.execute({ q: 1 })).rejects.toThrowError(/explicit scope/i);
    await expect(tool.execute({ q: 1 }, new AbortController().signal)).rejects.toThrowError(
      AppExtensionAgentToolError,
    );
    await expect(
      tool.execute({ q: 1 }, undefined, {} as unknown as { scope: AppExtensionScope }),
    ).rejects.toThrowError(AppExtensionAgentToolError);
    expect(calls).toHaveLength(0);

    // Scopes do not leak between executions.
    const scopeA = scopeFor('proj-a', 'sess-a');
    const scopeB = scopeFor('proj-b', 'sess-b');
    await tool.execute({}, undefined, { scope: scopeA });
    await tool.execute({}, undefined, { scope: scopeB });
    expect(calls.map((c) => c.ctx.scope)).toEqual([scopeA, scopeB]);
    expect(calls[0].ctx.scope).toBe(scopeA);
    expect(calls[1].ctx.scope).toBe(scopeB);
  });

  test('defaults input to an empty object', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(rt, 'demo.notes', [{ id: 'list', kind: 'read', exposeToAgent: true }], calls);
    const [tool] = buildAppExtensionAgentTools(rt).tools;
    await tool.execute(undefined, undefined, { scope: scopeFor() });
    expect(calls[0].input).toEqual({});
  });

  test('passes handler results through unchanged', async () => {
    const rt = new AppExtensionRuntime();
    const nested = { items: [1, { two: 2 }], meta: { ok: true } };
    rt.register(
      {
        schemaVersion: 1,
        apiVersion: APP_EXTENSION_API_VERSION,
        id: 'rich.ext',
        name: 'rich',
        version: '1.0.0',
        clientEntry: 'dist/client.js',
        serverEntry: 'dist/server.js',
        views: [],
        operations: [{ id: 'fetch', kind: 'read', description: 'Fetch', exposeToAgent: true }],
      },
      { reads: { fetch: async () => nested }, actions: {} },
    );
    const [tool] = buildAppExtensionAgentTools(rt).tools;
    await expect(tool.execute({}, undefined, { scope: scopeFor() })).resolves.toBe(nested);
  });

  test('propagates runtime errors when the extension is disabled after build', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(rt, 'demo.notes', [{ id: 'list', kind: 'read', exposeToAgent: true }], calls);
    const [tool] = buildAppExtensionAgentTools(rt).tools;
    rt.disable('demo.notes');
    await expect(tool.execute({}, undefined, { scope: scopeFor() })).rejects.toSatisfy(
      (err) => err instanceof AppExtensionError && err.code === 'disabled',
    );
  });
});
