import { describe, expect, it } from 'vitest';
import { SessionViewCache } from '../../session-view-cache.js';
import { SessionCoordinator } from '../session-coordinator.js';
import type { UIMessage } from '#lib/client-messages.js';

const ui = (id: string, content: string): UIMessage => ({
  id,
  role: 'user',
  content,
  streaming: false,
  createdAt: 1,
});

describe('session coordinator', () => {
  it('reduces an authoritative snapshot, token delta, and tool event on one state', () => {
    let id = 0;
    const coordinator = new SessionCoordinator({
      now: () => 100,
      createId: () => `generated-${++id}`,
    });
    const changes: { effects: unknown[]; messages: UIMessage[] }[] = [];
    coordinator.subscribe(({ state, effects }) => {
      changes.push({ effects, messages: state.messages });
    });

    coordinator.applySnapshot({
      type: 'session_loaded',
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    });
    coordinator.applyEvent({ type: 'message_start', message: { role: 'assistant' } });
    coordinator.applyEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'world' },
    });
    coordinator.applyEvent({
      type: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'tool-1',
      args: { path: 'a.ts' },
    });

    expect(coordinator.state.messages.at(-2)?.content).toBe('world');
    expect(coordinator.state.toolsById.get('tool-1')?.toolName).toBe('read');
    expect(changes.at(-2)?.effects).toContainEqual({
      type: 'render_message',
      messageId: 'generated-1',
      streaming: true,
      scroll: true,
    });
  });

  it('routes cached background frames without notifying visible subscribers', () => {
    const cache = new SessionViewCache();
    const coordinator = new SessionCoordinator({ cache, createId: () => 'id' });
    coordinator.applySnapshot({
      type: 'session_loaded',
      sessionId: 'active',
      messages: [{ role: 'user', content: 'active' }],
    });
    coordinator.saveActiveView({
      expandedUserMsgs: new Set(),
      truncatedUserMsgs: new Set(),
      draft: '',
      contextUsage: null,
      queuedSteering: [],
      queuedFollowUp: [],
      queuedDeferred: [],
      scrollAtBottom: true,
    });
    coordinator.applySnapshot({
      type: 'session_loaded',
      sessionId: 'background',
      messages: [{ role: 'assistant', content: 'old' }],
    });
    const before = coordinator.state.messages;
    let notifications = 0;
    coordinator.subscribe(() => notifications++);
    expect(coordinator.applyBackgroundFrame('active', { type: 'agent_start' })).toBe(true);
    expect(notifications).toBe(0);
    expect(coordinator.state.messages).toBe(before);
    expect(cache.restore('active')?.messages).toHaveLength(1);
    expect(cache.restore('active')?.messages[0]?.streaming).toBe(false);
  });

  it('prepends older pages and updates pagination counters through the coordinator', () => {
    const coordinator = new SessionCoordinator();
    coordinator.applySnapshot({
      type: 'session_loaded',
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'new' }],
      totalMessageCount: 2,
      messagesTruncated: true,
    });
    coordinator.prependOlderMessages([{ role: 'user', content: 'old' }], 2, false);

    expect(coordinator.state.messages.map((message) => message.content)).toEqual(['old', 'new']);
    expect(coordinator.state.totalRawMessagesLoaded).toBe(2);
    expect(coordinator.state.totalMessageCount).toBe(2);
    expect(coordinator.state.messagesTruncated).toBe(false);
  });

  it('emits scroll and render effects for identity and streaming transitions', () => {
    const coordinator = new SessionCoordinator({ createId: () => 'assistant' });
    const effects: unknown[][] = [];
    coordinator.subscribe((change) => effects.push(change.effects));
    coordinator.applySnapshot({ type: 'session_loaded', sessionId: 'first', messages: [] });
    coordinator.applySnapshot({ type: 'session_loaded', sessionId: 'second', messages: [] });
    coordinator.applyEvent({ type: 'message_start', message: { role: 'assistant' } });
    coordinator.applyEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'reasoning' },
    });

    expect(effects[1]).toContainEqual({ type: 'scroll_bottom' });
    expect(effects.at(-1)).toContainEqual({
      type: 'render_message',
      messageId: 'assistant',
      streaming: true,
      scroll: false,
    });
  });

  it('keeps transcript ownership for notices and removal', () => {
    const coordinator = new SessionCoordinator({ createId: () => 'notice' });
    coordinator.appendNotice('hello', 'warning');
    expect(coordinator.state.messages[0]?.content).toBe('hello');
    expect(coordinator.dismissMessage('notice')).toBe(true);
    expect(coordinator.state.messages).toEqual([]);
  });

  it('atomically replaces a session identity and returns retained UI state', () => {
    const coordinator = new SessionCoordinator();
    coordinator.applySnapshot({ type: 'session_loaded', sessionId: 'one', messages: [] });
    coordinator.saveActiveView({
      expandedUserMsgs: new Set(['m']),
      truncatedUserMsgs: new Set(),
      draft: 'draft',
      contextUsage: null,
      queuedSteering: [],
      queuedFollowUp: [],
      queuedDeferred: [],
      scrollAtBottom: false,
    });
    coordinator.applySnapshot({ type: 'session_loaded', sessionId: 'two', messages: [] });
    const result = coordinator.applySnapshot(
      { type: 'session_loaded', sessionId: 'one', messages: [] },
      { preserveActiveView: true }
    );
    expect(result.restoredUi?.draft).toBe('draft');
    expect(coordinator.state.sessionId).toBe('one');
  });

  it('accepts explicit message replacement without rebuilding a reducer per frame', () => {
    const coordinator = new SessionCoordinator();
    coordinator.replaceMessages([ui('m1', 'hello')]);
    expect(coordinator.state.messages).toHaveLength(1);
    expect(coordinator.state.toolsById.size).toBe(0);
  });

  it('keeps the transcript array stable for deltas and reports only the touched row', () => {
    const coordinator = new SessionCoordinator({ createId: () => 'assistant' });
    coordinator.applyEvent({ type: 'message_start', message: { role: 'assistant' } });
    const messages = coordinator.state.messages;
    let touched: string[] = [];
    coordinator.subscribe((change) => {
      touched = change.touchedMessageIds;
    });

    coordinator.applyEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'token' },
    });

    expect(coordinator.state.messages).toBe(messages);
    expect(touched).toEqual(['assistant']);
  });

  it('changes transcript identity on append and removal', () => {
    const coordinator = new SessionCoordinator({ createId: () => 'assistant' });
    const empty = coordinator.state.messages;

    coordinator.applyEvent({ type: 'message_start', message: { role: 'assistant' } });
    const appended = coordinator.state.messages;
    expect(appended).not.toBe(empty);
    expect(appended).toHaveLength(1);

    coordinator.applyEvent({ type: 'agent_end' });
    expect(coordinator.state.messages).not.toBe(appended);
    expect(coordinator.state.messages).toHaveLength(0);
  });
});
