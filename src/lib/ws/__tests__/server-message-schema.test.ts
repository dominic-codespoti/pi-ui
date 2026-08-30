import { describe, expect, it } from 'vitest';
import {
  parseServerMessage,
  ConnectedMessageSchema,
  SessionLoadedSchema,
  SessionsErrorSchema,
  AvailableModelsChangedSchema,
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

  it('parses session_loaded with only required fields', () => {
    const raw = {
      type: 'session_loaded',
      sessionId: 'sess-5678',
      isStreaming: true,
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
      expect(parsed.value.isStreaming).toBe(true);
      expect(parsed.value.model).toBeNull();
    }
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

  it('parses other custom server events correctly', () => {
    const modelChanged = parseServerMessage({
      type: 'model_changed',
      model: {
        provider: 'anthropic',
        id: 'claude-3-7-sonnet',
        name: 'Claude 3.7 Sonnet',
        reasoning: true,
      },
      thinkingLevel: 'high',
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
      isRunning: true,
      unseen: false,
      lastActivity: 1234567890,
    });
    expect(sessionRuntime.ok).toBe(true);

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
        isStreaming: false,
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
  });
});
