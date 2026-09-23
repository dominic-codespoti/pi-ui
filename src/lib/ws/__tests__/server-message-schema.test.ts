import { describe, expect, it } from 'vitest';
import {
  parseServerMessage,
  ConnectedMessageSchema,
  SessionLoadedSchema,
  SessionsErrorSchema,
  AvailableModelsChangedSchema,
  ModelsRefreshResultSchema,
} from '../server-message-schema.js';

const v = await import('valibot');

describe('server-message-schema', () => {
  it('parses valid connected sample with kind "connected"', () => {
    const raw = {
      type: 'connected',
      sessionId: 'sess-1234',
      isStreaming: false,
      thinkingLevel: 'medium',
      model: {
        provider: 'anthropic',
        id: 'claude-3-7-sonnet',
        name: 'Claude 3.7 Sonnet',
        reasoning: true,
        contextWindow: 200000,
      },
      availableModels: [
        {
          provider: 'anthropic',
          id: 'claude-3-7-sonnet',
          name: 'Claude 3.7 Sonnet',
          reasoning: true,
        },
      ],
      messages: [{ role: 'user', content: 'hello' }],
      sessionPath: '/tmp/test.json',
      totalMessageCount: 1,
      messagesTruncated: false,
    };

    const parsed = parseServerMessage(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.kind === 'connected') {
      expect(parsed.value.sessionId).toBe('sess-1234');
      expect(parsed.value.model?.id).toBe('claude-3-7-sonnet');
      expect(parsed.value.availableModels).toHaveLength(1);
    }
  });
  it('accepts partial extension UI snapshots but still rejects wrong field types', () => {
    const connected = {
      type: 'connected',
      sessionId: 'sess-partial-ui',
      isStreaming: false,
      thinkingLevel: 'medium',
      model: null,
      availableModels: [],
      messages: [],
      extensionUiState: { terminalInputActive: true },
    };

    const parsed = parseServerMessage(connected);
    expect(parsed.ok).toBe(true);

    const invalid = parseServerMessage({ ...connected, messages: 'x' });
    expect(invalid.ok).toBe(false);
  });

  it('parses session_loaded without optional isStreaming', () => {
    const raw = {
      type: 'session_loaded',
      sessionId: 'sess-5678',
      thinkingLevel: 'off',
      model: null,
      availableModels: [],
      messages: [],
    };

    const parsed = parseServerMessage(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.kind).toBe('custom');
      expect(parsed.value.sessionId).toBe('sess-5678');
      expect(parsed.value.isStreaming).toBeUndefined();
      expect(parsed.value.model).toBeNull();
    }
  });

  it('preserves stamped session_loaded responses and rejects malformed request IDs', () => {
    const loaded = parseServerMessage({
      type: 'session_loaded',
      sessionId: 'sess-5678',
      requestId: 'req-load-1',
      thinkingLevel: 'off',
      model: null,
      availableModels: [],
      messages: [],
    });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.requestId).toBe('req-load-1');

    expect(
      parseServerMessage({
        type: 'session_loaded',
        sessionId: 'sess-5678',
        requestId: '',
        thinkingLevel: 'off',
        model: null,
        availableModels: [],
        messages: [],
      }).ok
    ).toBe(false);
    expect(
      parseServerMessage({
        type: 'sessions_error',
        message: 'failed',
        requestId: 42,
      }).ok
    ).toBe(false);
  });

  it('validates newly registered custom event payloads', () => {
    const validEvents = [
      {
        type: 'extension_error',
        error: { extensionPath: '/tmp/example.ts', event: 'load', error: 'failed' },
      },
      { type: 'package_result', success: true, message: 'Package installed.' },
      { type: 'agent_error', error: 'Agent failed.' },
    ];

    for (const raw of validEvents) {
      const parsed = parseServerMessage(raw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.kind).toBe('custom');
    }

    expect(
      parseServerMessage({
        type: 'extension_error',
        error: { extensionPath: '/tmp/example.ts', event: 'load' },
      }).ok
    ).toBe(false);
    expect(
      parseServerMessage({
        type: 'extension_error',
        error: { extensionPath: '/tmp/example.ts', event: 'load', error: 42 },
      }).ok
    ).toBe(false);
    expect(parseServerMessage({ type: 'package_result', success: true }).ok).toBe(false);
    expect(parseServerMessage({ type: 'agent_error', error: 42 }).ok).toBe(false);
  });

  it('parses sessions_error with requestId and round-trips', () => {
    const raw = {
      type: 'sessions_error',
      message: 'Failed to switch session',
      requestId: 'req-abc-999',
    };

    const parsed = parseServerMessage(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.kind).toBe('custom');
      expect(parsed.value.message).toBe('Failed to switch session');
      expect(parsed.value.requestId).toBe('req-abc-999');
    }
  });

  it('fails with ok:false for garbage inputs (number, null, array, missing type)', () => {
    expect(parseServerMessage(null).ok).toBe(false);
    expect(parseServerMessage(undefined).ok).toBe(false);
    expect(parseServerMessage(42).ok).toBe(false);
    expect(parseServerMessage('string-payload').ok).toBe(false);
    expect(parseServerMessage([]).ok).toBe(false);
    expect(parseServerMessage({}).ok).toBe(false);
    expect(parseServerMessage({ type: '' }).ok).toBe(false);

    const failRes = parseServerMessage(123);
    expect(failRes.ok).toBe(false);
    if (!failRes.ok) {
      expect(failRes.issues.length).toBeGreaterThan(0);
    }
  });

  it('passes unknown type "some_future_event" as kind "sdk"', () => {
    const raw = {
      type: 'some_future_event',
      foo: 'bar',
      nested: { a: 1, b: 2 },
    };

    const parsed = parseServerMessage(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.kind).toBe('sdk');
      expect(parsed.value.type).toBe('some_future_event');
      expect(parsed.value.foo).toBe('bar');
    }
  });

  it.each(['toString', 'constructor', 'hasOwnProperty'])(
    'passes inherited event type %s through as SDK without throwing',
    (type) => {
      const raw = { type, payload: 'future SDK data' };

      expect(() => parseServerMessage(raw)).not.toThrow();
      const parsed = parseServerMessage(raw);
      expect(parsed).toEqual({ ok: true, kind: 'sdk', value: raw });
    }
  );

  it('parses available_models_changed with sessionId', () => {
    const raw = {
      type: 'available_models_changed',
      sessionId: 'sess-active',
      availableModels: [
        {
          provider: 'openai',
          id: 'gpt-4o',
          name: 'GPT-4o',
          reasoning: false,
        },
      ],
    };

    const parsed = parseServerMessage(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.kind).toBe('custom');
      expect(parsed.value.sessionId).toBe('sess-active');
      expect(parsed.value.availableModels).toHaveLength(1);
    }
  });

  it('parses resources and commands catalogs as typed custom events', () => {
    expect(
      parseServerMessage({
        type: 'resources_list',
        skills: [
          {
            name: 'build',
            description: 'Build project',
            scope: 'project',
            isBuiltin: false,
            source: '/tmp/build.md',
          },
        ],
        prompts: [],
        sessionId: 'sess-1',
      })
    ).toMatchObject({ ok: true, kind: 'custom' });
    expect(
      parseServerMessage({
        type: 'commands_list',
        commands: [{ name: 'deploy', source: 'extension' }],
        sessionId: 'sess-1',
      })
    ).toMatchObject({ ok: true, kind: 'custom' });
    expect(
      parseServerMessage({
        type: 'commands_list',
        commands: [{ name: 'deploy', source: 42 }],
      }).ok
    ).toBe(false);
  });

  it('rejects drift from required shared wire fields', () => {
    expect(
      parseServerMessage({
        type: 'model_changed',
        model: { provider: 'openai', id: 'gpt', reasoning: false },
      }).ok
    ).toBe(false);
    expect(
      parseServerMessage({
        type: 'project_trust',
        trust: { cwd: '/tmp/project', requiresDecision: true },
      }).ok
    ).toBe(false);
    expect(
      parseServerMessage({
        type: 'package_progress',
        progress: { phase: 'start' },
      }).ok
    ).toBe(false);
  });

  it('parses other custom server events correctly', () => {
    const modelChanged = parseServerMessage({
      type: 'model_changed',
      model: {
        provider: 'anthropic',
        id: 'claude-3-7-sonnet',
        name: 'Claude 3.7 Sonnet',
        reasoning: true,
      },
    });
    expect(modelChanged.ok).toBe(true);

    const slashResult = parseServerMessage({
      type: 'slash_result',
      command: 'test',
      message: 'ran successfully',
      level: 'info',
    });
    expect(slashResult.ok).toBe(true);

    const fileContent = parseServerMessage({
      type: 'file_content',
      path: 'src/app.ts',
      content: 'console.log("hello");',
    });
    expect(fileContent.ok).toBe(true);

    const fileSaved = parseServerMessage({
      type: 'file_saved',
      path: 'src/app.ts',
    });
    expect(fileSaved.ok).toBe(true);

    const webhookUrl = parseServerMessage({
      type: 'notification_webhook_url',
      url: 'https://ntfy.sh/test',
    });
    expect(webhookUrl.ok).toBe(true);

    const sessionRuntime = parseServerMessage({
      type: 'session_runtime',
      sessionId: 's-1',
      phase: 'idle',
      isRunning: false,
      lastActivity: 1234567890,
      unread: false,
      needsAttention: false,
      resident: true,
    });
    expect(sessionRuntime.ok).toBe(true);
    if (sessionRuntime.ok && sessionRuntime.kind === 'custom') {
      expect(sessionRuntime.value.phase).toBe('idle');
      expect(sessionRuntime.value.activeToolName).toBeUndefined();
    }

    const olderMsgs = parseServerMessage({
      type: 'older_messages',
      messages: [{ id: 'm1' }],
      totalMessageCount: 10,
      messagesTruncated: true,
    });
    expect(olderMsgs.ok).toBe(true);

    const termInput = parseServerMessage({
      type: 'extension_terminal_input_result',
      id: 'term-1',
      consumed: true,
      data: 'abc',
    });
    expect(termInput.ok).toBe(true);
  });
  it('validates extended and legacy session_runtime frames', () => {
    const full = {
      type: 'session_runtime',
      sessionId: 's-runtime',
      phase: 'running',
      isRunning: true,
      lastActivity: 1700000000000,
      unread: true,
      needsAttention: false,
      resident: true,
    };

    expect(parseServerMessage(full).ok).toBe(true);
    expect(
      parseServerMessage({
        type: 'session_runtime',
        sessionId: 's-legacy',
        isRunning: false,
        lastActivity: 1700000000000,
      }).ok
    ).toBe(true);
    expect(parseServerMessage({ ...full, phase: 'paused' }).ok).toBe(false);
  });

  it('reports validation issues when a known custom schema has invalid fields', () => {
    const invalidSessionLoaded = parseServerMessage({
      type: 'session_loaded',
      sessionId: 12345, // invalid type
      isStreaming: 'not-a-bool',
    });
    expect(invalidSessionLoaded.ok).toBe(false);
    if (!invalidSessionLoaded.ok) {
      expect(invalidSessionLoaded.issues.length).toBeGreaterThan(0);
      expect(invalidSessionLoaded.issues.some((i) => i.includes('sessionId'))).toBe(true);
    }
  });

  it('parses correlated extension completions and preserves unknown fields', () => {
    const parsed = parseServerMessage({
      type: 'extension_completions',
      sessionId: 'sess-completions',
      requestId: 'req-completions',
      trigger: '@',
      query: 'foo',
      items: [
        {
          value: 'fresh',
          label: 'latest',
          description: 'A fresh completion',
          providerMetadata: { source: 'extension' },
        },
      ],
      serverMetadata: { revision: 2 },
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.kind).toBe('custom');
      expect(parsed.value.sessionId).toBe('sess-completions');
      expect(parsed.value.requestId).toBe('req-completions');
      expect(parsed.value.items).toEqual([
        {
          value: 'fresh',
          label: 'latest',
          description: 'A fresh completion',
          providerMetadata: { source: 'extension' },
        },
      ]);
      expect(parsed.value.serverMetadata).toEqual({ revision: 2 });
    }
  });

  it('rejects extension completions with malformed item entries', () => {
    const frame = {
      type: 'extension_completions',
      sessionId: 'sess-completions',
      requestId: 'req-completions',
      trigger: '@',
      query: 'foo',
    };

    for (const item of [
      { label: 'missing value' },
      { value: 'missing label' },
      { value: 'wrong description', label: 'item', description: 42 },
    ]) {
      expect(parseServerMessage({ ...frame, items: [item] }).ok).toBe(false);
    }
  });

  describe('exported schemas direct use', () => {
    it('ConnectedMessageSchema validates a handshake payload', () => {
      const res = v.safeParse(ConnectedMessageSchema, {
        type: 'connected',
        sessionId: 's1',
        isStreaming: false,
        thinkingLevel: 'off',
        model: null,
        availableModels: [],
        messages: [],
      });
      expect(res.success).toBe(true);
    });

    it('SessionLoadedSchema accepts minimal required fields', () => {
      const res = v.safeParse(SessionLoadedSchema, {
        type: 'session_loaded',
        sessionId: 's2',
        thinkingLevel: 'off',
        model: null,
        availableModels: [],
        messages: [],
      });
      expect(res.success).toBe(true);
    });

    it('SessionsErrorSchema keeps requestId', () => {
      const res = v.parse(SessionsErrorSchema, {
        type: 'sessions_error',
        message: 'nope',
        requestId: 'op-1',
      });
      expect(res.requestId).toBe('op-1');
    });

    it('AvailableModelsChangedSchema tolerates absent sessionId', () => {
      const res = v.safeParse(AvailableModelsChangedSchema, {
        type: 'available_models_changed',
        availableModels: [],
      });
      expect(res.success).toBe(true);
    });
    it('parses a model refresh result', () => {
      const res = v.safeParse(ModelsRefreshResultSchema, {
        type: 'models_refresh_result',
        success: true,
        message: 'Models refreshed.',
      });
      expect(res.success).toBe(true);
    });
  });
});
