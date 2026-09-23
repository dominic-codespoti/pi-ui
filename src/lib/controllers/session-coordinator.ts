import { rawMessagesToUI, uid, type UIMessage } from '#lib/client-messages.js';
import {
  SessionViewCache,
  type SessionView,
  type SessionViewUiState,
} from '#lib/session-view-cache.js';
import type { ServerMessage } from '#lib/ws/protocol.js';
import {
  createSessionReducerState,
  reduceSession,
  type SessionAction,
  type SessionEffect,
  type SessionReducerOptions,
  type SessionReducerResult,
  type SessionReducerState,
} from './session-reducer.js';

export type SessionCoordinatorChange = {
  state: SessionReducerState;
  effects: SessionEffect[];
  touchedMessageIds: string[];
};

export type SessionCoordinatorListener = (change: SessionCoordinatorChange) => void;

export type SessionCoordinatorSnapshotOptions = {
  /** UI state captured immediately before changing the active identity. */
  activeView?: SessionViewUiState;
  /** Whether the previous active transcript should be retained in the cache. */
  preserveActiveView?: boolean;
  /** Whether cached UI state should be restored for the incoming identity. */
  restoreCachedUi?: boolean;
};

export type SessionCoordinatorSnapshotResult = SessionReducerResult & {
  restoredUi: SessionViewUiState | null;
};

export type SessionCoordinatorOptions = SessionReducerOptions & {
  cache?: SessionViewCache;
  state?: Partial<SessionReducerState>;
};

/**
 * Owns the active session's reducer state and the inactive resident views.
 * This class deliberately has no framework dependencies: a page can subscribe
 * to state/effects while a worker or another host can consume the same frame
 * and pagination APIs without DOM work.
 */
export class SessionCoordinator {
  private stateValue: SessionReducerState;
  private readonly reducerOptions: SessionReducerOptions;
  private readonly listeners = new Set<SessionCoordinatorListener>();
  readonly cache: SessionViewCache;

  constructor(options: SessionCoordinatorOptions = {}) {
    this.reducerOptions = {
      ...(options.now ? { now: options.now } : {}),
      ...(options.createId ? { createId: options.createId } : {}),
    };
    this.cache = options.cache ?? new SessionViewCache();
    this.stateValue = createSessionReducerState(options.state);
  }

  get state(): SessionReducerState {
    return this.stateValue;
  }

  subscribe(listener: SessionCoordinatorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(effects: SessionEffect[] = [], touchedMessageIds: string[] = []): void {
    if (this.listeners.size === 0) return;
    const change = { state: this.stateValue, effects, touchedMessageIds };
    for (const listener of this.listeners) listener(change);
  }

  private reduce(action: SessionAction): SessionReducerResult {
    const result = reduceSession(this.stateValue, action, this.reducerOptions);
    if (result.structureChanged) {
      // The reducer can append/splice in place; publish a fresh array only for
      // those structural changes so keyed transcript derivations stay stable.
      this.stateValue.messages = [...this.stateValue.messages];
    }
    this.publish(result.effects, result.touchedMessageIds);
    return result;
  }

  applySnapshot(
    payload: Record<string, unknown>,
    options: SessionCoordinatorSnapshotOptions = {}
  ): SessionCoordinatorSnapshotResult {
    const previousId = this.stateValue.sessionId;
    const incomingId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
    const identityChanged = incomingId !== undefined && incomingId !== previousId;
    const shouldPreserve = options.preserveActiveView !== false;

    if (identityChanged && previousId && options.activeView && shouldPreserve) {
      this.saveView(previousId, options.activeView);
    }

    const result = this.reduce({ type: 'snapshot', payload });
    const restoredUi =
      identityChanged && incomingId && options.restoreCachedUi !== false
        ? this.cache.restoreUiState(incomingId)
        : null;
    return { ...result, restoredUi };
  }

  applyEvent(message: ServerMessage | Record<string, unknown>): SessionReducerResult {
    return this.reduce({ type: 'event', message });
  }

  /**
   * Feed an event to a cached inactive resident. Cached sessions are only
   * reduced when retained, and effects are intentionally discarded so no DOM
   * renderer or scroll scheduler can run for a background session.
   */
  applyBackgroundFrame(
    sessionId: string,
    message: ServerMessage | Record<string, unknown>
  ): boolean {
    if (sessionId === this.stateValue.sessionId) return false;
    const view = this.cache.restore(sessionId);
    if (!view) return false;

    const background = createSessionReducerState({
      sessionId,
      messages: view.messages,
      activeStreamMsg: view.activeStreamMsg,
      toolsById: view.toolsById,
      contextUsage: view.contextUsage,
      queuedSteering: view.queuedSteering,
      queuedFollowUp: view.queuedFollowUp,
      toolsExpanded: this.stateValue.toolsExpanded,
    });
    const result = reduceSession(background, { type: 'event', message }, this.reducerOptions);
    view.messages = result.state.messages;
    view.activeStreamMsg = result.state.activeStreamMsg;
    view.toolsById = result.state.toolsById;
    view.contextUsage = result.state.contextUsage;
    view.queuedSteering = result.state.queuedSteering;
    view.queuedFollowUp = result.state.queuedFollowUp;
    return true;
  }

  saveActiveView(ui: SessionViewUiState): boolean {
    const sessionId = this.stateValue.sessionId;
    if (!sessionId) return false;
    this.saveView(sessionId, ui);
    return true;
  }

  private saveView(sessionId: string, ui: SessionViewUiState): void {
    const state = this.stateValue;
    const view: SessionView = {
      messages: state.messages,
      activeStreamMsg: state.activeStreamMsg,
      toolsById: state.toolsById,
      ...ui,
    };
    this.cache.save(sessionId, view);
  }

  restoreUiState(sessionId: string): SessionViewUiState | null {
    return this.cache.restoreUiState(sessionId);
  }

  replaceMessages(messages: UIMessage[], fields: Partial<SessionReducerState> = {}): void {
    this.stateValue.messages = messages;
    this.stateValue.activeStreamMsg = fields.activeStreamMsg ?? null;
    this.stateValue.toolsById = fields.toolsById ?? this.buildToolIndex(messages);
    Object.assign(this.stateValue, fields);
    this.publish();
  }

  clearTranscript(): void {
    this.replaceMessages([], {
      activeStreamMsg: null,
      toolsById: new Map<string, UIMessage>(),
      contextUsage: null,
      queuedSteering: [],
      queuedFollowUp: [],
      totalRawMessagesLoaded: 0,
      totalMessageCount: 0,
      messagesTruncated: false,
      isCompacting: false,
      compactionStartedAt: null,
    });
  }

  appendMessage(message: UIMessage): void {
    this.stateValue.messages = [...this.stateValue.messages, message];
    if (message.role === 'tool' && message.toolCallId)
      this.stateValue.toolsById.set(message.toolCallId, message);
    this.publish();
  }

  appendNotice(
    content: string,
    level: 'info' | 'warning' | 'error' = 'info',
    fields: Partial<UIMessage> = {}
  ): void {
    this.appendMessage({
      id: (this.reducerOptions.createId ?? uid)(),
      role: 'notice',
      content,
      noticeKind: 'toast',
      level,
      streaming: false,
      createdAt: (this.reducerOptions.now ?? Date.now)(),
      ...fields,
    });
  }

  appendDiagnostic(message: UIMessage): void {
    this.appendMessage(message);
  }

  dismissMessage(id: string): boolean {
    const index = this.stateValue.messages.findIndex((message) => message.id === id);
    if (index < 0) return false;
    this.stateValue.messages = this.stateValue.messages.filter(
      (_, itemIndex) => itemIndex !== index
    );
    this.publish();
    return true;
  }

  appendUserMessage(message: UIMessage): void {
    this.appendMessage(message);
  }

  prependOlderMessages(
    rawMessages: unknown[],
    totalMessageCount: number,
    messagesTruncated: boolean
  ): UIMessage[] {
    const older = rawMessagesToUI(rawMessages);
    this.stateValue.messages = [...older, ...this.stateValue.messages];
    for (const message of older) {
      if (message.role === 'tool' && message.toolCallId)
        this.stateValue.toolsById.set(message.toolCallId, message);
    }
    this.stateValue.totalRawMessagesLoaded += rawMessages.length;

    this.stateValue.totalMessageCount = totalMessageCount;
    this.stateValue.messagesTruncated = messagesTruncated;
    this.publish();
    return older;
  }

  setToolsExpanded(expanded: boolean): void {
    this.stateValue.toolsExpanded = expanded;
    const touchedMessageIds: string[] = [];
    for (const message of this.stateValue.messages) {
      if (message.role === 'tool' && !message.streaming && message.expanded !== expanded) {
        message.expanded = expanded;
        touchedMessageIds.push(message.id);
      }
    }
    this.publish([], touchedMessageIds);
  }

  updateTool(toolCallId: string, update: (message: UIMessage) => void): boolean {
    const message = this.stateValue.toolsById.get(toolCallId);
    if (!message) return false;
    update(message);
    this.publish([], [message.id]);
    return true;
  }

  clearStreamingFlags(): void {
    const touchedMessageIds: string[] = [];
    for (const message of this.stateValue.messages) {
      if (message.streaming) {
        message.streaming = false;
        touchedMessageIds.push(message.id);
      }
    }
    this.stateValue.activeStreamMsg = null;
    this.publish([], touchedMessageIds);
  }
  private buildToolIndex(messages: UIMessage[]): Map<string, UIMessage> {
    const index = new Map<string, UIMessage>();
    for (const message of messages) {
      if (message.role === 'tool' && message.toolCallId) index.set(message.toolCallId, message);
    }
    return index;
  }
}

export function createSessionCoordinator(
  options: SessionCoordinatorOptions = {}
): SessionCoordinator {
  return new SessionCoordinator(options);
}
