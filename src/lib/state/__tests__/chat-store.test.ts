import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatStore } from '../chat-store.svelte';

// scheduleContentRender defers work to rAF — capture callbacks without running.
let rafCallbacks: FrameRequestCallback[] = [];
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  rafCallbacks.push(cb);
  return rafCallbacks.length;
});

function flushRaf(): void {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  cbs.forEach((cb) => cb(0));
}

function userMsg(content: string) {
  return {
    id: `u-${content}`,
    role: 'user' as const,
    content,
    streaming: false,
    createdAt: Date.now(),
  };
}

describe('ChatStore streaming lifecycle', () => {
  let chat: ChatStore;
  beforeEach(() => {
    rafCallbacks = [];
    chat = new ChatStore();
  });

  it('only creates a bubble for assistant message_start', () => {
    chat.beginAssistantTurn({ role: 'user' });
    expect(chat.messages).toHaveLength(0);
    chat.beginAssistantTurn({ role: 'assistant' });
    expect(chat.messages).toHaveLength(1);
    expect(chat.activeStreamMsg).toBe(chat.messages[0]);
  });

  it('appends text and thinking deltas to the active stream', () => {
    chat.beginAssistantTurn({ role: 'assistant' });
    chat.applyStreamDelta({ type: 'text_delta', delta: 'Hel' });
    chat.applyStreamDelta({ type: 'text_delta', delta: 'lo' });
    chat.applyStreamDelta({ type: 'thinking_delta', delta: 'hmm' });
    expect(chat.messages[0].content).toBe('Hello');
    expect(chat.messages[0].thinking).toBe('hmm');
  });

  it('ignores deltas when nothing is streaming', () => {
    expect(() => chat.applyStreamDelta({ type: 'text_delta', delta: 'x' })).not.toThrow();
    expect(chat.messages).toHaveLength(0);
  });

  it('seals usage and clears the pointer on assistant message_end', () => {
    chat.beginAssistantTurn({ role: 'assistant' });
    chat.endAssistantMessage({
      role: 'assistant',
      stopReason: 'endTurn',
      content: [{ type: 'text', text: 'done' }],
      usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.5 } },
    });
    expect(chat.activeStreamMsg).toBeNull();
    expect(chat.messages[0].usage?.totalTokens).toBe(3);
    expect(chat.messages[0].streaming).toBe(false);
  });

  it('marks aborted assistant messages', () => {
    chat.beginAssistantTurn({ role: 'assistant' });
    chat.endAssistantMessage({ role: 'assistant', stopReason: 'aborted' });
    expect(chat.messages[0].aborted).toBe(true);
    expect(chat.messages[0].content).toBe('Operation aborted');
  });

  it('replaces the streamed buffer when contentTransformed is flagged', () => {
    chat.beginAssistantTurn({ role: 'assistant' });
    chat.applyStreamDelta({ type: 'text_delta', delta: 'raw streamed' });
    chat.applyStreamDelta({ type: 'thinking_delta', delta: 'raw thought' });
    chat.endAssistantMessage({
      role: 'assistant',
      stopReason: 'endTurn',
      contentTransformed: true,
      content: [
        { type: 'text', text: 'transformed body' },
        { type: 'thinking', thinking: 'transformed thought' },
      ],
    });
    expect(chat.messages[0].content).toBe('transformed body');
    expect(chat.messages[0].thinking).toBe('transformed thought');
  });

  it('keeps streamed text when contentTransformed is absent', () => {
    chat.beginAssistantTurn({ role: 'assistant' });
    chat.applyStreamDelta({ type: 'text_delta', delta: 'streamed' });
    chat.endAssistantMessage({
      role: 'assistant',
      stopReason: 'endTurn',
      content: [{ type: 'text', text: 'ignored' }],
    });
    expect(chat.messages[0].content).toBe('streamed');
  });

  it('pushes custom-role messages through rawMessagesToUI', () => {
    chat.endAssistantMessage({
      role: 'custom',
      id: 'c1',
      content: 'custom body',
      customType: 'note',
    });
    expect(chat.messages.length).toBeGreaterThan(0);
  });

  it('sealStreaming drops empty assistant bubbles and finalizes partial ones', () => {
    chat.beginAssistantTurn({ role: 'assistant' }); // stays empty
    chat.beginAssistantTurn({ role: 'assistant' });
    chat.applyStreamDelta({ type: 'text_delta', delta: 'kept' });
    flushRaf();
    chat.sealStreaming();
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].content).toBe('kept');
    expect(chat.messages[0].streaming).toBe(false);
  });
});

describe('ChatStore.finishAgentRun', () => {
  let chat: ChatStore;
  beforeEach(() => {
    chat = new ChatStore();
  });

  it('returns null on a normal turn', () => {
    expect(
      chat.finishAgentRun([
        { role: 'assistant', stopReason: 'endTurn', content: [{ type: 'text', text: 'ok' }] },
      ])
    ).toBeNull();
  });

  it('surfaces an error stop reason with level=error', () => {
    const notice = chat.finishAgentRun([{ role: 'assistant', stopReason: 'error' }]);
    expect(notice).toContain('Agent error');
    expect(chat.messages.at(-1)?.level).toBe('error');
  });

  it('flags empty responses that are neither toolUse nor aborted', () => {
    const notice = chat.finishAgentRun([{ role: 'assistant', stopReason: 'endTurn', content: [] }]);
    expect(notice).toBe('Agent returned an empty response.');
  });

  it('tolerates tool-only turns without calling them empty', () => {
    const notice = chat.finishAgentRun([
      { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall' }] },
    ]);
    expect(notice).toBeNull();
  });

  it('ignores non-array run messages', () => {
    expect(chat.finishAgentRun(undefined)).toBeNull();
  });
});

describe('ChatStore tool traces', () => {
  it('tracks start/update/end by toolCallId', () => {
    const chat = new ChatStore();
    chat.toolExecutionStart({ toolName: 'bash', toolCallId: 't1' }, false);
    const trace = chat.findToolMessage('t1');
    expect(trace?.streaming).toBe(true);

    chat.toolExecutionUpdate({
      toolCallId: 't1',
      partialResult: { content: [{ type: 'text', text: 'partial out' }] },
    });
    expect(trace?.content).toBe('partial out');

    chat.toolExecutionEnd({ toolCallId: 't1', result: {} });
    expect(trace?.streaming).toBe(false);
  });

  it('auto-expands short successful output', () => {
    const chat = new ChatStore();
    chat.toolExecutionStart({ toolName: 'ls', toolCallId: 't2' }, false);
    chat.toolExecutionEnd({
      toolCallId: 't2',
      result: { content: [{ type: 'text', text: 'a\nb' }] },
    });
    expect(chat.messages[0].expanded).toBe(true);
  });

  it('auto-expands errors regardless of size', () => {
    const chat = new ChatStore();
    chat.toolExecutionStart({ toolName: 'bash', toolCallId: 't3' }, false);
    chat.toolExecutionEnd({
      toolCallId: 't3',
      isError: true,
      result: { content: [{ type: 'text', text: 'x'.repeat(5000) }] },
    });
    expect(chat.messages[0].expanded).toBe(true);
  });
});

describe('ChatStore notices, queues, history', () => {
  it('seals compaction notices with a token summary', () => {
    const chat = new ChatStore();
    chat.compactionStart('manual');
    chat.compactionEnd({ result: { tokensBefore: 1000, estimatedTokensAfter: 250 } });
    expect(chat.isCompacting).toBe(false);
    expect(chat.messages.at(-1)?.content).toContain('1,000 → 250');
    expect(chat.messages.at(-1)?.compaction).toMatchObject({
      status: 'completed',
      tokensBefore: 1000,
      tokensAfter: 250,
      willRetry: false,
    });
  });

  it('marks non-aborted compaction errors as failed', () => {
    const chat = new ChatStore();
    chat.compactionStart('manual');
    chat.compactionEnd({
      aborted: false,
      errorMessage: 'Nothing to compact (session too small)',
    });
    expect(chat.messages.at(-1)?.compaction).toMatchObject({
      status: 'failed',
      errorMessage: 'Nothing to compact (session too small)',
    });
    expect(chat.messages.at(-1)?.content).toBe(
      'compaction failed: Nothing to compact (session too small)'
    );
  });

  it('seals retry notices on failure', () => {
    const chat = new ChatStore();
    chat.retryStart({ attempt: 1, maxAttempts: 2 });
    chat.retryEnd({ success: false, finalError: 'boom' });
    expect(chat.messages.at(-1)?.content).toContain('retry failed: boom');
  });

  it('prepends older history after the existing tail', () => {
    const chat = new ChatStore();
    chat.messages.push(userMsg('newest'));
    chat.prependOlder({
      messages: [{ role: 'user', content: 'oldest', timestamp: Date.now() }],
      totalMessageCount: 9,
      messagesTruncated: true,
    });
    expect(chat.messages.map((m) => m.content)).toEqual(['oldest', 'newest']);
    expect(chat.totalRawMessagesLoaded).toBe(1);
    expect(chat.totalMessageCount).toBe(9);
    expect(chat.messagesTruncated).toBe(true);
  });

  it('dismisses notices by id', () => {
    const chat = new ChatStore();
    chat.showNotice('hi');
    const id = chat.messages[0].id;
    chat.dismissNotice(id);
    expect(chat.messages).toHaveLength(0);
  });
});
