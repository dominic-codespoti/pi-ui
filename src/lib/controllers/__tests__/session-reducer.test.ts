import { describe, expect, it } from 'vitest';
import {
  createSessionReducerState,
  reduceSession,
  type SessionReducerState,
} from '../session-reducer.js';
function apply(
  state: SessionReducerState,
  message: Record<string, unknown>,
  options: { now?: () => number; createId?: () => string } = {}
): SessionReducerState {
  return reduceSession(state, { type: 'event', message }, options).state;
}

describe('session reducer', () => {
  it('marks the session streaming on agent_start so the abort control is available', () => {
    const state = createSessionReducerState({ sessionId: 'session-1' });
    expect(apply(state, { type: 'agent_start' }).isStreaming).toBe(true);
  });

  it('replaces identity-owned transcript and context on a new snapshot', () => {
    const state = createSessionReducerState({
      sessionId: 'old',
      queuedSteering: ['pending'],
      queuedFollowUp: ['later'],
      contextUsage: { tokens: 900, contextWindow: 1000, percent: 90 },
      messages: [
        {
          id: 'old-message',
          role: 'assistant',
          content: 'old transcript',
          streaming: false,
          createdAt: 1,
        },
      ],
    });
    const result = reduceSession(state, {
      type: 'snapshot',
      payload: {
        type: 'session_loaded',
        sessionId: 'new',
        messages: [{ role: 'user', content: 'new transcript', timestamp: 2 }],
        contextUsage: { tokens: 20, contextWindow: 200 },
      },
    });

    expect(result.identityChanged).toBe(true);
    expect(result.transcriptReplaced).toBe(true);
    expect(result.state.sessionId).toBe('new');
    expect(result.state.messages).toHaveLength(1);
    expect(result.state.messages[0]?.content).toBe('new transcript');
    expect(result.state.queuedSteering).toEqual([]);
    expect(result.state.queuedFollowUp).toEqual([]);
    expect(result.state.contextUsage).toMatchObject({ tokens: 20, contextWindow: 200 });
    expect(result.effects).toContainEqual({ type: 'scroll_bottom' });
  });
  it('clears explicit null context usage in full snapshots with model-window fallback', () => {
    const state = createSessionReducerState({
      model: {
        provider: 'test',
        id: 'model',
        name: 'Test model',
        reasoning: false,
        contextWindow: 4000,
      },
      contextUsage: { tokens: 900, contextWindow: 4000, percent: 22.5 },
    });

    reduceSession(state, {
      type: 'snapshot',
      payload: { type: 'session_loaded', contextUsage: null },
    });

    expect(state.contextUsage).toEqual({ tokens: null, contextWindow: 4000, percent: null });
  });

  it('clears explicit null and preserves absent context usage in partial snapshots', () => {
    const state = createSessionReducerState({
      model: {
        provider: 'test',
        id: 'model',
        name: 'Test model',
        reasoning: false,
        contextWindow: 4000,
      },
      contextUsage: { tokens: 900, contextWindow: 4000, percent: 22.5 },
    });

    reduceSession(state, {
      type: 'snapshot',
      payload: { type: 'session_update' },
    });
    expect(state.contextUsage).toEqual({ tokens: 900, contextWindow: 4000, percent: 22.5 });

    reduceSession(state, {
      type: 'snapshot',
      payload: { type: 'session_update', contextUsage: null },
    });
    expect(state.contextUsage).toEqual({ tokens: null, contextWindow: 4000, percent: null });
  });

  it('tracks active tools across start, update, and end transitions', () => {
    let id = 0;
    const options = { now: () => 100, createId: () => `generated-${++id}` };
    const state = createSessionReducerState({ sessionId: 'session-1' });

    apply(
      state,
      {
        type: 'tool_execution_start',
        toolName: 'read',
        toolCallId: 'tool-1',
        args: { path: 'a.ts' },
      },
      options
    );
    expect(state.activeToolName).toBe('read');
    expect(state.messages[0]).toMatchObject({
      role: 'tool',
      toolCallId: 'tool-1',
      streaming: true,
    });

    apply(
      state,
      {
        type: 'tool_execution_update',
        toolName: 'read',
        toolCallId: 'tool-1',
        partialResult: {
          content: [
            { type: 'text', text: 'partial' },
            { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
          ],
        },
      },
      options
    );
    expect(state.messages[0]?.content).toBe('partial');
    expect(state.messages[0]?.images).toEqual(['data:image/png;base64,aW1hZ2U=']);
    expect(state.activeToolName).toBe('read');

    apply(
      state,
      {
        type: 'tool_execution_end',
        toolName: 'read',
        toolCallId: 'tool-1',
        result: { content: [{ type: 'text', text: 'complete' }] },
      },
      options
    );
    expect(state.activeToolName).toBeUndefined();
    expect(state.messages[0]).toMatchObject({ content: 'complete', streaming: false, endMs: 100 });
  });

  it('preserves queue order and duplicate entries so each item has a removable index', () => {
    const state = createSessionReducerState({ sessionId: 'session-1' });
    apply(state, {
      type: 'queue_update',
      steering: ['one', 'one', 'two'],
      followUp: ['next', 'next'],
      deferred: ['waiting', 'waiting'],
    });
    expect(state.queuedSteering).toEqual(['one', 'one', 'two']);
    expect(state.queuedFollowUp).toEqual(['next', 'next']);
    expect(state.queuedDeferred).toEqual(['waiting', 'waiting']);
  });

  it('records compaction progress and final status with context usage', () => {
    let now = 1000;
    let id = 0;
    const options = { now: () => now, createId: () => `notice-${++id}` };
    const state = createSessionReducerState({
      sessionId: 'session-1',
      contextUsage: { tokens: 1000, contextWindow: 2000, percent: 50 },
    });

    apply(state, { type: 'compaction_start', reason: 'manual' }, options);
    expect(state.isCompacting).toBe(true);
    expect(state.messages[0]).toMatchObject({
      role: 'notice',
      noticeKind: 'compaction',
      streaming: true,
      compaction: { status: 'running', tokensBefore: 1000 },
    });

    now = 1300;
    apply(
      state,
      {
        type: 'compaction_end',
        result: { tokensBefore: 1000, estimatedTokensAfter: 400 },
        contextUsage: { tokens: 400, contextWindow: 2000 },
      },
      options
    );
    expect(state.isCompacting).toBe(false);
    expect(state.compactionStartedAt).toBeNull();
    expect(state.messages[0]).toMatchObject({
      streaming: false,
      content: 'context compacted · 1,000 → 400 tokens',
      compaction: { status: 'completed', durationMs: 300, tokensAfter: 400 },
    });
    expect(state.contextUsage).toMatchObject({ tokens: 400, contextWindow: 2000 });
  });

  it('records retry start and settles the matching retry notice', () => {
    let id = 0;
    const state = createSessionReducerState({ sessionId: 'session-1' });
    const options = { now: () => 500, createId: () => `retry-${++id}` };
    apply(
      state,
      {
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 2500,
        errorMessage: 'overloaded',
      },
      options
    );
    expect(state.messages[0]).toMatchObject({
      role: 'notice',
      noticeKind: 'retry',
      content: 'retrying (2/3, 3s) — overloaded',
      streaming: true,
    });

    apply(state, { type: 'auto_retry_end', success: true }, options);
    expect(state.messages[0]).toMatchObject({
      streaming: false,
      content: 'retry succeeded',
    });
  });

  it('keeps message identity stable for deltas and reports the touched id', () => {
    const state = createSessionReducerState({ sessionId: 'session-1' });
    const started = reduceSession(
      state,
      { type: 'event', message: { type: 'message_start', message: { role: 'assistant' } } },
      { createId: () => 'assistant' }
    );
    const messages = started.state.messages;

    const result = reduceSession(state, {
      type: 'event',
      message: {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'x' },
      },
    });

    expect(result.state.messages).toBe(messages);
    expect(result.structureChanged).toBe(false);
    expect(result.touchedMessageIds).toEqual(['assistant']);
    expect(result.state.messages[0]?.content).toBe('x');
  });

  it('reports structural append and removal changes', () => {
    const state = createSessionReducerState({ sessionId: 'session-1' });
    const start = reduceSession(
      state,
      { type: 'event', message: { type: 'message_start', message: { role: 'assistant' } } },
      { createId: () => 'assistant' }
    );
    expect(start.structureChanged).toBe(true);

    const end = reduceSession(state, {
      type: 'event',
      message: { type: 'agent_end' },
    });
    expect(end.structureChanged).toBe(true);
    expect(end.state.messages).toHaveLength(0);
  });

  it('renders streamed tool arguments before execution and merges the real start row', () => {
    let nextId = 0;
    const state = createSessionReducerState({ sessionId: 'session-1' });
    const options = { createId: () => `generated-${++nextId}` };
    apply(
      state,
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 2,
          id: 'tool-call-1',
          toolName: 'read',
        },
      },
      options
    );
    apply(
      state,
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"src/' },
      },
      options
    );
    const pendingId = state.messages[0]?.id;
    expect(state.messages[0]).toMatchObject({
      role: 'tool',
      toolName: 'read',
      toolCallId: 'tool-call-1',
      toolArgsPreview: '{"path":"src/',
      streaming: true,
    });

    apply(
      state,
      {
        type: 'tool_execution_start',
        toolName: 'read',
        toolCallId: 'tool-call-1',
        args: { path: 'src/main.ts' },
      },
      options
    );
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: pendingId,
      toolCallId: 'tool-call-1',
      toolInput: 'main.ts',
      toolArgs: { path: 'src/main.ts' },
      streaming: true,
    });
    expect(state.messages[0]?.toolArgsPreview).toBeUndefined();
  });
  it('counts bash output lines across delta boundaries', () => {
    const state = createSessionReducerState({ sessionId: 'session-1' });
    apply(state, { type: 'bash_execution_update', id: 'bash-1', delta: 'one\n' });
    apply(state, { type: 'bash_execution_update', id: 'bash-1', delta: 'two\nthree' });

    expect(state.messages[0]).toMatchObject({
      content: 'one\ntwo\nthree',
      lineCount: 3,
    });
  });
  it('keeps streamed assistant text and ordered blocks when the final response is aborted', () => {
    const state = createSessionReducerState({ sessionId: 'session-1' });
    apply(
      state,
      { type: 'message_start', message: { role: 'assistant' } },
      { createId: () => 'assistant' }
    );
    apply(state, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'partial answer' },
    });
    apply(state, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'reasoning' },
    });
    apply(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'partial answer' },
          { type: 'thinking', thinking: 'reasoning' },
        ],
        stopReason: 'aborted',
        errorMessage: 'Cancelled by user',
      },
    });
    expect(state.messages[0]).toMatchObject({
      content: 'partial answer',
      thinking: 'reasoning',
      stopReason: 'aborted',
      errorMessage: 'Cancelled by user',
      aborted: true,
      streaming: false,
      blocks: [
        { type: 'text', text: 'partial answer' },
        { type: 'thinking', text: 'reasoning' },
      ],
    });
  });

  it('appends streamed compaction summaries to the transcript', () => {
    const state = createSessionReducerState({ sessionId: 'session-1' });
    apply(state, {
      type: 'message_end',
      message: { role: 'compactionSummary', summary: 'important context', tokensBefore: 1200 },
    });
    apply(state, {
      type: 'agent_end',
      messages: [{ role: 'branchSummary', summary: 'branch context', fromId: 'entry-7' }],
    });
    expect(state.messages[0]).toMatchObject({
      role: 'compaction_summary',
      summary: 'important context',
      tokensBefore: 1200,
    });
    expect(state.messages[1]).toMatchObject({
      role: 'branch_summary',
      summary: 'branch context',
      fromId: 'entry-7',
    });
  });

  it('appends live diagnostic custom messages to the transcript', () => {
    const state = createSessionReducerState({ sessionId: 'session-1' });

    apply(state, {
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'pi-ui:diagnostic',
        content: 'Something happened',
        details: { level: 'warning', source: 'test' },
      },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: 'diagnostic',
      content: 'Something happened',
      level: 'warning',
      source: 'test',
    });
  });
});
