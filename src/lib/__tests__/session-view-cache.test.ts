import { describe, expect, it } from 'vitest';
import { SessionViewCache, type SessionView } from '../session-view-cache';
import type { UIMessage } from '../client-messages';

function message(overrides: Partial<UIMessage> = {}): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: 'hello',
    streaming: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

function view(id: string, overrides: Partial<SessionView> = {}): SessionView {
  const current = message({ id, content: `message-${id}` });
  return {
    messages: [current],
    activeStreamMsg: current,
    toolsById: new Map(),
    expandedUserMsgs: new Set(['expanded']),
    truncatedUserMsgs: new Set(['truncated']),
    draft: `draft-${id}`,
    contextUsage: { tokens: 12, contextWindow: 100, percent: 12 },
    queuedSteering: [`steer-${id}`],
    queuedFollowUp: [`follow-${id}`],
    scrollAtBottom: false,
    ...overrides,
  };
}

describe('SessionViewCache', () => {
  it('retains at most three views', () => {
    const cache = new SessionViewCache();
    cache.save('a', view('a'));
    cache.save('b', view('b'));
    cache.save('c', view('c'));
    cache.save('d', view('d'));

    expect(cache.size).toBe(3);
    expect(cache.restore('a')).toBeNull();
    expect(cache.restore('b')).not.toBeNull();
    expect(cache.restore('c')).not.toBeNull();
    expect(cache.restore('d')).not.toBeNull();
  });

  it('evicts the least recently restored view first', () => {
    const cache = new SessionViewCache();
    cache.save('a', view('a'));
    cache.save('b', view('b'));
    cache.save('c', view('c'));
    expect(cache.restore('a')).not.toBeNull();

    cache.save('d', view('d'));

    expect(cache.restore('b')).toBeNull();
    expect(cache.restore('a')).not.toBeNull();
    expect(cache.restore('c')).not.toBeNull();
    expect(cache.restore('d')).not.toBeNull();
  });

  it('strips image attachment and base64 payloads when saving', () => {
    const cache = new SessionViewCache();
    const attached = message({
      images: ['data:image/png;base64,AAAA'],
      toolArgs: {
        image: { data: 'data:image/jpeg;base64,BBBB', src: 'data:image/jpeg;base64,BBBB' },
        keep: 'text',
      },
    });
    cache.save('images', view('images', { messages: [attached], activeStreamMsg: attached }));

    const restored = cache.restore('images');
    expect(restored?.messages[0].images).toBeUndefined();
    expect(restored?.messages[0].toolArgs).toEqual({ image: {}, keep: 'text' });
  });

  it('restores an equivalent view without sharing mutable containers', () => {
    const cache = new SessionViewCache();
    const original = view('roundtrip');
    cache.save('roundtrip', original);

    const restored = cache.restore('roundtrip');
    expect(restored).toEqual(original);
    expect(restored).not.toBe(original);
    expect(restored?.messages).not.toBe(original.messages);
    expect(restored?.expandedUserMsgs).not.toBe(original.expandedUserMsgs);
    expect(restored?.queuedSteering).not.toBe(original.queuedSteering);
  });
});
