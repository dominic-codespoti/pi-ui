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
        partialResult: { content: [{ type: 'text', text: 'partial' }] },
      },
      options
    );
    expect(state.messages[0]?.content).toBe('partial');
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

  it('deduplicates queue updates while preserving their channel order', () => {
    const state = createSessionReducerState({ sessionId: 'session-1' });
    apply(state, {
      type: 'queue_update',
      steering: ['one', 'one', 'two'],
      followUp: ['next', 'next'],
    });
    expect(state.queuedSteering).toEqual(['one', 'two']);
    expect(state.queuedFollowUp).toEqual(['next']);
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
});
