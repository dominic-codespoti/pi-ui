import { describe, expect, test, vi } from 'vitest';
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  APP_EXTENSION_API_VERSION,
  type AppExtensionCallContext,
  type AppExtensionManifest,
  type AppExtensionScope,
} from '../../app-extensions/types.ts';
import { AppExtensionRuntime } from './runtime.ts';
import {
  APP_EXTENSION_SDK_TOOL_ERROR_LIMIT_CHARS,
  APP_EXTENSION_SDK_TOOL_OUTPUT_LIMIT_BYTES,
  buildSdkAppExtensionTools,
  resolveSdkScope,
  toSdkAgentToolResult,
  toSdkToolParameters,
} from './sdk-tools.ts';

interface TestOp {
  id: string;
  kind: 'read' | 'action';
  exposeToAgent?: boolean;
  description?: string;
  scope?: 'app' | 'project' | 'session';
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
): void {
  const manifest: AppExtensionManifest = {
    schemaVersion: 1,
    apiVersion: APP_EXTENSION_API_VERSION,
    id,
    name: id,
    version: '1.0.0',
    clientEntry: 'dist/client.js',
    serverEntry: 'dist/server.js',
    views: [],
    operations: ops.map((op) => ({
      id: op.id,
      kind: op.kind,
      description: op.description ?? `Do ${op.id}`,
      ...(op.scope !== undefined ? { scope: op.scope } : {}),
      ...(op.exposeToAgent !== undefined ? { exposeToAgent: op.exposeToAgent } : {}),
      ...(op.inputSchema !== undefined ? { inputSchema: op.inputSchema } : {}),
    })),
  };
  const reads: Record<string, (input: Record<string, unknown>, ctx: AppExtensionCallContext) => Promise<unknown>> =
    {};
  const actions: Record<string, (input: Record<string, unknown>, ctx: AppExtensionCallContext) => Promise<unknown>> =
    {};
  for (const op of ops) {
    const fn = async (input: Record<string, unknown>, ctx: AppExtensionCallContext) => {
      calls.push({ extensionId: id, operationId: op.id, input, ctx });
      return { extensionId: id, operationId: op.id, echo: input };
    };
    if (op.kind === 'read') reads[op.id] = fn;
    else actions[op.id] = fn;
  }
  rt.register(manifest, { reads, actions }, { enabled: true });
}

function sdkCtx(cwd = '/work', sessionId = 'sess-1'): ExtensionContext {
  return {
    sessionManager: {
      getCwd: () => cwd,
      getSessionId: () => sessionId,
    },
  } as unknown as ExtensionContext;
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function execute(
  tool: ToolDefinition,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> {
  const result = await (tool.execute as unknown as (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>)(
    'call-1',
    params,
    signal,
    undefined,
    ctx,
  );
  return result;
}

describe('toSdkToolParameters', () => {
  test('preserves the descriptor JSON schema as a TypeBox schema', () => {
    const schema = {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    };
    const params = toSdkToolParameters(schema) as unknown as Record<string, unknown>;
    expect(params).toMatchObject({ type: 'object', properties: { q: { type: 'string' } } });
    const fallback = toSdkToolParameters({
      type: 'object',
      additionalProperties: true,
    }) as unknown as Record<string, unknown>;
    expect(fallback).toMatchObject({ type: 'object', additionalProperties: true });
  });
});

describe('resolveSdkScope', () => {
  test('defaults to app and ignores live session state', () => {
    expect(resolveSdkScope(undefined, { getCwd: () => '/work', getSessionId: () => 's1' })).toEqual(
      {},
    );
    expect(resolveSdkScope('app', { getCwd: () => '/work', getSessionId: () => 's1' })).toEqual({});
  });

  test('derives project scope from getCwd only', () => {
    expect(
      resolveSdkScope('project', { getCwd: () => '/work', getSessionId: () => 's1' }),
    ).toEqual({ projectId: '/work' });
    expect(() =>
      resolveSdkScope('project', { getCwd: () => '', getSessionId: () => 's1' }),
    ).toThrowError(/live session cwd/i);
  });

  test('derives session scope from getSessionId plus cwd when available', () => {
    expect(
      resolveSdkScope('session', { getCwd: () => '/work', getSessionId: () => 's1' }),
    ).toEqual({ projectId: '/work', sessionId: 's1' });
    expect(resolveSdkScope('session', { getCwd: () => '', getSessionId: () => 's1' })).toEqual({
      sessionId: 's1',
    });
    expect(() =>
      resolveSdkScope('session', { getCwd: () => '/work', getSessionId: () => '' }),
    ).toThrowError(/live session id/i);
  });
});

describe('buildSdkAppExtensionTools mapping', () => {
  test('maps descriptors to the public SDK ToolDefinition shape', () => {
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
      'demo.notes',
      [{ id: 'list', kind: 'read', exposeToAgent: true, inputSchema: schema }],
      calls,
    );
    const { tools } = buildSdkAppExtensionTools(rt);
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.name).toBe('app_demo_notes_list');
    expect(tool.label).toContain('demo.notes');
    expect(tool.description).toBe('Do list');
    expect((tool.parameters as unknown as Record<string, unknown>).type).toBe('object');
    expect(typeof tool.execute).toBe('function');
  });

  test('exposes only agent-visible operations and stays sorted', () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'zeta',
      [
        { id: 'b', kind: 'read', exposeToAgent: true },
        { id: 'hidden', kind: 'read' },
      ],
      calls,
    );
    registerTestExtension(rt, 'alpha', [{ id: 'a', kind: 'read', exposeToAgent: true }], calls);
    const { tools } = buildSdkAppExtensionTools(rt);
    expect(tools.map((t) => t.name)).toEqual(['app_alpha_a', 'app_zeta_b']);
  });

  test('reports skipped extensions as warnings without losing the rest', () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(rt, 'good', [{ id: 'ping', kind: 'read', exposeToAgent: true }], calls);
    registerTestExtension(rt, 'team.a', [{ id: 'b_c', kind: 'read', exposeToAgent: true }], calls);
    registerTestExtension(rt, 'team_a', [{ id: 'b.c', kind: 'read', exposeToAgent: true }], calls);
    const built = buildSdkAppExtensionTools(rt);
    expect(built.tools.map((t) => t.name).sort()).toEqual(['app_good_ping', 'app_team_a_b_c']);
    expect(built.warnings).toHaveLength(1);
    expect(built.warnings[0]).toMatch(/team_a/);
    expect(built.warnings[0]).toMatch(/collides/);
  });
});

describe('buildSdkAppExtensionTools scope derivation', () => {
  test('derives explicit scope from the live session manager, not tool params', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'demo.notes',
      [
        { id: 'stats', kind: 'read', exposeToAgent: true },
        { id: 'reindex', kind: 'action', exposeToAgent: true, scope: 'project' },
        { id: 'summarize', kind: 'read', exposeToAgent: true, scope: 'session' },
      ],
      calls,
    );
    const { tools } = buildSdkAppExtensionTools(rt);

    // Tool params carrying fake scope ids must not leak into the call scope.
    const hostile = { q: 1, scope: { projectId: '/evil', sessionId: 'evil' }, projectId: '/evil' };
    await execute(toolByName(tools, 'app_demo_notes_stats'), hostile, sdkCtx('/work', 'sess-9'));
    await execute(toolByName(tools, 'app_demo_notes_reindex'), hostile, sdkCtx('/work', 'sess-9'));
    await execute(toolByName(tools, 'app_demo_notes_summarize'), hostile, sdkCtx('/work', 'sess-9'));

    expect(calls[0].ctx.scope).toEqual({});
    expect(calls[1].ctx.scope).toEqual({ projectId: '/work' });
    expect(calls[2].ctx.scope).toEqual({ projectId: '/work', sessionId: 'sess-9' });
    for (const call of calls) {
      expect(call.ctx.caller.kind).toBe('agent');
    }
    expect(calls[2].ctx.caller).toEqual({ kind: 'agent', sessionId: 'sess-9' });
  });

  test('never falls back to global or focused state: missing live context rejects', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'demo.notes',
      [{ id: 'summarize', kind: 'read', exposeToAgent: true, scope: 'session' }],
      calls,
    );
    const [tool] = buildSdkAppExtensionTools(rt).tools;
    await expect(
      execute(tool, {}, {} as unknown as ExtensionContext),
    ).rejects.toThrowError(/live.*sessionManager/i);
    await expect(
      execute(tool, {}, { sessionManager: {} } as unknown as ExtensionContext),
    ).rejects.toThrowError(/live.*sessionManager/i);
    expect(calls).toHaveLength(0);
  });

  test('project scope without a live cwd rejects instead of using ambient state', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'demo.notes',
      [{ id: 'reindex', kind: 'action', exposeToAgent: true, scope: 'project' }],
      calls,
    );
    const [tool] = buildSdkAppExtensionTools(rt).tools;
    await expect(execute(tool, {}, sdkCtx('', 'sess-1'))).rejects.toThrowError();
    expect(calls).toHaveLength(0);
  });
});

describe('buildSdkAppExtensionTools abort handling', () => {
  test('pre-aborted signals reject without dispatching', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'demo.notes',
      [{ id: 'list', kind: 'read', exposeToAgent: true }],
      calls,
    );
    const [tool] = buildSdkAppExtensionTools(rt).tools;
    const controller = new AbortController();
    controller.abort();
    await expect(execute(tool, { q: 1 }, sdkCtx(), controller.signal)).rejects.toThrowError(
      /aborted/i,
    );
    expect(calls).toHaveLength(0);
  });

  test('forwards the live signal into the runtime context', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'demo.notes',
      [{ id: 'list', kind: 'read', exposeToAgent: true }],
      calls,
    );
    const [tool] = buildSdkAppExtensionTools(rt).tools;
    const controller = new AbortController();
    await execute(tool, { q: 1 }, sdkCtx(), controller.signal);
    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.signal).toBe(controller.signal);
  });

  test('an abort racing the dispatch rejects even when the handler ignores it', async () => {
    const rt = new AppExtensionRuntime();
    rt.register(
      {
        schemaVersion: 1,
        apiVersion: APP_EXTENSION_API_VERSION,
        id: 'slow.ext',
        name: 'slow',
        version: '1.0.0',
        clientEntry: 'dist/client.js',
        serverEntry: 'dist/server.js',
        views: [],
        operations: [{ id: 'wait', kind: 'read', description: 'Wait', exposeToAgent: true }],
      },
      { reads: { wait: async () => new Promise(() => {}) }, actions: {} },
    );
    const [tool] = buildSdkAppExtensionTools(rt).tools;
    const controller = new AbortController();
    const pending = execute(tool, {}, sdkCtx(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrowError(/aborted/i);
  });
});

describe('toSdkAgentToolResult bounding', () => {
  test('returns the SDK AgentToolResult shape for small results', () => {
    const result = toSdkAgentToolResult(
      { extensionId: 'demo.notes', operationId: 'list', name: 'app_demo_notes_list' },
      { items: [1, 2] },
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ items: [1, 2] });
    expect(result.details).toEqual({ items: [1, 2] });
  });

  test('bounds large JSON output with a truncation marker on both text and details', async () => {
    const rt = new AppExtensionRuntime();
    const big = 'x'.repeat(APP_EXTENSION_SDK_TOOL_OUTPUT_LIMIT_BYTES + 1024);
    rt.register(
      {
        schemaVersion: 1,
        apiVersion: APP_EXTENSION_API_VERSION,
        id: 'big.ext',
        name: 'big',
        version: '1.0.0',
        clientEntry: 'dist/client.js',
        serverEntry: 'dist/server.js',
        views: [],
        operations: [{ id: 'dump', kind: 'read', description: 'Dump', exposeToAgent: true }],
      },
      { reads: { dump: async () => big }, actions: {} },
    );
    const [tool] = buildSdkAppExtensionTools(rt).tools;
    const result = await execute(tool, {}, sdkCtx());
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/truncated/);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
      APP_EXTENSION_SDK_TOOL_OUTPUT_LIMIT_BYTES + 64,
    );
    expect(result.details).toMatchObject({ truncated: true });
  });

  test('throws a bounded error result for failures and unserializable values', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'demo.notes',
      [{ id: 'boom', kind: 'read', exposeToAgent: true }],
      calls,
    );
    rt.register(
      {
        schemaVersion: 1,
        apiVersion: APP_EXTENSION_API_VERSION,
        id: 'fail.ext',
        name: 'fail',
        version: '1.0.0',
        clientEntry: 'dist/client.js',
        serverEntry: 'dist/server.js',
        views: [],
        operations: [
          { id: 'nope', kind: 'read', description: 'Nope', exposeToAgent: true },
          { id: 'huge-err', kind: 'read', description: 'Huge', exposeToAgent: true },
          { id: 'circular', kind: 'read', description: 'Circular', exposeToAgent: true },
        ],
      },
      {
        reads: {
          nope: async () => {
            throw new Error('boom');
          },
          'huge-err': async () => {
            throw new Error(`boom ${'x'.repeat(10000)}`);
          },
          circular: async () => {
            const self: Record<string, unknown> = {};
            self.self = self;
            return self;
          },
        },
        actions: {},
      },
    );
    const { tools } = buildSdkAppExtensionTools(rt);
    await expect(execute(toolByName(tools, 'app_fail_ext_nope'), {}, sdkCtx())).rejects.toThrowError(
      /fail\.ext:nope.*boom/i,
    );
    const huge = await execute(
      toolByName(tools, 'app_fail_ext_huge_err'),
      {},
      sdkCtx(),
    ).catch((err: unknown) => err as Error);
    expect(huge).toBeInstanceOf(Error);
    if (!(huge instanceof Error)) throw new Error('expected bounded Error');
    expect(huge.message.length).toBeLessThanOrEqual(
      APP_EXTENSION_SDK_TOOL_ERROR_LIMIT_CHARS + 200,
    );
    expect(huge.message).toMatch(/truncated/);
    await expect(
      execute(toolByName(tools, 'app_fail_ext_circular'), {}, sdkCtx()),
    ).rejects.toThrowError(/JSON-serializable/i);
  });
});

describe('buildSdkAppExtensionTools context-factory injection', () => {
  test('lets server composition inject the shared validated execution context', async () => {
    const rt = new AppExtensionRuntime();
    const calls: SeenCall[] = [];
    registerTestExtension(
      rt,
      'demo.notes',
      [{ id: 'list', kind: 'read', exposeToAgent: true, scope: 'project' }],
      calls,
    );
    const createContext = vi.fn(async (args: { scope: AppExtensionScope; sessionId?: string; signal?: AbortSignal }) => ({
      scope: args.scope,
      caller: { kind: 'agent', sessionId: args.sessionId ?? 'injected' } as const,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
      workspace: { marker: 'shared-validated' },
    }));
    const { tools } = buildSdkAppExtensionTools(rt, {
      createContext: createContext as unknown as Parameters<typeof buildSdkAppExtensionTools>[1] extends {
        createContext?: infer F;
      }
        ? F
        : never,
    });
    const controller = new AbortController();
    await execute(tools[0], { q: 1 }, sdkCtx('/work', 'sess-7'), controller.signal);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(createContext.mock.lastCall?.[0]).toMatchObject({
      extensionId: 'demo.notes',
      operationId: 'list',
      scope: { projectId: '/work' },
      sessionId: 'sess-7',
    });
    expect(calls[0].ctx).toMatchObject({
      scope: { projectId: '/work' },
      workspace: { marker: 'shared-validated' },
    });
    expect(calls[0].ctx.signal).toBe(controller.signal);
  });
});
